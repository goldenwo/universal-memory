/**
 * server/lib/facts.mjs — Facts-surface dispatch: env-to-mem0 llm-config translation.
 *
 * UM_FACTS_PROVIDER selects the facts provider (openai | anthropic | google | ollama).
 * All four providers support facts.
 *
 * Produces a mem0 llm config block: { provider, config: {...} }
 * consumed by mem0 facts extraction in the facts pipeline.
 * mem0 OSS handles actual provider calls internally.
 *
 * See design §4.1 (mem0 config-translation pattern).
 */

import { providers, getProvider } from './provider/registry.mjs';

export const FACTS_BACKENDS = Object.fromEntries(
  Object.entries(providers).filter(([_, p]) => p.supports.facts),
);

export function getFactsLlmConfig(env) {
  const name = env.UM_FACTS_PROVIDER || 'openai';
  const provider = getProvider(name);
  if (!provider.supports.facts) {
    throw new Error(`${name} does not support facts`);
  }
  return provider.factsLlmConfig(env);
}
