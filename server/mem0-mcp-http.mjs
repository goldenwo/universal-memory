#!/usr/bin/env node
/**
 * universal-memory server — HTTP + MCP wrapper around mem0 OSS.
 *
 * Endpoints:
 *   GET  /health              liveness + memory count
 *   POST /mcp                 JSON-RPC (MCP clients)
 *   POST /api/search          { query, limit?, include_superseded? } -> { results: [...] }
 *   GET  /api/search          ?q=...&limit=5&include_superseded=true -> { results: [...] }
 *   POST /api/add             { text } -> mem0 extraction + store
 *   GET  /api/list            all memories for MEM0_USER_ID
 *   GET  /api/state/:project  read $VAULT/state/<project>/state.md directly (no mem0)
 *   DELETE /api/:id           remove a memory
 *   POST /api/reindex         { path } -> read vault file, upsert to mem0 with frontmatter metadata
 *
 * Required env: OPENAI_API_KEY, MEM0_USER_ID
 * Optional env: MEM0_MCP_PORT (default 6335), QDRANT_HOST, QDRANT_PORT,
 *               QDRANT_COLLECTION, MEM0_EMBEDDER_MODEL, MEM0_LLM_MODEL,
 *               UM_MCP_WRITE_ENABLED (default false)
 *
 * Search filter (default, disable with include_superseded=true):
 *   Excludes docs where status === 'superseded'|'deprecated'|'rejected'
 *   or invalidated_at is non-null. Legacy docs with no metadata are treated
 *   as current. Note: limit is applied before filtering, so callers may
 *   receive fewer results than requested when some are excluded.
 *
 * MCP write tools (memory_capture, memory_forget, memory_supersede):
 *   Gated on UM_MCP_WRITE_ENABLED=true. Off by default. When enabled, the
 *   server writes directly to the vault (writer-ownership exception — MCP
 *   clients such as Claude.ai/Desktop cannot write to the host filesystem).
 *   Vault mount mode must be rw when writes are enabled (UM_MOUNT_MODE=rw
 *   in docker-compose). See docs/mcp-tools.md for full tool reference.
 */

import { createServer } from 'http';
import path from 'node:path';
import { Memory } from 'mem0ai/oss';
import { parseFrontmatter, serializeFrontmatter } from './lib/frontmatter.mjs';
import { readVaultFile } from './lib/vault.mjs';
import { applyTemporalDecay } from './lib/ranking.mjs';
import { writeVaultFile, findDocByIdInVault } from './lib/vault-write.mjs';

function requireEnv(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`[mem0-mcp] FATAL: ${name} is required`);
		process.exit(1);
	}
	return v;
}

const PORT = parseInt(process.env.MEM0_MCP_PORT || '6335', 10);
const USER_ID = requireEnv('MEM0_USER_ID');
requireEnv('OPENAI_API_KEY');

let memory;
async function initMemory() {
	memory = new Memory({
		version: 'v1.1',
		embedder: {
			provider: 'openai',
			config: { model: process.env.MEM0_EMBEDDER_MODEL || 'text-embedding-3-small' },
		},
		vectorStore: {
			provider: 'qdrant',
			config: {
				host: process.env.QDRANT_HOST || 'localhost',
				port: parseInt(process.env.QDRANT_PORT || '6333', 10),
				collectionName: process.env.QDRANT_COLLECTION || 'memories',
			},
		},
		llm: {
			provider: 'openai',
			config: { model: process.env.MEM0_LLM_MODEL || 'gpt-4.1-nano-2025-04-14' },
		},
		// mem0's default history DB is "memory.db" relative to CWD. In the container
		// CWD is /app (root-owned) but we run as USER node — unwritable. Put it in
		// /tmp by default (ephemeral, always writable). Users who want persistence
		// can set MEM0_HISTORY_DB_PATH to a bind-mounted path.
		historyDbPath: process.env.MEM0_HISTORY_DB_PATH || '/tmp/mem0-history.db',
	});
	// Retry warmup — Qdrant may not be fully ready the instant the container reports healthy,
	// and compose's depends_on/service_healthy cannot be fully trusted across all Qdrant image
	// tags (some image variants don't ship the binaries their healthchecks would need).
	const MAX_ATTEMPTS = 30;
	for (let i = 1; i <= MAX_ATTEMPTS; i++) {
		try {
			await memory.getAll({ userId: '__warmup__' });
			console.log(`[mem0-mcp] Memory initialized, Qdrant reachable (attempt ${i})`);
			return;
		} catch (err) {
			if (i === MAX_ATTEMPTS) {
				console.error(`[mem0-mcp] FATAL: Qdrant unreachable after ${MAX_ATTEMPTS} attempts: ${err.message}`);
				throw err;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

const TOOLS = [
	// ── Original 4 tools ────────────────────────────────────────────────────
	{
		name: 'memory_search',
		description: 'Search memories by semantic similarity with optional status filters',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Semantic search query' },
				limit: { type: 'number', description: 'Max results (default 5, max 100)' },
				include_superseded: { type: 'boolean', description: 'Include superseded/deprecated/rejected docs (default false)' },
				filters: {
					type: 'object',
					description: 'Optional metadata filters',
					properties: {
						project: { type: 'string', description: 'Filter by project name' },
						type: { type: 'string', description: 'Filter by document type (e.g. session_summary, authored)' },
					},
				},
			},
			required: ['query'],
		},
	},
	{
		name: 'memory_add',
		description: 'Add a fact to long-term memory',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string' },
				metadata: { type: 'object', description: 'Optional key-value metadata to attach to the memory' },
			},
			required: ['text'],
		},
	},
	{
		name: 'memory_list',
		description: 'List all stored memories',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'memory_delete',
		description: 'Delete a memory by ID',
		inputSchema: {
			type: 'object',
			properties: { memoryId: { type: 'string' } },
			required: ['memoryId'],
		},
	},
	// ── Task 10: 6 new tools ────────────────────────────────────────────────
	{
		name: 'memory_state',
		description: 'Fetch the state.md for a project (current state-of-play, not from mem0)',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project name (must match ^[a-zA-Z0-9._-]+$)' },
			},
			required: ['project'],
		},
	},
	{
		name: 'memory_recent',
		description: 'Fetch recent session_summary documents for a project',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project name filter (optional)' },
				limit: { type: 'number', description: 'Max results (default 5)' },
			},
		},
	},
	{
		name: 'memory_capture',
		description: 'Write a new authored document to the vault and reindex it (requires UM_MCP_WRITE_ENABLED=true)',
		inputSchema: {
			type: 'object',
			properties: {
				content: { type: 'string', description: 'Markdown body of the document (no frontmatter — metadata arg supplies that)' },
				metadata: {
					type: 'object',
					description: 'Frontmatter fields. Required: type, id, title. Optional: project, status, valid_from, and any other fields.',
					properties: {
						type: { type: 'string' },
						id: { type: 'string', description: 'Filename stem — must be unique in the vault' },
						title: { type: 'string' },
						project: { type: 'string' },
					},
					required: ['type', 'id', 'title'],
				},
			},
			required: ['content', 'metadata'],
		},
	},
	{
		name: 'memory_checkpoint',
		description: 'Force a session summary + state update (stub — not yet implemented; completes with Phase C Task 15/21)',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project to checkpoint (optional)' },
			},
		},
	},
	{
		name: 'memory_forget',
		description: 'Deprecate a document by ID — sets status=deprecated and invalidated_at in its frontmatter (requires UM_MCP_WRITE_ENABLED=true)',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Document ID (filename stem without .md)' },
			},
			required: ['id'],
		},
	},
	{
		name: 'memory_supersede',
		description: 'Replace an existing document with a new one — old doc gets status=superseded, new doc is created (requires UM_MCP_WRITE_ENABLED=true)',
		inputSchema: {
			type: 'object',
			properties: {
				old_id: { type: 'string', description: 'ID of the document to supersede' },
				new_doc: {
					type: 'object',
					description: 'New document to create',
					properties: {
						type: { type: 'string' },
						id: { type: 'string', description: 'New document ID (filename stem)' },
						title: { type: 'string' },
						content: { type: 'string', description: 'Markdown body of the new document' },
						project: { type: 'string' },
					},
					required: ['type', 'id', 'title', 'content'],
				},
			},
			required: ['old_id', 'new_doc'],
		},
	},
];

// ---------------------------------------------------------------------------
// Write-gating helper
// ---------------------------------------------------------------------------

function mcpWriteEnabled() {
	return process.env.UM_MCP_WRITE_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// Internal reindex helper (POST /api/reindex equivalent, called server-side)
// ---------------------------------------------------------------------------

async function reindexDoc(relPath) {
	const fileText = await readVaultFile(relPath);
	const { frontmatter: fm, body } = parseFrontmatter(fileText);
	if (!fm.type || !fm.id || !fm.title) {
		const missing = ['type', 'id', 'title'].filter((k) => !fm[k]);
		throw new Error(`Missing required frontmatter fields: ${missing.join(', ')}`);
	}
	const targetId = fm.id;
	const allMemories = await memory.getAll({ userId: USER_ID });
	const allItems = allMemories?.results || allMemories || [];
	const existingItems = allItems.filter((r) => (r.metadata || {}).id === targetId);
	for (const item of existingItems) {
		await memory.delete(item.id);
	}
	const metadata = { schema_version: 1, ...fm };
	const docText = `${fm.title}\n\n${body.trim()}`;
	await memory.add(docText, { userId: USER_ID, metadata, infer: false });
	return { ok: true, path: relPath, id: targetId, indexed: true };
}

// ---------------------------------------------------------------------------
// handleToolCall
// ---------------------------------------------------------------------------

async function handleToolCall(name, args) {
	switch (name) {
		// ── Original 4 tools ──────────────────────────────────────────────────
		case 'memory_search': {
			const limit = args.limit || 5;
			const includeSup = args.include_superseded === true;
			const searchResult = await doSearch(args.query, limit, includeSup);
			let items = searchResult.results;

			// Apply optional metadata filters (project, type)
			if (args.filters) {
				if (args.filters.project) {
					items = items.filter((r) => (r.metadata || {}).project === args.filters.project);
				}
				if (args.filters.type) {
					items = items.filter((r) => (r.metadata || {}).type === args.filters.type);
				}
			}

			return JSON.stringify({ results: items });
		}
		case 'memory_add': {
			const result = await memory.add(args.text, { userId: USER_ID, ...(args.metadata && { metadata: args.metadata }) });
			const events = result?.results?.map((r) => `[${r.event || r.metadata?.event}] ${r.memory}`).join('; ') || 'Stored.';
			return events;
		}
		case 'memory_list': {
			const all = await memory.getAll({ userId: USER_ID });
			const items = all?.results || all || [];
			return items.map((r) => `- ${r.memory} (id: ${r.id})`).join('\n') || 'No memories.';
		}
		case 'memory_delete': {
			await memory.delete(args.memoryId);
			return `Deleted ${args.memoryId}`;
		}

		// ── Task 10: 6 new tools ──────────────────────────────────────────────
		case 'memory_state': {
			const project = args.project;
			if (!project || !/^[a-zA-Z0-9._-]+$/.test(project)) {
				throw new Error('Invalid project name: must match ^[a-zA-Z0-9._-]+$');
			}
			const relPath = `state/${project}/state.md`;
			let fileText;
			try {
				fileText = await readVaultFile(relPath);
			} catch (err) {
				if (err.code === 'ENOENT') {
					return JSON.stringify({ ok: true, project, state: null, valid_from: null });
				}
				throw err;
			}
			const { frontmatter, body } = parseFrontmatter(fileText);
			const validFrom = frontmatter.valid_from || null;
			return JSON.stringify({ ok: true, project, state: { frontmatter, body }, valid_from: validFrom });
		}

		case 'memory_recent': {
			const limit = args.limit || 5;
			// Search using a broad session-summary query, then filter by type
			const searchResult = await doSearch('session_summary', limit * 3, false);
			let items = searchResult.results.filter((r) => (r.metadata || {}).type === 'session_summary');
			// Sort by valid_from descending (most recent first)
			items.sort((a, b) => {
				const ta = new Date((a.metadata || {}).valid_from || 0).getTime();
				const tb = new Date((b.metadata || {}).valid_from || 0).getTime();
				return tb - ta;
			});
			// Apply project filter if provided
			if (args.project) {
				items = items.filter((r) => (r.metadata || {}).project === args.project);
			}
			items = items.slice(0, limit);
			return JSON.stringify({ results: items });
		}

		case 'memory_capture': {
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
			}
			const { content, metadata } = args;
			if (!metadata || !metadata.type || !metadata.id || !metadata.title) {
				throw new Error('metadata must include: type, id, title');
			}
			const project = metadata.project || 'default';
			const id = metadata.id;
			const relPath = `authored/${project}/${id}.md`;

			// Build document: frontmatter + body
			const fm = {
				schema_version: 1,
				status: 'current',
				valid_from: new Date().toISOString(),
				...metadata,
			};
			const docText = serializeFrontmatter(fm, `\n${content}`);

			await writeVaultFile(relPath, docText);
			console.log(`[mem0-mcp] memory_capture: wrote ${relPath}`);

			// Reindex
			let indexed = false;
			try {
				await reindexDoc(relPath);
				indexed = true;
			} catch (err) {
				console.error(`[mem0-mcp] memory_capture: reindex failed: ${err.message}`);
			}

			return JSON.stringify({ ok: true, path: relPath, id, indexed });
		}

		case 'memory_checkpoint': {
			// STUB — wires in with Phase C Task 15/21 (session-end.sh integration)
			return JSON.stringify({
				ok: false,
				error: 'memory_checkpoint not yet implemented; use /um-checkpoint slash command or wait for Phase C Task 15/21',
			});
		}

		case 'memory_forget': {
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
			}
			const { id } = args;
			if (!id) throw new Error('id is required');

			const relPath = await findDocByIdInVault(id);
			if (!relPath) throw new Error(`Document not found in vault: ${id}`);

			// Read + parse
			const fileText = await readVaultFile(relPath);
			const { frontmatter: fm, body } = parseFrontmatter(fileText);

			// Mutate frontmatter
			fm.status = 'deprecated';
			fm.invalidated_at = new Date().toISOString();

			// Write back atomically
			const updated = serializeFrontmatter(fm, body);
			await writeVaultFile(relPath, updated);
			console.log(`[mem0-mcp] memory_forget: deprecated ${relPath}`);

			// Reindex so mem0 sees the updated status
			try {
				await reindexDoc(relPath);
			} catch (err) {
				console.error(`[mem0-mcp] memory_forget: reindex failed: ${err.message}`);
			}

			return JSON.stringify({ ok: true, id, path: relPath, status: 'deprecated' });
		}

		case 'memory_supersede': {
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
			}
			const { old_id, new_doc } = args;
			if (!old_id) throw new Error('old_id is required');
			if (!new_doc || !new_doc.type || !new_doc.id || !new_doc.title || !new_doc.content) {
				throw new Error('new_doc must include: type, id, title, content');
			}

			// 1. Find old doc
			const oldRelPath = await findDocByIdInVault(old_id);
			if (!oldRelPath) throw new Error(`Document not found in vault: ${old_id}`);

			const newId = new_doc.id;
			const newProject = new_doc.project || 'default';
			const newRelPath = `authored/${newProject}/${newId}.md`;
			const now = new Date().toISOString();

			// 2. Create new doc
			const newFm = {
				schema_version: 1,
				status: 'current',
				valid_from: now,
				...new_doc,
				supersedes: [old_id],
			};
			// Remove content from frontmatter — it belongs in the body
			const newContent = new_doc.content;
			delete newFm.content;
			const newDocText = serializeFrontmatter(newFm, `\n${newContent}`);
			await writeVaultFile(newRelPath, newDocText);
			console.log(`[mem0-mcp] memory_supersede: created new doc ${newRelPath}`);

			// 3. Mutate old doc frontmatter
			const oldFileText = await readVaultFile(oldRelPath);
			const { frontmatter: oldFm, body: oldBody } = parseFrontmatter(oldFileText);
			oldFm.status = 'superseded';
			oldFm.superseded_by = newId;
			oldFm.invalidated_at = now;
			const updatedOld = serializeFrontmatter(oldFm, oldBody);
			await writeVaultFile(oldRelPath, updatedOld);
			console.log(`[mem0-mcp] memory_supersede: superseded old doc ${oldRelPath}`);

			// 4. Reindex both
			let newIndexed = false;
			let oldIndexed = false;
			try {
				await reindexDoc(newRelPath);
				newIndexed = true;
			} catch (err) {
				console.error(`[mem0-mcp] memory_supersede: new doc reindex failed: ${err.message}`);
			}
			try {
				await reindexDoc(oldRelPath);
				oldIndexed = true;
			} catch (err) {
				console.error(`[mem0-mcp] memory_supersede: old doc reindex failed: ${err.message}`);
			}

			return JSON.stringify({
				ok: true,
				old_id,
				new_id: newId,
				old_status: 'superseded',
				new_status: 'current',
				indexed: { old: oldIndexed, new: newIndexed },
			});
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

function handleMcpMessage(msg) {
	const { id, method, params } = msg;
	if (method === 'initialize') {
		return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'universal-memory', version: '0.1.0' }, capabilities: { tools: {} } } };
	} else if (method === 'notifications/initialized') {
		return null;
	} else if (method === 'tools/list') {
		return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
	} else if (method === 'tools/call') {
		return handleToolCall(params.name, params.arguments || {})
			.then((text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }))
			.catch((err) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } }));
	} else if (id !== undefined) {
		return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
	}
	return null;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/**
 * Shared search handler — called by both POST and GET /api/search.
 * Returns { results: [...] }.
 * Default filter excludes superseded/deprecated/rejected docs and docs with
 * invalidated_at set. Pass includeSuperseded=true to skip all filtering.
 */
async function doSearch(query, limit, includeSuperseded) {
	const raw = await memory.search(query, { userId: USER_ID, limit: limit || 5 });
	let items = raw?.results || raw || [];
	if (!includeSuperseded) {
		items = items.filter((r) => {
			const md = r.metadata || {};
			const excluded =
				md.status === 'superseded' ||
				md.status === 'deprecated' ||
				md.status === 'rejected' ||
				(md.invalidated_at != null);
			return !excluded;
		});
	}
	// Optional temporal decay re-ranking (off by default).
	// Set UM_TEMPORAL_DECAY=true to enable; UM_DECAY_HALF_LIFE_DAYS controls
	// the decay rate (default: 30 days). Applied after status filter so only
	// allowed results are re-ranked.
	if (process.env.UM_TEMPORAL_DECAY === 'true') {
		const halfLife = parseInt(process.env.UM_DECAY_HALF_LIFE_DAYS || '30', 10) || 30;
		items = applyTemporalDecay(items, halfLife);
	}
	return { results: items };
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.writeHead(200);
		res.end();
		return;
	}

	try {
		if (url.pathname === '/health' && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, memories: (await memory.getAll({ userId: USER_ID }))?.results?.length || 0 }));
			return;
		}
		if (url.pathname === '/mcp' && req.method === 'POST') {
			const body = JSON.parse(await readBody(req));
			const result = await handleMcpMessage(body);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(result ? JSON.stringify(result) : '');
			return;
		}
		if (url.pathname === '/api/search' && req.method === 'POST') {
			const { query, limit = 5, include_superseded = false } = JSON.parse(await readBody(req));
			if (!query || typeof query !== 'string' || !query.trim()) {
				res.writeHead(400, {'Content-Type': 'application/json'});
				res.end(JSON.stringify({error: 'query is required'}));
				return;
			}
			const includeSup = include_superseded === true;
			const rawLimitPost = typeof limit === 'number' ? limit : parseInt(limit, 10);
			const clampedLimitPost = Number.isFinite(rawLimitPost) && rawLimitPost > 0 ? Math.min(rawLimitPost, 100) : 5;
			const response = await doSearch(query, clampedLimitPost, includeSup);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
			return;
		}
		if (url.pathname === '/api/search' && req.method === 'GET') {
			const q = url.searchParams.get('q') || '';
			const rawLimit = parseInt(url.searchParams.get('limit') || '5', 10);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 5;
			const includeSuperseded = url.searchParams.get('include_superseded') === 'true';
			if (!q) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'q parameter is required' }));
				return;
			}
			const response = await doSearch(q, limit, includeSuperseded);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
			return;
		}
		if (url.pathname === '/api/add' && req.method === 'POST') {
			const { text, metadata } = JSON.parse(await readBody(req));
			const result = await memory.add(text, { userId: USER_ID, ...(metadata && { metadata }) });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(result));
			return;
		}
		if (url.pathname === '/api/list' && req.method === 'GET') {
			const all = await memory.getAll({ userId: USER_ID });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(all?.results || all || []));
			return;
		}
		// GET /api/state/:project — direct file read, does NOT touch mem0
		if (url.pathname.startsWith('/api/state/') && req.method === 'GET') {
			const projectSegment = url.pathname.slice('/api/state/'.length);
			// Reject empty or multi-segment paths (no nested slashes allowed)
			if (!projectSegment || !/^[a-zA-Z0-9._-]+$/.test(projectSegment)) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid project name: must match ^[a-zA-Z0-9._-]+$' }));
				return;
			}
			const relPath = `state/${projectSegment}/state.md`;
			let fileText;
			try {
				fileText = await readVaultFile(relPath);
			} catch (err) {
				if (err.code === 'ENOENT') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, project: projectSegment, state: null, valid_from: null }));
					return;
				}
				throw err;
			}
			const { frontmatter, body } = parseFrontmatter(fileText);
			const validFrom = frontmatter.valid_from || null;
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, project: projectSegment, state: { frontmatter, body }, valid_from: validFrom }));
			return;
		}
		if (url.pathname === '/api/reindex' && req.method === 'POST') {
			let reqBody;
			try {
				reqBody = JSON.parse(await readBody(req));
			} catch {
				res.writeHead(400, {'Content-Type': 'application/json'});
				res.end(JSON.stringify({error: 'invalid JSON body'}));
				return;
			}
			const { path: relPath } = reqBody;

			// 1. path present
			if (!relPath || typeof relPath !== 'string' || !relPath.trim()) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'path is required' }));
				return;
			}

			// 2. read file (throws on traversal or ENOENT)
			let fileText;
			try {
				fileText = await readVaultFile(relPath);
			} catch (err) {
				if (err.code === 'ENOENT') {
					res.writeHead(404, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: `File not found: ${relPath}` }));
					return;
				}
				if (err.message && err.message.includes('traversal')) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: `Path traversal detected: ${relPath}` }));
					return;
				}
				throw err;
			}

			// 3. parse once, destructure both frontmatter and body
			const { frontmatter: fm, body } = parseFrontmatter(fileText);

			// 4. required fields
			if (!fm.type || !fm.id || !fm.title) {
				const missing = ['type', 'id', 'title'].filter((k) => !fm[k]);
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: `Missing required frontmatter fields: ${missing.join(', ')}` }));
				return;
			}

			// 5. state type rejected
			if (fm.type === 'state') {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'state.md is never reindexed — use /api/state (Task 10)' }));
				return;
			}

			// 6. filename stem must match metadata.id
			const stem = path.basename(relPath, '.md');
			if (stem !== fm.id) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: `id mismatch: frontmatter id "${fm.id}" does not match filename stem "${stem}"` }));
				return;
			}

			// 7. upsert: delete all existing entries with this metadata.id, then add
			const targetId = fm.id;
			// TODO(v0.3): O(N) full-user scan. Replace with metadata-filtered query when mem0 OSS supports it.
			const allMemories = await memory.getAll({ userId: USER_ID });
			const allItems = allMemories?.results || allMemories || [];
			const existingItems = allItems.filter((r) => (r.metadata || {}).id === targetId);
			// TODO(v0.3): no mutex on delete+add — concurrent reindex for same id may produce duplicates. Acceptable at current single-user CLI-driven scale.
			for (const item of existingItems) {
				await memory.delete(item.id);
			}

			// 8. build metadata from frontmatter (schema_version defaults to 1 if absent)
			const metadata = {
				schema_version: 1,
				...fm,
			};

			// Compose a meaningful text to add to mem0 (title + body excerpt)
			const docText = `${fm.title}\n\n${body.trim()}`;
			// infer: false preserves full document text; skipping mem0's LLM extraction which would summarize/split into atomic facts.
			await memory.add(docText, { userId: USER_ID, metadata, infer: false });

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, path: relPath, id: targetId, indexed: true }));
			return;
		}
		if (url.pathname.startsWith('/api/') && req.method === 'DELETE') {
			const id = url.pathname.split('/api/')[1];
			await memory.delete(id);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ deleted: id }));
			return;
		}
		res.writeHead(404);
		res.end('Not Found');
	} catch (err) {
		console.error('[mem0-mcp] Error:', err.message);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: err.message }));
	}
});

await initMemory();
server.listen(PORT, '0.0.0.0', () => {
	console.log(`[mem0-mcp] HTTP server listening on 0.0.0.0:${PORT}`);
	console.log('[mem0-mcp] Endpoints: /health, /mcp (JSON-RPC), /api/*');
});
