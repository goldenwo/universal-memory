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

import { parseIntEnv } from './env-number.mjs';

export function createRateLimiter(opts = {}) {
  // A blank or malformed knob is no override (env-number.mjs). parseInt read it as NaN, and a
  // NaN rpm or burst makes every token count NaN, which is never < 1: everything admitted.
  const maxIps = opts.maxIps ?? parseIntEnv(process.env.UM_RATE_LIMIT_MAX_IPS) ?? 10000;
  const rpm = opts.rpm ?? parseIntEnv(process.env.UM_RATE_LIMIT_RPM) ?? 60;
  const burst = opts.burst ?? parseIntEnv(process.env.UM_RATE_LIMIT_BURST) ?? 10;
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

// /mcp is charged per JSON-RPC message, not per request. These are the
// messages a client sends on every connect, plus the list/discovery calls
// it may send alongside them. handleMcpMessage answers each one from
// static data or with method-not-found, with no memory, vault or LLM work.
// Charging them to the shared bucket let a desktop relaunch that restored
// 12 sessions in 96 s drain the burst of 10 on handshakes alone
// (2026-10-23 UTC: 5 requests per connect, 3 sessions refused their MCP
// tools). They draw on their own bucket instead, sized here. Everything
// else pays the shared bucket, including tools/call, any other method, a
// batch and an unparseable body. Add a method here only if its answer
// does no I/O.
const MCP_HANDSHAKE_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'ping',
  'server/discover',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

// The handshake bucket. The burst holds two 12-session restores
// (5 requests each) back to back, and the rate still caps a client stuck in
// a reconnect loop.
export const MCP_HANDSHAKE_BUCKET = Object.freeze({ rpm: 300, burst: 120 });

// The largest declared body a POST /mcp may have and still be read before
// it is charged, so that its parsed message can pick the bucket. Handshake
// messages are well under 1 KB. A larger POST, or one with no declared
// length, pays the shared bucket before its body is read.
export const MCP_HANDSHAKE_BODY_MAX = 16 * 1024;

// Arrays (batches) and primitives have no own `method`, and a Set never
// matches inherited names, so neither is ever a handshake message.
export function isMcpHandshakeMessage(message) {
  return MCP_HANDSHAKE_METHODS.has(message?.method);
}

// True for a POST whose Content-Length is a plain decimal no larger than
// MCP_HANDSHAKE_BODY_MAX: its charge can wait until the message is parsed.
// Node caps the body it delivers at the declared length.
export function defersChargeToMessage(req) {
  if (req.method !== 'POST') return false;
  const declared = req.headers?.['content-length'];
  return typeof declared === 'string'
    && /^\d+$/.test(declared)
    && Number(declared) <= MCP_HANDSHAKE_BODY_MAX;
}

// Extract the rate-limit key from a request. Default: the socket's remote
// address (correct for direct connections). Behind a reverse proxy, set
// UM_RATE_LIMIT_TRUSTED_PROXY_HEADER=x-forwarded-for (or similar) to trust
// that header — takes the leftmost IP per RFC 7239 (the original client).
//
// Security note: trusting a forwarded header is spoof-safe ONLY if every
// untrusted hop is rejected at the network layer. Never enable this on an
// open port. Default off is the safe shape for direct-connection installs;
// proxy-fronted installs must opt in deliberately.
export function extractRateLimitKey(req, env = process.env) {
  const trustedHeader = env.UM_RATE_LIMIT_TRUSTED_PROXY_HEADER;
  if (trustedHeader) {
    const value = req.headers?.[trustedHeader.toLowerCase()];
    if (value) {
      return String(value).split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
