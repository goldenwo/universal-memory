// server/lib/oauth/throttle.mjs
//
// Global IP-independent exponential backoff for failed consent attempts
// (Gap-3 OAuth spec section 6 item 9: per-IP limits are weak behind a
// funnel/proxy — one egress IP — or a rotating attacker; this throttle is
// deliberately global because there is exactly one operator credential to
// guess). Pure in-memory, clock injectable everywhere so the suite has no
// sleeps; the source IP appears nowhere in the API by design.
export function createConsentThrottle({ baseMs = 1000, maxMs = 300_000 } = {}) {
  let failures = 0, blockedUntil = 0;
  return {
    admitted(now = Date.now()) { return now >= blockedUntil; },
    fail(now = Date.now()) { failures += 1; blockedUntil = now + Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 16)); },
    retryAfterSec(now = Date.now()) { return Math.max(1, Math.ceil((blockedUntil - now) / 1000)); },
    success() { failures = 0; blockedUntil = 0; },
  };
}
