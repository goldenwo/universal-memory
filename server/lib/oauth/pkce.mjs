// server/lib/oauth/pkce.mjs
//
// PKCE S256 verification (RFC 7636; Gap-3 OAuth spec section 6 item 3).
// S256 only — 'plain' is never accepted; the authorize endpoint rejects
// requests without an S256 challenge before any code is issued.

import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyS256(verifier, challenge) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  // An S256 challenge is always 43 base64url chars (SHA-256 = 32 bytes).
  if (typeof challenge !== 'string' || challenge.length !== 43) return false;
  const digestBuf = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'), 'utf8');
  const challengeBuf = Buffer.from(challenge, 'utf8');
  // Length pre-check is REQUIRED — timingSafeEqual throws on unequal lengths.
  // It is not a timing channel: both lengths are public constants (43), never
  // secret-dependent. The byte comparison itself is constant-time.
  return digestBuf.length === challengeBuf.length && timingSafeEqual(digestBuf, challengeBuf);
}
