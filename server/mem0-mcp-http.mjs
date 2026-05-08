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
import { withRetry } from './lib/retry.mjs';
import { listEnvelope } from './lib/envelope.mjs';
import { endpointClassRoute } from './lib/endpoint-class.mjs';
import { extractBearer, compareTokens, shouldBypassLoopback } from './lib/auth.mjs';
import { errorResponse, httpStatusFor } from './lib/error-envelope.mjs';
import { createRateLimiter, extractRateLimitKey } from './lib/rate-limit.mjs';
import { toJsonRpcError } from './lib/jsonrpc-errors.mjs';
import { getLogger } from './lib/logger.mjs';
import { obsFallback, safeLog } from './lib/obs-fallback.mjs';
import { withRequestContext, currentRequestId } from './lib/request-context.mjs';
import { registry, httpRequestsTotal, httpRequestDurationSeconds, mcpToolCallsTotal } from './lib/metrics.mjs';
import { generateOpenAPISpec, generateCustomGPTActionsSpec } from './openapi.mjs';
import { getEmbedderConfig } from './lib/embed.mjs';
import { getFactsLlmConfig } from './lib/facts.mjs';
import { validateSummarizerConfig, validateProviderSupport, validateModelExists } from './lib/startup-validation.mjs';
import { getProvider, supportingProviders } from './lib/provider/registry.mjs';
import { filterSystemDocs, filterSystemDocsByTopLevelId } from './lib/system-docs.mjs';
import { createStampClient } from './lib/embedding-stamp.mjs';
import { priceFor } from './lib/pricing.mjs';
import { umAdd } from './lib/add.mjs';

// ---------------------------------------------------------------------------
// Route-template resolver (C.3 / spec §5.3 + future C.4 metrics).
//
// Maps a raw URL pathname + method to the route TEMPLATE used in log
// `endpoint` fields and (later) Prometheus labels. Path segments that
// expand at runtime (e.g., :project, :id) are collapsed to their
// template form so log + metric cardinality stays bounded.
//
// Returns null for unknown / unrouted paths — caller then logs the raw
// pathname as a last-resort `endpoint` for the 404 finish-log.
// ---------------------------------------------------------------------------
function resolveRouteTemplate(pathname, method) {
  if (pathname === '/health') return '/health';
  if (pathname === '/openapi.yaml') return '/openapi.yaml';
  if (pathname === '/metrics') return '/metrics';
  if (pathname === '/mcp') return '/mcp';
  if (pathname === '/api/search') return '/api/search';
  if (pathname === '/api/add') return '/api/add';
  if (pathname === '/api/list') return '/api/list';
  if (pathname === '/api/reindex') return '/api/reindex';
  if (pathname === '/api/append-turn') return '/api/append-turn';
  if (pathname === '/api/checkpoint') return '/api/checkpoint';
  if (pathname === '/api/delete') return '/api/delete';
  if (pathname.startsWith('/api/recent/')) return '/api/recent/:project';
  if (pathname.startsWith('/api/state/')) return '/api/state/:project';
  if (pathname.startsWith('/api/') && method === 'DELETE') return '/api/:id';
  return null;
}

// Decode a /api/recent/:project or /api/state/:project URL into the
// project segment used as a log field. Returns null when no project
// is present in the URL.
function extractProjectFromPath(pathname) {
  if (pathname.startsWith('/api/recent/')) {
    try { return decodeURIComponent(pathname.slice('/api/recent/'.length)); } catch { return null; }
  }
  if (pathname.startsWith('/api/state/')) {
    try { return decodeURIComponent(pathname.slice('/api/state/'.length)); } catch { return null; }
  }
  return null;
}

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
if (IS_MAIN) {
  // R9 mitigation (DE6): refuse unsupported (provider, surface) combos at startup
  // BEFORE initMemory so e.g. UM_EMBEDDING_PROVIDER=anthropic is rejected with a
  // helpful list of valid embedding providers. validateProviderSupport throws;
  // catch and exit(1) per server convention.
  try {
    validateProviderSupport(process.env);
  } catch (err) {
    console.error(`[mem0-mcp] FATAL: ${err.message}`);
    process.exit(1);
  }
  // Adv-5 mitigation (DE7): refuse models not in PRICING for the configured
  // provider (e.g. UM_EMBEDDING_PROVIDER=google with UM_EMBEDDING_MODEL=
  // text-embedding-3-small). Runs AFTER validateProviderSupport (provider
  // first, model second). Ollama exempt — user-managed local pulls.
  try {
    validateModelExists(process.env);
  } catch (err) {
    console.error(`[mem0-mcp] FATAL: ${err.message}`);
    process.exit(1);
  }
  // Validate that whatever providers the operator selected have their required keys,
  // and that each provider supports the surface it's assigned to.
  // This replaces the hard-coded requireEnv('OPENAI_API_KEY') check so that
  // non-openai deployments (e.g., ollama-only, Phase F Path 3) are not blocked.
  const surfaceMap = {
    UM_EMBEDDING_PROVIDER: 'embeddings',
    UM_SUMMARIZER_PROVIDER: 'summarizer',
    UM_SUMMARIZER_FALLBACK: 'summarizer',
    UM_FACTS_PROVIDER: 'facts',
  };
  for (const slot of ['UM_EMBEDDING_PROVIDER', 'UM_SUMMARIZER_PROVIDER', 'UM_SUMMARIZER_FALLBACK', 'UM_FACTS_PROVIDER']) {
    const rawName = process.env[slot];
    if (slot === 'UM_SUMMARIZER_FALLBACK' && !rawName) continue; // optional slot
    const resolved = rawName || 'openai';
    let provider;
    try {
      provider = getProvider(resolved);
    } catch (err) {
      console.error(`[mem0-mcp] FATAL: ${slot}=${resolved} — ${err.message}`);
      process.exit(1);
    }
    // Capability check: fail fast if provider doesn't support the assigned surface
    const surface = surfaceMap[slot];
    if (!provider.supports[surface]) {
      console.error(`[mem0-mcp] FATAL: ${slot}=${resolved} does not support ${surface}; valid providers for ${surface}: ${supportingProviders(surface).join(', ')}`);
      process.exit(1);
    }
    if (provider.requires.length === 0) continue; // ollama-style, no key needed
    if (!provider.resolveApiKey(process.env)) {
      console.error(`[mem0-mcp] FATAL: ${slot}=${resolved} requires one of: ${provider.requires.join(', ')}`);
      process.exit(1);
    }
  }
  // R8 mitigation: log info when summarizer fallback is cross-provider; warn on legacy UM_SUMMARIZER.
  validateSummarizerConfig(process.env, getLogger());
}

let memory;

/**
 * DE5 — startup guard wired around Memory init. The DI seam exists so the
 * three branches (null / match / mismatch) and verifyDim ordering can be
 * tested without spinning up Qdrant or a real embedder.
 *
 * Branches (spec §6.2):
 *   - null     → writeStamp(currentEnv) + warn(LEGACY_COLLECTION_STAMPED) +
 *                verifyDim() (R2 mitigation: stamp legacy collections so
 *                subsequent restarts hit the match branch)
 *   - match    → verifyDim() only (probe runs whenever a stamp is in place)
 *   - mismatch → fatal log per spec §6.2 + exit(1) (R3 mitigation: never
 *                serve under stamp/env disagreement; verifyDim NOT called)
 *
 * @param {Object} args
 * @param {Object} args.memory   already-constructed Memory instance (or stub)
 * @param {Object} args.stamp    stamp client (createStampClient(...) or stub)
 * @param {Object} args.log      structured logger (pino-shaped: warn/info/fatal)
 * @param {Object} args.env      env object to derive expected shape from
 *                               (must carry UM_EMBEDDING_PROVIDER + UM_EMBEDDING_MODEL)
 * @param {Function} [args.exit] exit hook (defaults to process.exit; tests inject)
 * @param {Object} [args.embedder] embedder instance forwarded to verifyDim
 *                                 (defaults to memory.embedder; tests omit when
 *                                 stamp.verifyDim is stubbed)
 */
export async function initMemoryWithGuard({ memory, stamp, log, env, exit = process.exit, embedder } = {}) {
  // Derive expected shape from env+pricing. Pricing is the canonical source for
  // dim per (provider, model) — see spec §6.1 + DE4 plan note ("DE5 owns the
  // env→shape derivation"). priceFor returns { ..., dim?: number } for embed
  // entries; if dim is missing we fail-fast below (I3) rather than letting
  // {dim: undefined} pollute the stamp.
  const provider = env?.UM_EMBEDDING_PROVIDER || 'openai';
  // Pull the per-provider default from the registry so non-openai operators who
  // omit UM_EMBEDDING_MODEL still get the right model (rather than `undefined`,
  // which polluted the stamp and triggered false fatal alarms). Single source
  // of truth for default models — picks up new providers automatically.
  // getProvider() throws on unknown names; swallow so a typo in
  // UM_EMBEDDING_PROVIDER falls through to mismatch (operator-visible) rather
  // than crashing the guard with an opaque init error.
  let providerDef;
  try { providerDef = getProvider(provider); } catch { providerDef = undefined; }
  const model = env?.UM_EMBEDDING_MODEL || providerDef?.defaults?.embeddingModel;
  // I3 (DE5 review fix): gate undefined-dim BEFORE stamp.read(). If the pricing
  // registry has no entry for (provider, model), `priceFor(...).dim` is
  // undefined — and writing {dim: undefined} to the stamp on the null branch
  // would silently bypass the guard on subsequent restarts (undefined ===
  // undefined → 'match'). Fail-fast tells the operator to fix the registry
  // gap before booting rather than inviting a future silent drift.
  const expectedDim = priceFor(provider, model)?.dim;
  if (typeof expectedDim !== 'number') {
    log.fatal(
      { code: 'PRICING_REGISTRY_DIM_MISSING', provider, model },
      `[mem0-mcp] FATAL: pricing registry has no dim for ${provider}/${model}; add it to server/lib/pricing.mjs before booting`,
    );
    return exit(1);
  }
  const expected = { provider, model, dim: expectedDim };

  const actual = await stamp.read();
  if (actual === null) {
    // Mock-SDK boot path (smoke gate, spec §9.4): skip writeStamp + verifyDim.
    // Both call into the embedder (umAdd/writeStamp embeds the stamp text; verifyDim
    // calls embedder.embedQuery), which mem0 routes through real provider
    // SDKs — UM_TEST_MOCK_SDK only short-circuits our *Invoke wrappers, not
    // mem0's internal embedder. Without this skip, boot smoke for non-openai
    // providers crashes on `API key not valid` from the fake-key fallback
    // (PR #35 CI run 25235221732). Stamp-write logic is covered by
    // server/test/init-memory-stamp-guard.test.mjs and live FIN1 integration.
    if (env.UM_TEST_MOCK_SDK === '1') {
      log.info(
        { code: 'EMBEDDING_STAMP_MOCK_SKIP', expected },
        '[mem0-mcp] UM_TEST_MOCK_SDK=1 — skipping stamp write + verify on null branch',
      );
      return memory;
    }
    // Null branch — legacy collection. Stamp it so future restarts hit `match`,
    // then probe live dim. R2 mitigation per spec §6.2.
    await stamp.write(expected);
    log.warn(
      { code: 'LEGACY_COLLECTION_STAMPED', stamp: expected },
      'Legacy collection stamped with current embedding shape',
    );
    await stamp.verifyDim({ embedder, dim: expectedDim });
    return memory;
  }
  // Stamp present — compare shape against env-derived expected.
  // I2 (DE5 review fix): drop the dead-code ternary fallback to compareStamp;
  // createStampClient always exposes `.compare` and tests now mirror that
  // shape. The else-branch was unreachable production-side.
  const cmp = stamp.compare(actual, expected);
  if (cmp === 'mismatch') {
    // Mismatch — fatal. verifyDim NOT called; we never reach a serving state.
    // Message must satisfy spec §13.1 contract (see the test): contain the CLI
    // pointer plus both stamped and configured shapes.
    const msg =
      `Embedding stamp mismatch. ` +
      `Stamped: provider=${actual.provider} model=${actual.model} dim=${actual.dim}. ` +
      `Configured: provider=${expected.provider} model=${expected.model} dim=${expected.dim}. ` +
      'Run `um-cli reindex --confirm` to migrate.';
    log.fatal({ code: 'EMBEDDING_STAMP_MISMATCH', stamped: actual, configured: expected }, msg);
    return exit(1);
  }
  // Match — probe live dim to catch silent provider model substitutions (R3).
  // I1 (DE5 review fix): emit positive observability signal that the guard ran
  // and matched, so operators tailing structured logs can confirm the boot
  // crossed the stamp gate (rather than silently degrading to no-guard).
  log.info(
    { code: 'EMBEDDING_STAMP_MATCH', stamp: actual },
    '[mem0-mcp] embedding stamp matches; verifying dim',
  );
  // Mock-SDK boot path: skip verifyDim (calls embedder.embedQuery → real
  // provider SDK). Same rationale as the null branch above. Match path
  // verification is covered by unit tests + production live boot.
  if (env.UM_TEST_MOCK_SDK === '1') {
    return memory;
  }
  await stamp.verifyDim({ embedder, dim: expectedDim });
  return memory;
}

export async function initMemory() {
	memory = new Memory({
		version: 'v1.1',
		embedder: getEmbedderConfig(process.env),
		vectorStore: {
			provider: 'qdrant',
			config: {
				host: process.env.QDRANT_HOST || 'localhost',
				port: parseInt(process.env.QDRANT_PORT || '6333', 10),
				collectionName: process.env.QDRANT_COLLECTION || 'memories',
			},
		},
		llm: getFactsLlmConfig(process.env),
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
			break;
		} catch (err) {
			if (i === MAX_ATTEMPTS) {
				console.error(`[mem0-mcp] FATAL: Qdrant unreachable after ${MAX_ATTEMPTS} attempts: ${err.message}`);
				throw err;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	// DE5 — wire the embedding-stamp guard. The wrapper handles the 3 branches
	// (null/match/mismatch) and the verifyDim probe. Production deps:
	//   - memory: the live Memory instance (warmed above)
	//   - stamp:  createStampClient bound to the same Memory
	//   - log:    pino logger from getLogger()
	//   - env:    process.env (UM_EMBEDDING_PROVIDER + UM_EMBEDDING_MODEL drive the expected shape)
	//   - embedder: mem0 exposes the embedder instance as memory.embedder; we
	//     adapt its `embed(text)` signature to the `embedQuery(text)` API
	//     verifyDim expects so the dim probe goes through the same path
	//     mem0 will use for real reads/writes.
	const stampClient = createStampClient({ memory });
	const embedderAdapter = memory.embedder
		? { embedQuery: (text) => memory.embedder.embed(text) }
		: undefined;
	await initMemoryWithGuard({
		memory,
		stamp: stampClient,
		log: getLogger(),
		env: process.env,
		embedder: embedderAdapter,
	});
	return memory;
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
		description: 'Trigger a session summary + state refresh for the given project. Pipeline: reads raw captures -> LLM-summarizes -> writes to sessions/<project>/<id>.md -> atomically merges into state/<project>/state.md -> reindexes into mem0. Cost-capped per day per project. Honors UM_SUMMARIZER (openai | ollama | claude-agent-sdk; latter falls back to openai server-side). Parity with the /um-checkpoint slash command in Claude Code.',
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
 * Filter logic: getVisibleTools() uses this set; TOOLS still holds all 11 so
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
 * When writeEnabled is true (or omitted and env var is true/1), all 11 tools are returned.
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

// ---------------------------------------------------------------------------
// C.11: tag mem0/qdrant errors as retryable for the shared withRetry() helper.
// mem0's JS client doesn't ship a `.retryable` flag on its rejections, but in
// practice nearly every failure we observe is transient (qdrant unreachable,
// network blip, container restarting). Our own validation errors (typeof
// guards, INPUT_INVALID class) are caught BEFORE reaching mem0, so it is safe
// to default-mark mem0 errors retryable. Adapters that want to opt out can
// re-throw with `.retryable = false`.
// ---------------------------------------------------------------------------
function tagRetryable(err) {
	if (err && err.retryable === undefined) err.retryable = true;
	return err;
}

// ---------------------------------------------------------------------------
// Shared helper: delete all mem0 entries matching a metadata.id value
// Returns the count of deleted entries.
// ---------------------------------------------------------------------------

async function deleteByMetadataId(targetId) {
	// TODO(v0.3): O(N) full-user scan. Replace with metadata-filtered query when mem0 OSS supports it.
	// C.11: wrap in withRetry — transient qdrant blips don't fail the request.
	// R1 review A1, fix #1: thread op label so um_mem0_ops_total increments.
	const allMemories = await withRetry(() =>
		memory.getAll({ userId: USER_ID }).catch((e) => { throw tagRetryable(e); })
	, { op: 'getAll' });
	const allItems = allMemories?.results || allMemories || [];
	const existingItems = allItems.filter((r) => (r.metadata || {}).id === targetId);
	for (const item of existingItems) {
		await withRetry(() =>
			memory.delete(item.id).catch((e) => { throw tagRetryable(e); })
		, { op: 'delete' });
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
	// v0.8 G2: umAdd routes through orchestrators for metric emission.
	await withRetry(() =>
		umAdd({ memory, text: docText, userId: USER_ID, metadata, infer: false })
			.catch((e) => { throw tagRetryable(e); })
	, { op: 'add' });
	return { ok: true, path: relPath, id: targetId, indexed: true };
}

// ---------------------------------------------------------------------------
// handleToolCall
//
// R1 review A1, fix #1: every MCP tool dispatch emits one
// um_mcp_tool_calls_total{tool, status} sample (status='ok' on resolution,
// status='fail' on rejection). The switch body is delegated to
// _handleToolCallInner so the wrapper can do exactly one emit per call,
// independent of how many branches a handler crosses internally.
// ---------------------------------------------------------------------------

export async function handleToolCall(name, args, ctx = {}) {
	let status = 'ok';
	try {
		return await _handleToolCallInner(name, args, ctx);
	} catch (err) {
		status = 'fail';
		throw err;
	} finally {
		try {
			// Use the tool name verbatim — TOOLS list is the cardinality cap.
			// Unknown-tool throws (default branch) still bucket under their
			// caller-supplied name; the cardinality is bounded by what the
			// caller can put in `params.name`. If that becomes a worry, a
			// future fix can clamp to the TOOLS allow-list before emit.
			mcpToolCallsTotal.inc({ tool: String(name), status });
		} catch (e) {
			obsFallback(e, `metrics:mcp_tool:${name}:${status}`);
		}
	}
}

async function _handleToolCallInner(name, args, ctx = {}) {
	switch (name) {
		// ── Original 4 tools ──────────────────────────────────────────────────
		case 'memory_search': {
			const limit = args.limit || 5;
			const includeSup = args.include_superseded === true;
			const clientFull = args.full === true;
			// Always call doSearch(full=true) internally so metadata is preserved for
			// post-filtering (project, type). Then project to compact shape at the end
			// unless the MCP client explicitly requested full bodies (args.full=true).
			let response = await doSearch(args.query, limit, includeSup, true, ctx);
			let items = response.results;

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

			// §4.1 extensibility contract: preserve additive top-level siblings
			// (e.g., provider, latency_ms) that doSearch propagated from the
			// upstream memory.search() envelope. Mirrors the REST /api/search
			// pattern — only `results` is replaced; every other top-level key
			// is forwarded. Without this, the MCP memory_search tool surface
			// silently drops siblings and breaks parity with REST.
			const { results: _prev, ...responseExtras } = response;
			return JSON.stringify(listEnvelope(items, responseExtras));
		}
		case 'memory_add': {
			if (!isWriteEnabled()) {
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env',
				));
			}
			const memoryClient = ctx?.memory ?? memory;
			// v0.8 G2: see /api/add migration; same pattern.
			const result = await withRetry(() =>
				umAdd({ memory: memoryClient, text: args.text, userId: USER_ID, ...(args.metadata && { metadata: args.metadata }), infer: true })
					.catch((e) => { throw tagRetryable(e); })
			, { op: 'add' });
			const events = result?.results?.map((r) => `[${r.event || r.metadata?.event}] ${r.memory}`).join('; ') || 'Stored.';
			return events;
		}
		case 'memory_list': {
			const clientFull = args.full === true;
			const listLimit = args.limit != null ? Math.min(parseInt(args.limit, 10) || 0, 1000) : null;
			// Delegate to doList which returns { results: Array } per spec §4.1 (v0.6).
			// When full=true: items are raw mem0 objects (body/metadata preserved).
			// When full=false (default): items are compact { id, title, snippet }.
			const { results: items } = await doList(clientFull, listLimit, ctx);
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
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env',
				));
			}
			const memoryClient = ctx?.memory ?? memory;
			// C.11: wrap memory.delete — transient qdrant errors get up to 3 retries.
			// R1 review A1, fix #1: thread op label for um_mem0_ops_total.
			await withRetry(() =>
				memoryClient.delete(args.memoryId)
					.catch((e) => { throw tagRetryable(e); })
			, { op: 'delete' });
			return `Deleted ${args.memoryId}`;
		}

		// ── Task 10: 6 new tools ──────────────────────────────────────────────
		case 'memory_state': {
			// Delegates to extracted doState() for DI testability (B.1.4b Step 0a).
			// doState validates the project name and throws on invalid input.
			return await doState(args.project, ctx);
		}

		case 'memory_recent': {
			// CRITICAL-2 fix: delegate to doRecent (filesystem, mtime-sorted) to match
			// REST /api/recent/:project semantics. Previous impl called doSearch (mem0
			// vector-store) which is a different data source and different ordering.
			// BREAKING CHANGE (v0.4 alpha): project is now required (was optional).
			const project = args.project;
			const limit = args.limit ?? 10;
			const full = args.full === true;
			const result = await doRecent(project, limit, full, ctx);
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
			if (!isWriteEnabled()) {
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env',
				));
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
			// C.9 (§4.2.0): pino emit must never throw out of a tool path.
			safeLog(() => getLogger().info({ request_id: currentRequestId(), tool: 'memory_capture', path: relPath }, 'memory_capture: wrote'), 'log:memory_capture:wrote');

			// Reindex
			let indexed = false;
			try {
				await reindexDoc(relPath);
				indexed = true;
			} catch (err) {
				safeLog(() => getLogger().error({ request_id: currentRequestId(), tool: 'memory_capture', path: relPath, err_message: err?.message }, 'memory_capture: reindex failed'), 'log:memory_capture:reindex-failed');
			}

			return JSON.stringify({ ok: true, path: relPath, id, indexed });
		}

		case 'memory_checkpoint': {
			if (!isWriteEnabled()) {
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env',
				));
			}
			return JSON.stringify(await doCheckpoint(args, { vaultDir: process.env.UM_VAULT_DIR, reindexFn: reindexDoc }));
		}

		case 'memory_forget': {
			const { id } = args;
			if (!id) throw new Error('id is required');
			// C1: validate id before using as path component
			validateSafeName('id', id);
			if (!isWriteEnabled()) {
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env',
				));
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
			safeLog(() => getLogger().info({ request_id: currentRequestId(), tool: 'memory_forget', path: relPath }, 'memory_forget: deprecated'), 'log:memory_forget:deprecated');

			// Reindex so mem0 sees the updated status
			try {
				await reindexDoc(relPath);
			} catch (err) {
				safeLog(() => getLogger().error({ request_id: currentRequestId(), tool: 'memory_forget', path: relPath, err_message: err?.message }, 'memory_forget: reindex failed'), 'log:memory_forget:reindex-failed');
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
			if (!isWriteEnabled()) {
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env',
				));
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
			safeLog(() => getLogger().info({ request_id: currentRequestId(), tool: 'memory_supersede', path: newRelPath }, 'memory_supersede: created new doc'), 'log:memory_supersede:created');

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
				safeLog(() => getLogger().info({ request_id: currentRequestId(), tool: 'memory_supersede', path: oldRelPath }, 'memory_supersede: superseded old doc'), 'log:memory_supersede:superseded');
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
				safeLog(() => getLogger().error({ request_id: currentRequestId(), tool: 'memory_supersede', path: newRelPath, err_message: err?.message }, 'memory_supersede: new doc reindex failed'), 'log:memory_supersede:new-reindex-failed');
			}
			try {
				await reindexDoc(oldRelPath);
				oldIndexed = true;
			} catch (err) {
				safeLog(() => getLogger().error({ request_id: currentRequestId(), tool: 'memory_supersede', path: oldRelPath, err_message: err?.message }, 'memory_supersede: old doc reindex failed'), 'log:memory_supersede:old-reindex-failed');
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
			if (!isWriteEnabled()) {
				return JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env',
				));
			}
			const result = await doAppendTurn(args, { vaultDir: process.env.UM_VAULT_DIR });
			// B.9 (spec §5.4): fire-and-forget reindex for MCP parity with the
			// REST endpoint. Errors logged, never propagated — the turn is
			// already on disk and will reindex on the next successful pass.
			if (result.ok && result.path) {
				reindexDoc(result.path).catch((err) => {
					safeLog(() => getLogger().warn({
						request_id: currentRequestId(),
						tool: 'memory_append_turn',
						path: result.path,
						err_message: err?.message ?? String(err),
					}, 'memory_append_turn reindex failed (best-effort)'), 'log:memory_append_turn:reindex-failed');
				});
			}
			return JSON.stringify(result);
		}

		default:
			// B.13 (§5.1): unknown-tool throw is caught by handleMcpMessage's
			// .catch() below; that catch wraps the error message in the unified
			// envelope. The Error here flows through the tool-error path with
			// code INPUT_INVALID (caller named a non-existent tool — caller-shape).
			{
				const err = new Error(`Unknown tool: ${name}`);
				err.umCode = 'INPUT_INVALID';
				throw err;
			}
	}
}

/**
 * Map an exception thrown inside handleToolCall to a stable §5.2 error code.
 * Heuristics:
 *   - err.umCode (set explicitly by the throw site) wins.
 *   - err.code = 'INPUT_TOO_LARGE' from readBody → INPUT_TOO_LARGE.
 *   - "must include" / "is required" / "must match" / "Invalid project name"
 *     messages from validateSafeName / required-field guards → INPUT_INVALID.
 *   - "Document not found in vault" / "File not found" → STATE_NOT_FOUND.
 *   - "already exists" → STATE_ALREADY_EXISTS.
 *   - Anything else → SERVER_INTERNAL.
 *
 * @param {Error} err
 * @returns {string} stable error code
 */
function _classifyToolError(err) {
	if (err && err.umCode) return err.umCode;
	if (err && err.code === 'INPUT_TOO_LARGE') return 'INPUT_TOO_LARGE';
	const msg = err?.message ?? '';
	if (/must include|is required|must match|Invalid project|invalid project|new_doc must|metadata must/i.test(msg)) {
		return 'INPUT_INVALID';
	}
	if (/not found in vault|File not found|does not exist/i.test(msg)) {
		return 'STATE_NOT_FOUND';
	}
	if (/already exists|same path/i.test(msg)) {
		return 'STATE_ALREADY_EXISTS';
	}
	return 'SERVER_INTERNAL';
}

function handleMcpMessage(msg, ctx = {}) {
	const { id, method, params } = msg;
	if (method === 'initialize') {
		return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'universal-memory', version: '0.7.0-alpha' }, capabilities: { tools: {} } } };
	} else if (method === 'notifications/initialized') {
		return null;
	} else if (method === 'tools/list') {
		return { jsonrpc: '2.0', id, result: { tools: getVisibleTools() } };
	} else if (method === 'tools/call') {
		return handleToolCall(params.name, params.arguments || {}, ctx)
			.then((text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }))
			.catch((err) => {
				// B.13 (§5.1) JSON-RPC dual-shape:
				//   - INNER: result.content[0].text wraps the unified envelope as
				//     a JSON string (so MCP clients parsing the text block see
				//     ok:false / error.code / error.message / error.retryable).
				//   - OUTER: handleMcpMessage already returns 200 OK for tool
				//     errors with isError:true (MCP spec). We do NOT promote the
				//     tool error to a JSON-RPC outer error.code here — the
				//     transport stays clean; the structured shape is in the text
				//     block per spec §5.1.
				const stableCode = _classifyToolError(err);
				const envelope = errorResponse(stableCode, err?.message ?? 'unknown error');
				return {
					jsonrpc: '2.0', id,
					result: {
						content: [{ type: 'text', text: JSON.stringify(envelope) }],
						isError: true,
					},
				};
			});
	} else if (id !== undefined) {
		// B.13 (§5.1) JSON-RPC dual-shape: method-not-found uses the standard
		// JSON-RPC numeric -32601. No string code mapping (it's a transport-
		// level error, not a §5.2 application-level error).
		return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
	}
	return null;
}

// Default request-body cap (spec §5.2): 2 MB. Overridable per-process via
// UM_HTTP_MAX_REQUEST_BYTES — installer seeds the env with this default.
// Resolved inside readBody() (not at module load) so tests that mutate the
// env var between `startServer` calls see the new value on each request.
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function _currentMaxBodyBytes() {
	const v = parseInt(process.env.UM_HTTP_MAX_REQUEST_BYTES || '', 10);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Read the request body into a UTF-8 string, enforcing UM_HTTP_MAX_REQUEST_BYTES.
 *
 * On overrun (either via Content-Length header or mid-stream byte count), the
 * incoming stream is paused, further chunks are ignored, and the returned
 * promise rejects with an error whose `.code === 'INPUT_TOO_LARGE'`. The outer
 * request handler's catch turns that into a 413 response with the v0.6 envelope
 * (spec §5.2 precedence 1 — fires before JSON-parse or any field-level
 * validator).
 *
 * Early-pause (not req.destroy()) is intentional: we need the paired ServerResponse
 * to still be writable so the 413 response body can flush. req.destroy() tears
 * down the socket prematurely and the client sees a connection reset instead of
 * a structured error envelope. The pause still prevents an attacker from forcing
 * us to buffer a 2 GB upload — we stop consuming bytes the moment the cap trips.
 */
function readBody(req, maxBytes = _currentMaxBodyBytes()) {
	return new Promise((resolve, reject) => {
		const makeOverrunError = () => {
			const err = new Error(`request body exceeds UM_HTTP_MAX_REQUEST_BYTES cap (${maxBytes} bytes)`);
			err.code = 'INPUT_TOO_LARGE';
			err.statusCode = 413;
			return err;
		};
		// Reject early if Content-Length header exceeds cap.
		// We do NOT tear down the socket here (req.destroy()) because the outer
		// handler still needs to flush a 413 response on the paired res. The
		// calling route's try/catch rejects, the outer catch writes headers and
		// body, and Node handles the socket close after the response flushes.
		// We do `req.pause()` to stop buffering any further bytes the peer may
		// still be sending — attacker uploads 2 GB, we stop reading at the cap.
		const contentLength = parseInt(req.headers?.['content-length'] || '0', 10);
		if (contentLength > maxBytes) {
			req.pause();
			req.unpipe?.();
			return reject(makeOverrunError());
		}
		const chunks = [];
		let totalBytes = 0;
		let rejected = false;
		req.on('data', (c) => {
			if (rejected) return;
			totalBytes += c.length;
			if (totalBytes > maxBytes) {
				rejected = true;
				// Stop consuming further bytes; abandon buffered chunks.
				req.pause();
				req.unpipe?.();
				return reject(makeOverrunError());
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (rejected) return;
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', (err) => {
			if (rejected) return;
			reject(err);
		});
	});
}

/**
 * Exported handler for POST /api/append-turn.
 * Accepts a pre-parsed body via req.body (unit-test friendly).
 *
 * Reindex semantics (spec §5.4): memory_append_turn is best-effort — the turn
 * is captured to disk unconditionally, and any reindex to the vector store is
 * fire-and-forget with logged errors. HTTP 200 is returned as soon as the disk
 * write succeeds; the vector index can be stale until the next successful
 * reindex (e.g., from a subsequent checkpoint). Contrast with memory_checkpoint,
 * where reindex is blocking because the checkpoint is a consistency point.
 *
 * @param {{ body: { project, content, role, timestamp?, conversation_id? } }} req
 * @param {{ status(code): this, json(obj): this }} res
 * @param {{ vaultDir?: string, writesEnabled: boolean, reindexFn?: Function }} ctx
 *   `reindexFn`: optional async fn(relPath) → indexed; called fire-and-forget
 *   after a successful disk write. Defaults to the module-level `reindexDoc`.
 *   Tests inject a stub (throwing or success) to assert best-effort semantics.
 */
export async function handleAppendTurnRequest(req, res, ctx) {
	if (!ctx.writesEnabled) {
		// B.13 (§5.1): writes-disabled is a caller-visible config error — code
		// INPUT_INVALID per §5.2 (caller can recover by enabling env). HTTP 403
		// is preserved for the existing wire contract; status code is decoupled
		// from the stable error code by design.
		res.status(403).json(errorResponse(
			'INPUT_INVALID',
			'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env',
		));
		return;
	}
	try {
		const { project, content, role, timestamp, conversation_id } = req.body || {};
		const result = await doAppendTurn(
			{ project, content, role, timestamp, conversation_id },
			{ vaultDir: ctx.vaultDir },
		);
		if (!result.ok) {
			// B.6b (spec §5.2): field-level size violations from the lib layer
			// ("content exceeds N bytes", "conversation_id exceeds N bytes") are
			// promoted to the v0.6 INPUT_TOO_LARGE envelope with HTTP 413.
			// Same error code + caller action as the request-body cap — send
			// less data. The lib keeps returning its legacy plain-string shape
			// for backward compat with older unit tests; the wire envelope lives
			// at the HTTP boundary (here).
			if (typeof result.error === 'string' && /exceeds.*bytes/i.test(result.error)) {
				res.status(413).json(errorResponse('INPUT_TOO_LARGE', result.error));
				return;
			}
			// B.13 (§5.1): all other lib-layer "ok:false" results are caller-shape
			// validation failures (invalid project, role, timestamp, etc.). Wrap
			// in the unified envelope with INPUT_INVALID. The lib's plain-string
			// `result.error` is preserved verbatim as the envelope `message`.
			res.status(400).json(errorResponse(
				'INPUT_INVALID',
				typeof result.error === 'string' ? result.error : 'invalid input',
			));
			return;
		}
		// B.9 (spec §5.4): fire-and-forget reindex. The user keeps typing; the
		// turn is on disk; the vector index catches up on the next successful
		// reindex. Errors are logged but do NOT affect the 200 response or the
		// durability of the captured turn.
		// Phase C: structured logger replaces the legacy console.warn.
		const reindexFn = ctx.reindexFn ?? reindexDoc;
		reindexFn(result.path).catch((err) => {
			safeLog(() => getLogger().warn({
				request_id: currentRequestId(),
				endpoint: '/api/append-turn',
				path: result.path,
				err_message: err?.message ?? String(err),
			}, 'append-turn reindex failed (best-effort)'), 'log:append-turn:reindex-failed');
		});
		res.status(200).json(result);
	} catch (err) {
		safeLog(() => getLogger().error({
			request_id: currentRequestId(),
			endpoint: '/api/append-turn',
			err_message: err?.message,
		}, 'handleAppendTurnRequest error'), 'log:append-turn:handler-error');
		// B.13 (§5.1): unhandled exceptions → SERVER_INTERNAL. Honor any
		// pre-tagged err.statusCode (e.g., 413 for body-cap overruns) but the
		// stable error code is INPUT_TOO_LARGE / SERVER_INTERNAL by category.
		if (err && err.code === 'INPUT_TOO_LARGE') {
			res.status(413).json(errorResponse('INPUT_TOO_LARGE', err.message));
			return;
		}
		res.status(err.statusCode || 500).json(errorResponse(
			'SERVER_INTERNAL',
			err.statusCode ? err.message : 'internal server error',
		));
	}
}

/**
 * Exported handler for POST /api/checkpoint.
 * Accepts a pre-parsed body via req.body (unit-test friendly).
 * Supports DI of _doCheckpoint for testing without a real vault/LLM.
 *
 * Reindex semantics (spec §5.4): memory_checkpoint reindex is BLOCKING + retry-
 * exhausted. doCheckpoint awaits the reindex with 3x exponential backoff;
 * persistent failure surfaces as `result.error.code = "UPSTREAM_FAILURE"` which
 * we map to HTTP 502 here. Contrast with /api/append-turn (B.9) which is fire-
 * and-forget. STATE_LOCK_CONTENTION (phase-2 contention from two-phase write)
 * maps to HTTP 503 for retryable-by-client semantics.
 *
 * @param {{ body: { project?, since?, until?, skip_state_merge? } }} req
 * @param {{ status(code): this, json(obj): this }} res
 * @param {{ vaultDir?: string, writesEnabled: boolean, _doCheckpoint?: Function }} ctx
 */
export async function handleCheckpointRequest(req, res, ctx) {
	if (!ctx.writesEnabled) {
		// B.13 (§5.1): see handleAppendTurnRequest above — same writes-disabled
		// code (INPUT_INVALID) for parity across all write endpoints.
		res.status(403).json(errorResponse(
			'INPUT_INVALID',
			'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true in your .env',
		));
		return;
	}
	try {
		const { project, since, until, skip_state_merge } = req.body || {};
		const checkpointFn = ctx._doCheckpoint ?? doCheckpoint;
		const result = await checkpointFn(
			{ project, since, until, skip_state_merge },
			{ vaultDir: ctx.vaultDir ?? process.env.UM_VAULT_DIR, reindexFn: ctx._reindexFn ?? reindexDoc },
		);
		if (!result.ok) {
			// B.10: doCheckpoint returns structured `error: { code, message }` for
			// UPSTREAM_FAILURE (retry-exhausted reindex) and STATE_LOCK_CONTENTION
			// (two-phase write phase-2 contention). B.13 (§5.1): wrap in the
			// unified envelope so the wire shape stays consistent with §5.1.
			// summary_id / summary_path (when present on the upstream-fail result)
			// land inside `error` as additive fields so callers can correlate the
			// failed reindex with the partially-written summary doc.
			const errCode = result.error && typeof result.error === 'object' ? result.error.code : null;
			if (errCode && (errCode === 'UPSTREAM_FAILURE' || errCode === 'STATE_LOCK_CONTENTION')) {
				const extra = {};
				if (result.summary_id) extra.summary_id = result.summary_id;
				if (result.summary_path) extra.summary_path = result.summary_path;
				res.status(httpStatusFor(errCode)).json(errorResponse(
					errCode,
					result.error.message ?? errCode,
					extra,
				));
				return;
			}
			// B.13: legacy plain-string `error` results (cost-cap, in-progress,
			// invalid project, etc.) are caller-shape validations → INPUT_INVALID.
			res.status(400).json(errorResponse(
				'INPUT_INVALID',
				typeof result.error === 'string' ? result.error : 'invalid input',
			));
			return;
		}
		res.status(200).json(result);
	} catch (err) {
		safeLog(() => getLogger().error({
			request_id: currentRequestId(),
			endpoint: '/api/checkpoint',
			err_message: err?.message,
		}, 'handleCheckpointRequest error'), 'log:checkpoint:handler-error');
		// B.13 (§5.1): mirror handleAppendTurnRequest — INPUT_TOO_LARGE
		// pass-through for body-cap overruns; everything else is SERVER_INTERNAL.
		if (err && err.code === 'INPUT_TOO_LARGE') {
			res.status(413).json(errorResponse('INPUT_TOO_LARGE', err.message));
			return;
		}
		res.status(err.statusCode || 500).json(errorResponse(
			'SERVER_INTERNAL',
			err.statusCode ? err.message : 'internal server error',
		));
	}
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
 * @param {object} [ctx={}] - DI context; preferred shape `{ memory: MemoryClient }`.
 *   Backward compatible: callers that pass a bare memoryClient (object with
 *   `.search()`) as the fifth arg continue to work — see `search-quality.test.mjs`
 *   and `decay-integration.test.mjs` which still use that positional style.
 *   Defaults to the module-level `memory` binding used by real requests.
 *   Phase B/C/D will extend ctx with `ctx.logger`, `ctx.metrics`,
 *   `ctx.rateLimiter`, `ctx.auth`, etc. — unified contract across all list/state
 *   handlers keeps middleware injection consistent (A.8 sweep).
 */
export async function doSearch(query, limit, includeSuperseded, full = false, ctx = {}) {
	// DI resolution: prefer ctx.memory (new convention), then treat ctx itself as a
	// memoryClient if it exposes search (legacy positional pattern), else fall back
	// to the module-level memory binding used by real requests.
	const memoryClient = ctx?.memory ?? (typeof ctx?.search === 'function' ? ctx : memory);
	// C.11: wrap memoryClient.search — transient qdrant errors get up to 3 retries
	// before surfacing UPSTREAM_FAILURE. /api/search is the hottest path (every
	// session-start / chat turn), so a brief qdrant blip should not bubble a 502
	// to the user when one retry would cover it.
	// R1 review A1, fix #1: thread op label for um_mem0_ops_total.
	const raw = await withRetry(() =>
		memoryClient.search(query, { userId: USER_ID, limit: limit || 5 })
			.catch((e) => { throw tagRetryable(e); })
	, { op: 'search' });
	let items = raw?.results || raw || [];
	// §4.1 extensibility contract: additive sibling fields on the memory-client
	// envelope (e.g., future `provider`, `latency_ms` for multi-provider
	// transparency) MUST propagate through to the wire response. Mirrors the
	// doList fix (036fe95) so parity holds across all list endpoints. If the
	// client returned a bare array (legacy mem0 versions), no siblings exist
	// and extras stays empty.
	const extras = {};
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const k of Object.keys(raw)) {
			if (k !== 'results') extras[k] = raw[k];
		}
	}
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
	// DE3 / spec §6.1: strip internal system docs (e.g. _um_embedding_stamp)
	// AFTER ranking/decay (so scoring never wastes a slot on the stamp) and
	// BEFORE projection/envelope serialization (so consumers never see it on
	// any read path). Single touchpoint covers /api/search + memory_search.
	items = filterSystemDocs(items);
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
	return listEnvelope(mapped, extras);
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
 * @param {object} [ctx={}] - DI context; preferred shape `{ memory: MemoryClient }`
 *   for signature parity with the other list/state handlers. doState itself is
 *   filesystem-only and does not currently consume `ctx.memory`, but accepting
 *   ctx keeps the DI contract uniform across the read surface (A.8 sweep).
 *   Backward compatible: legacy callers that pass a bare memoryClient positionally
 *   continue to work — the ternary falls through to the module-level `memory`.
 *   Phase B/C/D will extend ctx with `ctx.logger`, `ctx.metrics`,
 *   `ctx.rateLimiter`, `ctx.auth`, etc.
 * @returns {Promise<string>} JSON string
 */
export async function doState(project, ctx = {}) {
  // doState is filesystem-only — no memory client resolution needed today.
  // `ctx = {}` is accepted for signature parity with doSearch/doRecent/doList
  // and as the injection point for Phase B middleware (ctx.logger, ctx.metrics,
  // ctx.rateLimiter, ctx.auth). The `void ctx` below suppresses "unused param"
  // warnings without losing the documented DI surface.
  void ctx;
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
      safeLog(() => getLogger().error({
        request_id: currentRequestId(),
        endpoint: '/api/state/:project',
        project,
        path: relPath,
        err_code: err.code,
        err_message: err?.message,
      }, 'doState transient I/O error'), 'log:doState:transient-io');
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
 * @param {object} [ctx={}] - DI context; preferred shape `{ memory: MemoryClient }`
 *   for signature parity with the other list/state handlers. doRecent itself
 *   reads the vault filesystem and does not currently consume `ctx.memory`,
 *   but accepting ctx keeps the DI contract uniform across the read surface
 *   (A.8 sweep). Backward compatible: legacy callers that pass a bare memoryClient
 *   positionally as the fourth arg continue to work — the ternary tolerates it.
 *   Phase B/C/D will extend ctx with `ctx.logger`, `ctx.metrics`,
 *   `ctx.rateLimiter`, `ctx.auth`, etc.
 * @returns {Promise<{ results: Array<{id, title, snippet, body?}> }>}
 */
export async function doRecent(project, limit = 10, full = false, ctx = {}) {
  // doRecent is filesystem-only — no memory client resolution needed today.
  // `ctx = {}` is accepted for signature parity with doSearch/doList and as
  // the injection point for Phase B middleware (ctx.logger, ctx.metrics,
  // ctx.rateLimiter, ctx.auth). The `void ctx` below suppresses "unused param"
  // warnings without losing the documented DI surface.
  void ctx;
  if (!project || !/^[a-zA-Z0-9._-]+$/.test(project)) {
    throw new Error('Invalid project name: must match ^[a-zA-Z0-9._-]+$');
  }

  const subdir = `authored/${project}`;
  const relPaths = await listVaultFiles(subdir);

  if (relPaths.length === 0) {
    return listEnvelope([]);
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
        safeLog(() => getLogger().error({
          request_id: currentRequestId(),
          endpoint: '/api/recent/:project',
          project,
          path: relPath,
          err_message: err?.message,
        }, 'doRecent: skipping stat'), 'log:doRecent:stat-skip');
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
        safeLog(() => getLogger().error({
          request_id: currentRequestId(),
          endpoint: '/api/recent/:project',
          project,
          path: relPath,
          err_message: err?.message,
        }, 'doRecent: skipping read'), 'log:doRecent:read-skip');
        return null;
      }
    })
  );
  // DE3 / spec §6.1: strip internal system docs (e.g. _um_embedding_stamp)
  // before envelope serialization. doRecent reads the vault filesystem and
  // its records carry id at the top level (no metadata wrapper), so we use
  // the top-level-id variant of the helper. Single touchpoint covers
  // /api/recent/:project (the only public surface for doRecent).
  const results = filterSystemDocsByTopLevelId(resultsRaw.filter(Boolean));

  return listEnvelope(results);
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
 * Full shape (full=true): raw mem0 result objects inside the results array
 *   (preserves per-item raw mem0 fields for callers that request full).
 *
 * Returns the unified `{results: Array}` envelope per spec §4.1 (v0.6 breaking
 * change). Aligns /api/list with /api/search and /api/recent so all three read
 * endpoints share a consistent response shape. Callers that previously relied
 * on a bare array must migrate to `response.results` — see MIGRATION.md v0.5→v0.6.
 *
 * @param {boolean} [full=false] - false → compact shape; true → raw mem0 items
 * @param {number|null} [limit=null] - max items to return; null = unlimited
 * @param {object} [ctx={}] - DI context; preferred shape `{ memory: MemoryClient }`.
 *   Backward compatible: callers that pass a bare memoryClient (object with
 *   `.getAll()`) as the third arg continue to work — see `search-quality.test.mjs`
 *   which still uses that style. Defaults to the module-level `memory` binding.
 * @returns {Promise<{results: Array}>} envelope containing the items array
 */
export async function doList(full = false, limit = null, ctx = {}) {
  // DI resolution: prefer ctx.memory (new convention), then treat ctx itself as a
  // memoryClient if it exposes getAll (legacy positional pattern), else fall back
  // to the module-level memory binding used by real requests.
  const memoryClient = ctx?.memory ?? (typeof ctx?.getAll === 'function' ? ctx : memory);
  // C.11: wrap memoryClient.getAll — transient qdrant errors get up to 3 retries
  // before surfacing UPSTREAM_FAILURE. /api/list is request-path; covers MCP
  // memory_list as well via doList.
  // R1 review A1, fix #1: thread op label for um_mem0_ops_total.
  const all = await withRetry(() =>
    memoryClient.getAll({ userId: USER_ID })
      .catch((e) => { throw tagRetryable(e); })
  , { op: 'getAll' });
  const rawItems = all?.results || all || [];
  // DE3 / spec §6.1: strip internal system docs (e.g. _um_embedding_stamp)
  // BEFORE limit-slicing so the stamp does not consume one of the user's
  // requested slots. Single touchpoint covers /api/list + memory_list.
  const items = filterSystemDocs(rawItems);
  const sliced = (limit !== null && limit > 0) ? items.slice(0, limit) : items;
  // §4.1 extensibility contract: additive sibling fields on the memory-client
  // envelope (e.g., future `provider`, `latency_ms` for multi-provider
  // transparency) MUST propagate through to the wire response. listEnvelope()
  // accepts an `extras` object for exactly this reason. We forward any non-
  // `results` top-level keys the client returned — unknown siblings are
  // ignored by well-behaved parsers and available to forward-compat callers.
  const extras = {};
  if (all && typeof all === 'object' && !Array.isArray(all)) {
    for (const k of Object.keys(all)) {
      if (k !== 'results') extras[k] = all[k];
    }
  }
  if (full) {
    return listEnvelope(sliced, extras);
  }
  // Compact projection — consistent shape with doSearch compact items (minus score,
  // which is search-specific). id and title use the same fallback logic as doSearch.
  const results = sliced.map((r) => {
    const id = r.metadata?.id ?? r.id;
    const title = r.metadata?.title ?? r.metadata?.id ?? r.id ?? '(untitled)';
    const snippet = buildSnippet(title, r.memory);
    return { id, title, snippet };
  });
  return listEnvelope(results, extras);
}

/**
 * Factory: build the top-level HTTP request handler.
 *
 * Returning a factory (rather than exporting the handler directly) lets tests
 * inject a stubbed `ctx.memory` client without touching the module-level
 * binding used by the production bootstrap. The shape matches the DI convention
 * already used by doSearch/doList/doRecent/doState (A.8 sweep): `ctx.memory`
 * overrides the module-level `memory` binding; anything else falls back.
 *
 * A.9 wire-shape test requirement: integration tests need to listen on an
 * ephemeral port and exercise the real request → response path without a real
 * mem0/Qdrant/OpenAI stack. This factory is the minimal export that makes that
 * possible without rewriting any route logic.
 *
 * @param {object} [ctx={}] DI context; `ctx.memory` overrides the module-level
 *   memory binding for all do* calls and direct memory calls in this handler.
 *   Phase B/C/D will extend this with logger/metrics/rateLimiter/auth.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function createRequestHandler(ctx = {}) {
	// Resolve the memory client once per handler instance. Direct memory calls
	// in routes below (outside the do* helpers) use this resolved reference so
	// tests that inject ctx.memory see their stub in every code path.
	const resolvedMemory = () => ctx?.memory ?? memory;
	// C.7 / spec §4.2 step 5: per-handler rate-limiter. Created ONCE per
	// handler instance — the bucket Map is closed over and shared across
	// every request the handler serves. createRateLimiter() reads
	// UM_RATE_LIMIT_RPM / BURST / MAX_IPS from process.env at construction
	// time, matching the env-snapshot behavior of every other server knob.
	const admit = createRateLimiter();
	return async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	// W6.4 — include Authorization in the allowlist so browser-origin
	// clients (Custom GPT Actions, Claude.ai web connectors, third-party
	// integrations) can send `Authorization: Bearer <token>`. Without it,
	// the browser's CORS preflight rejects every authenticated request
	// before it reaches our auth layer — a silent break for v1.0's
	// public-facing API surface. Wildcard `Access-Control-Allow-Origin: *`
	// is intentional and compatible with bearer tokens (browsers block
	// `withCredentials` cookies on wildcard origin, but `Authorization`
	// headers are not credentials in the CORS sense).
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

	if (req.method === 'OPTIONS') {
		res.writeHead(200);
		res.end();
		return;
	}

	// C.3 / spec §4.2.0: /health is the liveness probe — every
	// k8s/load-balancer poll hits it. Wrapping in withRequestContext
	// would burn the 100 µs cumulative-cost budget; emitting a finish-
	// log per probe would also pollute logs. /health gets a fast direct
	// path: endpoint-class still applies (bypassAuth=true, returnStatus
	// never set for /health), but we skip ALS + the counter-finish log.
	if (url.pathname === '/health' && req.method === 'GET') {
		try {
			// DE5 / spec §6.1: after the startup guard stamps legacy collections,
			// getAll() includes the embedding-stamp doc. Filter system docs out of
			// the count so /health reflects user-facing memories only — preserves
			// the contract that operators reading this endpoint see real-doc count.
			const raw = await resolvedMemory().getAll({ userId: USER_ID });
			const items = Array.isArray(raw) ? raw : (raw?.results ?? []);
			const memories = filterSystemDocs(items).length;
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, memories }));
		} catch (err) {
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('SERVER_INTERNAL', 'health-check failed')));
			}
		}
		return;
	}

	// C.3 / spec §5.3: every non-/health request runs inside an ALS
	// scope so log calls deeper in the stack can pull request_id from
	// currentRequestId() without explicit threading. The wrap also
	// generates the request_id once per request (or honors an injected
	// X-Request-Id header for trace stitching across services).
	const incomingId = req.headers['x-request-id'];
	return withRequestContext({ id: typeof incomingId === 'string' ? incomingId : undefined }, async () => {
	const startedAt = Date.now();
	const routeTemplate = resolveRouteTemplate(url.pathname, req.method);

	// Counter-finish log emitter — invoked once per request via res.end
	// shim below. `extras` lets the per-route handlers attach the
	// `tool` (MCP) or any other late-bound field. Project comes from
	// the URL for /api/recent/:project + /api/state/:project; other
	// REST routes don't carry a project.
	const finishLogExtras = {};
	const setFinishLogExtra = (k, v) => { finishLogExtras[k] = v; };
	let finishLogEmitted = false;
	const emitFinishLog = () => {
		if (finishLogEmitted) return;
		finishLogEmitted = true;
		const ms = Date.now() - startedAt;
		const obj = {
			request_id: currentRequestId(),
			endpoint: routeTemplate || url.pathname,
			status: res.statusCode,
			ms,
			...finishLogExtras,
		};
		const project = extractProjectFromPath(url.pathname);
		if (project) obj.project = project;
		// C.9 (§4.2.0): pino throws on log-write failure (full disk on
		// the log partition). Wrap each emit so a logger failure can't
		// poison the response path. obs-fallback writes to stderr at
		// most once per minute — never recurses through pino.
		try {
			// Error-bucket logs go via warn/error directly (with error_code +
			// error_class). The counter-finish log uses info for the success
			// case and warn/error already emit their own structured line.
			if (res.statusCode >= 500) {
				getLogger().error(obj, 'request');
			} else if (res.statusCode >= 400) {
				getLogger().warn(obj, 'request');
			} else {
				getLogger().info(obj, 'request');
			}
		} catch (e) {
			obsFallback(e, 'log:request-finish');
		}
	};
	// C.5: counter-finish metrics emit. Same callsite as the log emit
	// so the routeTemplate computation is shared (single source of
	// truth - log + metric MUST agree on the endpoint label).
	// Skipped for /metrics itself (recursive scrape artifact). /health
	// is already opted out above the ALS wrap, so it never reaches
	// this code path.
	//
	// C.9 (§4.2.0): on prom-client throw (label-cardinality / label-shape
	// violation, transport hiccup), drop into obs-fallback rather than
	// the structured logger. If pino is the failing emitter, that path
	// would recurse. obs-fallback writes directly to stderr at most once
	// per minute — request continues.
	let metricsEmitted = false;
	const emitMetrics = () => {
		if (metricsEmitted) return;
		metricsEmitted = true;
		if (url.pathname === '/metrics') return;
		try {
			const ms = Date.now() - startedAt;
			// R1 review C6, fix #2: cardinality fence. Unknown paths
			// (resolveRouteTemplate→null) bucket under '/__unknown__' so an
			// attacker spraying /api/foo, /api/bar, /api/baz cannot grow the
			// prom-client registry unboundedly. Per-IP rate-limit (60 RPM) is a
			// partial natural throttle; multi-IP would still amplify without
			// this fence.
			const endpoint = routeTemplate || '/__unknown__';
			httpRequestsTotal.inc({ endpoint, status: String(res.statusCode) });
			httpRequestDurationSeconds.observe({ endpoint }, ms / 1000);
		} catch (e) {
			obsFallback(e, `metrics:request:${routeTemplate || '/__unknown__'}`);
		}
	};
	// Shim res.end so every code path (200, 4xx, 5xx, early-return)
	// flushes the §5.3 finish log + C.5 metrics emit without each
	// route handler having to remember.
	const _origEnd = res.end.bind(res);
	res.end = function (...args) {
		try { emitFinishLog(); } catch { /* logging must never break the response */ }
		try { emitMetrics(); } catch { /* metrics must never break the response */ }
		return _origEnd(...args);
	};

	// ---------------------------------------------------------------
	// Middleware chain (spec §4.2 step 3-7) — B.6.
	//
	// Inserted at handler entry so every /api/* and /mcp request flows
	// through endpoint-class routing + bearer-auth enforcement before
	// any route handler runs. Loopback bypass keeps local-dev ergonomic
	// (UM_ALLOW_LOOPBACK_NOAUTH=true by default), forwarded-header
	// default-deny prevents a proxy / tunnel from impersonating it.
	// ---------------------------------------------------------------

	// Step 3: endpoint-class routing.
	const sourceIp = req.socket?.remoteAddress ?? null;
	const route = endpointClassRoute(req, process.env, sourceIp);

	// Step 3a: hard short-circuit — e.g. /metrics 404 off-loopback.
	if (route.returnStatus) {
		res.writeHead(route.returnStatus);
		res.end();
		return;
	}

	// Step 4: auth check. Skipped when the endpoint-class row says
	// bypassAuth (e.g. /health) OR when loopback-bypass applies AND
	// no forwarded header is present.
	if (!route.bypassAuth && !shouldBypassLoopback(req)) {
		const expected = process.env.UM_AUTH_TOKEN;
		if (!expected) {
			// Counter-finish log fires via res.end shim; emit a structured
			// warn here so ops sees the misconfiguration distinctly from a
			// generic 500.
			safeLog(() => getLogger().error({
				request_id: currentRequestId(),
				endpoint: routeTemplate || url.pathname,
				status: 500,
				error_code: 'SERVER_INTERNAL',
				error_class: 'auth_unconfigured',
			}, 'auth misconfigured'), 'log:auth:misconfigured');
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(errorResponse(
				'SERVER_INTERNAL',
				'server auth not configured (UM_AUTH_TOKEN unset)'
			)));
			return;
		}
		const received = extractBearer(req);
		const tokenMatches = received != null && compareTokens(received, expected);
		if (!tokenMatches) {
			// C.3 / §5.3: distinguish auth_missing from auth_wrong in logs
			// so ops can tell "client never sent a token" from "client sent
			// the wrong token" — useful for debugging plugin-version drift.
			// Wire-response stays AUTH_INVALID for both (attacker can't
			// differentiate).
			const errorClass = received == null ? 'auth_missing' : 'auth_wrong';
			safeLog(() => getLogger().warn({
				request_id: currentRequestId(),
				endpoint: routeTemplate || url.pathname,
				status: 401,
				error_code: 'AUTH_INVALID',
				error_class: errorClass,
			}, 'auth failed'), 'log:auth:failed');
			// Round-8 upgrade hint: legacy plugins (pre-v0.6) lack an
			// identifying User-Agent. When the UA is missing or not a
			// UM client, steer the user toward the plugin upgrade flow;
			// recognized UM clients get the terse message (they know).
			const ua = req.headers['user-agent'] || '';
			const isUmClient = /um-(cli|bridge|plugin)\//.test(ua);
			const hint = isUmClient
				? 'invalid or missing bearer token'
				: 'invalid or missing bearer token — upgrade plugin to v0.6+ via `git pull && bash installer/install.sh --plugin-cc` or set Authorization: Bearer <token from ~/.um/auth-token>';
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(errorResponse('AUTH_INVALID', hint)));
			return;
		}
	}

	// Step 5: rate-limit (C.7, spec §4.2 step 5). Bypass conditions
	// MIRROR auth bypass exactly:
	//   - route.bypassRateLimit (endpoint-class B.2: /health, /metrics
	//     loopback-only branch, /openapi?gpt=1) → always skip.
	//   - shouldBypassLoopback(req): pure loopback + no forwarded
	//     headers → skip. Local CC plugin from same machine is NEVER
	//     rate-limited; tunnel / proxy traffic IS. This is the same
	//     defense-in-depth posture as auth (step 4 above).
	// Over-limit:
	//   - 429 with Retry-After header in seconds (RFC 7231 §7.1.3).
	//   - Body uses §5.1 unified envelope via errorResponse() —
	//     LIMIT_RATE_EXCEEDED auto-tags retryable:true.
	//   - res.end shim flushes the C.5 metrics counter for status=429
	//     and the C.3 finish-log on the way out.
	if (!route.bypassRateLimit && !shouldBypassLoopback(req)) {
		const ipKey = extractRateLimitKey(req);
		const decision = admit(ipKey);
		if (!decision.admitted) {
			res.writeHead(429, {
				'Content-Type': 'application/json',
				'Retry-After': String(decision.retryAfterSec),
			});
			res.end(JSON.stringify(errorResponse(
				'LIMIT_RATE_EXCEEDED',
				'rate limit exceeded',
			)));
			return;
		}
	}

	// B.6b: UM_HTTP_MAX_REQUEST_BYTES cap enforced inside readBody() below.
	//   Overrun throws an error with .code='INPUT_TOO_LARGE' which is caught
	//   at the end of this handler → 413 INPUT_TOO_LARGE envelope response.
	//   Fires BEFORE JSON-parse or any field-level validator (spec §5.2
	//   precedence 1).
	// C.5: counter-finish metrics emit wired in res.end shim above.

	try {
		// /health is handled BEFORE the ALS wrap (top of this handler)
		// per spec §4.2.0 — opted out for the 100µs liveness budget.
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
		// C.5 / spec 4.2: /metrics returns Prometheus text exposition.
		// Endpoint-class router (B.2) already decided routing policy:
		//   - loopback-only + loopback IP -> bypass auth + rate-limit
		//   - loopback-only + non-loopback -> 404 short-circuit (above)
		//   - public + UM_METRICS_AUTH_REQUIRED=true -> auth required
		//   - public + UM_METRICS_AUTH_REQUIRED=false -> bypass
		// /metrics is OUT of the rate-limit path (bypassRateLimit=true on
		// the loopback branch) so legitimate Prometheus scrapes from
		// loopback are never 429'd at steady 15s scrape intervals.
		if (url.pathname === '/metrics' && req.method === 'GET') {
			const text = await registry.metrics();
			res.writeHead(200, { 'Content-Type': registry.contentType });
			res.end(text);
			return;
		}
		if (url.pathname === '/mcp' && req.method === 'POST') {
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch (e) {
				// B.6b: re-throw INPUT_TOO_LARGE so the outer catch emits the 413
				// envelope.
				if (e && e.code === 'INPUT_TOO_LARGE') throw e;
				// B.13 (§5.1) JSON-RPC dual-shape: malformed JSON-RPC request →
				// JSON-RPC standard parse-error -32700. The OUTER transport
				// envelope is a well-formed JSON-RPC response; the body is the
				// numeric parse-error code. Inner envelope uses the unified
				// shape via toJsonRpcError() for the data block.
				const parseEnvelope = errorResponse('INPUT_INVALID', 'invalid JSON body');
				const rpcErr = toJsonRpcError(parseEnvelope);
				// Override the standard parse-error code per JSON-RPC 2.0.
				rpcErr.code = -32700;
				rpcErr.message = 'Parse error';
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: rpcErr }));
				return;
			}
			// C.3 / spec §5.3: surface the tool name to the counter-finish
			// log so the MCP path log carries `tool` per the contract. Only
			// tools/call carries a tool name; initialize / tools/list don't.
			if (body && body.method === 'tools/call' && body.params?.name) {
				setFinishLogExtra('tool', body.params.name);
			} else if (body && typeof body.method === 'string') {
				setFinishLogExtra('tool', body.method);
			}
			// Forward DI ctx so handleToolCall → do* helpers see the injected
			// memory stub in tests, mirroring the REST routes' pattern.
			const result = await handleMcpMessage(body, ctx);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(result ? JSON.stringify(result) : '');
			return;
		}
		if (url.pathname === '/api/search' && req.method === 'POST') {
			const { query, limit = 5, include_superseded = false, filters, full: fullBody } = JSON.parse(await readBody(req));
			if (!query || typeof query !== 'string' || !query.trim()) {
				res.writeHead(400, {'Content-Type': 'application/json'});
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'query is required')));
				return;
			}
			const includeSup = include_superseded === true;
			const rawLimitPost = typeof limit === 'number' ? limit : parseInt(limit, 10);
			const clampedLimitPost = Number.isFinite(rawLimitPost) && rawLimitPost > 0 ? Math.min(rawLimitPost, 100) : 5;
			const fullReq = fullBody === true || url.searchParams.get('full') === '1';
			// Always fetch full results (metadata preserved) so metadata post-filters work,
			// then project to compact shape at the end if the client did not request full.
			let response = await doSearch(query, clampedLimitPost, includeSup, true, ctx);
			// Optional metadata filters (project, type) — post-filter after mem0 recall
			if (filters && typeof filters === 'object') {
				let items = response.results;
				if (filters.project) items = items.filter((r) => (r.metadata || {}).project === filters.project);
				if (filters.type) items = items.filter((r) => (r.metadata || {}).type === filters.type);
				// Preserve §4.1 siblings (e.g., provider, latency_ms) that doSearch
				// propagated from the upstream memory.search() envelope. Only
				// `results` is replaced; every other top-level key is forwarded.
				const { results: _prev, ...responseExtras } = response;
				response = listEnvelope(items, responseExtras);
			}
			// Project to compact shape unless caller explicitly requested full.
			if (!fullReq) {
				const compact = response.results.map((r) => ({
					id: r.id,
					title: r.title,
					score: r.score,
					snippet: buildSnippet(r.title, r.body),
				}));
				// Preserve §4.1 siblings through the compact projection — same
				// extensibility contract as the filter branch above.
				const { results: _prev, ...responseExtras } = response;
				response = listEnvelope(compact, responseExtras);
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
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'q parameter is required')));
				return;
			}
			// Always fetch full results (metadata preserved) so metadata typeFilter works,
			// then project to compact shape at the end if the client did not request full.
			let response = await doSearch(q, limit, includeSuperseded, true, ctx);
			if (typeFilter) {
				const items = (response.results || []).filter((r) => (r.metadata || {}).type === typeFilter);
				// Preserve §4.1 siblings (e.g., provider, latency_ms) that doSearch
				// propagated from the upstream memory.search() envelope. Only
				// `results` is replaced; every other top-level key is forwarded.
				const { results: _prev, ...responseExtras } = response;
				response = listEnvelope(items, responseExtras);
			}
			// Project to compact shape unless caller explicitly requested full.
			if (!fullReq) {
				const compact = response.results.map((r) => ({
					id: r.id,
					title: r.title,
					score: r.score,
					snippet: buildSnippet(r.title, r.body),
				}));
				// Preserve §4.1 siblings through the compact projection — same
				// extensibility contract as the typeFilter branch above.
				const { results: _prev, ...responseExtras } = response;
				response = listEnvelope(compact, responseExtras);
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
			return;
		}
		if (url.pathname === '/api/add' && req.method === 'POST') {
			const { text, metadata } = JSON.parse(await readBody(req));
			// v0.8 G2: umAdd routes through embed()/facts() orchestrators which
			// emit um_provider_*{surface=embed|facts} metrics in prod. The outer
			// withRetry wrapping is preserved for tagRetryable continuity.
			const result = await withRetry(() =>
				umAdd({ memory: resolvedMemory(), text, userId: USER_ID, ...(metadata && { metadata }), infer: true, _qdrantClient: ctx._qdrantClient, _factsProviderOverride: ctx._factsProviderOverride, _embedProviderOverride: ctx._embedProviderOverride })
					.catch((e) => { throw tagRetryable(e); })
			, { op: 'add' });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(result));
			return;
		}
		if (url.pathname === '/api/list' && req.method === 'GET') {
			// Spec §4.1 (v0.6): returns { results: [...] } envelope — unified with
			// /api/search and /api/recent. Compact shape by default; ?full=1 returns
			// raw mem0 items inside the results array.
			const full = url.searchParams.get('full') === '1';
			const limitStr = url.searchParams.get('limit');
			const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 0, 1000) : null;
			const response = await doList(full, limit, ctx);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
			return;
		}
		// GET /api/recent/:project — list recent authored docs by filesystem mtime, compact shape
		if (url.pathname.startsWith('/api/recent/') && req.method === 'GET') {
			const projectSegment = decodeURIComponent(url.pathname.slice('/api/recent/'.length));
			const rawLimit = parseInt(url.searchParams.get('limit') || '10', 10);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 10;
			const full = url.searchParams.get('full') === '1';
			try {
				const result = await doRecent(projectSegment, limit, full, ctx);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(result));
			} catch (err) {
				if (/Invalid project name/.test(err.message)) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(errorResponse('INPUT_INVALID', err.message)));
				} else {
					safeLog(() => getLogger().error({
						request_id: currentRequestId(),
						endpoint: '/api/recent/:project',
						err_message: err?.message,
					}, '/api/recent error'), 'log:recent:handler-error');
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(errorResponse('SERVER_INTERNAL', 'internal_error')));
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
				res.end(JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'Invalid project name: must match ^[a-zA-Z0-9._-]+$',
				)));
				return;
			}
			// Delegates to extracted doState() for DI testability (B.1.4b Step 0a).
			// R5-L1: preserve Content-Type header — ChatGPT Custom GPT actions and
			// other REST clients expect application/json; Node's autodetection would
			// fall back to text/plain and break downstream callers.
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(await doState(projectSegment, ctx));
			return;
		}
		if (url.pathname === '/api/reindex' && req.method === 'POST') {
			let reqBody;
			try {
				reqBody = JSON.parse(await readBody(req));
			} catch (e) {
				// B.6b: re-throw INPUT_TOO_LARGE so the outer catch emits the 413
				// envelope — don't swallow body-cap overruns as "invalid JSON".
				if (e && e.code === 'INPUT_TOO_LARGE') throw e;
				res.writeHead(400, {'Content-Type': 'application/json'});
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'invalid JSON body')));
				return;
			}
			const { path: relPath } = reqBody;

			// 1. path present
			if (!relPath || typeof relPath !== 'string' || !relPath.trim()) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'path is required')));
				return;
			}

			// 2. read file (throws on traversal or ENOENT)
			let fileText;
			try {
				fileText = await readVaultFile(relPath);
			} catch (err) {
				if (err.code === 'ENOENT') {
					res.writeHead(404, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(errorResponse('STATE_NOT_FOUND', `File not found: ${relPath}`)));
					return;
				}
				if (err.message && err.message.includes('traversal')) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(errorResponse('INPUT_INVALID', `Path traversal detected: ${relPath}`)));
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
				res.end(JSON.stringify(errorResponse(
					'INPUT_INVALID',
					`Missing required frontmatter fields: ${missing.join(', ')}`,
				)));
				return;
			}

			// 5. state type rejected
			if (fm.type === 'state') {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'state.md is never reindexed — use /api/state (Task 10)',
				)));
				return;
			}

			// 6. filename stem must match metadata.id
			const stem = path.basename(relPath, '.md');
			if (stem !== fm.id) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse(
					'INPUT_INVALID',
					`id mismatch: frontmatter id "${fm.id}" does not match filename stem "${stem}"`,
				)));
				return;
			}

			// 7. upsert: delete all existing entries with this metadata.id, then add
			const targetId = fm.id;
			// TODO(v0.6): no mutex on delete+add — concurrent reindex for same id may produce duplicates. Acceptable at current single-user CLI-driven scale.
			await deleteByMetadataId(targetId);

			// 8. build metadata from frontmatter (schema_version defaults to 1 if absent)
			const metadata = {
				schema_version: 1,
				...fm,
			};

			// Compose a meaningful text to add to mem0 (title + body excerpt)
			const docText = `${fm.title}\n\n${body.trim()}`;
			// v0.8 G2: see /api/add migration.
			await withRetry(() =>
				umAdd({ memory: resolvedMemory(), text: docText, userId: USER_ID, metadata, infer: false })
					.catch((e) => { throw tagRetryable(e); })
			, { op: 'add' });

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, path: relPath, id: targetId, indexed: true }));
			return;
		}
		if (url.pathname === '/api/append-turn' && req.method === 'POST') {
			let reqBody;
			try {
				reqBody = JSON.parse(await readBody(req));
			} catch (e) {
				// B.6b: re-throw INPUT_TOO_LARGE — see /api/reindex above.
				if (e && e.code === 'INPUT_TOO_LARGE') throw e;
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'invalid JSON body')));
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
			} catch (e) {
				// B.6b: re-throw INPUT_TOO_LARGE — see /api/reindex above.
				if (e && e.code === 'INPUT_TOO_LARGE') throw e;
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'invalid JSON body')));
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
			} catch (e) {
				// B.6b: re-throw INPUT_TOO_LARGE — see /api/reindex above.
				if (e && e.code === 'INPUT_TOO_LARGE') throw e;
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'invalid JSON body')));
				return;
			}
			const hasMetadata = reqBody.metadata !== undefined;
			const hasId = reqBody.id !== undefined;
			if (hasMetadata && hasId) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'provide either metadata.id or id, not both',
				)));
				return;
			}
			if (!hasMetadata && !hasId) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse(
					'INPUT_INVALID',
					'provide either metadata.id (Shape A) or id (Shape B)',
				)));
				return;
			}
			if (hasMetadata) {
				// Shape A: delete by metadata.id
				const targetId = reqBody.metadata?.id;
				if (!targetId || typeof targetId !== 'string' || !targetId.trim()) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(errorResponse(
						'INPUT_INVALID',
						'metadata.id is required and must be a non-empty string',
					)));
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
					res.end(JSON.stringify(errorResponse(
						'INPUT_INVALID',
						'id is required and must be a non-empty string',
					)));
					return;
				}
				try {
					// R1 review B11, fix #3: wrap mem0.delete. Idempotent op
					// (delete-same-id twice = no-op) so retry is safe; uniformity
					// with the other request-path mem0 calls outweighs the
					// argument that delete is "already idempotent."
					await withRetry(() =>
						resolvedMemory().delete(uuid)
							.catch((e) => { throw tagRetryable(e); })
					, { op: 'delete' });
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, deleted: 1, query: `id=${uuid}` }));
				} catch (err) {
					// mem0 may throw if UUID not found — treat as 0 deleted.
					// withRetry wraps in UPSTREAM_FAILURE on retry-exhaustion;
					// either path lands here and is normalized to deleted: 0.
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, deleted: 0, query: `id=${uuid}` }));
				}
				return;
			}
		}
		if (url.pathname.startsWith('/api/') && req.method === 'DELETE') {
			const id = url.pathname.split('/api/')[1];
			// R1 review B11, fix #3: wrap mem0.delete. Idempotent op so retry
			// is safe; matches the wrapping of POST /api/delete Shape B above.
			await withRetry(() =>
				resolvedMemory().delete(id)
					.catch((e) => { throw tagRetryable(e); })
			, { op: 'delete' });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ deleted: id }));
			return;
		}
		// B.13 (§5.1): unknown route → STATE_NOT_FOUND envelope (HTTP 404).
		// Replaces the legacy plain-text "Not Found" body so every 4xx/5xx on
		// /api/* shares the unified §5.1 wire shape.
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(errorResponse('STATE_NOT_FOUND', 'route not found')));
	} catch (err) {
		// B.6b: request-body cap overruns throw err with .code='INPUT_TOO_LARGE'.
		// Convert to 413 v0.6 envelope — same envelope the field-level
		// MAX_CONTENT_BYTES path emits (spec §5.2 unified error code).
		// Guard against writing headers twice (req.destroy() may have already
		// fired a response in some races — `res.headersSent` short-circuits).
		if (err && err.code === 'INPUT_TOO_LARGE') {
			if (!res.headersSent) {
				res.writeHead(413, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('INPUT_TOO_LARGE', err.message)));
			}
			return;
		}
		// B.13 (§5.1): SyntaxError from inline JSON.parse(await readBody(...))
		// in /api/search POST and /api/add POST → INPUT_INVALID. Other inline
		// JSON-parse paths (reindex, append-turn, checkpoint, delete) wrap in
		// their own try/catch and emit INPUT_INVALID directly.
		if (err instanceof SyntaxError) {
			if (!res.headersSent) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('INPUT_INVALID', 'invalid JSON body')));
			}
			return;
		}
		// R1 review B11, fix #3: withRetry surfaces UPSTREAM_FAILURE on
		// retry-exhaustion. Without this branch the outer catch falls through
		// to SERVER_INTERNAL → 500, which defeats the "retry, then 502" intent
		// of withRetry-wrapping the request-path mem0 calls. Map to 502 via
		// the unified envelope so clients see a retryable: true error.
		if (err && err.code === 'UPSTREAM_FAILURE') {
			if (!res.headersSent) {
				res.writeHead(httpStatusFor('UPSTREAM_FAILURE'), { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(errorResponse('UPSTREAM_FAILURE', err.message ?? 'upstream failed')));
			}
			return;
		}
		safeLog(() => getLogger().error({
			request_id: currentRequestId(),
			endpoint: routeTemplate || url.pathname,
			err_message: err?.message,
			err_stack: err?.stack,
		}, 'unhandled error'), 'log:unhandled-error');
		// B.13 (§5.1): unhandled exception → SERVER_INTERNAL envelope.
		// In production, omit the message to avoid leaking internals; in dev
		// keep the original message to preserve debuggability.
		const userMsg = process.env.NODE_ENV === 'production' ? 'internal_error' : err.message;
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(errorResponse('SERVER_INTERNAL', userMsg)));
		}
	}
	}); // close withRequestContext
	};
}

// Module-level server instance — used by the IS_MAIN bootstrap below. Tests
// import createRequestHandler directly and start their own http.createServer on
// an ephemeral port (see api-list-wire-shape.test.mjs).
const server = createServer(createRequestHandler());

// Bootstrap — only runs when this file is invoked directly (not when imported
// for tests). IS_MAIN is computed at the top of the file; see its comment.
if (IS_MAIN) {
	await initMemory();
	server.listen(PORT, '0.0.0.0', () => {
		console.log(`[mem0-mcp] HTTP server listening on 0.0.0.0:${PORT}`);
		console.log('[mem0-mcp] Endpoints: /health, /openapi.yaml, /mcp (JSON-RPC), /api/*');
	});
}
