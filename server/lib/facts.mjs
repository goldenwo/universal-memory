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
 *
 * G2: in addition to the config translator above, this module exposes a
 * facts() orchestrator so direct facts call sites and tests can exercise
 * um_provider_* metric emission with surface label 'facts' (spec §8.3).
 */

import { providers, getProvider, supportingProviders } from './provider/registry.mjs';
import { computeCost } from './pricing.mjs';

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

// G2: no-op default metrics sink (see summarize.mjs note).
const NOOP_METRICS = { counter: () => {}, histogram: () => {} };

/**
 * Extract facts from text via the selected provider, emitting um_provider_*
 * metrics (spec §8.3) on success and error paths. Surface label is 'facts'.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {string} [ctx.provider]            - Provider name (default: env.UM_FACTS_PROVIDER || 'openai')
 * @param {string} [ctx.model]               - Model override
 * @param {object} [ctx._providerOverride]   - Test seam: object with `factsInvoke(text, opts)` method
 * @param {object} [ctx.metrics]             - DI metrics sink ({ counter, histogram }); defaults to no-op
 * @returns {Promise<{facts: any, tokensIn: number, tokensOut: number, costUsd: number}>}
 */
export async function facts(text, ctx = {}) {
  const providerName = ctx.provider ?? process.env.UM_FACTS_PROVIDER ?? 'openai';
  const provider = ctx._providerOverride ?? getProvider(providerName);
  const supportsFacts = ctx._providerOverride
    ? true
    : provider.supports?.facts === true;
  if (!supportsFacts) {
    throw new Error(`${providerName} does not support facts; valid: ${supportingProviders('facts').join(', ')}`);
  }
  const model = ctx.model ?? process.env.UM_FACTS_MODEL ?? provider.defaults?.factsModel;

  const metrics = ctx.metrics ?? NOOP_METRICS;
  const surface = 'facts';
  const labels = { provider: providerName, model, surface };
  const startNs = process.hrtime.bigint();

  if (typeof provider.factsInvoke !== 'function') {
    throw new Error(`provider ${providerName} has no factsInvoke() method (G2: real provider.factsInvoke lands in a later task; tests must inject _providerOverride)`);
  }

  let raw;
  try {
    raw = await provider.factsInvoke(text, { ...ctx, model });
  } catch (err) {
    metrics.counter(
      'um_provider_errors_total',
      { ...labels, error_class: err?.class ?? 'UNKNOWN' },
      1,
    );
    throw err;
  }
  const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;

  const tokensIn = raw.usage?.tokensIn ?? raw.tokensIn ?? 0;
  const tokensOut = raw.usage?.tokensOut ?? raw.tokensOut ?? 0;
  const extracted = raw.facts ?? raw.content ?? null;
  const costUsd = providerName === 'ollama' ? 0 : computeCost(providerName, model, tokensIn, tokensOut);

  metrics.counter('um_provider_tokens_total', { ...labels, direction: 'in' }, tokensIn);
  metrics.counter('um_provider_tokens_total', { ...labels, direction: 'out' }, tokensOut);
  metrics.counter('um_provider_cost_usd_total', labels, costUsd);
  metrics.histogram('um_provider_request_duration_seconds', labels, elapsedSec);

  return { facts: extracted, tokensIn, tokensOut, costUsd };
}
