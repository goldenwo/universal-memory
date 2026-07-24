import { timingSafeEqual, createHash } from 'node:crypto';

export const FORWARDED_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'forwarded', 'via',
  'cf-connecting-ip', 'true-client-ip',
  'tailscale-user-login', 'tailscale-user-name',
];

// Shared Authorization-header extractor: the two public extractors differ
// ONLY in which auth schemes their pattern accepts. Returns the token
// string or null (absent/malformed header, wrong scheme, empty token).
function extractAuthToken(req, schemePattern) {
  const h = req.headers?.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = schemePattern.exec(h);
  return m ? m[1] : null;
}

export function extractBearer(req) {
  return extractAuthToken(req, /^Bearer\s(.+)$/);
}

// mem0 Platform-compat facade (compat spec §6): mem0 SaaS clients send
// `Authorization: Token <key>` (some send Bearer). Accept BOTH schemes —
// but ONLY on compat routes: Step-4 selects this extractor when the
// endpoint-class row carries compat:true; every other route keeps
// extractBearer. Same return contract as extractBearer (token string or
// null); the extracted value is validated against the same UM_AUTH_TOKEN.
export function extractCompatToken(req) {
  return extractAuthToken(req, /^(?:Token|Bearer)\s(.+)$/);
}

export function compareTokens(received, expected) {
  // Fail closed before comparing: absent/empty/non-string operands are never
  // a match. The earlier `?? ''` coercion made compareTokens('', undefined)
  // TRUE — an empty-token bypass at any call site that does not pre-guard
  // `expected` (v1.8.1 shipped bug). The early return leaks nothing: it keys
  // on operand presence/type, which the caller and attacker already know,
  // never on secret content.
  if (typeof received !== 'string' || received === '') return false;
  if (typeof expected !== 'string' || expected === '') return false;
  // W6.4 hardening: hash both inputs to fixed-size SHA-256 digests before
  // timing-safe compare. This eliminates any length-dependent timing channel
  // — both digests are always 32 bytes regardless of input length. The
  // earlier length-short-circuit-with-dummy-compare scheme was correct in
  // intent but used the wrong operand (expected vs expected, not received-
  // padded), which a sufficiently-precise timing observer could distinguish.
  // SHA-256 is fast (~µs for short inputs) and removes the issue entirely.
  const rHash = createHash('sha256').update(Buffer.from(received, 'utf8')).digest();
  const eHash = createHash('sha256').update(Buffer.from(expected, 'utf8')).digest();
  return timingSafeEqual(rHash, eHash);
}

export function shouldBypassLoopback(req, env = process.env) {
  if ((env.UM_ALLOW_LOOPBACK_NOAUTH ?? 'true') !== 'true') return false;
  const ip = req.socket?.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1') return false;
  for (const h of FORWARDED_HEADERS) {
    if (req.headers && req.headers[h] !== undefined) return false;
  }
  return true;
}
