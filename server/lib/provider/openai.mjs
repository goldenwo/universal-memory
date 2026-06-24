/**
 * server/lib/provider/openai.mjs — OpenAI implementation of the Standard Provider Contract.
 *
 * Supports all three surfaces: embeddings (text-embedding-3-small), summarizer
 * (gpt-4o-mini), and facts (gpt-4.1-nano-2025-04-14).
 *
 * Auth: UM_OPENAI_API_KEY (preferred) or OPENAI_API_KEY. The UM_-prefix wins
 * to allow power users to override OPENAI_API_KEY (used by other tools) with a
 * UM-specific key.
 *
 * See design §3.2 (Standard Provider Contract) for the full interface spec.
 */

import { ProviderError } from './errors.mjs';

export const providerName = 'openai';

export const supports = { embeddings: true, summarizer: true, facts: true };

export const defaults = {
  summarizerModel: 'gpt-4o-mini',
  embeddingModel: 'text-embedding-3-small',
  embeddingDim: 1536,
  factsModel: 'gpt-4.1-nano-2025-04-14',
};

export const requires = ['UM_OPENAI_API_KEY', 'OPENAI_API_KEY'];

export function resolveApiKey(env) {
  for (const name of requires) {
    if (env[name]) return env[name];
  }
  return null;
}

export function validateKeyFormat(key) {
  return typeof key === 'string' && key.startsWith('sk-');
}

export function embedderConfig(env) {
  return {
    provider: 'openai',
    config: {
      model: env.UM_EMBEDDING_MODEL || defaults.embeddingModel,
      apiKey: resolveApiKey(env),
      // Pre-set the dimension so mem0 doesn't make an embed API call at
      // boot to auto-detect it (which would require a valid key + working
      // upstream). Each provider knows its own default dim — this is the
      // documented opt-out per mem0's "Please set 'embeddingDims' in
      // embedder.config explicitly" error.
      embeddingDims: defaults.embeddingDim,
    },
  };
}

export function factsLlmConfig(env) {
  return {
    provider: 'openai',
    config: {
      model: env.UM_FACTS_MODEL || defaults.factsModel,
      apiKey: resolveApiKey(env),
    },
  };
}

export function extractUsage(raw) {
  return {
    tokensIn: raw?.usage?.prompt_tokens ?? 0,
    tokensOut: raw?.usage?.completion_tokens ?? 0,
  };
}

export function normalizeError(err) {
  return {
    status: err?.status ?? err?.response?.status ?? 500,
    message: err?.message ?? 'provider error',
  };
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
      content: '[MOCK] openai summary',
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'openai',
        status: 401,
        message: `summarize backend=openai requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: OpenAI } = await import('openai');
    client = new OpenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.chat.completions.create({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'openai',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    content: raw.choices[0].message.content,
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
      content: JSON.stringify({ contradicts: false, confidence: 0.1, reasoning: '[MOCK] openai judge' }),
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'openai',
        status: 401,
        message: `contradiction judge backend=openai requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: OpenAI } = await import('openai');
    client = new OpenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.chat.completions.create({
      model,
      temperature: 0, // deterministic supersession decisions (D3.3 follow-up)
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'openai',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    content: raw.choices[0].message.content,
    usage: extractUsage(raw),
  };
}

export const ANSWER_GRADER_MAX_TOKENS = 256; // one-line JSON + brief reasoning; avoids truncation→parse-fail (spec §2.1)

// Answer-correctness grader transport (offline eval — spec 2026-06-22). Mirrors
// contradictionJudgeInvoke exactly + an explicit max_tokens. The dispatcher
// (answer-grader.mjs) passes systemPrompt (ANSWER_SYSTEM_PROMPT) with the memory body
// already wrapped as untrusted data. One home for max_tokens, referenced once here.
export async function answerGradeInvoke(prompt, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.summarizerModel, systemPrompt = '', maxTokens } = opts;
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      content: JSON.stringify({ answers: false, confidence: 0.1, reasoning: '[MOCK] openai answer grader' }),
      usage: { tokensIn: 10, tokensOut: 5 },
    };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'openai',
        status: 401,
        message: `answer grader backend=openai requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: OpenAI } = await import('openai');
    client = new OpenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.chat.completions.create({
      model,
      temperature: 0, // deterministic grading
      max_tokens: maxTokens ?? ANSWER_GRADER_MAX_TOKENS, // default unchanged; extraction judge overrides (two arrays + reasoning)
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'openai',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    content: raw.choices[0].message.content,
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
        provider: 'openai',
        status: 401,
        message: `embed backend=openai requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: OpenAI } = await import('openai');
    client = new OpenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.embeddings.create({ model, input: text });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'openai',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    vector: raw.data[0].embedding,
    usage: { tokensIn: raw.usage?.prompt_tokens ?? 0, tokensOut: 0 },
  };
}

const FACTS_SYSTEM_PROMPT = `You are a fact extractor. The user message contains text from a memory store.
Extract atomic, declarative facts useful for personalization or recall.
Output ONLY a JSON object: {"facts": ["fact 1", "fact 2"]}. No preamble, no markdown fences.
If no facts can be extracted, output {"facts": []}.`;

function parseFactsJson(content) {
  // Tolerate accidental markdown fences (```json ... ```) — common LLM drift.
  // OpenAI also returns null content for refusals / content-filter stops,
  // so guard against TypeError before .replace runs.
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
  const { client: providedClient, env = process.env, model = defaults.factsModel, temperature } = opts;
  if (env.UM_TEST_MOCK_SDK === '1') {
    return { facts: ['[MOCK] openai fact'], usage: { tokensIn: 10, tokensOut: 5 } };
  }
  let client = providedClient;
  if (!client) {
    const apiKey = resolveApiKey(env);
    if (!apiKey) {
      throw new ProviderError({
        class: 'PROVIDER_CONFIG',
        provider: 'openai',
        status: 401,
        message: `facts backend=openai requires one of: ${requires.join(', ')}`,
        retryable: false,
      });
    }
    const { default: OpenAI } = await import('openai');
    client = new OpenAI({ apiKey });
  }
  let raw;
  try {
    raw = await client.chat.completions.create({
      model,
      // Inert by default: prod omits temperature (→ provider default). The extraction-fidelity
      // eval passes 0 so the system-under-test is deterministic for run-stable pinning.
      ...(temperature !== undefined ? { temperature } : {}),
      messages: [
        { role: 'system', content: FACTS_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    });
  } catch (cause) {
    const norm = normalizeError(cause);
    throw new ProviderError({
      class: norm.status === 429 ? 'PROVIDER_RATELIMIT' : (norm.status >= 500 ? 'PROVIDER_UPSTREAM' : 'PROVIDER_CONFIG'),
      provider: 'openai',
      status: norm.status,
      message: norm.message,
      retryable: norm.status === 429 || norm.status >= 500,
      cause: norm,
    });
  }
  return {
    facts: parseFactsJson(raw.choices[0].message.content),
    usage: extractUsage(raw),
  };
}
