// server/lib/rate-limit.mjs
//
// Bounded-map token-bucket rate limiter with amortized LRU eviction.
// Spec §4.2: in-process Map<ip, {tokens, lastRefill, touched}>; max
// UM_RATE_LIMIT_MAX_IPS entries (default 10000); LRU eviction triggered
// ON ADMIT when map size >= 90% cap (no periodic sweep — avoids p99
// latency spikes per §4.2.0 amortization rule).
//
// Token bucket: UM_RATE_LIMIT_RPM (default 60) sustained per minute,
// UM_RATE_LIMIT_BURST (default 10) burst capacity.
//
// Restart loses state — acceptable per §4.2 design (bucket state is
// in-process intentionally; no Redis/disk dependency).
//
// Clock-skew safety (§6.1 + R1 review): Math.max(0, now - rec.lastRefill)
// clamps elapsed time when the system clock goes backward (NTP step,
// VM live migration). Prevents Retry-After from computing negative AND
// stops refill from overshooting on a forward-then-backward jump.
//
// C.7 wires this into the middleware chain. The endpoint-class router
// (B.2) returns {bypassRateLimit} so /health, /metrics, /openapi etc.
// skip this limiter entirely.

export function createRateLimiter(opts = {}) {
  const maxIps = parseInt(
    opts.maxIps ?? process.env.UM_RATE_LIMIT_MAX_IPS ?? '10000',
    10,
  );
  const rpm = parseInt(opts.rpm ?? process.env.UM_RATE_LIMIT_RPM ?? '60', 10);
  const burst = parseInt(
    opts.burst ?? process.env.UM_RATE_LIMIT_BURST ?? '10',
    10,
  );
  const refillPerMs = rpm / 60_000;
  const evictThreshold = Math.floor(maxIps * 0.9);
  const map = new Map(); // ip -> { tokens, lastRefill, touched }

  function evictOneOldest() {
    // O(n) scan, amortized at admit time. Per §4.2.0 this is preferable
    // to a periodic O(n) sweep — periodic sweeps spike p99 latency for
    // any request unlucky enough to land in the sweep window.
    let oldestIp = null;
    let oldestTouched = Infinity;
    for (const [ip, rec] of map) {
      if (rec.touched < oldestTouched) {
        oldestTouched = rec.touched;
        oldestIp = ip;
      }
    }
    if (oldestIp !== null) map.delete(oldestIp);
  }

  return function admit(ip, now = Date.now()) {
    // Amortized LRU: only evict when adding a NEW IP would push the
    // map at-or-above 90% cap. Existing IPs hit their bucket without
    // triggering eviction.
    if (!map.has(ip) && map.size >= evictThreshold) {
      evictOneOldest();
    }

    let rec = map.get(ip);
    if (!rec) {
      rec = { tokens: burst, lastRefill: now, touched: now };
      map.set(ip, rec);
    }

    // Clock-skew safety: never compute negative elapsed.
    const elapsed = Math.max(0, now - rec.lastRefill);
    rec.tokens = Math.min(burst, rec.tokens + elapsed * refillPerMs);
    rec.lastRefill = now;
    rec.touched = now;

    if (rec.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - rec.tokens) / refillPerMs);
      // Floor to 1 second — sub-second waits still report 1 (HTTP
      // Retry-After is integer seconds; 0 would say "retry now" which
      // contradicts a denial).
      return {
        admitted: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }
    rec.tokens -= 1;
    return { admitted: true };
  };
}
