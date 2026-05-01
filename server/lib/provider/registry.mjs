/**
 * server/lib/provider/registry.mjs — central registry of all provider modules.
 *
 * Each provider module exports:
 *   providerName  {string}   — matches the key in this registry
 *   supports      {object}   — capability flags (e.g. { embeddings: true, chat: true })
 *   normalizeError {fn}      — wraps native error into ProviderError (see errors.mjs)
 *
 * `supports.embeddings` controls which providers the embedding pipeline selects.
 * Only providers that export `supports: { embeddings: true }` are returned by
 * `supportingProviders('embeddings')`. Anthropic has no embeddings API — omit or
 * set false there. See design §3.1 (provider capability matrix).
 *
 * A3-A6 ship the individual modules; A7 removes the skip-guard in registry.test.mjs.
 */

import * as openai from './openai.mjs';
import * as anthropic from './anthropic.mjs';
import * as google from './google.mjs';
import * as ollama from './ollama.mjs';

export const providers = {
  openai,
  anthropic,
  google,
  ollama,
};

export function getProvider(name) {
  const p = providers[name];
  if (!p) throw new Error(`unknown provider: ${name}; valid: ${Object.keys(providers).join(', ')}`);
  return p;
}

export function supportingProviders(surface) {
  return Object.entries(providers)
    .filter(([_, p]) => p.supports?.[surface] === true)
    .map(([name]) => name);
}
