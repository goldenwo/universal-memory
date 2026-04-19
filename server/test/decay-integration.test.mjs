/**
 * decay-integration.test.mjs — placeholder for P3 decay-on integration test
 *
 * Status: DEFERRED to v0.3
 *
 * Rationale: applyTemporalDecay is fully unit-tested in ranking.test.mjs.
 * The wiring (UM_TEMPORAL_DECAY env var → applyDecay call in doSearch) is
 * trivial and review-verified in mem0-mcp-http.mjs. A full integration test
 * requires either:
 *   a) Exporting doSearch from mem0-mcp-http.mjs and mocking memory.search()
 *      (~30 min, moderate refactor)
 *   b) Restarting the container with UM_TEMPORAL_DECAY=true and running
 *      an HTTP smoke case (too heavyweight for a single smoke run)
 *   c) A Node integration test that spins up a temporary server instance
 *      (requires orchestration)
 *
 * Decision for v0.2.0: skip. Unit tests cover the math; code review confirmed
 * the env-var wiring. Proper integration smoke is tracked for v0.3.
 *
 * To implement (Option A): export doSearch and use vitest/jest to call it
 * directly with a mocked memory object. The test should:
 *   1. Set UM_TEMPORAL_DECAY=true
 *   2. Create two fake memory results — one recent, one old
 *   3. Call doSearch (or a thin wrapper) with those results
 *   4. Assert the recent result ranks higher after decay
 */
