#!/usr/bin/env node
/**
 * universal-memory server — HTTP + MCP wrapper around mem0 OSS.
 *
 * Endpoints:
 *   GET  /health              liveness + memory count
 *   GET  /openapi.yaml        OpenAPI 3.1 spec for this server (YAML)
 *   POST /mcp                 JSON-RPC (MCP clients)
 *   POST /api/search          { query, limit?, include_superseded? } -> { results: [...] }
 *   GET  /api/search          ?q=...&limit=5&include_superseded=true -> { results: [...] }
 *   POST /api/add             { text } -> mem0 extraction + store
 *   GET  /api/list            all memories for MEM0_USER_ID
 *   GET  /api/recent/:project recent authored docs by mtime desc, compact shape (no mem0)
 *   GET  /api/state/:project  read $VAULT/state/<project>/state.md directly (no mem0)
 *   DELETE /api/:id           remove a memory (by mem0 UUID via URL param)
 *   POST /api/delete          { metadata: { id } } or { id: <uuid> } -> delete by metadata.id or UUID
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
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Memory } from 'mem0ai/oss';
import { parseFrontmatter, serializeFrontmatter } from './lib/frontmatter.mjs';
import { readVaultFile, vaultPath, listVaultFiles, statVaultFile } from './lib/vault.mjs';
import { applyTemporalDecay } from './lib/ranking.mjs';
import { writeVaultFile, findDocByIdInVault } from './lib/vault-write.mjs';
import { doAppendTurn } from './lib/append-turn.mjs';
import { doCheckpoint } from './lib/checkpoint.mjs';
import { generateOpenAPISpec, generateCustomGPTActionsSpec } from './openapi.mjs';

// ---------------------------------------------------------------------------
// Snippet design fixture — single source of truth for compact-shape N.
// Lives in server/config/ so it survives the Docker build (test/ is excluded
// by .dockerignore; config/ is COPY'd by the Dockerfile).
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _SNIPPET_DESIGN = JSON.parse(readFileSync(
  path.resolve(__dirname, 'config/snippet-design.json'),
  'utf8'
));
const SNIPPET_N = _SNIPPET_DESIGN.snippet.N;      // 240
const SNIPPET_ELLIPSIS = _SNIPPET_DESIGN.snippet.ellipsis;  // "…"

/**
 * Build a compact snippet: title + " — " + first SNIPPET_N code points of body (+ ellipsis).
 * Uses [...str] (code-point-aware iteration) rather than slice(0, N) which operates on
 * UTF-16 code units and can split a surrogate pair at the boundary.
 * Shared by doRecent and doSearch so snippet format is guaranteed identical.
 *
 * Title fallback convention (matches doRecent): if title is empty/null, returns only the excerpt.
 *
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function buildSnippet(title, body) {
  const trimmedBody = (body || '').trim();
  const codePoints = [...trimmedBody];
  const bodyExcerpt = codePoints.length > SNIPPET_N
    ? codePoints.slice(0, SNIPPET_N).join('') + SNIPPET_ELLIPSIS
    : trimmedBody;
  return title ? `${title} — ${bodyExcerpt}` : bodyExcerpt;
}

// True when this module is the entry point (invoked via `node mem0-mcp-http.mjs`
// or the Docker CMD), false when imported by tests. Gates the bootstrap block
// at the bottom of the file so test imports don't start a real server.
const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Slug validation — C1: id/project fields used as filename components must be safe
// ---------------------------------------------------------------------------

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Throws if value is not a string matching SAFE_NAME_RE.
 * @param {string} field  - Human-readable field name for error messages
 * @param {string} value  - The value to validate
 */
function validateSafeName(field, value) {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
    throw new Error(`${field} must match ${SAFE_NAME_RE.source}`);
  }
}

function requireEnv(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`[mem0-mcp] FATAL: ${name} is required`);
		process.exit(1);
	}
	return v;
}

const PORT = parseInt(process.env.MEM0_MCP_PORT || '6335', 10);
// When run as main, env vars must be set — fail fast. When imported for tests,
// fall back to harmless defaults so the module loads (tests don't hit initMemory
// and provide their own memoryClient mocks).
const USER_ID = IS_MAIN ? requireEnv('MEM0_USER_ID') : (process.env.MEM0_USER_ID || 'test-user');
if (IS_MAIN) requireEnv('OPENAI_API_KEY');

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

export const TOOLS = [
	// ── Original 4 tools ────────────────────────────────────────────────────
	{
		name: 'memory_search',
		description: 'Semantic search with optional status/metadata filters. Returns compact shape (id, title, score, snippet) by default; pass full=true for full body.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Semantic search query' },
				limit: { type: 'number', description: 'Max results (default 5, max 100)' },
				include_superseded: { type: 'boolean', description: 'Include superseded/deprecated/rejected docs' },
				filters: {
					type: 'object',
					description: 'Metadata filters',
					properties: {
						project: { type: 'string', description: 'Filter by project' },
						type: { type: 'string', description: 'Filter by doc type (e.g. session_summary)' },
					},
				},
				full: { type: 'boolean', description: 'Return full bodies instead of compact shape', default: false },
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
		description: 'List all stored memories. Returns compact shape (id, title, snippet) by default; pass full=true for full bodies.',
		inputSchema: {
			type: 'object',
			properties: {
				full: { type: 'boolean', description: 'Return full bodies instead of compact shape', default: false },
				limit: { type: 'number', description: 'Max results to return (default: unlimited, max 1000)' },
			},
		},
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
		description: 'Fetch recent authored documents for a project by filesystem mtime (not from mem0). Returns compact shape (id, title, snippet) by default; pass full=true for full body.',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project name (must match ^[a-zA-Z0-9._-]+$)' },
				limit: { type: 'number', description: 'Max results (default 10)' },
				full: { type: 'boolean', description: 'Return full bodies instead of compact shape', default: false },
			},
			required: ['project'],
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
		description: 'Force a session summary + state update (server-side stub — currently delegates to `/um-checkpoint` slash command in Claude Code)',
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
	// ── v0.5: append-turn tool ────────────────────────────────────────────────
	{
		name: 'memory_append_turn',
		description: 'Write a raw conversation turn to the vault capture log for the given project. Appends to captures/<project>/raw/<date>.md and is consumed by the next session-end summary. Provides MCP parity with POST /api/append-turn. Requires UM_MCP_WRITE_ENABLED=true.',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string', description: 'Project name (must match ^[a-zA-Z0-9._-]+$)' },
				content: { type: 'string', description: 'Turn text content (markdown)', maxLength: 8192 },
				role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Role of the turn author' },
				timestamp: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp (defaults to now)' },
				conversation_id: { type: 'string', description: 'Optional conversation/session identifier' },
			},
			required: ['project', 'content', 'role'],
		},
	},
];

// ---------------------------------------------------------------------------
// Write-gating helpers
// ---------------------------------------------------------------------------

/**
 * Names of MCP tools that mutate state. Exported so tests can import the
 * canonical set without duplicating it.
 *
 * Filter logic: getVisibleTools() uses this set; TOOLS still holds all 10 so
 * the runtime can still execute write tools when UM_MCP_WRITE_ENABLED=true.
 */
export const WRITE_TOOL_NAMES = new Set([
	'memory_add', 'memory_delete', 'memory_capture',
	'memory_checkpoint', 'memory_forget', 'memory_supersede',
	'memory_append_turn',
]);

/**
 * Returns true if UM_MCP_WRITE_ENABLED is set to 'true' or '1'.
 * Unset, 'false', '0', or any other value → false (writes disabled).
 */
export function isWriteEnabled() {
	const v = process.env.UM_MCP_WRITE_ENABLED;
	return v === 'true' || v === '1';
}

/**
 * Returns the tools visible to MCP clients given the current write-enabled state.
 * When writeEnabled is true (or omitted and env var is true/1), all 10 tools are returned.
 * When false (default when UM_MCP_WRITE_ENABLED is unset), write tools are filtered out.
 *
 * @param {boolean} [writeEnabled] — if omitted, reads process.env.UM_MCP_WRITE_ENABLED
 * @returns {Array} subset of TOOLS
 */
export function getVisibleTools(writeEnabled) {
	const enabled = writeEnabled !== undefined ? writeEnabled : isWriteEnabled();
	if (enabled) return TOOLS;
	return TOOLS.filter(t => !WRITE_TOOL_NAMES.has(t.name));
}

/** @deprecated Use isWriteEnabled() instead */
function mcpWriteEnabled() {
	return isWriteEnabled();
}

// ---------------------------------------------------------------------------
// Shared helper: delete all mem0 entries matching a metadata.id value
// Returns the count of deleted entries.
// ---------------------------------------------------------------------------

async function deleteByMetadataId(targetId) {
	// TODO(v0.3): O(N) full-user scan. Replace with metadata-filtered query when mem0 OSS supports it.
	const allMemories = await memory.getAll({ userId: USER_ID });
	const allItems = allMemories?.results || allMemories || [];
	const existingItems = allItems.filter((r) => (r.metadata || {}).id === targetId);
	for (const item of existingItems) {
		await memory.delete(item.id);
	}
	return existingItems.length;
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
	// C2: state.md documents must never be indexed into mem0 (they are served
	// directly via /api/state and the memory_state MCP tool).
	if (fm.type === 'state') {
		throw new Error('state.md documents must not be indexed into mem0');
	}
	const targetId = fm.id;
	await deleteByMetadataId(targetId);
	const metadata = { schema_version: 1, ...fm };
	const docText = `${fm.title}\n\n${body.trim()}`;
	await memory.add(docText, { userId: USER_ID, metadata, infer: false });
	return { ok: true, path: relPath, id: targetId, indexed: true };
}

// ---------------------------------------------------------------------------
// handleToolCall
// ---------------------------------------------------------------------------

export async function handleToolCall(name, args) {
	switch (name) {
		// ── Original 4 tools ──────────────────────────────────────────────────
		case 'memory_search': {
			const limit = args.limit || 5;
			const includeSup = args.include_superseded === true;
			const clientFull = args.full === true;
			// Always call doSearch(full=true) internally so metadata is preserved for
			// post-filtering (project, type). Then project to compact shape at the end
			// unless the MCP client explicitly requested full bodies (args.full=true).
			const searchResult = await doSearch(args.query, limit, includeSup, true);
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

			// Project to compact shape unless client requested full bodies.
			if (!clientFull) {
				items = items.map((r) => ({
					id: r.id,
					title: r.title,
					score: r.score,
					snippet: buildSnippet(r.title, r.body),
				}));
			}

			return JSON.stringify({ results: items });
		}
		case 'memory_add': {
			if (!isWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env' });
			}
			const result = await memory.add(args.text, { userId: USER_ID, ...(args.metadata && { metadata: args.metadata }) });
			const events = result?.results?.map((r) => `[${r.event || r.metadata?.event}] ${r.memory}`).join('; ') || 'Stored.';
			return events;
		}
		case 'memory_list': {
			const clientFull = args.full === true;
			const listLimit = args.limit != null ? Math.min(parseInt(args.limit, 10) || 0, 1000) : null;
			// Delegate to doList which handles compact/full projection.
			// When full=true: raw mem0 items (backward compat shape) serialized as JSON.
			// When full=false (default): compact { id, title, snippet } items.
			const items = await doList(clientFull, listLimit);
			if (items.length === 0) return 'No memories.';
			if (clientFull) {
				// Full shape: return as JSON so body/metadata fields are accessible
				return JSON.stringify(items);
			}
			// Compact shape: human-readable text format consistent with prior MCP behavior
			return items.map((r) => `- ${r.snippet} (id: ${r.id})`).join('\n');
		}
		case 'memory_delete': {
			if (!isWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env' });
			}
			await memory.delete(args.memoryId);
			return `Deleted ${args.memoryId}`;
		}

		// ── Task 10: 6 new tools ──────────────────────────────────────────────
		case 'memory_state': {
			// Delegates to extracted doState() for DI testability (B.1.4b Step 0a).
			// doState validates the project name and throws on invalid input.
			return await doState(args.project);
		}

		case 'memory_recent': {
			// CRITICAL-2 fix: delegate to doRecent (filesystem, mtime-sorted) to match
			// REST /api/recent/:project semantics. Previous impl called doSearch (mem0
			// vector-store) which is a different data source and different ordering.
			// BREAKING CHANGE (v0.4 alpha): project is now required (was optional).
			const project = args.project;
			const limit = args.limit ?? 10;
			const full = args.full === true;
			const result = await doRecent(project, limit, full);
			return JSON.stringify(result);
		}

		case 'memory_capture': {
			const { content, metadata } = args;
			if (!metadata || !metadata.type || !metadata.id || !metadata.title) {
				throw new Error('metadata must include: type, id, title');
			}
			// C1: validate filename-path components before any path construction
			validateSafeName('metadata.id', metadata.id);
			if (metadata.project != null) validateSafeName('metadata.project', metadata.project);
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
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
			if (!isWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env' });
			}
			return JSON.stringify(await doCheckpoint(args, { vaultDir: process.env.UM_VAULT_DIR, reindexFn: reindexDoc }));
		}

		case 'memory_forget': {
			const { id } = args;
			if (!id) throw new Error('id is required');
			// C1: validate id before using as path component
			validateSafeName('id', id);
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
			}

			const relPath = await findDocByIdInVault(id);
			if (!relPath) throw new Error(`Document not found in vault: ${id}`);

			// Read + parse
			const fileText = await readVaultFile(relPath);
			const { frontmatter: fm, body } = parseFrontmatter(fileText);

			// I3: idempotency — if already deprecated, return early without overwriting invalidated_at
			if (fm.status === 'deprecated' && fm.invalidated_at) {
				return JSON.stringify({ ok: true, id, path: relPath, status: 'deprecated', already_deprecated: true });
			}

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
			const { old_id, new_doc } = args;
			if (!old_id) throw new Error('old_id is required');
			if (!new_doc || !new_doc.type || !new_doc.id || !new_doc.title || !new_doc.content) {
				throw new Error('new_doc must include: type, id, title, content');
			}
			// C1: validate all filename-path components before any path construction
			validateSafeName('old_id', old_id);
			validateSafeName('new_doc.id', new_doc.id);
			if (new_doc.project != null) validateSafeName('new_doc.project', new_doc.project);
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
			}

			// 1. Find old doc
			const oldRelPath = await findDocByIdInVault(old_id);
			if (!oldRelPath) throw new Error(`Document not found in vault: ${old_id}`);

			const newId = new_doc.id;
			const newProject = new_doc.project || 'default';
			const newRelPath = `authored/${newProject}/${newId}.md`;
			const now = new Date().toISOString();

			// C1: guard against self-supersede (old and new resolve to the same path)
			if (oldRelPath === newRelPath) {
				throw new Error('old_id and new_doc resolve to the same path; cannot supersede a doc with itself');
			}

			// C1: guard against clobbering an existing unrelated doc at the new path
			try {
				await fs.access(path.join(vaultPath(), newRelPath));
				// If we get here, the file exists — this is a collision
				throw new Error(`new_doc target path already exists: ${newRelPath}`);
			} catch (e) {
				if (e.code === 'ENOENT') {
					// Expected: new path does not exist yet — safe to proceed
				} else if (e.message && e.message.startsWith('new_doc target path already exists')) {
					throw e;
				} else {
					throw e;
				}
			}

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
			// I1: if the old-doc mutation fails, roll back the new doc we just wrote
			// to avoid leaving the vault in an inconsistent state (two current docs,
			// no supersedes linkage on the old doc).
			try {
				const oldFileText = await readVaultFile(oldRelPath);
				const { frontmatter: oldFm, body: oldBody } = parseFrontmatter(oldFileText);
				oldFm.status = 'superseded';
				oldFm.superseded_by = newId;
				oldFm.invalidated_at = now;
				const updatedOld = serializeFrontmatter(oldFm, oldBody);
				await writeVaultFile(oldRelPath, updatedOld);
				console.log(`[mem0-mcp] memory_supersede: superseded old doc ${oldRelPath}`);
			} catch (err) {
				// Rollback: remove the new doc we wrote in step 2 (best-effort)
				try { await fs.unlink(path.join(vaultPath(), newRelPath)); } catch {}
				throw err;
			}

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

		case 'memory_append_turn': {
			if (!mcpWriteEnabled()) {
				return JSON.stringify({ ok: false, error: 'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env' });
			}
			const result = await doAppendTurn(args, { vaultDir: process.env.UM_VAULT_DIR });
			return JSON.stringify(result);
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

function handleMcpMessage(msg) {
	const { id, method, params } = msg;
	if (method === 'initialize') {
		return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'universal-memory', version: '0.5.0-alpha' }, capabilities: { tools: {} } } };
	} else if (method === 'notifications/initialized') {
		return null;
	} else if (method === 'tools/list') {
		return { jsonrpc: '2.0', id, result: { tools: getVisibleTools() } };
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
 * Exported handler for POST /api/append-turn.
 * Accepts a pre-parsed body via req.body (unit-test friendly).
 * @param {{ body: { project, content, role, timestamp?, conversation_id? } }} req
 * @param {{ status(code): this, json(obj): this }} res
 * @param {{ vaultDir?: string, writesEnabled: boolean }} ctx
 */
export async function handleAppendTurnRequest(req, res, ctx) {
	if (!ctx.writesEnabled) {
		res.status(403).json({ ok: false, error: 'MCP writes disabled' });
		return;
	}
	const { project, content, role, timestamp, conversation_id } = req.body || {};
	const result = await doAppendTurn(
		{ project, content, role, timestamp, conversation_id },
		{ vaultDir: ctx.vaultDir },
	);
	if (!result.ok) {
		res.status(400).json(result);
		return;
	}
	res.status(200).json(result);
}

/**
 * Exported handler for POST /api/checkpoint.
 * Accepts a pre-parsed body via req.body (unit-test friendly).
 * Supports DI of _doCheckpoint for testing without a real vault/LLM.
 * @param {{ body: { project?, since?, until?, skip_state_merge? } }} req
 * @param {{ status(code): this, json(obj): this }} res
 * @param {{ vaultDir?: string, writesEnabled: boolean, _doCheckpoint?: Function }} ctx
 */
export async function handleCheckpointRequest(req, res, ctx) {
	if (!ctx.writesEnabled) {
		res.status(403).json({ ok: false, error: 'MCP writes disabled' });
		return;
	}
	const { project, since, until, skip_state_merge } = req.body || {};
	const checkpointFn = ctx._doCheckpoint ?? doCheckpoint;
	const result = await checkpointFn(
		{ project, since, until, skip_state_merge },
		{ vaultDir: ctx.vaultDir ?? process.env.UM_VAULT_DIR, reindexFn: ctx._reindexFn ?? reindexDoc },
	);
	if (!result.ok) {
		res.status(400).json(result);
		return;
	}
	res.status(200).json(result);
}

/**
 * Shared search handler — called by both POST and GET /api/search.
 * Returns { results: [...] }.
 * Default filter excludes superseded/deprecated/rejected docs and docs with
 * invalidated_at set. Pass includeSuperseded=true to skip all filtering.
 */
/**
 * Run a search against the vector store with optional status-filter + decay re-rank.
 *
 * Extracted as an exported function (rather than inlined in the route handler)
 * so `server/test/decay-integration.test.mjs` can exercise the decay wiring
 * with a mocked memory client — without spinning up a full server + container.
 *
 * Compact shape (full=false, default): { id, title, score, snippet }
 *   - id   = metadata.id (filename stem, NOT mem0 UUID — spec §5.2.1)
 *   - title fallback: metadata.id if title absent (matches doRecent convention)
 *   - snippet = buildSnippet(title, memory body)
 * Full shape (full=true): compact shape + { body } (raw memory text)
 *
 * @param {string} query
 * @param {number} limit
 * @param {boolean} includeSuperseded
 * @param {boolean} [full=false] — false → compact shape; true → add body field
 * @param {{search: Function}} [memoryClient] — dependency injection for tests;
 *   defaults to the module-level `memory` binding used by real requests.
 */
export async function doSearch(query, limit, includeSuperseded, full = false, memoryClient = memory) {
	const raw = await memoryClient.search(query, { userId: USER_ID, limit: limit || 5 });
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
	// Project to compact or full shape.
	// - id:    metadata.id (filename stem, NOT mem0 UUID — spec §5.2.1)
	// - title: metadata.title if present; falls back to metadata.id (matches doRecent convention)
	// - score: from mem0 result (may be decay-adjusted above)
	// - compact (full=false): { id, title, score, snippet } — snippet via buildSnippet()
	// - full   (full=true):   { id, title, score, body, metadata } — body = raw memory text;
	//                         metadata preserved for internal callers (MCP handlers) that
	//                         post-filter on metadata.type / metadata.project / metadata.valid_from.
	const mapped = items.map((r) => {
		const id = r.metadata?.id ?? r.id;
		const title = r.metadata?.title ?? r.metadata?.id ?? '(untitled)';
		const base = { id, title, score: r.score };
		if (full) {
			base.body = r.memory;
			base.metadata = r.metadata; // preserve for internal MCP callers that filter on metadata
		} else {
			base.snippet = buildSnippet(title, r.memory);
		}
		return base;
	});
	return { results: mapped };
}

// ---------------------------------------------------------------------------
// doState — extracted for DI testability (B.1.4b Step 0a)
// Called by both the MCP handler (memory_state) and the REST handler
// (GET /api/state/:project). Returns a JSON string for MCP parity; the REST
// handler writes the same string directly to the response body.
//
// Validation is defense-in-depth: doState throws on invalid project names.
// The REST handler ALSO keeps its own pre-validation that returns HTTP 400
// before doState runs, so REST never hits the throw path. Both checks pass the
// same regex — the duplication is intentional belt-and-suspenders.
// ---------------------------------------------------------------------------

/**
 * Fetch the state.md for a project and return it as a JSON string.
 * Returns { ok, project, state: { frontmatter, body }, valid_from } or
 * { ok, project, state: null, valid_from: null } when the file does not exist.
 *
 * @param {string} project - Project name (validated: ^[a-zA-Z0-9._-]+$)
 * @returns {Promise<string>} JSON string
 */
export async function doState(project) {
  if (!project || !/^[a-zA-Z0-9._-]+$/.test(project)) {
    throw new Error('Invalid project name: must match ^[a-zA-Z0-9._-]+$');
  }
  const relPath = `state/${project}/state.md`;
  try {
    const fileText = await readVaultFile(relPath);
    const { frontmatter, body } = parseFrontmatter(fileText);
    return JSON.stringify({
      ok: true,
      project,
      state: { frontmatter, body },
      valid_from: frontmatter.valid_from || null,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return JSON.stringify({ ok: true, project, state: null, valid_from: null });
    }
    // Transient I/O errors: log + treat as state-unavailable so callers can retry cleanly.
    // Whitelisted codes only — permission/config errors must bubble so ops can fix them.
    if (['EBUSY', 'ETXTBSY', 'EMFILE', 'ENFILE', 'EAGAIN'].includes(err.code)) {
      console.error('[mem0-mcp] doState transient I/O error:', relPath, err.message);
      return JSON.stringify({ ok: true, project, state: null, valid_from: null });
    }
    // Config/permission errors (EACCES, EPERM, etc.): bubble so ops can fix
    throw err;
  }
}

/**
 * List the most recently modified vault documents for a project.
 *
 * Reads from the vault filesystem (authored/<project>/*.md) and sorts by mtime
 * descending — the natural recency signal, no mem0 vector-store round-trip needed.
 *
 * Returns compact shape by default: { id, title, snippet }.
 * Pass full=true for { id, title, snippet, body }.
 * Snippet format: title + " — " + first SNIPPET_N chars of body (+ ellipsis if truncated).
 *
 * @param {string} project - Project name (validated: ^[a-zA-Z0-9._-]+$)
 * @param {number} [limit=10] - Max results to return
 * @param {boolean} [full=false] - Include body in response
 * @param {*} [_memoryClient] - Unused; accepted for DI signature parity with doSearch
 * @returns {Promise<{ results: Array<{id, title, snippet, body?}> }>}
 */
export async function doRecent(project, limit = 10, full = false, _memoryClient = memory) {
  if (!project || !/^[a-zA-Z0-9._-]+$/.test(project)) {
    throw new Error('Invalid project name: must match ^[a-zA-Z0-9._-]+$');
  }

  const subdir = `authored/${project}`;
  const relPaths = await listVaultFiles(subdir);

  if (relPaths.length === 0) {
    return { results: [] };
  }

  // Stat all files to get mtime, tolerating ENOENT (file deleted between list and stat).
  // Any other I/O error is logged and the file is dropped from results — one bad file
  // must not 500 the entire request (real race on Linux under concurrent vault writes).
  const withStatsRaw = await Promise.all(
    relPaths.map(async (relPath) => {
      try {
        const { mtime } = await statVaultFile(relPath);
        return { relPath, mtime };
      } catch (err) {
        if (err.code === 'ENOENT') return null; // deleted between list and stat — skip
        console.error('[mem0-mcp] doRecent: skipping stat for', relPath, err.message);
        return null;
      }
    })
  );
  const withStats = withStatsRaw.filter(Boolean);
  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Take top `limit` files and build the compact (or full) shape, tolerating ENOENT.
  const topFiles = withStats.slice(0, limit);
  const resultsRaw = await Promise.all(
    topFiles.map(async ({ relPath }) => {
      try {
        const fileText = await readVaultFile(relPath);
        const { frontmatter: fm, body } = parseFrontmatter(fileText);
        const stem = path.basename(relPath, '.md');
        const id = fm.id || stem;
        const title = fm.title || stem;

        // Compact snippet — delegate to shared buildSnippet() for consistent format.
        const snippet = buildSnippet(title, body);

        const record = { id, title, snippet };
        if (full) {
          record.body = body;
        }
        return record;
      } catch (err) {
        if (err.code === 'ENOENT') return null; // deleted between stat and read — skip
        console.error('[mem0-mcp] doRecent: skipping read for', relPath, err.message);
        return null;
      }
    })
  );
  const results = resultsRaw.filter(Boolean);

  return { results };
}

// ---------------------------------------------------------------------------
// doList — extracted for DI testability and compact-shape support (B.1.4b)
//
// Step 1 scope decision: option (b) — compact shape only, keep list scope as-is.
// Rationale: /api/list today is a vault listing (all memories for MEM0_USER_ID),
// not per-project filtered in the way /api/search is. Adding a project arg now
// would also require updating the MCP tool schema (B.1.5 territory) and changing
// existing listing semantics. Option (b) is minimal: doList(full=false) +
// compact-shape projection. If B.1.5 needs a project arg, decide there.
// ---------------------------------------------------------------------------

/**
 * List all stored memories for MEM0_USER_ID.
 *
 * Compact shape (full=false, default): { id, title, snippet }
 *   - id    = metadata.id (filename stem) if present, else mem0 UUID
 *   - title = metadata.title if present; falls back to metadata.id, then mem0 UUID
 *   - snippet = buildSnippet(title, memory body)
 * Full shape (full=true): raw mem0 result objects (backward compat with pre-B.1 callers)
 *
 * Returns a raw array (not an envelope) to preserve backward compatibility with
 * the existing /api/list contract — the current handler returns `all?.results || all || []`.
 * Changing to {results:[...]} would be a breaking API change beyond "compact shape" scope.
 *
 * @param {boolean} [full=false] - false → compact shape; true → raw mem0 items
 * @param {number|null} [limit=null] - max items to return; null = unlimited
 * @param {{getAll: Function}} [memoryClient] - DI for tests; defaults to module `memory`
 * @returns {Promise<Array>} flat array of memory items
 */
export async function doList(full = false, limit = null, memoryClient = memory) {
  const all = await memoryClient.getAll({ userId: USER_ID });
  const items = all?.results || all || [];
  const sliced = (limit !== null && limit > 0) ? items.slice(0, limit) : items;
  if (full) {
    return sliced;
  }
  // Compact projection — consistent shape with doSearch compact items (minus score,
  // which is search-specific). id and title use the same fallback logic as doSearch.
  return sliced.map((r) => {
    const id = r.metadata?.id ?? r.id;
    const title = r.metadata?.title ?? r.metadata?.id ?? r.id ?? '(untitled)';
    const snippet = buildSnippet(title, r.memory);
    return { id, title, snippet };
  });
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
		if (url.pathname === '/openapi.yaml' && req.method === 'GET') {
			// Self-describing spec — served as YAML for ChatGPT Custom GPT Actions (Phase D)
			// and any tooling that prefers an authoritative spec URL.
			// ?gpt=1 returns the trimmed Custom GPT Actions subset (4 routes, renamed
			// operationIds, 5xx stripped, schemas pruned) — see plugins/chatgpt-custom-gpt.
			const gptMode = url.searchParams.get('gpt') === '1';
			res.writeHead(200, { 'Content-Type': 'application/yaml' });
			res.end(gptMode ? generateCustomGPTActionsSpec() : generateOpenAPISpec());
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
			const { query, limit = 5, include_superseded = false, filters, full: fullBody } = JSON.parse(await readBody(req));
			if (!query || typeof query !== 'string' || !query.trim()) {
				res.writeHead(400, {'Content-Type': 'application/json'});
				res.end(JSON.stringify({error: 'query is required'}));
				return;
			}
			const includeSup = include_superseded === true;
			const rawLimitPost = typeof limit === 'number' ? limit : parseInt(limit, 10);
			const clampedLimitPost = Number.isFinite(rawLimitPost) && rawLimitPost > 0 ? Math.min(rawLimitPost, 100) : 5;
			const fullReq = fullBody === true || url.searchParams.get('full') === '1';
			// Always fetch full results (metadata preserved) so metadata post-filters work,
			// then project to compact shape at the end if the client did not request full.
			let response = await doSearch(query, clampedLimitPost, includeSup, true);
			// Optional metadata filters (project, type) — post-filter after mem0 recall
			if (filters && typeof filters === 'object') {
				let items = response.results;
				if (filters.project) items = items.filter((r) => (r.metadata || {}).project === filters.project);
				if (filters.type) items = items.filter((r) => (r.metadata || {}).type === filters.type);
				response = { results: items };
			}
			// Project to compact shape unless caller explicitly requested full.
			if (!fullReq) {
				response = {
					results: response.results.map((r) => ({
						id: r.id,
						title: r.title,
						score: r.score,
						snippet: buildSnippet(r.title, r.body),
					})),
				};
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
			return;
		}
		if (url.pathname === '/api/search' && req.method === 'GET') {
			const q = url.searchParams.get('q') || '';
			const rawLimit = parseInt(url.searchParams.get('limit') || '5', 10);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 5;
			const includeSuperseded = url.searchParams.get('include_superseded') === 'true';
			const typeFilter = url.searchParams.get('type') || null;
			const fullReq = url.searchParams.get('full') === '1';
			if (!q) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'q parameter is required' }));
				return;
			}
			// Always fetch full results (metadata preserved) so metadata typeFilter works,
			// then project to compact shape at the end if the client did not request full.
			let response = await doSearch(q, limit, includeSuperseded, true);
			if (typeFilter) {
				const items = (response.results || []).filter((r) => (r.metadata || {}).type === typeFilter);
				response = { results: items };
			}
			// Project to compact shape unless caller explicitly requested full.
			if (!fullReq) {
				response = {
					results: response.results.map((r) => ({
						id: r.id,
						title: r.title,
						score: r.score,
						snippet: buildSnippet(r.title, r.body),
					})),
				};
			}
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
			// B.1.4b: compact shape by default; ?full=1 returns raw mem0 items.
			// Preserves raw-array envelope (not {results:[...]}) for backward compat.
			const full = url.searchParams.get('full') === '1';
			const limitStr = url.searchParams.get('limit');
			const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 0, 1000) : null;
			const items = await doList(full, limit);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(items));
			return;
		}
		// GET /api/recent/:project — list recent authored docs by filesystem mtime, compact shape
		if (url.pathname.startsWith('/api/recent/') && req.method === 'GET') {
			const projectSegment = decodeURIComponent(url.pathname.slice('/api/recent/'.length));
			const rawLimit = parseInt(url.searchParams.get('limit') || '10', 10);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 10;
			const full = url.searchParams.get('full') === '1';
			try {
				const result = await doRecent(projectSegment, limit, full);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(result));
			} catch (err) {
				if (/Invalid project name/.test(err.message)) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: err.message }));
				} else {
					console.error('[mem0-mcp] /api/recent error:', err.message);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'internal_error' }));
				}
			}
			return;
		}
		// GET /api/state/:project — direct file read, does NOT touch mem0
		if (url.pathname.startsWith('/api/state/') && req.method === 'GET') {
			const projectSegment = decodeURIComponent(url.pathname.slice('/api/state/'.length));
			// Belt-and-suspenders: REST handler pre-validates and returns HTTP 400
			// before doState() runs, so REST never hits doState's throw path.
			// Both checks use the same regex — intentional duplication.
			if (!projectSegment || !/^[a-zA-Z0-9._-]+$/.test(projectSegment)) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid project name: must match ^[a-zA-Z0-9._-]+$' }));
				return;
			}
			// Delegates to extracted doState() for DI testability (B.1.4b Step 0a).
			// R5-L1: preserve Content-Type header — ChatGPT Custom GPT actions and
			// other REST clients expect application/json; Node's autodetection would
			// fall back to text/plain and break downstream callers.
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(await doState(projectSegment));
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
			// TODO(v0.3): no mutex on delete+add — concurrent reindex for same id may produce duplicates. Acceptable at current single-user CLI-driven scale.
			await deleteByMetadataId(targetId);

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
		if (url.pathname === '/api/append-turn' && req.method === 'POST') {
			let reqBody;
			try {
				reqBody = JSON.parse(await readBody(req));
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'invalid JSON body' }));
				return;
			}
			const httpRes = {
				statusCode: 200,
				status(code) { this.statusCode = code; return this; },
				json(obj) {
					res.writeHead(this.statusCode, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(obj));
				},
			};
			await handleAppendTurnRequest(
				{ body: reqBody },
				httpRes,
				{ vaultDir: process.env.UM_VAULT_DIR, writesEnabled: isWriteEnabled() },
			);
			return;
		}
		if (url.pathname === '/api/checkpoint' && req.method === 'POST') {
			let reqBody;
			try {
				reqBody = JSON.parse(await readBody(req));
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'invalid JSON body' }));
				return;
			}
			const httpRes = {
				statusCode: 200,
				status(code) { this.statusCode = code; return this; },
				json(obj) {
					res.writeHead(this.statusCode, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(obj));
				},
			};
			await handleCheckpointRequest(
				{ body: reqBody },
				httpRes,
				{ vaultDir: process.env.UM_VAULT_DIR, writesEnabled: isWriteEnabled() },
			);
			return;
		}
		if (url.pathname === '/api/delete' && req.method === 'POST') {
			let reqBody;
			try {
				reqBody = JSON.parse(await readBody(req));
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'invalid JSON body' }));
				return;
			}
			const hasMetadata = reqBody.metadata !== undefined;
			const hasId = reqBody.id !== undefined;
			if (hasMetadata && hasId) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'provide either metadata.id or id, not both' }));
				return;
			}
			if (!hasMetadata && !hasId) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'provide either metadata.id (Shape A) or id (Shape B)' }));
				return;
			}
			if (hasMetadata) {
				// Shape A: delete by metadata.id
				const targetId = reqBody.metadata?.id;
				if (!targetId || typeof targetId !== 'string' || !targetId.trim()) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'metadata.id is required and must be a non-empty string' }));
					return;
				}
				const deleted = await deleteByMetadataId(targetId);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, deleted, query: `metadata.id=${targetId}` }));
				return;
			} else {
				// Shape B: delete by mem0 UUID directly
				const uuid = reqBody.id;
				if (!uuid || typeof uuid !== 'string' || !uuid.trim()) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'id is required and must be a non-empty string' }));
					return;
				}
				try {
					await memory.delete(uuid);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, deleted: 1, query: `id=${uuid}` }));
				} catch (err) {
					// mem0 may throw if UUID not found — treat as 0 deleted
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, deleted: 0, query: `id=${uuid}` }));
				}
				return;
			}
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
		console.error('[mem0-mcp] Unhandled error:', err.stack);
		const userMsg = process.env.NODE_ENV === 'production' ? 'internal_error' : err.message;
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: userMsg }));
	}
});

// Bootstrap — only runs when this file is invoked directly (not when imported
// for tests). IS_MAIN is computed at the top of the file; see its comment.
if (IS_MAIN) {
	await initMemory();
	server.listen(PORT, '0.0.0.0', () => {
		console.log(`[mem0-mcp] HTTP server listening on 0.0.0.0:${PORT}`);
		console.log('[mem0-mcp] Endpoints: /health, /openapi.yaml, /mcp (JSON-RPC), /api/*');
	});
}
