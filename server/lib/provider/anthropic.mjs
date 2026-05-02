/**
 * server/lib/provider/anthropic.mjs — Anthropic implementation of the Standard Provider Contract.
 *
 * Supports: summarizer (claude-haiku-4-5-20251001), facts (claude-haiku-4-5-20251001).
 * Does NOT support: embeddings — Anthropic has no first-party embedding model.
 *   embedderConfig is literal `null` per spec §3.2 (registry filter detects null vs function).
 *
 * Auth: UM_ANTHROPIC_API_KEY (UM-prefixed wins) or ANTHROPIC_API_KEY.
 *
 * See design §3.2 (Standard Provider Contract).
 */

import { ProviderError } from './errors.mjs';

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
      model,
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
  // Anthropic SDK returns content as an array of content blocks; extract text from first block
  return {
    content: raw.content[0].text,
    usage: extractUsage(raw),
  };
}

const FACTS_SYSTEM_PROMPT = `You are a fact extractor. The user message contains text from a memory store.
Extract atomic, declarative facts useful for personalization or recall.
Output ONLY a JSON object: {"facts": ["fact 1", "fact 2"]}. No preamble, no markdown fences.
If no facts can be extracted, output {"facts": []}.`;

function parseFactsJson(content) {
  // Null-guard: SDK may return null content for refusals / content filter.
  const stripped = (content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed?.facts) && parsed.facts.every((f) => typeof f === 'string')) {
      return parsed.facts;
    }
  } catch { /* fall through */ }
  return [];
}

export async function factsInvoke(text, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.factsModel } = opts;
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
      model,
      max_tokens: 1024,
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
  // Anthropic returns content as content blocks; the first text block holds the JSON.
  const textBlock = raw.content.find((b) => b.type === 'text') ?? raw.content[0];
  return {
    facts: parseFactsJson(textBlock.text),
    usage: extractUsage(raw),
  };
}
