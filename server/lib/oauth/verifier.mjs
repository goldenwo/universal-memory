// server/lib/oauth/verifier.mjs
//
// OAuth access-token verification — the OR-branch the /mcp middleware calls
// (Gap-3 OAuth spec section 4.2: "/mcp auth becomes an OR behind one verifier
// interface: legacy bearer or OAuth token (hash lookup + expiry + audience +
// scope-table check)"). Hiding opaque-vs-JWT behind this one interface is the
// Gap-4 seam (spec section 10): a future JWT swap touches this module only.
import { sha256hex } from './state-store.mjs';

export function createOAuthVerifier(store, baseUrl, { now = Date.now } = {}) {
  const aud = `${baseUrl.replace(/\/+$/, '')}/mcp`;
  return function verifyOAuthBearer(bearer) {
    if (typeof bearer !== 'string' || !bearer.startsWith('umat_')) return null;
    const rec = store.findAccessToken(sha256hex(bearer));
    if (!rec || rec.exp <= now() || rec.aud !== aud) return null;
    return { sub: rec.sub, scope: rec.scope, branch: 'oauth' };
  };
}
