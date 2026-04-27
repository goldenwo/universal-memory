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
      api_key: resolveApiKey(env),
    },
  };
}

export function factsLlmConfig(env) {
  return {
    provider: 'google',
    config: {
      model: env.UM_FACTS_MODEL || defaults.factsModel,
      api_key: resolveApiKey(env),
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

export async function summarizerInvoke(prompt, { client, model = defaults.summarizerModel, systemPrompt = '' }) {
  let raw;
  try {
    raw = await client.models.generateContent({
      model,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
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
