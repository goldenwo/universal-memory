/**
 * server/test/fixtures/qdrant-mock.mjs — shared mock qdrant client for unit tests.
 *
 * Originally inlined in `add.test.mjs:6–13` as `makeMockQdrant`. Extracted here
 * (D1 plan E.1, R2 G9) so both `add.test.mjs` and `dedup.test.mjs` import the
 * same source-of-truth and so D1's dedup tests can extend the recording surface
 * (.scroll / .search / .setPayload) without diverging from the original mock.
 *
 * Default behavior:
 *   .upsert     records {collection, body}; returns { status: 'ok' }
 *   .scroll     records {collection, body}; returns { points: [] } unless
 *                  pre-seeded via mock.scrollResult
 *   .search     records {collection, body}; returns [] unless pre-seeded via
 *                  mock.searchResult
 *   .setPayload records {collection, body}; returns { status: 'ok' } unless
 *                  pre-seeded via mock.setPayloadError (then throws)
 *
 * Tests can pre-seed by setting `mock.scrollResult = { points: [...] }` or
 * `mock.searchResult = [...]` BEFORE calling umAdd. They can simulate failure
 * via `mock.scrollError = new Error(...)` etc.
 *
 * Mock-narrowing (D1 plan E.2): tests asserting the §4.5.1 short-circuit fires
 * BEFORE any dedup-side method access can pass a mock built via
 * `makeMockQdrantUpsertOnly()` which omits scroll/search/setPayload entirely —
 * those methods will throw `TypeError: client.X is not a function` if reached.
 */

/**
 * Evaluate a single qdrant filter `must` arm against a point's payload.
 * Supports the predicates D1 + D2 actually use; returns true (fail-open)
 * for unknown shapes so forward-compat extensions don't silently exclude.
 *
 *   { key, match: { value } }     → strict-equality match
 *   { is_empty: { key } }         → payload[key] === undefined
 *   { is_null:  { key } }         → payload[key] === null
 *
 * Other qdrant predicates (range, geo, has_id, etc.) are not exercised by
 * any current dedup / read path and would return fail-open if encountered.
 */
function evalFilterArm(payload, arm) {
  if (arm?.is_empty?.key !== undefined) {
    return payload?.[arm.is_empty.key] === undefined;
  }
  if (arm?.is_null?.key !== undefined) {
    return payload?.[arm.is_null.key] === null;
  }
  if (arm?.key !== undefined && arm?.match !== undefined) {
    if (arm.match.value !== undefined) {
      return payload?.[arm.key] === arm.match.value;
    }
  }
  return true;
}

/**
 * Apply a qdrant-shaped filter (`{ must: [arm, ...] }`) to an array of
 * points, returning only those whose payload satisfies ALL `must` arms.
 * Returns the input list unchanged when the filter is empty/absent.
 */
function applyMustFilter(points, filter) {
  if (!filter?.must || filter.must.length === 0) return points;
  return points.filter((p) =>
    filter.must.every((arm) => evalFilterArm(p.payload ?? {}, arm)),
  );
}

/**
 * Full mock with all 4 methods. The default for dedup tests.
 *
 * D2 (R12): when `mock.honorFilters = true` is set BEFORE the umAdd call,
 * `scroll` / `search` apply the filter's `must` arms to `scrollResult` /
 * `searchResult` and return only matching points. This lets D2 tests
 * exercise real filter behavior (lane / persona partitioning, `is_empty`
 * absence arms) instead of asserting filter-shape only.
 *
 * Pre-D2 tests leave `honorFilters` at its default `false`, so the mock
 * returns the pre-seeded value unchanged — backward-compatible. Existing
 * D1 dedup tests do not need to opt in.
 */
/**
 * @param {object} [seed={}] - Optional seed object.
 * @param {Array}  [seed.points=[]] - Initial points to pre-populate `_store`.
 *   Each element should be `{ id, payload }`. Enables `client._get(id)` and
 *   additive `setPayload` mutation for D3 supersede/unsupersede tests.
 *   Existing callers that pass no args are unaffected (backward-compatible).
 */
export function makeMockQdrant({ points: seedPoints = [] } = {}) {
  const upserts = [];
  const scrolls = [];
  const searches = [];
  const setPayloads = [];

  // D3.1: internal point store — supports _get() read-back and additive
  // setPayload mutation, mirroring real qdrant's partial-merge behaviour.
  const _store = new Map(seedPoints.map((p) => [p.id, { ...p, payload: { ...(p.payload ?? {}) } }]));

  const mock = {
    upserts,
    scrolls,
    searches,
    setPayloads,
    // Test pre-seeds
    scrollResult: { points: [] },
    searchResult: [],
    scrollError: null,
    searchError: null,
    setPayloadError: null,
    upsertError: null,
    // D2 (R12): opt-in filter evaluation for `scroll` / `search`. When
    // false (default), the mock returns the pre-seeded result unchanged.
    // When true, the filter's `must` arms are applied to scrollResult /
    // searchResult and only matching points are returned.
    honorFilters: false,
    client: {
      upsert: async (collection, body) => {
        upserts.push({ collection, body });
        if (mock.upsertError) throw mock.upsertError;
        return { status: 'ok' };
      },
      scroll: async (collection, body) => {
        scrolls.push({ collection, body });
        if (mock.scrollError) throw mock.scrollError;
        if (!mock.honorFilters) return mock.scrollResult;
        const points = mock.scrollResult?.points ?? [];
        const filtered = applyMustFilter(points, body?.filter);
        return { ...mock.scrollResult, points: filtered };
      },
      search: async (collection, body) => {
        searches.push({ collection, body });
        if (mock.searchError) throw mock.searchError;
        if (!mock.honorFilters) return mock.searchResult;
        const arr = Array.isArray(mock.searchResult) ? mock.searchResult : [];
        return applyMustFilter(arr, body?.filter);
      },
      setPayload: async (collection, body) => {
        setPayloads.push({ collection, body });
        if (mock.setPayloadError) throw mock.setPayloadError;
        // D3.1: additive merge into _store — mirrors real qdrant setPayload
        // which partially updates only the supplied keys, leaving others intact.
        // Keys set to null are stored as null (real qdrant cannot delete keys).
        const ids = body?.points ?? [];
        const patch = body?.payload ?? {};
        for (const id of ids) {
          if (_store.has(id)) {
            const stored = _store.get(id);
            stored.payload = { ...stored.payload, ...patch };
          }
        }
        return { status: 'ok' };
      },
      // D3.1: read-back helper — returns the stored point object (with
      // current payload after any setPayload mutations) for a given id.
      // Only works for points pre-seeded via makeMockQdrant({ points: [...] }).
      _get: (id) => _store.get(id),
    },
  };
  return mock;
}

/**
 * Upsert-only mock — omits scroll/search/setPayload entirely. Used to assert
 * the §4.5.1 short-circuit fires BEFORE any dedup-side method is accessed
 * (D1 plan E.2 mock-narrowing pattern). Tests T9 (flag off), T10 (system doc),
 * T11 (migration bypass), T13 (reindex bypass) all use this fixture.
 *
 * If umAdd's flag-off / bypass paths regress and DO call a dedup-side method,
 * the test fails with `TypeError: client.scroll is not a function` — strongest
 * possible regression guard.
 */
export function makeMockQdrantUpsertOnly() {
  const upserts = [];
  const mock = {
    upserts,
    upsertError: null,
    client: {
      upsert: async (collection, body) => {
        upserts.push({ collection, body });
        if (mock.upsertError) throw mock.upsertError;
        return { status: 'ok' };
      },
      // No scroll, search, or setPayload — accessing them will TypeError.
    },
  };
  return mock;
}

/**
 * Memory shim — duck-types the mem0 Memory config used by umAdd.
 */
export function makeMockMemory({ collection = 'memories' } = {}) {
  return {
    config: {
      vectorStore: {
        config: { collectionName: collection, host: 'localhost', port: 6333 },
      },
    },
  };
}
