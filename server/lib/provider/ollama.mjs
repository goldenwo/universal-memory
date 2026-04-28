/**
 * server/lib/provider/ollama.mjs — Ollama implementation of the Standard Provider Contract.
 *
 * Supports all three surfaces: embeddings (nomic-embed-text, dim 768),
 * summarizer (llama3), and facts (llama3).
 *
 * Auth: None. Ollama is local-only; no API keys or authentication required.
 * Optional: OLLAMA_HOST env var to override default 'http://localhost:11434'.
 *
 * R5 mitigation (§10.5): probeModel() function validates that the user's
 * selected model is already pulled into the local Ollama instance before
 * attempting requests.
 *
 * See design §3.2 (Standard Provider Contract) for the full interface spec.
 */

import { ProviderError } from './errors.mjs';

export const providerName = 'ollama';

export const supports = { embeddings: true, summarizer: true, facts: true };

export const defaults = {
  summarizerModel: 'llama3',
  embeddingModel: 'nomic-embed-text',
  embeddingDim: 768,
  factsModel: 'llama3',
};

export const requires = [];

export function resolveApiKey(env) {
  // Ollama has no API keys; iterate empty requires, always return null
  for (const name of requires) {
    if (env[name]) return env[name];
  }
  return null;
}

export function validateKeyFormat(key) {
  // No key validation for local Ollama; always return true
  return true;
}

export function embedderConfig(env) {
  return {
    provider: 'ollama',
    config: {
      baseURL: env.OLLAMA_HOST || 'http://localhost:11434',
      model: env.UM_EMBEDDING_MODEL || defaults.embeddingModel,
    },
  };
}

export function factsLlmConfig(env) {
  return {
    provider: 'ollama',
    config: {
      baseURL: env.OLLAMA_HOST || 'http://localhost:11434',
      model: env.UM_FACTS_MODEL || defaults.factsModel,
    },
  };
}

export function extractUsage(raw) {
  return {
    tokensIn: raw?.prompt_eval_count ?? 0,
    tokensOut: raw?.eval_count ?? 0,
  };
}

export function normalizeError(err) {
  // Whitelist approach: return only {status, message}
  return {
    status: err?.status ?? err?.response?.status ?? 500,
    message: err?.message ?? 'provider error',
  };
}

export async function summarizerInvoke(prompt, { fetch = globalThis.fetch, host = process.env.OLLAMA_HOST || 'http://localhost:11434', model = defaults.summarizerModel, systemPrompt = '' }) {
  let res;
  try {
    res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, system: systemPrompt || undefined, stream: false }),
    });
  } catch (cause) {
    throw new ProviderError({
      class: 'PROVIDER_UPSTREAM',
      provider: 'ollama',
      status: 0,
      message: cause.message,
      retryable: true,
      cause,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError({
      class: res.status === 429 ? 'PROVIDER_RATELIMIT' : (res.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'ollama',
      status: res.status,
      message: text || `ollama HTTP ${res.status}`,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  const raw = await res.json();
  return {
    content: raw.response,
    usage: extractUsage(raw),
  };
}

/**
 * probeModel — R5 mitigation: validate that the user-selected model is
 * actually pulled into the local Ollama instance before attempting requests.
 *
 * Fetches /api/tags, checks if models[].name === model.
 *
 * @param {string} host - Ollama host URL (e.g. 'http://localhost:11434')
 * @param {string} model - Model name to probe (e.g. 'llama3')
 * @param {Object} opts - Options object { fetch }
 * @param {Function} opts.fetch - Fetch implementation (defaults to globalThis.fetch)
 * @returns {Promise<boolean>} - true if model found, false if absent
 * @throws {ProviderError} - on network/host unreachable errors
 */
export async function probeModel(host, model, { fetch: customFetch = globalThis.fetch } = {}) {
  let res;
  try {
    res = await customFetch(`${host}/api/tags`);
  } catch (cause) {
    throw new ProviderError({
      class: 'PROVIDER_UPSTREAM',
      provider: 'ollama',
      status: 0,
      message: `ollama probeModel failed: ${cause.message}`,
      retryable: false,
      cause,
    });
  }
  if (!res.ok) {
    throw new ProviderError({
      class: 'PROVIDER_UPSTREAM',
      provider: 'ollama',
      status: res.status,
      message: `ollama tags HTTP ${res.status}`,
      retryable: false,
    });
  }
  const data = await res.json();
  return Array.isArray(data?.models) && data.models.some((m) => m.name === model);
}
