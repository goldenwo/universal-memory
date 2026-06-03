/**
 * server/lib/provider/google.mjs — Google implementation of the Standard Provider Contract.
 *
 * Supports all three surfaces: embeddings (text-embedding-004), summarizer
 * (gemini-2.0-flash), and facts (gemini-2.0-flash).
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

export const providerName = 'google';

export const supports = { embeddings: true, summarizer: true, facts: true };

export const defaults = {
  summarizerModel: 'gemini-2.0-flash',
  embeddingModel: 'text-embedding-004',
  embeddingDim: 768,
  factsModel: 'gemini-2.0-flash',
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
    tokensOut: raw?.usageMetadata?.candidatesTokenCount ?? 0,
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

const FACTS_SYSTEM_PROMPT = `You are a fact extractor. The user message contains text from a memory store.
Extract atomic, declarative facts useful for personalization or recall.
Output ONLY a JSON object: {"facts": ["fact 1", "fact 2"]}. No preamble, no markdown fences.
If no facts can be extracted, output {"facts": []}.`;

function parseFactsJson(content) {
  const stripped = (content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed?.facts) && parsed.facts.every((f) => typeof f === 'string')) return parsed.facts;
  } catch { /* fall through */ }
  return [];
}

export async function factsInvoke(text, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.factsModel } = opts;
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
      config: { systemInstruction: FACTS_SYSTEM_PROMPT },
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
