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
 *   - toMem0AddResults — umAdd's {results:[{id, memory, event}]} passed
 *     through defensively to the mem0 add-response shape.
 *
 *   - handleMem0Compat — the compat-route dispatcher (Batch 2 skeleton):
 *     method+path → per-route handler returning {status, body} in the mem0
 *     error dialect ({detail}). Business logic lands in Batch 3; every
 *     known route is a 501 stub today, unknown compat paths 404.
 *
 * Endpoint-class row + Step-4 auth selection live in endpoint-class.mjs /
 * auth.mjs / mem0-mcp-http.mjs (spec §6) — not here.
 */

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
 * @param {object|undefined} filters
 * @returns {{conditions: {key: string, op: string, value: string}[], mode: 'AND'|'OR'}|null}
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
    const branches = filters[mode];
    if (!Array.isArray(branches)) {
      throw new CompatFilterError(`${mode} requires an array of flat conditions`, mode);
    }
    const conditions = branches.flatMap((branch) => parseFlatCondition(branch));
    if (conditions.length === 0) return null;
    return { conditions, mode };
  }

  const conditions = parseFlatCondition(filters);
  if (conditions.length === 0) return null;
  return { conditions, mode: 'AND' };
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
    const actual = record.created_at;
    if (typeof actual !== 'string') return false; // missing timestamp cannot satisfy a bound
    return op === 'gte' ? actual >= value : actual <= value;
  }
  // eq — dialect field first, metadata-stored partition keys second (spec §5)
  const actual = record[key] !== undefined ? record[key] : record.metadata?.[key];
  return actual === value;
}

/**
 * Apply a parsed filter descriptor to projected records (pure, facade-side
 * post-retrieval filtering — spec §3 "Application point").
 *
 * @param {object[]} records — mem0-dialect records (post-toMem0Record)
 * @param {{conditions: object[], mode: 'AND'|'OR'}|null} descriptor
 * @returns {object[]}
 */
export function applyMem0Filters(records, descriptor) {
  if (!descriptor) return records;
  const { conditions, mode } = descriptor;
  return records.filter((record) =>
    mode === 'OR'
      ? conditions.some((cond) => matchCondition(record, cond))
      : conditions.every((cond) => matchCondition(record, cond)),
  );
}

/**
 * Project one RAW mem0 record ({id, memory, metadata?, score?} from raw
 * memoryClient.search/getAll) to the mem0 Platform dialect (spec §4):
 * {id, memory, created_at?, updated_at?, categories, metadata, user_id?, score?}.
 *
 * Translation: metadata.createdAt→created_at, metadata.updatedAt→updated_at,
 * metadata.userId→user_id — each OMITTED when absent (client uses ??
 * fallbacks; omission-not-null). categories is synthesized from
 * metadata.lane + any stored metadata.categories array, deduped — [] when
 * none (the client filters on r.categories, so [] beats omission there).
 * metadata is passed through as-is (client reads its own stored keys off
 * memory.metadata); the input is never mutated. Never throws on missing
 * fields; score is included only when it is a number.
 *
 * @param {{id: string, memory?: string, metadata?: object, score?: number}} raw
 * @param {object} [opts] — reserved for later batches (unused)
 * @returns {object} mem0-dialect record
 */
export function toMem0Record(raw, opts) { // eslint-disable-line no-unused-vars
  const metadata = raw?.metadata ?? {};

  const categories = [];
  if (typeof metadata.lane === 'string' && metadata.lane) categories.push(metadata.lane);
  if (Array.isArray(metadata.categories)) {
    for (const c of metadata.categories) {
      if (!categories.includes(c)) categories.push(c);
    }
  }

  const out = { id: raw?.id, memory: raw?.memory, categories, metadata };
  if (metadata.createdAt !== undefined) out.created_at = metadata.createdAt;
  if (metadata.updatedAt !== undefined) out.updated_at = metadata.updatedAt;
  if (metadata.userId !== undefined) out.user_id = metadata.userId;
  if (typeof raw?.score === 'number') out.score = raw.score;
  return out;
}

/**
 * Translate umAdd's return shape ({results:[{id, memory, event}]} — see
 * server/lib/add.mjs) to the mem0 add-response dialect. Defensive: any
 * missing/malformed input degrades to {results: []}; extra per-result
 * fields (e.g. supersededId) are dropped.
 *
 * @param {{results?: {id: string, memory: string, event: string}[]}|undefined} umAddResult
 * @returns {{results: {id: string, memory: string, event: string}[]}}
 */
export function toMem0AddResults(umAddResult) {
  const results = Array.isArray(umAddResult?.results) ? umAddResult.results : [];
  return { results: results.map(({ id, memory, event }) => ({ id, memory, event })) };
}

// ---------------------------------------------------------------------------
// Compat-route dispatcher (spec §3 route table; plan Task 3 skeleton).
// ---------------------------------------------------------------------------

/**
 * Batch-2 stub: every known compat route answers 501 until Batch 3 lands
 * its business logic. Kept as ONE named function so the route table below
 * reads as the contract and each Batch-3 handler replaces a stub in place.
 *
 * @returns {{status: number, body: {detail: string}}}
 */
function notImplemented() {
  return { status: 501, body: { detail: 'not implemented (batch 3)' } };
}

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
  { id: 'R1',  method: 'GET',    pattern: /^\/v1\/ping\/$/,                      handler: notImplemented },
  { id: 'R2',  method: 'POST',   pattern: /^\/v1\/memories\/$/,                  handler: notImplemented },
  { id: 'R3',  method: 'POST',   pattern: /^\/v2\/memories\/search\/$/,          handler: notImplemented },
  { id: 'R4',  method: 'POST',   pattern: /^\/v2\/memories\/$/,                  handler: notImplemented },
  { id: 'R5',  method: 'GET',    pattern: /^\/v1\/memories\/([^/]+)\/$/,         handler: notImplemented },
  { id: 'R6',  method: 'PUT',    pattern: /^\/v1\/memories\/([^/]+)\/$/,         handler: notImplemented },
  { id: 'R7',  method: 'DELETE', pattern: /^\/v1\/memories\/([^/]+)\/$/,         handler: notImplemented },
  { id: 'R8',  method: 'DELETE', pattern: /^\/v1\/memories\/$/,                  handler: notImplemented },
  { id: 'R9',  method: 'DELETE', pattern: /^\/v2\/entities\/([^/]+)\/([^/]+)\/$/, handler: notImplemented },
  { id: 'R10', method: 'GET',    pattern: /^\/v1\/entities\/$/,                  handler: notImplemented },
  { id: 'R11', method: 'GET',    pattern: /^\/v1\/events\/$/,                    handler: notImplemented },
  { id: 'R11', method: 'GET',    pattern: /^\/v1\/event\/([^/]+)\/$/,            handler: notImplemented },
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
 * @param {import('node:http').IncomingMessage|{method: string}} req — only `method` is read here
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
    return route.handler({ req, url, body, ctx, params: m.slice(1) });
  }
  return { status: 404, body: { detail: 'unknown compat route' } };
}
