/**
 * server/lib/mem0-read.mjs — mem0ai 3.x read-path adapters (#231).
 *
 * WHY. mem0ai 3.x rejects top-level entity params on search()/getAll() and
 * consumes SNAKE_CASE keys (`user_id`) from `filters` — but UM's storage
 * model stores camelCase `userId` payload keys (written natively by umAdd's
 * buildPayload and pinned by test/storage-model.test.mjs; the v0.8 G2
 * orchestrator never writes through mem0.add, so no UM point has ever
 * carried `user_id`). Two adapters keep UM's payload schema authoritative
 * WITHOUT any vault data migration:
 *
 * - searchConfig(): mem0 3.x's filter normalizer passes NON-entity keys
 *   through verbatim to the vector store, so `filters: { userId }` filters
 *   qdrant on UM's actual payload key. `topK` replaces 2.4.6's `limit`
 *   (which 3.x silently ignores → default 20), and `threshold: 0` disables
 *   3.x's NEW default relevance floor (0.1) — 2.4.6 had none, and relevance
 *   policy belongs to UM's own ranking pipeline (cf. the measured-negative
 *   score-floor result that parked PR #130 and the bouncer cost decision).
 *
 * - umGetAll(): 3.x getAll() HARD-REQUIRES a snake_case entity key in
 *   filters ("filters must contain at least one of: user_id, agent_id,
 *   run_id") which can never match UM's payloads — so enumeration moves to
 *   a native qdrant scroll projecting the EXACT 2.4.6 getAll result shape
 *   ({ results: [{ id, memory, hash, createdAt, updatedAt, metadata,
 *   userId }] }) so existing consumers (doList, stats corpus fetch, compat
 *   scan, deleteByMetadataId, the DE5 stamp read) keep their contract
 *   unchanged.
 *
 * The warmup call in initMemory deliberately does NOT use these adapters —
 * it stays on memory.getAll() precisely because it must drive mem0's
 * public-call init surface (spec F14: the constructor swallows init errors;
 * the legacy-qdrant gate's discriminator depends on the warmup surfacing
 * them).
 */
import { getRealClient } from './qdrant-client-resolver.mjs';

/**
 * mem0 3.x search() config for a UM-scoped query.
 * @param {Object} args
 * @param {string} args.userId  UM operator id (camelCase payload key)
 * @param {number} [args.limit] page size; maps to 3.x `topK` (omit → mem0 default)
 */
export function searchConfig({ userId, limit } = {}) {
  const cfg = { filters: { userId }, threshold: 0 };
  if (limit !== undefined) cfg.topK = limit;
  return cfg;
}

// mem0ai 2.4.6's getAll defaulted to limit=100; preserved so enumeration
// callers keep their measured behavior (the U2 #171 audit note documents
// the explicit FULL_SCAN_LIMIT escape for true full scans).
const DEFAULT_LIMIT = 100;

// Mirror of mem0ai 2.4.6's getAll projection `excludedKeys` — everything
// else in the payload lands under `metadata`.
const EXCLUDED_KEYS = new Set(['userId', 'agentId', 'runId', 'hash', 'data', 'createdAt', 'updatedAt']);

/** mem0 2.4.6 result-entry projection, shared by umGetAll and umSearch. */
function projectPoint(mem) {
  return {
    id: mem.id,
    memory: mem.payload.data,
    hash: mem.payload.hash,
    createdAt: mem.payload.createdAt,
    updatedAt: mem.payload.updatedAt,
    metadata: Object.entries(mem.payload)
      .filter(([key]) => !EXCLUDED_KEYS.has(key))
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
    ...(mem.payload.userId && { userId: mem.payload.userId }),
    ...(mem.payload.agentId && { agentId: mem.payload.agentId }),
    ...(mem.payload.runId && { runId: mem.payload.runId }),
  };
}

/** UM's camel-key qdrant scope filter. */
const scopeFilter = (userId) => ({ must: [{ key: 'userId', match: { value: userId } }] });

/**
 * Native-scroll replacement for mem0 getAll(), 2.4.6-shape-compatible.
 * @param {Object} memory  mem0 Memory instance (config carries host/port/collection)
 * @param {Object} args    { userId, limit? }
 * @param {Object} [deps]  DI seam for tests: { getClient }
 */
export async function umGetAll(memory, { userId, limit = DEFAULT_LIMIT } = {}, { getClient = getRealClient } = {}) {
  const client = await getClient(memory);
  const collection = memory.config.vectorStore.config.collectionName;
  const res = await client.scroll(collection, {
    filter: scopeFilter(userId),
    limit,
    with_payload: true,
    with_vector: false,
  });
  return { results: (res?.points ?? []).map(projectPoint) };
}

/**
 * Native dense search replacement for mem0 search() (#231 A9 finding).
 *
 * mem0 3.x's search() UNCONDITIONALLY requires a snake entity key in its
 * normalized filters (even empty filters throw) — so no filter shape can
 * both satisfy the validator AND match UM's camelCase payloads. The native
 * read composes the pieces mem0 would have used anyway: mem0's OWN embedder
 * instance (config-driven, provider-correct, dims preset) + a qdrant dense
 * search scoped on UM's actual payload key + the 2.4.6 projection with the
 * raw cosine score. Behaviorally identical to 2.4.6's search for UM data
 * (spec F17: no sparse vectors / entity records / expiration payloads on
 * any UM point; no threshold — 2.4.6 had none).
 *
 * @param {Object} memory  mem0 Memory instance (embedder + vectorStore config)
 * @param {string} query
 * @param {Object} args    { userId, limit? }
 * @param {Object} [deps]  DI seam for tests: { getClient }
 */
export async function umSearch(memory, query, { userId, limit } = {}, { getClient = getRealClient } = {}) {
  const vector = await memory.embedder.embed(query);
  const client = await getClient(memory);
  const collection = memory.config.vectorStore.config.collectionName;
  const hits = await client.search(collection, {
    vector,
    filter: scopeFilter(userId),
    ...(limit !== undefined && { limit }),
    with_payload: true,
  });
  return { results: (hits ?? []).map((hit) => ({ ...projectPoint(hit), score: hit.score })) };
}

/**
 * Wrap a real mem0 Memory so `.search` routes through umSearch while every
 * other member delegates untouched. Installed ONCE at initMemory — the
 * `ctx?.memory ?? memory` DI seam and every `.search(query, searchConfig(...))`
 * call site keep their shapes (searchConfig's cfg is translated here), and
 * test fakes substitute wholesale exactly as before. `.getAll` is
 * DELIBERATELY not wrapped: the warmup must keep driving mem0's real public
 * surface (spec F14 — the legacy-gate discriminator), and enumeration
 * callers use umGetAll explicitly. Methods bind to the TARGET so mem0's
 * internal state/privates never see the proxy.
 */
export function wrapMem0Read(memory, deps) {
  return new Proxy(memory, {
    get(target, prop) {
      if (prop === 'search') {
        return (query, cfg = {}) =>
          umSearch(target, query, { userId: cfg?.filters?.userId, limit: cfg?.topK }, deps);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
