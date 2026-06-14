// server/lib/oauth/idp/policy.mjs
// Operator authorization policy. Single-operator today: the allow-set holds one
// identity, stored as a one-element set so it widens to an allowlist / per-user
// map later with no shape change.
const isNumeric = (s) => /^[0-9]+$/.test(s);

export function makeOperatorPolicy(env) {
  const raw = (env.UM_OAUTH_OPERATOR_GITHUB ?? '').trim();
  // Canonical form so this widens to a per-user allowlist at Gap-4 with no
  // shape change AND matches the sub that subForIdentity()/operatorSub() emit:
  // numeric → 'github:<id>'; login-only is the degraded path (no stable id) so
  // it keeps the raw login.
  const allow = raw ? new Set([isNumeric(raw) ? `github:${raw}` : raw]) : new Set();
  const numericId = isNumeric(raw) ? raw : null;

  function isOperator(provider, identity) {
    if (provider !== 'github' || !raw) return false;
    if (numericId) return identity.subject === numericId;    // exact-string, no coercion
    return String(identity.displayName).toLowerCase() === raw.toLowerCase();
  }
  // sub when we have a live verified identity (the GitHub path)
  // `provider` is supplied by the IdP dispatch layer, which guarantees it matches
  // the configured provider before this is called (see callback handler).
  function subForIdentity(provider, identity) {
    return `${provider}:${identity.subject}`;
  }
  // canonical sub when we DON'T have a live identity (token paste / cookie short-circuit)
  function operatorSub() {
    return numericId ? `github:${numericId}` : 'owner';
  }
  return { isOperator, subForIdentity, operatorSub, allow };
}
