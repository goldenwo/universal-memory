// server/test/rate-limit.test.mjs
// C.6 — bounded-map token-bucket rate limiter (spec §4.2 + §4.2.0).
//
// Tests pin the §6.1 behavior matrix:
//   1. Burst+sustained semantics (10 burst, 60 rpm defaults).
//   2. Retry-After in seconds, floor of 1.
//   3. Refill works — sustained rate over time matches rpm.
//   4. Clock-skew safety: now < lastRefill never produces negative
//      Retry-After (NTP step / VM live migration).
//   5. Env-var overrides UM_RATE_LIMIT_RPM / UM_RATE_LIMIT_BURST.
//   6. Amortized LRU eviction at >= 90% cap (no periodic sweep —
//      avoids p99 latency spikes per §4.2.0).
//   7. No eviction when under 90% cap (existing entries refill, not
//      reset).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../lib/rate-limit.mjs';

test('admits requests under limit, denies over', () => {
  const admit = createRateLimiter({ rpm: 60, burst: 10 });
  let now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    const r = admit('1.2.3.4', now);
    assert.equal(r.admitted, true, `request ${i + 1} should admit`);
  }
  // 11th request — burst exhausted, refill = 0 yet
  const r11 = admit('1.2.3.4', now);
  assert.equal(r11.admitted, false);
  assert.ok(r11.retryAfterSec >= 1, 'Retry-After must be >= 1');
});

test('admit returns Retry-After in seconds', () => {
  const admit = createRateLimiter({ rpm: 60, burst: 1 });
  let now = 2_000_000;
  admit('1.2.3.4', now); // exhaust
  const r = admit('1.2.3.4', now);
  assert.equal(r.admitted, false);
  // 60 rpm → 1 token/sec; need 1 token → ~1 sec
  assert.ok(r.retryAfterSec >= 1 && r.retryAfterSec <= 2);
});

test('refill works over time — sustained rate is rpm', () => {
  const admit = createRateLimiter({ rpm: 60, burst: 1 });
  let now = 3_000_000;
  // First exhausted
  assert.equal(admit('1.2.3.4', now).admitted, true);
  assert.equal(admit('1.2.3.4', now).admitted, false);
  // Wait 1 second (in mocked time) — refill 1 token
  now += 1000;
  assert.equal(admit('1.2.3.4', now).admitted, true);
});

test('clock-skew safety: now < lastRefill does not produce negative Retry-After', () => {
  const admit = createRateLimiter({ rpm: 60, burst: 5 });
  let now = 4_000_000;
  for (let i = 0; i < 5; i++) admit('1.2.3.4', now); // exhaust
  // Clock goes backward (NTP step)
  now -= 5000;
  const r = admit('1.2.3.4', now);
  assert.equal(r.admitted, false);
  assert.ok(r.retryAfterSec >= 1, `retryAfterSec should be >= 1, got ${r.retryAfterSec}`);
});

test('env override: UM_RATE_LIMIT_RPM and UM_RATE_LIMIT_BURST', () => {
  const prev = {
    rpm: process.env.UM_RATE_LIMIT_RPM,
    burst: process.env.UM_RATE_LIMIT_BURST,
  };
  process.env.UM_RATE_LIMIT_RPM = '120';
  process.env.UM_RATE_LIMIT_BURST = '5';
  try {
    const admit = createRateLimiter(); // no opts — pulls from env
    let now = 5_000_000;
    for (let i = 0; i < 5; i++) {
      assert.equal(admit('1.2.3.4', now).admitted, true);
    }
    assert.equal(admit('1.2.3.4', now).admitted, false);
  } finally {
    if (prev.rpm === undefined) delete process.env.UM_RATE_LIMIT_RPM;
    else process.env.UM_RATE_LIMIT_RPM = prev.rpm;
    if (prev.burst === undefined) delete process.env.UM_RATE_LIMIT_BURST;
    else process.env.UM_RATE_LIMIT_BURST = prev.burst;
  }
});

test('bounded-map with amortized LRU: when size > 90% cap, evict oldest-touched on next new IP', () => {
  const admit = createRateLimiter({ maxIps: 10, rpm: 60, burst: 10 });
  let now = 6_000_000;
  // Fill to 9 entries (90% of 10)
  for (let i = 1; i <= 9; i++) {
    admit(`10.0.0.${i}`, now);
    now += 100; // increment time so each has distinct touched
  }
  // 10th — oldest is 10.0.0.1; new entry should evict it
  admit('10.0.0.99', now);
  // Try to admit oldest again — should be a fresh bucket (full burst available)
  const r = admit('10.0.0.1', now);
  assert.equal(r.admitted, true);
  // Hit it 10 times — should all admit (fresh)
  for (let i = 0; i < 9; i++) {
    assert.equal(admit('10.0.0.1', now).admitted, true);
  }
  assert.equal(admit('10.0.0.1', now).admitted, false);
});

test('admit does NOT evict when size <= 90% cap', () => {
  const admit = createRateLimiter({ maxIps: 10, rpm: 60, burst: 10 });
  let now = 7_000_000;
  for (let i = 1; i <= 8; i++) {
    admit(`10.0.0.${i}`, now);
    now += 100;
  }
  // Below 90% — no eviction
  admit('10.0.0.1', now); // already in map; refill but don't evict
  // Confirm 10.0.0.1 still has buckets accumulated (didn't reset)
  // Easiest: just hit it 9 more times (= 10 total) and 11th should fail
  for (let i = 0; i < 9; i++) {
    admit('10.0.0.1', now);
  }
  const r = admit('10.0.0.1', now);
  assert.equal(r.admitted, false, 'bucket should be exhausted, not refreshed by eviction');
});
