// server/test/retry.test.mjs — withRetry helper tests (C.11, §5.4 + §4.2.2)
//
// Covers:
//  - retry-exhausted → UPSTREAM_FAILURE (1 initial + N retries)
//  - retry-then-success returns the first successful result
//  - non-retryable (retryable === false) bails immediately
//  - timing matches §4.2.2: 100/200/400 ms backoff + per-step 0–50 ms jitter
//  - UM_UPSTREAM_RETRY_MAX env override is honored
//  - opts.maxRetries / baseDelayMs / jitterMaxMs are honored (test hooks)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../lib/retry.mjs';

test('withRetry retries up to UM_UPSTREAM_RETRY_MAX (default 3) then throws UPSTREAM_FAILURE', async () => {
  let n = 0;
  const err = await withRetry(async () => {
    n++;
    throw Object.assign(new Error('transient'), { retryable: true });
  }, { maxRetries: 3, baseDelayMs: 1, jitterMaxMs: 0 }).catch((e) => e);
  assert.equal(n, 4, '1 initial + 3 retries');
  assert.equal(err.code, 'UPSTREAM_FAILURE');
  // Cause should preserve the underlying error
  assert.equal(err.cause?.message, 'transient');
});

test('withRetry returns first successful result', async () => {
  let n = 0;
  const r = await withRetry(async () => {
    if (++n < 2) throw Object.assign(new Error('once'), { retryable: true });
    return 'ok';
  }, { maxRetries: 3, baseDelayMs: 1, jitterMaxMs: 0 });
  assert.equal(r, 'ok');
  assert.equal(n, 2);
});

test('withRetry does NOT retry non-retryable errors', async () => {
  let n = 0;
  const err = await withRetry(async () => {
    n++;
    throw Object.assign(new Error('bad input'), { retryable: false });
  }, { maxRetries: 3, baseDelayMs: 1, jitterMaxMs: 0 }).catch((e) => e);
  assert.equal(n, 1, 'non-retryable should bail immediately');
  assert.equal(err.code, 'UPSTREAM_FAILURE');
});

test('withRetry timing: backoff is 100/200/400 ms + 0-50 ms jitter (§4.2.2)', async () => {
  const ts = [];
  let n = 0;
  await withRetry(async () => {
    ts.push(Date.now());
    if (++n < 4) throw Object.assign(new Error('t'), { retryable: true });
    return 'ok';
  }, { maxRetries: 3 }).catch(() => {});
  // ts[0] = first attempt; ts[1] - ts[0] = first delay (100 + 0..50)
  const d0 = ts[1] - ts[0];
  const d1 = ts[2] - ts[1];
  const d2 = ts[3] - ts[2];
  // Lower bound: base only. Upper bound: base + jitter (50ms) + scheduler slop.
  // Windows setTimeout granularity is ~15.6 ms; allow +50 ms scheduler slop on top
  // of the 50 ms jitter ceiling to avoid flakes on slow CI hosts.
  assert.ok(d0 >= 100 && d0 <= 200, `delay 0: ${d0}ms (want 100-200)`);
  assert.ok(d1 >= 200 && d1 <= 300, `delay 1: ${d1}ms (want 200-300)`);
  assert.ok(d2 >= 400 && d2 <= 500, `delay 2: ${d2}ms (want 400-500)`);
});

test('withRetry respects UM_UPSTREAM_RETRY_MAX env override', async () => {
  const prev = process.env.UM_UPSTREAM_RETRY_MAX;
  process.env.UM_UPSTREAM_RETRY_MAX = '1';
  try {
    let n = 0;
    await withRetry(async () => {
      n++;
      throw Object.assign(new Error('e'), { retryable: true });
    }, { baseDelayMs: 1, jitterMaxMs: 0 }).catch(() => {});
    assert.equal(n, 2, '1 initial + 1 retry');
  } finally {
    if (prev === undefined) delete process.env.UM_UPSTREAM_RETRY_MAX;
    else process.env.UM_UPSTREAM_RETRY_MAX = prev;
  }
});

// Test hook: opts.maxRetries beats env so checkpoint tests can pass [0,0,0]-equivalent
test('withRetry: opts.maxRetries beats UM_UPSTREAM_RETRY_MAX', async () => {
  const prev = process.env.UM_UPSTREAM_RETRY_MAX;
  process.env.UM_UPSTREAM_RETRY_MAX = '99'; // env says 99
  try {
    let n = 0;
    await withRetry(async () => {
      n++;
      throw Object.assign(new Error('e'), { retryable: true });
    }, { maxRetries: 2, baseDelayMs: 1, jitterMaxMs: 0 }).catch(() => {});
    assert.equal(n, 3, '1 initial + 2 retries (opts beats env)');
  } finally {
    if (prev === undefined) delete process.env.UM_UPSTREAM_RETRY_MAX;
    else process.env.UM_UPSTREAM_RETRY_MAX = prev;
  }
});

// Errors without an explicit `retryable` field default to retryable
// (mem0/qdrant errors don't ship that hint by default — see helper docstring).
test('withRetry: errors without retryable field default to retryable=true', async () => {
  let n = 0;
  await withRetry(async () => {
    n++;
    throw new Error('plain'); // no .retryable
  }, { maxRetries: 2, baseDelayMs: 1, jitterMaxMs: 0 }).catch(() => {});
  assert.equal(n, 3, 'plain errors should retry by default');
});

// Sanity: passing fn=undefined should error cleanly, not loop.
test('withRetry: maxRetries=0 means 1 attempt total', async () => {
  let n = 0;
  await withRetry(async () => {
    n++;
    throw Object.assign(new Error('e'), { retryable: true });
  }, { maxRetries: 0, baseDelayMs: 1, jitterMaxMs: 0 }).catch(() => {});
  assert.equal(n, 1, 'maxRetries=0 should run exactly once');
});
