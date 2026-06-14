// server/lib/oauth/idp/registry.mjs
// The IdpAdapter contract (one object per provider):
//   id
//   buildAuthorizeUrl({ state, redirectUri, nonce? }) -> string   (pure)
//   exchangeCode({ code, redirectUri }) -> { credentials }        (server-to-server)
//   fetchIdentity({ credentials, nonce? }) -> { subject, displayName }
// `credentials` is opaque to the flow; the optional `nonce` slot is unused by
// GitHub and reserved for a future OIDC adapter.
import { configuredProviders } from './config.mjs';
import { createGithubAdapter } from './github.mjs';

export { configuredProviders }; // re-export: single source lives in config.mjs

export function buildRegistry(env) {
  const adapters = new Map();
  for (const id of configuredProviders(env)) {
    if (id === 'github') adapters.set(id, createGithubAdapter(env));
  }
  return {
    get: (id) => adapters.get(id),
    list: () => [...adapters.values()],
  };
}
