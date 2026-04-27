/**
 * server/lib/embed.mjs — Embedding-surface dispatch: env-to-mem0 embedder-config translation.
 *
 * UM_EMBEDDING_PROVIDER selects the embedding provider (openai | google | ollama).
 * Anthropic does NOT support embeddings and is rejected with a helpful error.
 *
 * Produces a mem0 embedder config block: { provider, config: {...} }
 * consumed by `new Memory({ embedder: ..., ... })` at construction time.
 * mem0 OSS handles actual provider calls internally.
 *
 * See design §4.1 (mem0 config-translation pattern).
 */

import { providers, getProvider, supportingProviders } from './provider/registry.mjs';

export const EMBEDDING_BACKENDS = Object.fromEntries(
  Object.entries(providers).filter(([_, p]) => p.supports.embeddings),
);

export function getEmbedderConfig(env) {
  const name = env.UM_EMBEDDING_PROVIDER || 'openai';
  const provider = getProvider(name);
  if (!provider.supports.embeddings) {
    throw new Error(`${name} does not support embeddings; valid: ${supportingProviders('embeddings').join(', ')}`);
  }
  return provider.embedderConfig(env);
}
