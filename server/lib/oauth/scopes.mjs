// server/lib/oauth/scopes.mjs
//
// Data-driven scope -> tool-class table (Gap-3 OAuth spec section 3 Q3).
// 'vault' is the full-access superset; finer scopes later (vault:read,
// per-namespace) land as new table rows and existing 'vault' grants keep
// working — no re-consent. The 403 insufficient_scope shape ships from
// day 1 (spec section 6 item 6) even though single-'vault' makes it
// unreachable today.

export const SCOPE_GRANTS = Object.freeze({ vault: Object.freeze(['*']) });

// What the PRM document and the 401 challenge advertise (resource scopes).
// AS metadata additionally advertises 'offline_access' (spec section 4.2).
export const RESOURCE_SCOPES = Object.freeze(['vault']);

// Down-scope, never reject (spec section 4.2): Claude appends
// 'offline_access' to obtain refresh tokens; a strict-validating AS would
// invalid_scope the whole flow. Unknown scopes are dropped; an empty
// result falls back to the full resource-scope set.
export function negotiateScopes(requested) {
  const asked = String(requested ?? '').split(/\s+/).filter(Boolean);
  const offlineAccess = asked.includes('offline_access');
  const known = asked.filter((s) => s in SCOPE_GRANTS);
  return { granted: known.length ? known : [...RESOURCE_SCOPES], offlineAccess };
}

export function scopeAllowsTool(scopes, toolClass) {
  return scopes.some((s) => {
    const grants = SCOPE_GRANTS[s] ?? [];
    return grants.includes('*') || grants.includes(toolClass);
  });
}

export function insufficientScopeChallenge(neededScope) {
  return `Bearer error="insufficient_scope", scope="${neededScope}"`;
}
