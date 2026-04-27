/**
 * Middleware budget perf gate (Task C.10 — spec §4.2.0 Performance contract).
 *
 * Budget: p95 <= 5 ms, p99 <= 15 ms middleware overhead (excluding handler +
 * mem0 I/O). Pi 4B is the reference hardware; CI runner ~= Pi 4B perf. This
 * test fails the build if either p95 or p99 exceeds its budget by more than
 * 20% (TOLERANCE = 1.20) — guards against regressions from new middleware
 * additions (e.g. a blocking sync call, a chatty log, a per-request alloc
 * that GC-churns under load).
 *
 * Two probes:
 *   1. /health — endpoint-class bypass. Skips ALS wrap, auth, rate-limit,
 *      counter-finish log. Measures steps 1-3 of §4.2 middleware chain
 *      (CORS + endpoint-class resolution + direct-path short-circuit).
 *   2. /api/recent/:project — full chain. Measures steps 1-8 (CORS +
 *      endpoint-class + body-cap + auth + rate-limit + ALS + route-dispatch
 *      + counter-finish + metrics-finish). Fake-memory stub returns a
 *      single empty result set, so handler cost is O(1) and the measurement
 *      is dominated by middleware.
 *
 * Warmup: 50 iterations before measurement — primes the V8 JIT and socket
 * pool. Critical because the first ~20 requests run un-optimized.
 *
 * Sampling: 1000 iterations serially (sequential await, not Promise.all).
 * Serial is what the middleware chain actually sees under a single-client
 * keep-alive connection; concurrent would measure kernel-level scheduling
 * noise, not middleware cost.
 *
 * Total runtime on dev hardware: ~3s. CI impact: ~3s added to build+smoke.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../../mem0-mcp-http.mjs';

// Minimal stub — getAll returns instantly (single cache hit, no allocation
// hotspots). /api/recent reads from the vault filesystem, not mem0, so the
// stub's getAll() is only used by /health's memory-count probe.
const fakeMemory = {
  getAll: async () => ({ results: [{ id: 'a', memory: 'm', metadata: { id: 'a', title: 't' } }] }),
};

async function startServer() {
  const prev = process.env.UM_AUTH_TOKEN;
  process.env.UM_AUTH_TOKEN = 'tok';
  const srv = createServer(createRequestHandler({ memory: fakeMemory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prev === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prev;
  };
  return { port, close };
}

// Classic sort + index percentile. Slower than approximation algos but
// deterministic, and 1000 entries sort in <1 ms — not a test-cost concern.
function pct(arr, p) {
  const copy = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor(copy.length * p);
  return copy[Math.min(idx, copy.length - 1)];
}

const ITERS = 1000;
const WARMUP = 50;
const P95_BUDGET_MS = 5;
const P99_BUDGET_MS = 15;
const TOLERANCE = 1.20; // fail if the budget is exceeded by >20%

test('C.10: middleware budget — /health p95/p99 within §4.2.0 budget (5ms/15ms * 1.2)', async () => {
  const { port, close } = await startServer();
  try {
    const base = `http://127.0.0.1:${port}`;
    // Warmup — prime JIT, keep-alive socket, and GC state.
    for (let i = 0; i < WARMUP; i++) {
      const r = await fetch(`${base}/health`);
      await r.text();
    }
    const times = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
      const t0 = process.hrtime.bigint();
      const r = await fetch(`${base}/health`);
      await r.text();
      times[i] = Number(process.hrtime.bigint() - t0) / 1_000_000;
      assert.equal(r.status, 200);
    }
    const p50 = pct(times, 0.5);
    const p95 = pct(times, 0.95);
    const p99 = pct(times, 0.99);
    // Diagnostic log — when the assertion fails, operators need to see the
    // actual numbers to decide between "CI runner noise" and "real regression".
    console.log(`  /health perf: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${ITERS})`);
    assert.ok(
      p95 <= P95_BUDGET_MS * TOLERANCE,
      `/health p95 ${p95.toFixed(2)}ms > ${(P95_BUDGET_MS * TOLERANCE).toFixed(2)}ms (budget ${P95_BUDGET_MS}ms * ${TOLERANCE} tolerance)`,
    );
    assert.ok(
      p99 <= P99_BUDGET_MS * TOLERANCE,
      `/health p99 ${p99.toFixed(2)}ms > ${(P99_BUDGET_MS * TOLERANCE).toFixed(2)}ms (budget ${P99_BUDGET_MS}ms * ${TOLERANCE} tolerance)`,
    );
  } finally { await close(); }
});

test('C.10: middleware budget — /api/recent/:project full-chain p95/p99 within §4.2.0 budget', async () => {
  const { port, close } = await startServer();
  try {
    const base = `http://127.0.0.1:${port}`;
    // Warmup — same reason as /health probe. /api/recent may 404 on missing
    // vault dir, which is fine: the middleware chain still runs to completion
    // (auth, rate-limit, route dispatch, counter-finish), so the timing is a
    // valid measurement of middleware overhead.
    for (let i = 0; i < WARMUP; i++) {
      const r = await fetch(`${base}/api/recent/test-proj`);
      await r.text();
    }
    const times = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
      const t0 = process.hrtime.bigint();
      const r = await fetch(`${base}/api/recent/test-proj`);
      await r.text();
      times[i] = Number(process.hrtime.bigint() - t0) / 1_000_000;
    }
    const p50 = pct(times, 0.5);
    const p95 = pct(times, 0.95);
    const p99 = pct(times, 0.99);
    console.log(`  /api/recent/:project perf: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${ITERS})`);
    assert.ok(
      p95 <= P95_BUDGET_MS * TOLERANCE,
      `/api/recent p95 ${p95.toFixed(2)}ms > ${(P95_BUDGET_MS * TOLERANCE).toFixed(2)}ms (budget ${P95_BUDGET_MS}ms * ${TOLERANCE} tolerance)`,
    );
    assert.ok(
      p99 <= P99_BUDGET_MS * TOLERANCE,
      `/api/recent p99 ${p99.toFixed(2)}ms > ${(P99_BUDGET_MS * TOLERANCE).toFixed(2)}ms (budget ${P99_BUDGET_MS}ms * ${TOLERANCE} tolerance)`,
    );
  } finally { await close(); }
});
