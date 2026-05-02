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
 *
 * G2: in addition to the config translator above, this module exposes an
 * embed() orchestrator so direct (non-mem0) embed call sites and tests can
 * exercise um_provider_* metrics emission. The metric surface label is
 * 'embed' (SINGULAR), bridging from registry surface key 'embeddings'
 * (plural) per spec §8.3 enum and the §3.2 capability table.
 */

import { providers, getProvider, supportingProviders } from './provider/registry.mjs';
import { computeCost } from './pricing.mjs';
import { PROVIDER_METRICS, NOOP_METRICS, SURFACES } from './metrics.mjs';

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

/**
 * Embed text via the selected provider, emitting um_provider_* metrics
 * (spec §8.3) on success and error paths.
 *
 * Uses surface label 'embed' (singular) per §8.3 metric-label enum, NOT the
 * plural registry key 'embeddings' (capability table).
 *
 * @param {string} text
 * @param {object} ctx
 * @param {string} [ctx.provider]            - Provider name (default: env.UM_EMBEDDING_PROVIDER || 'openai')
 * @param {string} [ctx.model]               - Model override
 * @param {object} [ctx._providerOverride]   - Test seam: object with `embed(text, opts)` method
 * @param {object} [ctx.metrics]             - DI metrics sink ({ counter, histogram }); defaults to no-op
 * @returns {Promise<{vector: number[], tokensIn: number, tokensOut: number, costUsd: number}>}
 */
export async function embed(text, ctx = {}) {
  const providerName = ctx.provider ?? process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const provider = ctx._providerOverride ?? getProvider(providerName);
  const supportsEmbeddings = ctx._providerOverride
    ? true
    : provider.supports?.embeddings === true;
  if (!supportsEmbeddings) {
    throw new Error(`${providerName} does not support embeddings; valid: ${supportingProviders('embeddings').join(', ')}`);
  }
  const model = ctx.model ?? process.env.UM_EMBEDDING_MODEL ?? provider.defaults?.embeddingModel;

  const metrics = ctx.metrics ?? NOOP_METRICS;
  // SINGULAR per spec §8.3 — bridges from registry surface key 'embeddings'.
  const surface = SURFACES.EMBED;
  const labels = { provider: providerName, model, surface };
  const startNs = process.hrtime.bigint();

  // The provider's embed() returns { vector, usage: { tokensIn, tokensOut } }.
  // After v0.8 G2, every provider in EMBEDDING_BACKENDS exports embed(). The
  // guard that previously short-circuited here was a transition-phase aid;
  // a missing method now becomes a TypeError at the call below — fail-loud.

  let raw;
  try {
    raw = await provider.embed(text, { ...ctx, model });
  } catch (err) {
    metrics.counter(
      PROVIDER_METRICS.ERRORS_TOTAL,
      { ...labels, error_class: err?.class ?? 'UNKNOWN' },
      1,
    );
    throw err;
  }
  const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;

  const tokensIn = raw.usage?.tokensIn ?? raw.tokensIn ?? 0;
  const tokensOut = raw.usage?.tokensOut ?? raw.tokensOut ?? 0;
  const vector = raw.vector ?? raw.embedding;
  const costUsd = providerName === 'ollama' ? 0 : computeCost(providerName, model, tokensIn, tokensOut);

  metrics.counter(PROVIDER_METRICS.TOKENS_TOTAL, { ...labels, direction: 'in' }, tokensIn);
  metrics.counter(PROVIDER_METRICS.TOKENS_TOTAL, { ...labels, direction: 'out' }, tokensOut);
  metrics.counter(PROVIDER_METRICS.COST_USD_TOTAL, labels, costUsd);
  metrics.histogram(PROVIDER_METRICS.REQUEST_DURATION_SECONDS, labels, elapsedSec);

  return { vector, tokensIn, tokensOut, costUsd, provider: providerName, model };
}
