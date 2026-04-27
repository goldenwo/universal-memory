import { timingSafeEqual } from 'node:crypto';

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

export function compareTokens(received, expected) {
  const r = Buffer.from(received ?? '', 'utf8');
  const e = Buffer.from(expected ?? '', 'utf8');
  // Length-mismatch short-circuit with fixed-cost dummy compare (A1).
  if (r.length !== e.length) {
    try { timingSafeEqual(e, e); } catch {}
    return false;
  }
  return timingSafeEqual(r, e);
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
