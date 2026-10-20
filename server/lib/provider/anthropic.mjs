/**
 * server/lib/provider/anthropic.mjs — Anthropic implementation of the Standard Provider Contract.
 *
 * Supports: summarizer (claude-haiku-4-5-20251001), facts (claude-haiku-4-5-20251001).
 * Request shape is model-aware via MODEL_CAPABILITIES (sampling params, thinking, effort);
 * unlisted models keep the pre-Haiku-5.5 shape.
 * Does NOT support: embeddings — Anthropic has no first-party embedding model.
 *   embedderConfig is literal `null` per spec §3.2 (registry filter detects null vs function).
 *
 * Auth: UM_ANTHROPIC_API_KEY (UM-prefixed wins) or ANTHROPIC_API_KEY.
 *
 * See design §3.2 (Standard Provider Contract).
 */

import { ProviderError } from './errors.mjs';
import { FACTS_SYSTEM_PROMPT } from './facts-prompt.mjs';

export const providerName = 'anthropic';

export const supports = { embeddings: false, summarizer: true, facts: true };

export const defaults = {
  summarizerModel: 'claude-haiku-4-5-20251001',
  factsModel: 'claude-haiku-4-5-20251001',
};

export const requires = ['UM_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'];

export const embedderConfig = null;

export function resolveApiKey(env) {
  for (const name of requires) {
    if (env[name]) return env[name];
  }
  return null;
}

export function validateKeyFormat(key) {
  return typeof key === 'string' && key.startsWith('sk-ant-');
}

export function factsLlmConfig(env) {
  return {
    provider: 'anthropic',
    config: {
      model: env.UM_FACTS_MODEL || defaults.factsModel,
      apiKey: resolveApiKey(env),
    },
  };
}

export function extractUsage(raw) {
  return {
    tokensIn: raw?.usage?.input_tokens ?? 0,
    tokensOut: raw?.usage?.output_tokens ?? 0,
  };
}

/**
 * Per-model request capabilities, keyed by exact model id. Unlisted models (Haiku 4.5,
 * Sonnet 4.6, any operator-pinned older id) get LEGACY_CAPABILITIES — the request shape
 * every Anthropic call had before Haiku 5.5.
 *   samplingParams   — accepts a non-default temperature (Haiku 5.5: any other value is a 400)
 *   adaptiveThinking — thinks unless told otherwise; thinking tokens count toward max_tokens
 *                      and the response can start with thinking blocks
 *   effort           — accepts output_config.effort
 */
export const MODEL_CAPABILITIES = Object.freeze({
  'claude-haiku-5-5': Object.freeze({ samplingParams: false, adaptiveThinking: true, effort: true }),
});

const LEGACY_CAPABILITIES = Object.freeze({ samplingParams: true, adaptiveThinking: false, effort: false });

export function capabilitiesFor(model) {
  return MODEL_CAPABILITIES[model] ?? LEGACY_CAPABILITIES;
}

// Room for adaptive thinking on top of a surface's answer budget, so thinking can't eat
// the answer and stop at max_tokens before any text block.
const THINKING_HEADROOM_TOKENS = 4096;

/**
 * Model-aware messages.create params shared by the three invoke paths. Knobs the model
 * doesn't take are dropped rather than sent: temperature where sampling params are
 * rejected, effort/thinking where the model has no such parameter.
 *
 * @param {string} model
 * @param {object} opts
 * @param {number} opts.maxTokens      - answer budget (headroom is added when the model thinks)
 * @param {number} [opts.temperature]
 * @param {string} [opts.effort]       - 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 * @param {string} [opts.thinking]     - 'adaptive' | 'disabled'; omitted = model default
 * @param {number} [opts.thinkingHeadroom] - tokens added for thinking (default THINKING_HEADROOM_TOKENS)
 */
export function requestParams(model, { maxTokens, temperature, effort, thinking, thinkingHeadroom = THINKING_HEADROOM_TOKENS }) {
  const caps = capabilitiesFor(model);
  const thinks = caps.adaptiveThinking && thinking !== 'disabled';
  return {
    model,
    max_tokens: maxTokens + (thinks ? thinkingHeadroom : 0),
    ...(caps.samplingParams && temperature !== undefined ? { temperature } : {}),
    ...(caps.adaptiveThinking && thinking ? { thinking: { type: thinking } } : {}),
    ...(caps.effort && effort ? { output_config: { effort } } : {}),
  };
}

// The first text block's text: thinking models can put thinking blocks first, and a
// thinking-only response (stopped at max_tokens) has no text at all.
function textOf(raw) {
  const block = raw.content.find((b) => b.type === 'text') ?? raw.content[0];
  return block?.text ?? null;
}

export function normalizeError(err) {
  // Strip sensitive headers from config and request objects
  const clean = {
    status: err?.status ?? err?.response?.status ?? 500,
    message: err?.message ?? 'provider error',
  };
  return clean;
}

export async function summarizerInvoke(prompt, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.summarizerModel, systemPrompt = '' } = opts;
  // UM_TEST_MOCK_SDK: short-circuit to canned response so smoke-gate boot
  // tests can spin the container up without real API calls (spec §9.4).
  // Mock shape mirrors the real return below: { content, usage }.
  // Strict `=== '1'` check matches the UM_SKIP_BOOT_SMOKE pattern — avoids
  // the string-truthy footgun where 'false'/'0' would silently activate.
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      content: '[MOCK] anthropic summary',
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'anthropic',
        status: 401,
        message: `summarize backend=anthropic requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey });
  }
  let raw;
  try {
    raw = await client.messages.create({
      // max_tokens is required by the Anthropic API. Default temperature — only the judge needs temp=0.
      ...requestParams(model, { maxTokens: 1024 }),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'anthropic',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    content: textOf(raw),
    usage: extractUsage(raw),
  };
}

export async function contradictionJudgeInvoke(prompt, opts = {}) {
  // Mirrors summarizerInvoke exactly — same auth, same client construction,
  // same mock-sdk short-circuit. The dispatcher passes systemPrompt with the
  // §3.4 temporal-context guard already embedded.
  const { client: providedClient, env = process.env, model = defaults.summarizerModel, systemPrompt = '' } = opts;
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      content: JSON.stringify({ contradicts: false, confidence: 0.1, reasoning: '[MOCK] anthropic judge' }),
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'anthropic',
        status: 401,
        message: `contradiction judge backend=anthropic requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey });
  }
  let raw;
  try {
    raw = await client.messages.create({
      // temperature 0: deterministic supersession decisions (D3.3 follow-up), on models that take it.
      ...requestParams(model, { maxTokens: 1024, temperature: 0 }),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'anthropic',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    content: textOf(raw),
    usage: extractUsage(raw),
  };
}

// Facts prompt: shared v1.5.2 policy from facts-prompt.mjs since the #181 sync
// (pinned by test/provider-prompts-snapshot.test.mjs).

// The facts list, or null when the reply is not a valid {"facts": string[]} object.
function parseFactsJson(content) {
  // Null-guard: SDK may return null content for refusals / content filter.
  const stripped = (content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed?.facts) && parsed.facts.every((f) => typeof f === 'string')) {
      return parsed.facts;
    }
  } catch { /* fall through */ }
  return null;
}

// Facts effort on models that take one: extraction is a short, high-volume single shot, so
// the cheapest level — the model still thinks when a row needs it, and can skip thinking on
// rows that don't. Overridable per call (opts.effort / opts.thinking / opts.thinkingHeadroom)
// for eval arms.
const FACTS_EFFORT = 'low';

export async function factsInvoke(text, opts = {}) {
  // temperature 0 by default, overridable — mirrors openai's facts pin (#181 sync;
  // determinism for dedup/supersession + run-to-run eval comparability). Dropped on
  // models that reject sampling params (capabilitiesFor).
  const {
    client: providedClient, env = process.env, model = defaults.factsModel, temperature = 0,
    effort = FACTS_EFFORT, thinking, thinkingHeadroom,
  } = opts;
  if (env.UM_TEST_MOCK_SDK === '1') {
    return { facts: ['[MOCK] anthropic fact'], usage: { tokensIn: 10, tokensOut: 5 } };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'anthropic',
        status: 401,
        message: `facts backend=anthropic requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey });
  }
  let raw;
  try {
    raw = await client.messages.create({
      ...requestParams(model, { maxTokens: 1024, temperature, effort, thinking, thinkingHeadroom }),
      system: FACTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'anthropic',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  // A malformed, truncated or refused reply also yields facts: []. parseOk and stopReason
  // let callers tell those from a clean abstention ({"facts": []} with end_turn).
  const parsed = parseFactsJson(textOf(raw));
  return {
    facts: parsed ?? [],
    usage: extractUsage(raw),
    stopReason: raw.stop_reason ?? null,
    parseOk: parsed !== null,
  };
}
