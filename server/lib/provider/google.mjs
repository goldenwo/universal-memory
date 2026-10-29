/**
 * server/lib/provider/google.mjs — Google implementation of the Standard Provider Contract.
 *
 * Supports all three surfaces: embeddings (gemini-embedding-2), summarizer
 * (gemini-3.6-flash), and facts (gemini-3.6-flash) — see `defaults` below.
 *
 * Auth: Three-key precedence (Feas-4 from review loop) allows graceful override:
 *   1. UM_GOOGLE_API_KEY (UM-prefixed wins to allow power users to override)
 *   2. GOOGLE_API_KEY (standard Google env var)
 *   3. GEMINI_API_KEY (alternate Google key name)
 *
 * Security: normalizeError strips config.url (which carries ?key=AIza-... query param)
 * and config.params.key to mitigate R11 (Google-specific secret-leak surface).
 * See design §3.2 (Standard Provider Contract) and §10.5 R11 (normalizeError redaction).
 */

import { ProviderError } from './errors.mjs';
import { FACTS_SYSTEM_PROMPT } from './facts-prompt.mjs';

export const providerName = 'google';

export const supports = { embeddings: true, summarizer: true, facts: true };

export const defaults = {
  // 2026-10-23: Google's named replacements for gemini-2.0-flash (shut down 2026-06-01) and
  // text-embedding-004 (2026-01-14). gemini-embedding-2 returns 3072 dims when embedContent
  // sends no outputDimensionality (embed() below sends none). Not exercised live: the Gemini
  // account has been at quota 0 since 2026-05-01 (FIN1). A text-embedding-004 collection
  // mismatches this stamp at boot and needs `um-cli reindex --confirm`.
  summarizerModel: 'gemini-3.6-flash',
  embeddingModel: 'gemini-embedding-2',
  embeddingDim: 3072,
  factsModel: 'gemini-3.6-flash',
};

export const requires = ['UM_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];

export function resolveApiKey(env) {
  for (const name of requires) {
    if (env[name]) return env[name];
  }
  return null;
}

export function validateKeyFormat(key) {
  return typeof key === 'string' && key.startsWith('AIza');
}

export function embedderConfig(env) {
  return {
    provider: 'google',
    config: {
      model: env.UM_EMBEDDING_MODEL || defaults.embeddingModel,
      apiKey: resolveApiKey(env),
      // Pre-set the dimension so mem0 doesn't auto-detect at boot — see
      // the parallel comment in provider/openai.mjs for the rationale.
      embeddingDims: defaults.embeddingDim,
    },
  };
}

export function factsLlmConfig(env) {
  return {
    provider: 'google',
    config: {
      model: env.UM_FACTS_MODEL || defaults.factsModel,
      apiKey: resolveApiKey(env),
    },
  };
}

export function extractUsage(raw) {
  return {
    tokensIn: raw?.usageMetadata?.promptTokenCount ?? 0,
    // Gemini 3 bills thinking as output but reports it apart, in thoughtsTokenCount
    // (the gemini-3.6-flash default thinks); without it computeCost under-counts.
    tokensOut: (raw?.usageMetadata?.candidatesTokenCount ?? 0) + (raw?.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}

export function normalizeError(err) {
  // Whitelist-only approach: return only safe fields.
  // Google's secret-leak surface is in config.url (query string) and config.params.key.
  // This automatically drops all sensitive fields (config, request, response, etc.).
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
      content: '[MOCK] google summary',
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'google',
        status: 401,
        message: `summarize backend=google requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      ...(systemPrompt ? { config: { systemInstruction: systemPrompt } } : {}),
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'google',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  // Google GenAI SDK returns text directly on the response object
  return {
    content: raw.text,
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
      content: JSON.stringify({ contradicts: false, confidence: 0.1, reasoning: '[MOCK] google judge' }),
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'google',
        status: 401,
        message: `contradiction judge backend=google requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // temperature:0 for deterministic supersession (D3.3 follow-up); systemInstruction when present.
      config: { temperature: 0, ...(systemPrompt ? { systemInstruction: systemPrompt } : {}) },
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'google',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  // Google GenAI SDK returns text directly on the response object.
  return {
    content: raw.text,
    usage: extractUsage(raw),
  };
}

export async function embed(text, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.embeddingModel } = opts;
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      vector: new Array(defaults.embeddingDim).fill(0),
      usage: { tokensIn: 5, tokensOut: 0 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'google',
        status: 401,
        message: `embed backend=google requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.models.embedContent({ model, contents: text });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'google',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  // Google SDK returns `embeddings: [{ values: number[] }]`; confirm shape against
  // installed @google/genai version. If null/empty, throw PROVIDER_UPSTREAM.
  const vec = raw?.embeddings?.[0]?.values;
  if (!Array.isArray(vec)) {
    throw new ProviderError({
      class: 'PROVIDER_UPSTREAM',
      provider: 'google',
      status: 500,
      message: 'google embedContent returned unexpected shape (no embeddings[0].values)',
      retryable: false,
    });
  }
  return {
    vector: vec,
    usage: { tokensIn: 0, tokensOut: 0 },  // google embed API does not always return tokenCount
  };
}

// Facts prompt: shared v1.5.2 policy from facts-prompt.mjs since the #181 sync
// (pinned by test/provider-prompts-snapshot.test.mjs).

function parseFactsJson(content) {
  const stripped = (content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed?.facts) && parsed.facts.every((f) => typeof f === 'string')) return parsed.facts;
  } catch { /* fall through */ }
  return [];
}

export async function factsInvoke(text, opts = {}) {
  // temperature 0 by default, overridable — mirrors openai's facts pin (#181 sync;
  // determinism for dedup/supersession + run-to-run eval comparability).
  const { client: providedClient, env = process.env, model = defaults.factsModel, temperature = 0 } = opts;
  if (env.UM_TEST_MOCK_SDK === '1') {
    return { facts: ['[MOCK] google fact'], usage: { tokensIn: 10, tokensOut: 5 } };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'google',
        status: 401,
        message: `facts backend=google requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        systemInstruction: FACTS_SYSTEM_PROMPT,
        ...(temperature !== undefined ? { temperature } : {}),
      },
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'google',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    facts: parseFactsJson(raw.text),
    usage: extractUsage(raw),
  };
}
