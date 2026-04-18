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
 *   DELETE /api/:id           remove a memory
 *   POST /api/reindex         { path } -> read vault file, upsert to mem0 with frontmatter metadata
 *
 * Required env: OPENAI_API_KEY, MEM0_USER_ID
 * Optional env: MEM0_MCP_PORT (default 6335), QDRANT_HOST, QDRANT_PORT,
 *               QDRANT_COLLECTION, MEM0_EMBEDDER_MODEL, MEM0_LLM_MODEL
 *
 * Search filter (default, disable with include_superseded=true):
 *   Excludes docs where status === 'superseded'|'deprecated'|'rejected'
 *   or invalidated_at is non-null. Legacy docs with no metadata are treated
 *   as current. Note: limit is applied before filtering, so callers may
 *   receive fewer results than requested when some are excluded.
 */

import { createServer } from 'http';
import path from 'node:path';
import { Memory } from 'mem0ai/oss';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { readVaultFile } from './lib/vault.mjs';

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
	{ name: 'memory_search', description: 'Search memories by semantic similarity', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
	{ name: 'memory_add', description: 'Add a fact to long-term memory', inputSchema: { type: 'object', properties: { text: { type: 'string' }, metadata: { type: 'object', description: 'Optional key-value metadata to attach to the memory' } }, required: ['text'] } },
	{ name: 'memory_list', description: 'List all stored memories', inputSchema: { type: 'object', properties: {} } },
	{ name: 'memory_delete', description: 'Delete a memory by ID', inputSchema: { type: 'object', properties: { memoryId: { type: 'string' } }, required: ['memoryId'] } },
];

async function handleToolCall(name, args) {
	switch (name) {
		case 'memory_search': {
			const results = await memory.search(args.query, { userId: USER_ID, limit: args.limit || 5 });
			const items = results?.results || results || [];
			return items.map((r) => {
				const pct = r.score != null ? (r.score * 100).toFixed(0) : '--';
				return `[${pct}%] ${r.memory} (id: ${r.id})`;
			}).join('\n') || 'No results found.';
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
