// server/test/oauth-throttle.test.mjs — global IP-independent consent throttle
// (Gap-3 OAuth spec section 6 item 9). Per-IP limits are weak behind a single
// egress IP / rotating attacker; there is exactly one operator credential to
// guess, so the backoff is deliberately global. Every clock read is injectable
// — no sleeps in this suite — and the IP appears nowhere in the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentThrottle } from '../lib/oauth/throttle.mjs';

test('throttle: fresh instance admits immediately', () => {
  const t = createConsentThrottle();
  assert.equal(t.admitted(0), true);
});

test('throttle: 1 failure blocks for ~1s (baseMs)', () => {
  const t = createConsentThrottle();
  t.fail(0);
  assert.equal(t.admitted(999), false);   // still blocked just before 1s
  assert.equal(t.admitted(1000), true);   // exactly at blockedUntil → admitted
  assert.equal(t.admitted(1001), true);
});

test('throttle: exponential doubling 1→2→4s', () => {
  const t = createConsentThrottle();
  t.fail(0);
  assert.equal(t.admitted(999), false);   // 1s window
  t.fail(0);
  assert.equal(t.admitted(1999), false);  // 2s window
  assert.equal(t.admitted(2000), true);
  t.fail(0);
  assert.equal(t.admitted(3999), false);  // 4s window
  assert.equal(t.admitted(4000), true);
});

test('throttle: window caps at maxMs', () => {
  const t = createConsentThrottle({ baseMs: 1000, maxMs: 5000 });
  for (let i = 0; i < 20; i++) t.fail(0); // far past where 2**n would exceed cap
  assert.equal(t.admitted(4999), false);
  assert.equal(t.admitted(5000), true);   // never longer than maxMs
});

test('throttle: success() fully resets failures and block', () => {
  const t = createConsentThrottle();
  t.fail(0);
  t.fail(0);
  assert.equal(t.admitted(0), false);
  t.success();
  assert.equal(t.admitted(0), true);
  // and the next failure restarts at the base (1s), not the prior 2s window
  t.fail(0);
  assert.equal(t.admitted(999), false);
  assert.equal(t.admitted(1000), true);
});

test('throttle: retryAfterSec is a positive ceil of remaining block', () => {
  const t = createConsentThrottle();
  t.fail(0);
  assert.equal(t.retryAfterSec(0), 1);     // exactly 1000ms → 1s
  assert.equal(t.retryAfterSec(500), 1);   // 500ms remaining → ceil → 1s
  // even when already admitted, never returns 0 or negative
  assert.equal(t.retryAfterSec(5000) >= 1, true);
});

test('throttle: API exposes no IP parameter anywhere', () => {
  const t = createConsentThrottle();
  // admitted/fail/retryAfterSec accept only an optional `now`; success() none.
  assert.equal(t.admitted.length <= 1, true);
  assert.equal(t.fail.length <= 1, true);
  assert.equal(t.retryAfterSec.length <= 1, true);
  assert.equal(t.success.length, 0);
});
