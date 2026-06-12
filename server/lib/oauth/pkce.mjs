// server/lib/oauth/pkce.mjs
//
// PKCE S256 verification (RFC 7636; Gap-3 OAuth spec section 6 item 3).
// S256 only — 'plain' is never accepted; the authorize endpoint rejects
// requests without an S256 challenge before any code is issued.

import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyS256(verifier, challenge) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  if (typeof challenge !== 'string' || challenge.length === 0) return false;
  const digest = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(challenge, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
