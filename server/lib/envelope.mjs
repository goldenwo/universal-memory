/**
 * envelope.mjs — centralized constructor for the list-endpoint response envelope.
 *
 * Per spec §4.1 the canonical shape for list endpoints (/api/search, /api/list,
 * /api/recent) is `{ results: Array, ...extras }`. v0.7+ may add sibling fields
 * (e.g., `provider` for multi-provider transparency, `latency_ms` for
 * observability passthrough) — those additions are additive and MUST NOT break
 * existing parsers that ignore unknown fields.
 *
 * Centralizing envelope construction through this helper means v0.7 sibling
 * additions are a 1-line edit here instead of a sweep across every return site
 * in doSearch / doList / doRecent / the REST handlers.
 *
 * Non-list endpoints (e.g., /api/state which returns a single state object,
 * /api/add which returns a mem0 extraction result) MUST NOT use this helper —
 * they are not list envelopes.
 */

/**
 * Build a list-endpoint envelope.
 *
 * @param {Array} results - the result array (must be an array; never null/undefined)
 * @param {Object} [extras] - additional top-level sibling fields (e.g., {latency_ms: 12}).
 *   Reserved key `results` in extras is ignored — the first arg always wins, so
 *   extras cannot accidentally clobber the canonical field.
 * @returns {{results: Array} & Object}
 * @throws {TypeError} if `results` is not an array (prevents silent `{results: null}`
 *   shape drift from propagating to clients).
 */
export function listEnvelope(results, extras = {}) {
  if (!Array.isArray(results)) {
    throw new TypeError('listEnvelope: results must be an array (got ' + typeof results + ')');
  }
  return { ...extras, results };
}
