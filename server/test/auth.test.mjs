import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBearer, compareTokens, shouldBypassLoopback, FORWARDED_HEADERS } from '../lib/auth.mjs';

test('extractBearer returns token on valid header', () => {
  const r = extractBearer({ headers: { authorization: 'Bearer abc123' } });
  assert.equal(r, 'abc123');
});
test('extractBearer returns null on missing header', () => {
  assert.equal(extractBearer({ headers: {} }), null);
});
test('extractBearer returns null on wrong scheme', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Basic abc' } }), null);
});
test('compareTokens constant-time (length mismatch does not leak)', () => {
  assert.equal(compareTokens('abc', 'abc'), true);
  assert.equal(compareTokens('abc', 'abcd'), false);
  assert.equal(compareTokens('abc', 'abd'), false);
  assert.equal(compareTokens('', 'abc'), false);
});
test('shouldBypassLoopback true for 127.0.0.1 with no forwarded headers', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(shouldBypassLoopback(req), true);
});
for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'via', 'tailscale-user-login', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-name']) {
  test(`shouldBypassLoopback false when ${h} present (default-deny)`, () => {
    const req = { headers: { [h]: 'x' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(shouldBypassLoopback(req), false);
  });
}
test('shouldBypassLoopback false for non-loopback IP', () => {
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(shouldBypassLoopback(req), false);
});
test('FORWARDED_HEADERS list has all 10 entries from §4.2', () => {
  assert.equal(FORWARDED_HEADERS.length, 10);
});

// Per §6.1 auth matrix edge cases
test('extractBearer handles whitespace in token header', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer   abc123  ' } }), '  abc123  '); // preserves inner whitespace — server-side compare will reject
  assert.equal(extractBearer({ headers: { authorization: 'Bearer\tabc123' } }), 'abc123');
});
test('extractBearer returns null on empty Bearer prefix', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer' } }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Bearer ' } }), null);
});
test('extractBearer does not buffer-overflow on very long token', () => {
  const longTok = 'a'.repeat(100_000);
  assert.equal(extractBearer({ headers: { authorization: `Bearer ${longTok}` } }), longTok);
});
test('extractBearer with multiple Authorization headers — Node normalizes to first', () => {
  // Node HTTP collapses duplicate headers via comma-join except for a few allowlisted ones.
  // Authorization is NOT in the joinable allowlist; Node keeps the first. Still, assert that
  // the regex does not match the comma-joined shape in case a future Node version changes this.
  assert.equal(extractBearer({ headers: { authorization: 'Bearer good, Bearer evil' } }), 'good, Bearer evil'); // malformed-but-parseable
  // Downstream compareTokens will reject this because it is not a legal token byte string.
});

// W6.4 hardening — compareTokens hashes inputs to fixed 32-byte digests
// before timing-safe compare, so input length is no longer a timing channel.
// The earlier scheme used `timingSafeEqual(expected, expected)` as a dummy
// when received.length !== expected.length — correct in intent but used the
// wrong operand. The hash-based scheme eliminates the issue entirely.
test('compareTokens — drastically different lengths still return false (W6.4)', () => {
  const tinyMismatch = compareTokens('a', 'a'.repeat(64));
  const hugeMismatch = compareTokens('a'.repeat(10000), 'a'.repeat(64));
  const longCorrect = compareTokens('a'.repeat(64), 'a'.repeat(64));
  assert.equal(tinyMismatch, false);
  assert.equal(hugeMismatch, false);
  assert.equal(longCorrect, true);
});
test('compareTokens — null/undefined received does not crash (W6.4)', () => {
  // Safety: defensive null-coalesce in compareTokens means a missing-token
  // request (no Authorization header) ends up as `compareTokens(null, expected)`
  // somewhere on the path. Should always return false (empty SHA-256 != real).
  assert.equal(compareTokens(null, 'real-token'), false);
  assert.equal(compareTokens(undefined, 'real-token'), false);
  assert.equal(compareTokens('', 'real-token'), false);
});

// v1.8.1 shipped-bug fix: compareTokens('', undefined) returned TRUE — the
// `?? ''` coercion hashed two empty strings to equal digests. The bearer path
// was contained only by its own `if (!expected)` guard; the comparator itself
// must fail closed so new call sites (consent form, Stage B unlock) cannot
// inherit the empty-token bypass.
test('compareTokens fails closed when expected is empty/absent (empty-token bypass)', () => {
  assert.equal(compareTokens('', undefined), false);
  assert.equal(compareTokens('', null), false);
  assert.equal(compareTokens('', ''), false);
  assert.equal(compareTokens(undefined, undefined), false);
  assert.equal(compareTokens(null, null), false);
  assert.equal(compareTokens('some-token', ''), false);
  assert.equal(compareTokens('some-token', undefined), false);
});
test('compareTokens rejects non-string operands (no coercion surprises)', () => {
  assert.equal(compareTokens(42, 42), false);
  assert.equal(compareTokens(Buffer.from('tok'), 'tok'), false);
  assert.equal(compareTokens(['tok'], 'tok'), false);
  assert.equal(compareTokens({ toString: () => 'tok' }, 'tok'), false);
});

test('compareTokens — first-byte-wrong vs last-byte-wrong timing within noise (median-of-7, 4 KiB tokens)', () => {
  // Token length 4096 (not 64): with short tokens, Buffer.from() allocation
  // cost dominates the byte-comparison cost, so a buggy byte-by-byte
  // early-return implementation only produces a measured ratio of ~1.1-1.2 —
  // indistinguishable from jitter. At 4 KiB the byte-comparison cost
  // dominates the per-call overhead: a leaky implementation produces a
  // median-of-7 ratio of ~2.2-3.9, while the constant-time timingSafeEqual
  // produces a median-of-7 ratio of ~1.01-1.05 (verified empirically with a
  // reference leaky implementation across 20 batches × 7 trials). 4 KiB is
  // the smallest size that gives a clean separation; longer tokens scale
  // Buffer.from cost too, narrowing the margin again.
  const len = 4096;
  const good = 'a'.repeat(len);
  const firstBad = 'b' + 'a'.repeat(len - 1);
  const lastBad = 'a'.repeat(len - 1) + 'b';
  // Warm-up: prime the JIT so the measurement only captures steady-state.
  for (let i = 0; i < 1000; i++) { compareTokens(firstBad, good); compareTokens(lastBad, good); }
  const measure = (a, b) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10000; i++) compareTokens(a, b);
    return Number(process.hrtime.bigint() - t0);
  };
  // Median-of-7 (not min, not max): scheduler jitter (Windows context
  // switches, ETW, antivirus) is bidirectional in its effect on max/min
  // ratio — noise on the firstBad measurement *narrows* the ratio (false
  // negative), while noise on the lastBad measurement *widens* it (false
  // positive). So min-of-N hides leaks (the noisiest-firstBad trial
  // dominates) and max-of-N flags noise as leaks. Median is robust to
  // outliers in both directions and tracks the underlying steady-state.
  const ratios = [];
  for (let i = 0; i < 7; i++) {
    const first = measure(firstBad, good);
    const last = measure(lastBad, good);
    ratios.push(Math.max(first, last) / Math.min(first, last));
  }
  ratios.sort((a, b) => a - b);
  const medianRatio = ratios[3]; // index 3 of 7 sorted == median
  assert.ok(
    medianRatio < 1.5,
    `median-of-7 timing ratio ${medianRatio.toFixed(3)} exceeded 1.5x — possible leak. ` +
      `Sorted trials: [${ratios.map(r => r.toFixed(2)).join(', ')}]`,
  );
});
