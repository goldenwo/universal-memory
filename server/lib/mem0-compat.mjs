/**
 * server/lib/mem0-compat.mjs — pure pieces of the mem0 Platform-compat facade.
 *
 * Spec: docs/plans/2026-07-02-mem0-compat-facade-spec.md §3 (Filter DSL),
 * §4 (Record projection). This module owns ONLY the pure translation layer:
 *
 *   - parseMem0Filters / applyMem0Filters — the client-pinned filter-DSL
 *     subset, normalized to a predicate descriptor and applied facade-side
 *     post-retrieval (UM internals expose no filtered retrieval — spec §3).
 *     Unknown keys / malformed shapes fail loud (CompatFilterError → 400 at
 *     the route layer): a 400 beats a silently wrong result set.
 *   - toMem0Record — RAW mem0 record ({id, memory, metadata?, score?} from
 *     raw memoryClient.search/getAll, NOT doSearch's projection) → mem0
 *     dialect: camelCase internals (userId/createdAt/updatedAt) translated
 *     to snake_case, `categories` synthesized from metadata.lane + any
 *     stored categories, absent fields OMITTED (client uses ?? fallbacks).
 *   - toMem0AddResults — umAdd's {results:[{id, memory, event}]} projected
 *     defensively to the mem0 add-response shape, internal events translated
 *     to the dialect vocabulary (ADD | UPDATE | NONE — COMPAT_EVENT_MAP).
 *
 *   - handleMem0Compat — the compat-route dispatcher: method+path → per-route
 *     handler returning {status, body} in the mem0 error dialect ({detail}).
 *     Batch 3 (plan Tasks 4-6) owns the business logic. Handlers receive the
 *     DI ctx forwarded by mem0-mcp-http.mjs's compat dispatch site:
 *       ctx.userId  — RESOLVED_USER_ID (spec §5 single-operator identity)
 *       ctx.memory  — the mem0 Memory client (raw search/getAll/delete)
 *     plus the house `_`-prefixed test seams (_qdrantClient, _umAdd,
 *     _factsProviderOverride, _embedProviderOverride) — same seam names as
 *     umAdd so production forwards them untouched.
 *
 * Endpoint-class row + Step-4 auth selection live in endpoint-class.mjs /
 * auth.mjs / mem0-mcp-http.mjs (spec §6) — not here.
 */

import { umAdd as defaultUmAdd, md5 } from './add.mjs';
import { surfaceFromHeaders } from './capture-events.mjs';
import { D3_SERVER_MANAGED_STATUS_FIELDS } from './dedup-constants.mjs';
import { embed as defaultEmbed } from './embed.mjs';
import { getLogger } from './logger.mjs';
import { getRealClient } from './qdrant-client-resolver.mjs';
import { isRecallable } from './recallable.mjs';
import { noteRecallSearch } from './recall-telemetry.mjs';
import { withRetry } from './retry.mjs';
import { filterSystemDocs } from './system-docs.mjs';
import { SERVER_VERSION } from './version.mjs';

/** Typed error for filter-DSL violations; the route layer maps it to 400. */
export class CompatFilterError extends Error {
  /**
   * @param {string} message
   * @param {string} key — the offending filter key (surfaced in the 400 detail)
   */
  constructor(message, key) {
    super(message);
    this.name = 'CompatFilterError';
    this.key = key;
  }
}

/** Filter keys accepted as bare string equality (spec §3 Filter DSL). */
const EQUALITY_KEYS = new Set(['user_id', 'agent_id', 'app_id', 'run_id']);

/**
 * Parse one flat condition object (e.g. {user_id:"u"} or
 * {created_at:{gte,lte}}) into normalized {key, op, value} conditions.
 * Rejects nested AND/OR (only accepted at top level) and unknown keys.
 *
 * @param {object} obj
 * @returns {{key: string, op: string, value: string}[]}
 */
function parseFlatCondition(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new CompatFilterError('filter condition must be an object', String(obj));
  }
  const conditions = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'AND' || key === 'OR') {
      throw new CompatFilterError(`${key} is only accepted at the top level of filters`, key);
    }
    if (EQUALITY_KEYS.has(key)) {
      if (typeof value !== 'string') {
        throw new CompatFilterError(`filter key "${key}" requires a string value`, key);
      }
      conditions.push({ key, op: 'eq', value });
    } else if (key === 'categories') {
      if (value === null || typeof value !== 'object' || typeof value.contains !== 'string') {
        throw new CompatFilterError('filter key "categories" requires {contains: string}', key);
      }
      conditions.push({ key, op: 'contains', value: value.contains });
    } else if (key === 'created_at') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new CompatFilterError('filter key "created_at" requires {gte?: string, lte?: string}', key);
      }
      let matched = false;
      for (const op of ['gte', 'lte']) {
        if (value[op] === undefined) continue;
        if (typeof value[op] !== 'string') {
          throw new CompatFilterError(`created_at.${op} must be an ISO-8601 string`, key);
        }
        conditions.push({ key, op, value: value[op] });
        matched = true;
      }
      if (!matched) {
        throw new CompatFilterError('filter key "created_at" requires at least one of gte/lte', key);
      }
    } else {
      throw new CompatFilterError(`unsupported filter key "${key}"`, key);
    }
  }
  return conditions;
}

/**
 * Normalize the mem0 filter DSL subset to a predicate descriptor.
 *
 * Accepts: undefined | flat condition object | {AND:[flat,...]} | {OR:[flat,...]}.
 * Supported condition keys: user_id/agent_id/app_id/run_id (string equality),
 * categories:{contains:string}, created_at:{gte?,lte?}.
 *
 * Descriptor shape: `branches` is an array of condition ARRAYS — one array
 * per flat condition object. Per-branch grouping is LOAD-BEARING for OR:
 * `{OR:[{agent_id:'a',run_id:'r1'},{agent_id:'b',run_id:'r2'}]}` matches
 * (a,r1) or (b,r2) but NOT the cross-pairing (a,r2) — every condition
 * inside a branch stays AND'd within that branch. Empty flat objects
 * contribute no branch (a vacuous branch must not match everything).
 *
 * @param {object|undefined} filters
 * @returns {{branches: {key: string, op: string, value: string}[][], mode: 'AND'|'OR'}|null}
 *   null when filters is undefined/empty (no filtering).
 * @throws {CompatFilterError} on unknown keys, malformed value shapes, or
 *   AND/OR nesting (OR is top-level only; fail-loud → 400 at the route layer).
 */
export function parseMem0Filters(filters) {
  if (filters === undefined || filters === null) return null;
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new CompatFilterError('filters must be an object', String(filters));
  }
  const keys = Object.keys(filters);
  if (keys.length === 0) return null;

  const hasAnd = 'AND' in filters;
  const hasOr = 'OR' in filters;
  if (hasAnd || hasOr) {
    const mode = hasAnd ? 'AND' : 'OR';
    if (keys.length > 1) {
      throw new CompatFilterError(`${mode} must be the sole top-level filter key`, mode);
    }
    const flatObjects = filters[mode];
    if (!Array.isArray(flatObjects)) {
      throw new CompatFilterError(`${mode} requires an array of flat conditions`, mode);
    }
    const branches = flatObjects
      .map((flat) => parseFlatCondition(flat))
      .filter((branch) => branch.length > 0);
    if (branches.length === 0) return null;
    return { branches, mode };
  }

  const conditions = parseFlatCondition(filters);
  if (conditions.length === 0) return null;
  return { branches: [conditions], mode: 'AND' };
}

/**
 * Evaluate one normalized condition against a PROJECTED record (mem0
 * dialect — post-toMem0Record, so field names are user_id/created_at/
 * categories). agent_id/app_id/run_id are stored into metadata on write
 * (spec §5), so equality keys fall back to record.metadata when the
 * record has no top-level field of that name.
 *
 * @param {object} record
 * @param {{key: string, op: string, value: string}} cond
 * @returns {boolean}
 */
function matchCondition(record, cond) {
  const { key, op, value } = cond;
  if (op === 'contains') {
    return Array.isArray(record.categories) && record.categories.includes(value);
  }
  if (op === 'gte' || op === 'lte') {
    // Compare as INSTANTS, not strings: a +05:00-offset bound and a
    // Z-stored timestamp are the same moment in different notations —
    // lexicographic compare would misorder them. NaN on either side
    // (missing/garbage timestamp) fails the condition.
    const actualMs = Date.parse(record.created_at);
    const boundMs = Date.parse(value);
    if (Number.isNaN(actualMs) || Number.isNaN(boundMs)) return false;
    return op === 'gte' ? actualMs >= boundMs : actualMs <= boundMs;
  }
  // eq — dialect field first, metadata-stored partition keys second (spec §5)
  const actual = record[key] !== undefined ? record[key] : record.metadata?.[key];
  return actual === value;
}

/**
 * Apply a parsed filter descriptor to projected records (pure, facade-side
 * post-retrieval filtering — spec §3 "Application point").
 *
 * OR = at least one branch fully satisfied (every condition within it);
 * AND = every branch fully satisfied. Conditions never OR across branch
 * boundaries — the per-branch AND grouping is the whole point.
 *
 * @param {object[]} records — mem0-dialect records (post-toMem0Record)
 * @param {{branches: object[][], mode: 'AND'|'OR'}|null} descriptor
 * @returns {object[]}
 */
export function applyMem0Filters(records, descriptor) {
  if (!descriptor) return records;
  const { branches, mode } = descriptor;
  const branchMatches = (record) => (branch) => branch.every((cond) => matchCondition(record, cond));
  return records.filter((record) =>
    mode === 'OR'
      ? branches.some(branchMatches(record))
      : branches.every(branchMatches(record)),
  );
}

/**
 * Project one RAW mem0 record ({id, memory, metadata?, score?} from raw
 * memoryClient.search/getAll) to the mem0 Platform dialect (spec §4):
 * {id, memory, created_at?, updated_at?, categories, metadata, user_id?, score?}.
 *
 * Translation: createdAt→created_at, updatedAt→updated_at, userId→user_id —
 * read from metadata first, then from the RAW record's top level (mem0ai's
 * raw search/getAll EXCLUDES these keys from metadata and hoists them to the
 * record top level — dist/oss excludedKeys; qdrant-point-sourced callers may
 * instead leave them in metadata). Each is OMITTED when absent (client uses
 * ?? fallbacks; omission-not-null). categories is synthesized from
 * metadata.lane + any stored metadata.categories array, deduped — [] when
 * none (the client filters on r.categories, so [] beats omission there).
 * metadata is passed through as-is (client reads its own stored keys off
 * memory.metadata); the input is never mutated. Never throws on missing
 * fields; score is included only when it is a number.
 *
 * @param {{id: string, memory?: string, metadata?: object, score?: number}} raw
 * @returns {object} mem0-dialect record
 */
export function toMem0Record(raw) {
  const metadata = raw?.metadata ?? {};

  const categories = [];
  if (typeof metadata.lane === 'string' && metadata.lane) categories.push(metadata.lane);
  if (Array.isArray(metadata.categories)) {
    for (const c of metadata.categories) {
      if (!categories.includes(c)) categories.push(c);
    }
  }

  const out = { id: raw?.id, memory: raw?.memory, categories, metadata };
  const createdAt = metadata.createdAt ?? raw?.createdAt;
  const updatedAt = metadata.updatedAt ?? raw?.updatedAt;
  const userId = metadata.userId ?? raw?.userId;
  if (createdAt !== undefined) out.created_at = createdAt;
  if (updatedAt !== undefined) out.updated_at = updatedAt;
  if (userId !== undefined) out.user_id = userId;
  if (typeof raw?.score === 'number') out.score = raw.score;
  return out;
}

/**
 * Internal umAdd event vocabulary → the mem0 dialect the client parses
 * (ADD | UPDATE | NONE — docs/mem0-compat.md R2 row). The merge family
 * (DEDUP_MERGED: surface merged into an existing point; SUPERSEDED_INBAND:
 * new point upserted, older point demoted) both read as "an existing
 * memory changed" to a mem0 client → UPDATE. Absent/unknown events
 * degrade to NONE — never leak an internal token the client can't map.
 */
const COMPAT_EVENT_MAP = Object.freeze({
  ADD: 'ADD',
  DEDUP_MERGED: 'UPDATE',
  SUPERSEDED_INBAND: 'UPDATE',
  NONE: 'NONE',
});

/**
 * Translate umAdd's return shape ({results:[{id, memory, event}]} — see
 * server/lib/add.mjs) to the mem0 add-response dialect: internal events
 * mapped through COMPAT_EVENT_MAP. Defensive: any missing/malformed input
 * degrades to {results: []}; extra per-result fields (e.g. supersededId)
 * are dropped.
 *
 * @param {{results?: {id: string, memory: string, event: string}[]}|undefined} umAddResult
 * @returns {{results: {id: string, memory: string, event: string}[]}}
 */
export function toMem0AddResults(umAddResult) {
  const results = Array.isArray(umAddResult?.results) ? umAddResult.results : [];
  return {
    results: results.map(({ id, memory, event }) => ({
      id,
      memory,
      event: COMPAT_EVENT_MAP[event] ?? 'NONE',
    })),
  };
}

// ---------------------------------------------------------------------------
// Route handlers (spec §3 route table; plan Tasks 4-6).
// ---------------------------------------------------------------------------

/** Shorthand for the mem0 error dialect. */
function detailError(status, detail) {
  return { status, body: { detail } };
}

/** 400 for any impersonation attempt (spec §5 — no silent remap). */
function userIdMismatch(provided, operatorId) {
  return detailError(
    400,
    `user_id "${provided}" does not match this instance's operator user id "${operatorId}" — UM is single-operator (spec §5); omit user_id or send the operator id`,
  );
}

/** Uniform by-id 404 — foreign-point existence is NOT leaked (spec §6). */
function notFound() {
  return detailError(404, 'Resource not found: no memory with the given id');
}

/**
 * Resolve the operator identity + memory client from the dispatch ctx.
 * mem0-mcp-http.mjs's compat dispatch site always supplies both; a missing
 * value is a wiring bug and fails loud (→ 500 via the dispatcher catch).
 */
function resolveCompatCtx(ctx) {
  const operatorId = ctx?.userId;
  const memory = ctx?.memory;
  if (!operatorId) throw new Error('mem0-compat: ctx.userId (RESOLVED_USER_ID) missing');
  if (!memory) throw new Error('mem0-compat: ctx.memory (memory client) missing');
  return { operatorId, memory };
}

/**
 * Full-list scan limit for the facade's list/scan-delete/count paths.
 * mem0's getAll defaults to limit=100, which would silently truncate R4
 * paging (page_size cap is 500) and — worse — leave R8/R9 bulk deletes
 * incomplete. Explicit generous ceiling; single-operator instance scale is
 * hundreds–low-thousands of points (spec §3 R8 "O(N) acceptable").
 */
const COMPAT_SCAN_LIMIT = 10000;

/** Raw getAll for the operator → system docs stripped (read-path parity). */
async function scanAll(memory, operatorId) {
  const all = await withRetry(
    () => memory.getAll({ userId: operatorId, limit: COMPAT_SCAN_LIMIT }),
    { op: 'compat-getAll' },
  );
  return filterSystemDocs(all?.results ?? all ?? []);
}

/**
 * Reject a parsed filter descriptor that tries to scope to a FOREIGN
 * user_id (spec §5: presence anywhere in a request must equal the
 * operator). A matching user_id condition is fine — it matches everything
 * on a single-operator instance. Scans every branch: a foreign user_id in
 * ANY position (even one OR arm) is an impersonation attempt.
 */
function foreignUserIdIn(descriptor, operatorId) {
  for (const branch of descriptor?.branches ?? []) {
    const cond = branch.find((c) => c.key === 'user_id' && c.value !== operatorId);
    if (cond) return cond;
  }
  return null;
}

/**
 * Fetch one point by id via the raw qdrant client and enforce the spec §6
 * scope check. Returns null for absent points, foreign-userId points, AND
 * invalid ids the qdrant client rejects (e.g. non-UUID strings → HTTP 400
 * upstream) — all collapse to the same non-leaking 404 at the route layer.
 *
 * Error classification is deliberate: ONLY what IS absence maps to null —
 * an empty retrieve result, or a 400 the qdrant client raises for a
 * malformed id (@qdrant/js-client rejections carry `.status`). Anything
 * else (5xx, undefined status = network failure) is a transient/upstream
 * fault and RETHROWS after the retry budget → the dispatcher's 500 path.
 * Collapsing those to 404 would misreport "qdrant down" as "not found".
 */
async function fetchScopedPoint(ctx, memory, operatorId, id) {
  const client = ctx?._qdrantClient ?? await getRealClient(memory);
  const collection = memory.config.vectorStore.config.collectionName;
  let points;
  try {
    points = await withRetry(
      () => client.retrieve(collection, { ids: [id], with_payload: true })
        .catch((e) => {
          // Malformed-id 400 is deterministic — retrying it is pointless.
          if (e?.status === 400) e.retryable = false;
          throw e;
        }),
      { op: 'compat-retrieve' },
    );
  } catch (err) {
    // withRetry wraps the original error as UPSTREAM_FAILURE{cause}.
    const status = err?.status ?? err?.cause?.status;
    if (status === 400) return null; // invalid id shape → indistinguishable from absent (404)
    throw err;
  }
  const arr = Array.isArray(points) ? points : points?.points ?? [];
  const point = arr[0];
  if (!point || point.payload?.userId !== operatorId) return null;
  return { point, client, collection };
}

/**
 * qdrant point → the RAW-record shape toMem0Record expects, mirroring
 * mem0ai's own projection (same excludedKeys set): payload.data → memory,
 * camelCase bookkeeping hoisted to the top level, everything else →
 * metadata. Keeps R5/R6 responses byte-consistent with R3/R4 records.
 */
const MEM0_EXCLUDED_PAYLOAD_KEYS = new Set(['userId', 'agentId', 'runId', 'hash', 'data', 'createdAt', 'updatedAt']);

function pointToRawRecord(point) {
  const payload = point?.payload ?? {};
  const metadata = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!MEM0_EXCLUDED_PAYLOAD_KEYS.has(k)) metadata[k] = v;
  }
  const raw = { id: point?.id, memory: payload.data, metadata };
  if (payload.createdAt !== undefined) raw.createdAt = payload.createdAt;
  if (payload.updatedAt !== undefined) raw.updatedAt = payload.updatedAt;
  if (payload.userId !== undefined) raw.userId = payload.userId;
  return raw;
}

/**
 * Payload keys a compat client's `metadata` may never overwrite on R6:
 * scope (userId), content bookkeeping (data/hash — the handler owns their
 * refresh), timestamps the schema carries/sets itself, plus surface
 * attribution (surfaces) and lane partitioning (lane) — both server-
 * managed. The supersession-state fields come from the SAME canonical
 * constant assertNoReservedFields enforces on the write path
 * (D3_SERVER_MANAGED_STATUS_FIELDS: status/supersededBy/supersededAt) so
 * the two guards cannot drift.
 */
const R6_PROTECTED_KEYS = new Set([
  ...D3_SERVER_MANAGED_STATUS_FIELDS,
  'userId', 'data', 'hash', 'createdAt', 'updatedAt', 'surfaces', 'lane',
]);

function sanitizeUpdateMetadata(metadata) {
  const out = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (!R6_PROTECTED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// Read-path status filter: shared isRecallable (lib/recallable.mjs) — the
// SAME predicate doSearch applies, so compat reads can never drift from
// the house read-path exclusion semantics.

// --- R1 ---------------------------------------------------------------------

async function handlePing() {
  return { status: 200, body: { status: 'ok', name: 'universal-memory', version: SERVER_VERSION } };
}

// --- R2 ---------------------------------------------------------------------

async function handleAdd({ req, body, ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const b = body ?? {};
  if (b.user_id !== undefined && b.user_id !== operatorId) {
    return userIdMismatch(b.user_id, operatorId);
  }
  const messages = (Array.isArray(b.messages) ? b.messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.length > 0);
  if (messages.length === 0) {
    return detailError(400, 'messages[] with at least one non-empty content entry is required');
  }

  // Partition keys + categories are stored INTO metadata under their
  // snake_case wire names so applyMem0Filters' metadata fallback matches
  // them on read (spec §5; pure-test ambiguity note).
  const metadata = { ...(b.metadata ?? {}) };
  for (const key of ['agent_id', 'app_id', 'run_id']) {
    if (typeof b[key] === 'string' && b[key].length > 0) metadata[key] = b[key];
  }
  if (Array.isArray(b.categories)) metadata.categories = b.categories;

  // Provenance (spec §7): X-Mem0-Source header lowercased, else 'mem0-compat'.
  // T5 (#159 spec §6): derivation shared with the /api + /mcp routes via
  // surfaceFromHeaders (X-UM-Source now also honored, X-Mem0-Source stays the
  // compat alias) so the header set can't drift between the two dialects.
  const surface = surfaceFromHeaders(req?.headers, 'mem0-compat');

  const add = ctx?._umAdd ?? defaultUmAdd;
  const common = {
    memory,
    userId: operatorId,
    metadata,
    surface,
    _qdrantClient: ctx?._qdrantClient,
    _factsProviderOverride: ctx?._factsProviderOverride,
    _embedProviderOverride: ctx?._embedProviderOverride,
  };

  if (b.infer === false) {
    // Verbatim store path: one umAdd(infer:false) per message (spec §3 R2).
    const results = [];
    for (const m of messages) {
      const r = await add({ ...common, text: m.content, infer: false });
      results.push(...toMem0AddResults(r).results);
    }
    return { status: 200, body: { results } };
  }

  // Default path: the whole conversation as ONE role-prefixed transcript →
  // a single umAdd — UM's extractor pulls multiple facts from a blob, so one
  // call preserves mem0's whole-conversation extraction semantics (spec §3 R2).
  const transcript = messages.map((m) => `${m.role ?? 'user'}: ${m.content}`).join('\n');
  const r = await add({ ...common, text: transcript, infer: true });
  return { status: 200, body: toMem0AddResults(r) };
}

/**
 * Shared R3/R4 request preamble: resolve the operator ctx, parse filters
 * (CompatFilterError → 400 via the dispatcher), and enforce the spec §5
 * no-impersonation rule for user_id in BOTH filters and the body. Returns
 * either {error: {status, body}} (return it as-is) or the resolved scope.
 */
function resolveScopedRead(ctx, body) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const b = body ?? {};
  const descriptor = parseMem0Filters(b.filters);
  const foreign = foreignUserIdIn(descriptor, operatorId);
  if (foreign) return { error: userIdMismatch(foreign.value, operatorId) };
  if (b.user_id !== undefined && b.user_id !== operatorId) {
    return { error: userIdMismatch(b.user_id, operatorId) };
  }
  return { operatorId, memory, b, descriptor };
}

// --- R3 ---------------------------------------------------------------------

/** top_k ceiling — mirrors the R4 page_size cap (attacker-supplied sizes
 *  must not drive unbounded over-fetch: fetchLimit stays ≤ 3×500). */
const MAX_TOP_K = 500;

async function handleSearch({ req, body, ctx }) {
  const scope = resolveScopedRead(ctx, body);
  if (scope.error) return scope.error;
  const { operatorId, memory, b, descriptor } = scope;
  if (typeof b.query !== 'string' || b.query.trim().length === 0) {
    return detailError(400, 'query is required');
  }
  // rerank / keyword_search / fields: accepted, documented no-ops (spec §2).

  const topK = Math.min(Number.isInteger(b.top_k) && b.top_k > 0 ? b.top_k : 10, MAX_TOP_K);
  // Facade-side filters can only shrink the result set → over-fetch, then
  // filter, then truncate (spec §3 "Application point").
  const fetchLimit = Math.max(topK * 3, 30);
  // U2 (#171): recall telemetry at HANDLER level (NOT scanAll — shared with
  // bulk-delete; deletes are not recalls). The compat facade reads via raw
  // memory.search, never doSearch, so this is production read path 2 (plan
  // U2 R6). Duration measured around the underlying engine call.
  const recallStartedAt = Date.now();
  const raw = await withRetry(
    () => memory.search(b.query, { userId: operatorId, limit: fetchLimit }),
    { op: 'compat-search' },
  );
  const engineMs = Date.now() - recallStartedAt;
  let items = raw?.results ?? raw ?? [];
  // Read-path parity with doSearch: superseded/system records never surface.
  items = filterSystemDocs(items).filter(isRecallable);

  let records = items.map((r) => toMem0Record(r));
  records = applyMem0Filters(records, descriptor);
  const threshold = typeof b.threshold === 'number' ? b.threshold : 0.3;
  records = records.filter((r) => typeof r.score !== 'number' || r.score >= threshold);
  // Emit-after-success (U2 review nit): duration covers the ENGINE call only,
  // but the emit waits until post-processing succeeds — a throw above becomes
  // a 500 that was never counted as a served recall (doSearch parity).
  noteRecallSearch({
    surface: surfaceFromHeaders(req?.headers, 'mem0-compat'),
    durationMs: engineMs,
  });
  return { status: 200, body: { results: records.slice(0, topK) } };
}

// --- R4 ---------------------------------------------------------------------

async function handleList({ req, url, body, ctx }) {
  const scope = resolveScopedRead(ctx, body);
  if (scope.error) return scope.error;
  const { operatorId, memory, descriptor } = scope;

  // Read-path parity with R3/doSearch: superseded records never surface.
  // U2 (#171): the R4 list is a production read too — same handler-level
  // telemetry as R3 (emitting here, not inside scanAll, keeps the R8/R9
  // bulk-delete scans OUT of the recall counters — plan U2 audit).
  const recallStartedAt = Date.now();
  const scanned = await scanAll(memory, operatorId);
  const engineMs = Date.now() - recallStartedAt;
  const items = scanned.filter(isRecallable);
  const records = applyMem0Filters(items.map((r) => toMem0Record(r)), descriptor);

  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const sizeRaw = Number.parseInt(url.searchParams.get('page_size') ?? '', 10);
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  // page_size capped at 500: attacker-supplied sizes don't drive unbounded
  // per-row projection (spec §3 R4).
  const pageSize = Math.min(Number.isInteger(sizeRaw) && sizeRaw >= 1 ? sizeRaw : 100, 500);
  const start = (page - 1) * pageSize;
  // Emit-after-success (U2 review nit) — see the R3 note: engine-call
  // duration, but only counted once post-processing/paging succeeded.
  noteRecallSearch({
    surface: surfaceFromHeaders(req?.headers, 'mem0-compat'),
    durationMs: engineMs,
  });
  return { status: 200, body: { results: records.slice(start, start + pageSize) } };
}

// --- R5 ---------------------------------------------------------------------

async function handleGet({ params, ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const scoped = await fetchScopedPoint(ctx, memory, operatorId, params[0]);
  if (!scoped) return notFound();
  const raw = pointToRawRecord(scoped.point);
  // Read-path parity with R3/R4: a superseded point is as invisible by id
  // as it is in search/list — 404, same non-leak shape as absent/foreign.
  if (!isRecallable(raw)) return notFound();
  return { status: 200, body: toMem0Record(raw) };
}

// --- R6 ---------------------------------------------------------------------

async function handleUpdate({ params, body, ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const scoped = await fetchScopedPoint(ctx, memory, operatorId, params[0]);
  if (!scoped) return notFound();
  const { point, client, collection } = scoped;

  const b = body ?? {};
  const text = typeof b.text === 'string' && b.text.length > 0 ? b.text : undefined;
  const hasMetadata = b.metadata !== null && typeof b.metadata === 'object' && !Array.isArray(b.metadata);
  if (text === undefined && !hasMetadata) {
    return detailError(400, 'at least one of text / metadata is required');
  }
  const mergeMetadata = hasMetadata ? sanitizeUpdateMetadata(b.metadata) : {};
  const updatedAt = new Date().toISOString();

  let payload;
  if (text !== undefined) {
    // Explicit user edit is authoritative (mem0 semantics) — deliberately
    // bypasses dedup/supersession. Re-embed via the SAME embed orchestrator
    // umAdd uses (collection's stamped model → no stamp drift), then upsert
    // the SAME point id preserving the full umAdd payload schema: data/hash
    // refreshed, surfaces/status/userId/createdAt carried, updatedAt set.
    // A post-update hash collision with a DIFFERENT point is tolerated by
    // design — two points may share a hash (spec §3 R6 invariants).
    const { vector } = await defaultEmbed(text, { _providerOverride: ctx?._embedProviderOverride });
    payload = { ...point.payload, ...mergeMetadata, data: text, hash: md5(text), updatedAt };
    await withRetry(
      () => client.upsert(collection, { points: [{ id: point.id, vector, payload }] }),
      { op: 'compat-upsert' },
    );
  } else {
    // Metadata-only: additive setPayload merge (supersede.mjs idiom); the
    // stored vector + text are untouched.
    payload = { ...point.payload, ...mergeMetadata, updatedAt };
    await withRetry(
      () => client.setPayload(collection, { points: [point.id], payload: { ...mergeMetadata, updatedAt } }),
      { op: 'compat-setPayload' },
    );
  }

  const record = toMem0Record(pointToRawRecord({ id: point.id, payload }));
  return { status: 200, body: { ...record, event: 'UPDATE' } };
}

// --- R7 ---------------------------------------------------------------------

async function handleDeleteById({ params, ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const scoped = await fetchScopedPoint(ctx, memory, operatorId, params[0]);
  if (!scoped) return notFound();
  await withRetry(() => memory.delete(String(scoped.point.id)), { op: 'compat-delete' });
  return { status: 200, body: { message: 'Memory deleted successfully!' } };
}

// --- R8/R9 shared scan-delete ------------------------------------------------

/**
 * Facade-side scoped scan-then-delete-by-ids (spec §3 R8 mechanism —
 * O(N) by design at single-operator instance scale; NOT a new indexed
 * delete path). `metadataScopes` is {agent_id?, app_id?, run_id?}; all
 * present entries must match the stored metadata (AND). System docs are
 * excluded by scanAll — a user-scope wipe never deletes the embedding stamp.
 */
async function scanDelete(memory, operatorId, metadataScopes) {
  const items = await scanAll(memory, operatorId);
  const entries = Object.entries(metadataScopes);
  const matches = items.filter((r) => entries.every(([k, v]) => r?.metadata?.[k] === v));
  for (const r of matches) {
    // Per-id loop stays O(N) by design (spec §3 R8); each delete gets its
    // own retry budget so one transient blip doesn't abort the sweep.
    await withRetry(() => memory.delete(String(r.id)), { op: 'compat-delete' });
  }
  return { status: 200, body: { message: `${matches.length} memories deleted` } };
}

// --- R8 ---------------------------------------------------------------------

async function handleBulkDelete({ url, ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const qp = url.searchParams;
  const scopeKeys = ['user_id', 'agent_id', 'app_id', 'run_id']
    .filter((k) => typeof qp.get(k) === 'string' && qp.get(k).length > 0);
  if (scopeKeys.length === 0) {
    return detailError(400, 'at least one scope param is required (user_id / agent_id / app_id / run_id) — refusing an unscoped bulk delete');
  }
  const userId = qp.get('user_id');
  if (userId !== null && userId !== '' && userId !== operatorId) {
    return userIdMismatch(userId, operatorId);
  }
  const metadataScopes = {};
  for (const k of scopeKeys) {
    if (k !== 'user_id') metadataScopes[k] = qp.get(k);
  }
  return scanDelete(memory, operatorId, metadataScopes);
}

// --- R9 ---------------------------------------------------------------------

const ENTITY_METADATA_KEYS = { agent: 'agent_id', app: 'app_id', run: 'run_id' };

async function handleEntityDelete({ params, ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  const [type, id] = params;
  if (type === 'user') {
    // §6 no-leak: a foreign user entity 404s (not 400) — its existence is
    // exactly as undisclosed as a foreign point id.
    if (id !== operatorId) return notFound();
    return scanDelete(memory, operatorId, {});
  }
  const metadataKey = ENTITY_METADATA_KEYS[type];
  if (!metadataKey) return detailError(400, `unknown entity type "${type}" — expected user/agent/app/run`);
  return scanDelete(memory, operatorId, { [metadataKey]: id });
}

// --- R10 --------------------------------------------------------------------

async function handleEntities({ ctx }) {
  const { operatorId, memory } = resolveCompatCtx(ctx);
  // Count what a read can actually see (R4 parity): superseded points are
  // excluded, so total_memories always equals the R4 full-list length.
  const items = (await scanAll(memory, operatorId)).filter(isRecallable);
  return {
    status: 200,
    body: { results: [{ type: 'user', id: operatorId, total_memories: items.length }] },
  };
}

// --- R11 --------------------------------------------------------------------

async function handleEventsList() {
  // SaaS ingestion-event concept — UM has none; the plugin's event tools
  // degrade to "no events" (spec §3 R11).
  return { status: 200, body: { results: [] } };
}

async function handleEventById() {
  return detailError(404, 'Resource not found: events are not tracked by this server');
}

// ---------------------------------------------------------------------------
// Compat-route dispatcher (spec §3 route table).
// ---------------------------------------------------------------------------

/**
 * The client-pinned route subset (spec §3 R1-R11; R11 spans two paths).
 * First-match scan on method + pattern; capture groups become
 * `params` for the handler (e.g. the memory id, the entity type/id).
 * Trailing slashes are part of the contract — the client sends them.
 *
 * Handlers receive ({ req, url, body, ctx, params }) and return
 * {status, body}; errors use the mem0 dialect {detail} (spec §6).
 */
const COMPAT_ROUTES = [
  { id: 'R1',  method: 'GET',    pattern: /^\/v1\/ping\/$/,                      handler: handlePing },
  { id: 'R2',  method: 'POST',   pattern: /^\/v1\/memories\/$/,                  handler: handleAdd },
  { id: 'R3',  method: 'POST',   pattern: /^\/v2\/memories\/search\/$/,          handler: handleSearch },
  { id: 'R4',  method: 'POST',   pattern: /^\/v2\/memories\/$/,                  handler: handleList },
  { id: 'R5',  method: 'GET',    pattern: /^\/v1\/memories\/([^/]+)\/$/,         handler: handleGet },
  { id: 'R6',  method: 'PUT',    pattern: /^\/v1\/memories\/([^/]+)\/$/,         handler: handleUpdate },
  { id: 'R7',  method: 'DELETE', pattern: /^\/v1\/memories\/([^/]+)\/$/,         handler: handleDeleteById },
  { id: 'R8',  method: 'DELETE', pattern: /^\/v1\/memories\/$/,                  handler: handleBulkDelete },
  { id: 'R9',  method: 'DELETE', pattern: /^\/v2\/entities\/([^/]+)\/([^/]+)\/$/, handler: handleEntityDelete },
  { id: 'R10', method: 'GET',    pattern: /^\/v1\/entities\/$/,                  handler: handleEntities },
  { id: 'R11', method: 'GET',    pattern: /^\/v1\/events\/$/,                    handler: handleEventsList },
  { id: 'R11', method: 'GET',    pattern: /^\/v1\/event\/([^/]+)\/$/,            handler: handleEventById },
];

/**
 * Dispatch one authenticated compat request (mem0 Platform dialect).
 *
 * Called from mem0-mcp-http.mjs AFTER the middleware chain: the
 * endpoint-class row has already 404'd flag-off requests at Step-3a and
 * Step-4 has validated the Token|Bearer key — this function never sees an
 * unauthenticated request. The caller reads/parses the JSON body (house
 * pattern: routes own their body reads) and writes the returned
 * {status, body} as the JSON response.
 *
 * @param {import('node:http').IncomingMessage|{method: string, headers?: object}} req — `method` for dispatch; `headers` read by the search/list handlers for X-UM-Source recall-surface attribution (#171)
 * @param {URL} url — parsed request URL (pathname + searchParams)
 * @param {object|undefined} body — parsed JSON body (undefined for body-less methods)
 * @param {object} ctx — DI context (memory etc.), forwarded to handlers for Batch 3
 * @returns {Promise<{status: number, body: object}>} mem0-dialect response; errors are {detail}
 */
export async function handleMem0Compat(req, url, body, ctx) {
  for (const route of COMPAT_ROUTES) {
    if (req.method !== route.method) continue;
    const m = route.pattern.exec(url.pathname);
    if (!m) continue;
    try {
      return await route.handler({ req, url, body, ctx, params: m.slice(1) });
    } catch (err) {
      // Every compat response speaks the client's dialect — never let an
      // exception escape to the outer handler, which would answer in the
      // UM §5.1 envelope instead.
      //
      // Caller-input errors are safe to echo: a thrown CompatFilterError is
      // a malformed filter, and code INPUT_INVALID marks the house
      // validation family (umAdd's reserved-metadata guard, lane-slug
      // validation — see dedup-constants.mjs). Both → 400 {detail}.
      if (err instanceof CompatFilterError || err?.code === 'INPUT_INVALID') {
        return { status: 400, body: { detail: err.message } };
      }
      // Everything else is OURS: log the full error server-side, answer
      // with a fixed generic detail. NEVER err.message — the B.13 redaction
      // posture (an internal message can leak connection strings, stack
      // hints, upstream hostnames) applies to the compat dialect too.
      const logger = ctx?._logger ?? getLogger();
      try {
        logger.error({
          compat_route: route.id,
          endpoint: url.pathname,
          err_code: err?.code,
          err_message: err?.message,
          err_stack: err?.stack,
        }, 'mem0-compat handler error');
      } catch { /* logging must never break the response */ }
      return { status: 500, body: { detail: 'internal error' } };
    }
  }
  return { status: 404, body: { detail: 'unknown compat route' } };
}
