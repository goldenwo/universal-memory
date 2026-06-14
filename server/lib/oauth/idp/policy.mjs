// server/lib/oauth/idp/policy.mjs
// Operator authorization policy. Single-operator today: the allow-set holds one
// identity, stored as a one-element set so it widens to an allowlist / per-user
// map later with no shape change.
const isNumeric = (s) => /^[0-9]+$/.test(s);

export function makeOperatorPolicy(env) {
  const raw = (env.UM_OAUTH_OPERATOR_GITHUB ?? '').trim();
  const allow = raw ? new Set([raw]) : new Set();           // one element today
  const numericId = isNumeric(raw) ? raw : null;

  function isOperator(provider, identity) {
    if (provider !== 'github' || !raw) return false;
    if (numericId) return identity.subject === numericId;    // exact-string, no coercion
    return String(identity.displayName).toLowerCase() === raw.toLowerCase();
  }
  // sub when we have a live verified identity (the GitHub path)
  function subForIdentity(provider, identity) {
    return `${provider}:${identity.subject}`;
  }
  // canonical sub when we DON'T have a live identity (token paste / cookie short-circuit)
  function operatorSub() {
    return numericId ? `github:${numericId}` : 'owner';
  }
  return { isOperator, subForIdentity, operatorSub, allow };
}
