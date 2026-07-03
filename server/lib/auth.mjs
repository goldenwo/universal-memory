import { timingSafeEqual, createHash } from 'node:crypto';

export const FORWARDED_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'forwarded', 'via',
  'cf-connecting-ip', 'true-client-ip',
  'tailscale-user-login', 'tailscale-user-name',
];

export function extractBearer(req) {
  const h = req.headers?.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s(.+)$/.exec(h);
  return m ? m[1] : null;
}

// mem0 Platform-compat facade (compat spec §6): mem0 SaaS clients send
// `Authorization: Token <key>` (some send Bearer). Accept BOTH schemes —
// but ONLY on compat routes: Step-4 selects this extractor when the
// endpoint-class row carries compat:true; every other route keeps
// extractBearer. Same return contract as extractBearer (token string or
// null); the extracted value is validated against the same UM_AUTH_TOKEN.
export function extractCompatToken(req) {
  const h = req.headers?.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^(?:Token|Bearer)\s(.+)$/.exec(h);
  return m ? m[1] : null;
}

export function compareTokens(received, expected) {
  // W6.4 hardening: hash both inputs to fixed-size SHA-256 digests before
  // timing-safe compare. This eliminates any length-dependent timing channel
  // — both digests are always 32 bytes regardless of input length. The
  // earlier length-short-circuit-with-dummy-compare scheme was correct in
  // intent but used the wrong operand (expected vs expected, not received-
  // padded), which a sufficiently-precise timing observer could distinguish.
  // SHA-256 is fast (~µs for short inputs) and removes the issue entirely.
  const rHash = createHash('sha256').update(Buffer.from(received ?? '', 'utf8')).digest();
  const eHash = createHash('sha256').update(Buffer.from(expected ?? '', 'utf8')).digest();
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
