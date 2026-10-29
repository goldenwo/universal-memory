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
import { createRateLimiter, isMcpHandshakeMessage, defersChargeToMessage, MCP_HANDSHAKE_BODY_MAX } from '../lib/rate-limit.mjs';

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

// Set exactly `vars` among the three limiter knobs (the rest unset), run fn, restore.
function withRateEnv(vars, fn) {
  const keys = ['UM_RATE_LIMIT_RPM', 'UM_RATE_LIMIT_BURST', 'UM_RATE_LIMIT_MAX_IPS'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (k in vars) process.env[k] = vars[k]; else delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

// The knobs read like every numeric env knob (lib/env-number.mjs). parseInt read a blank or
// junk value as NaN, and a NaN rpm or burst makes every token count NaN, which is never < 1:
// the limiter admitted everything.
test('env override: a blank or malformed UM_RATE_LIMIT_RPM / _BURST falls back to the default, never NaN', () => {
  withRateEnv({ UM_RATE_LIMIT_RPM: 'abc', UM_RATE_LIMIT_BURST: ' ' }, () => {
    const admit = createRateLimiter();
    const now = 5_500_000;
    for (let i = 0; i < 10; i++) {
      assert.equal(admit('1.2.3.4', now).admitted, true, `request ${i + 1} within the default burst`);
    }
    const r = admit('1.2.3.4', now);
    assert.equal(r.admitted, false, 'default burst 10');
    assert.ok(r.retryAfterSec >= 1 && r.retryAfterSec <= 2, `default 60 rpm, got ${r.retryAfterSec}`);
  });
});

// A rate is not a count: 7.5 rpm refills one token every 8 s (parseInt read it as 7, and a
// whole-number-only parse would have turned it into the default 60).
test('env override: UM_RATE_LIMIT_RPM accepts a fractional rate', () => {
  withRateEnv({ UM_RATE_LIMIT_RPM: '7.5', UM_RATE_LIMIT_BURST: '1' }, () => {
    const admit = createRateLimiter();
    let now = 5_700_000;
    assert.equal(admit('1.2.3.4', now).admitted, true);
    now += 7_900;
    assert.equal(admit('1.2.3.4', now).admitted, false, 'under 8 s: not yet refilled');
    now += 200;
    assert.equal(admit('1.2.3.4', now).admitted, true, 'after 8 s at 7.5 rpm: one token');
  });
});

// '2x' was read as 2, so eviction began at 1 entry and a drained IP got a fresh bucket as
// soon as another IP arrived. The default cap (10000) keeps both.
test('env override: UM_RATE_LIMIT_MAX_IPS takes no numeric prefix', () => {
  withRateEnv({ UM_RATE_LIMIT_MAX_IPS: '2x', UM_RATE_LIMIT_BURST: '1' }, () => {
    const admit = createRateLimiter();
    const now = 5_600_000;
    assert.equal(admit('a', now).admitted, true);
    assert.equal(admit('a', now).admitted, false);
    assert.equal(admit('b', now).admitted, true);
    assert.equal(admit('a', now).admitted, false, 'a kept its drained bucket');
  });
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

// ---------------------------------------------------------------------------
// /mcp metering policy (2026-10-23 UTC: a desktop relaunch restored 12 sessions
// in 96 s and the 5-request handshake per connect drained the shared burst of
// 10). isMcpHandshakeMessage picks the bucket a parsed message pays;
// defersChargeToMessage says whether a POST is small enough to read before
// charging it.
// ---------------------------------------------------------------------------

test('isMcpHandshakeMessage: the handshake and discovery methods are handshake', () => {
  for (const method of [
    'initialize', 'notifications/initialized', 'tools/list', 'ping',
    'server/discover', 'resources/list', 'resources/templates/list', 'prompts/list',
  ]) {
    assert.equal(isMcpHandshakeMessage({ jsonrpc: '2.0', id: 1, method }), true, method);
  }
});

test('isMcpHandshakeMessage: tools/call, unknown methods and malformed shapes are not', () => {
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search' } },
    { jsonrpc: '2.0', id: 1, method: 'resources/read' },
    { jsonrpc: '2.0', id: 1, method: 'Initialize' },
    { jsonrpc: '2.0', id: 1, method: 42 },
    { jsonrpc: '2.0', id: 1 },
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    null,
    undefined,
    'initialize',
  ]) {
    assert.equal(isMcpHandshakeMessage(message), false, JSON.stringify(message) ?? String(message));
  }
});

test('isMcpHandshakeMessage: an inherited property name is not a method on the list', () => {
  assert.equal(isMcpHandshakeMessage({ jsonrpc: '2.0', id: 1, method: 'constructor' }), false);
  assert.equal(isMcpHandshakeMessage({ jsonrpc: '2.0', id: 1, method: '__proto__' }), false);
});

test('defersChargeToMessage: only a POST that declares a small body defers', () => {
  const req = (method, length) => ({ method, headers: length === undefined ? {} : { 'content-length': length } });
  assert.equal(defersChargeToMessage(req('POST', '312')), true);
  assert.equal(defersChargeToMessage(req('POST', '0')), true);
  assert.equal(defersChargeToMessage(req('POST', String(MCP_HANDSHAKE_BODY_MAX))), true);
  assert.equal(defersChargeToMessage(req('POST', String(MCP_HANDSHAKE_BODY_MAX + 1))), false, 'over the size pays up front');
  assert.equal(defersChargeToMessage(req('POST', undefined)), false, 'no declared length (chunked) pays up front');
  for (const bad of ['', 'abc', '-1', '1e3', '12 ', '0x10']) {
    assert.equal(defersChargeToMessage(req('POST', bad)), false, `content-length ${JSON.stringify(bad)}`);
  }
  assert.equal(defersChargeToMessage(req('GET', '0')), false);
  assert.equal(defersChargeToMessage(req('DELETE', '0')), false);
});
