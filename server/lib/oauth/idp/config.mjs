// server/lib/oauth/idp/config.mjs
// Single source of truth for "which IdP providers are fully configured".
// Dependency-free on purpose: the pure endpoint-class module imports this, so it
// must NOT pull in any adapter/fetch code.
export function configuredProviders(env) {
  const out = [];
  if (
    env.UM_OAUTH_IDP_GITHUB_CLIENT_ID &&
    env.UM_OAUTH_IDP_GITHUB_CLIENT_SECRET &&
    env.UM_OAUTH_OPERATOR_GITHUB
  ) out.push('github');
  return out;
}
