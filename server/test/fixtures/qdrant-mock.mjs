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
 * Full mock with all 4 methods. The default for dedup tests.
 */
export function makeMockQdrant() {
  const upserts = [];
  const scrolls = [];
  const searches = [];
  const setPayloads = [];
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
    client: {
      upsert: async (collection, body) => {
        upserts.push({ collection, body });
        if (mock.upsertError) throw mock.upsertError;
        return { status: 'ok' };
      },
      scroll: async (collection, body) => {
        scrolls.push({ collection, body });
        if (mock.scrollError) throw mock.scrollError;
        return mock.scrollResult;
      },
      search: async (collection, body) => {
        searches.push({ collection, body });
        if (mock.searchError) throw mock.searchError;
        return mock.searchResult;
      },
      setPayload: async (collection, body) => {
        setPayloads.push({ collection, body });
        if (mock.setPayloadError) throw mock.setPayloadError;
        return { status: 'ok' };
      },
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
