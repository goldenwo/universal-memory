// server/lib/oauth/idp/config.mjs
// Single source of truth for "which IdP providers are fully configured".
// Dependency-free on purpose: the pure endpoint-class module imports this, so it
// must NOT pull in any adapter/fetch code.
export function configuredProviders(env) {
  const out = [];
  const isSet = (v) => (v ?? '').trim() !== ''; // whitespace-only counts as unset
  if (
    isSet(env.UM_OAUTH_IDP_GITHUB_CLIENT_ID) &&
    isSet(env.UM_OAUTH_IDP_GITHUB_CLIENT_SECRET) &&
    isSet(env.UM_OAUTH_OPERATOR_GITHUB)
  ) out.push('github');
  return out;
}
