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

const URL_SAFE_ID = /^[a-z0-9_-]+$/; // ids are URL path segments: /oauth/idp/<id>/login|callback

export function buildRegistry(env) {
  const adapters = new Map();
  for (const id of configuredProviders(env)) {
    let adapter;
    if (id === 'github') adapter = createGithubAdapter(env);
    if (!adapter) continue;
    // The id is interpolated into route paths + the consent-page formaction, so a
    // non-URL-safe id (e.g. containing '/') would silently produce a broken URL.
    // Enforce the contract at the single registration chokepoint (fail-fast at boot).
    if (!URL_SAFE_ID.test(adapter.id)) {
      throw new Error(`IdP adapter id must be URL-safe (match ${URL_SAFE_ID}); got ${JSON.stringify(adapter.id)}`);
    }
    adapters.set(adapter.id, adapter);
  }
  return {
    get: (id) => adapters.get(id),
    list: () => [...adapters.values()],
  };
}
