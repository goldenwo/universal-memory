// server/lib/oauth/idp/policy.mjs
// Operator authorization policy. Single-operator: the configured GitHub identity
// (numeric id preferred, login accepted) is the sole account allowed to consent.
const isNumeric = (s) => /^[0-9]+$/.test(s);

export function makeOperatorPolicy(env) {
  const raw = (env.UM_OAUTH_OPERATOR_GITHUB ?? '').trim();
  // numeric → canonical 'github:<id>'; login-only is the degraded path (no stable id).
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
  return { isOperator, subForIdentity, operatorSub };
}
