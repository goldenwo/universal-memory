/**
 * server/lib/provider/openai.mjs — OpenAI implementation of the Standard Provider Contract.
 *
 * Supports all three surfaces: embeddings (text-embedding-3-small), summarizer
 * (gpt-4o-mini), and facts (gpt-6-luna — gpt-4.1-nano was shut down 2026-10-23; the
 * replacement was chosen by docs/plans/2026-10-23-model-migration/prereg.md).
 *
 * Auth: UM_OPENAI_API_KEY (preferred) or OPENAI_API_KEY. The UM_-prefix wins
 * to allow power users to override OPENAI_API_KEY (used by other tools) with a
 * UM-specific key.
 *
 * See design §3.2 (Standard Provider Contract) for the full interface spec.
 */

import { ProviderError } from './errors.mjs';
import { FACTS_SYSTEM_PROMPT } from './facts-prompt.mjs';

export const providerName = 'openai';

export const supports = { embeddings: true, summarizer: true, facts: true };

export const defaults = {
  summarizerModel: 'gpt-4o-mini',
  embeddingModel: 'text-embedding-3-small',
  embeddingDim: 1536,
  factsModel: 'gpt-6-luna',
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

/**
 * Per-model request capabilities, keyed by exact model id. Unlisted models (gpt-4o-mini,
 * gpt-4.1-*, any operator-pinned older id) get LEGACY_CAPABILITIES — the request shape every
 * OpenAI call had before the luna models (2026-10-23 migration, spec R1).
 *   samplingParams   — accepts a non-default temperature (luna: any other value is a 400)
 *   reasoningEffort  — accepts reasoning_effort; defaultEffort is sent when the caller names
 *                      none ('none' keeps the call free of reasoning tokens)
 *   completionTokens — takes the answer budget as max_completion_tokens, not max_tokens
 */
export const MODEL_CAPABILITIES = Object.freeze({
  'gpt-6-luna': Object.freeze({ samplingParams: false, reasoningEffort: true, defaultEffort: 'none', completionTokens: true }),
  'gpt-5.6-luna': Object.freeze({ samplingParams: false, reasoningEffort: true, defaultEffort: 'none', completionTokens: true }),
});

const LEGACY_CAPABILITIES = Object.freeze({ samplingParams: true, reasoningEffort: false, defaultEffort: null, completionTokens: false });

// A dated snapshot (`<alias>-YYYY-MM-DD`) takes its alias's entry, so an operator who pins
// one (and prices it) is not sent a temperature it rejects.
export function capabilitiesFor(model) {
  return MODEL_CAPABILITIES[model] ?? MODEL_CAPABILITIES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? LEGACY_CAPABILITIES;
}

/**
 * Model-aware chat.completions params (everything but messages) shared by the four call
 * sites. Knobs the model doesn't take are dropped rather than sent: a caller's temperature
 * on a model without sampling params, effort on a model without reasoning_effort.
 *
 * @param {string} model
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] - answer budget; sent under the model's own parameter name
 * @param {string} [opts.effort]    - reasoning_effort; omitted = the model's defaultEffort
 */
export function requestParams(model, { temperature, maxTokens, effort } = {}) {
  const caps = capabilitiesFor(model);
  const params = { model };
  if (caps.samplingParams && temperature !== undefined) params.temperature = temperature;
  if (caps.reasoningEffort) params.reasoning_effort = effort ?? caps.defaultEffort;
  if (maxTokens !== undefined) params[caps.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  return params;
}

export function extractUsage(raw) {
  return {
    tokensIn: raw?.usage?.prompt_tokens ?? 0,
    tokensOut: raw?.usage?.completion_tokens ?? 0,
  };
}

/**
 * The R1 call record (model migration Phase B, spec R1): what a summarizer, judge or grader
 * call sent and how it ended. The eval harnesses record it per call; production callers
 * ignore it. A field the response lacks is null, never a default, so the frozen scorer can
 * fail closed on it (a missing reasoning-token count must not read as 0). A refusal can
 * arrive with finish_reason 'stop', so the message's refusal field wins.
 */
function callRecord(raw, params) {
  const { message, finish_reason } = raw.choices[0];
  return {
    requestParams: params,
    servedModel: raw.model ?? null,
    systemFingerprint: raw.system_fingerprint ?? null,
    reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    stopReason: message.refusal ? 'refusal' : (finish_reason ?? null),
  };
}

// UM_TEST_MOCK_SDK's record: the params the real builder made, answered by the model asked for.
// It carries every field a live record does, which is why runs.sh refuses a leaked mock.
function mockCallRecord(params) {
  return { requestParams: params, servedModel: params.model, systemFingerprint: null, reasoningTokens: 0, stopReason: 'stop' };
}

export function normalizeError(err) {
  return {
    status: err?.status ?? err?.response?.status ?? 500,
    message: err?.message ?? 'provider error',
  };
}

export async function summarizerInvoke(prompt, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.summarizerModel, systemPrompt = '' } = opts;
  const params = requestParams(model);
  // UM_TEST_MOCK_SDK: short-circuit to canned response so smoke-gate boot
  // tests can spin the container up without real API calls (spec §9.4).
  // Mock shape mirrors the real return below: { content, usage, ...R1 record }.
  // Strict `=== '1'` check matches the UM_SKIP_BOOT_SMOKE pattern — avoids
  // the string-truthy footgun where 'false'/'0' would silently activate.
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      content: '[MOCK] openai summary',
      usage: { tokensIn: 10, tokensOut: 5 },
      ...mockCallRecord(params),
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
      ...params,
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
    ...callRecord(raw, params),
  };
}

export async function contradictionJudgeInvoke(prompt, opts = {}) {
  // Mirrors summarizerInvoke exactly — same auth, same client construction,
  // same mock-sdk short-circuit. The dispatcher passes systemPrompt with the
  // §3.4 temporal-context guard already embedded.
  const { client: providedClient, env = process.env, model = defaults.summarizerModel, systemPrompt = '' } = opts;
  // Deterministic supersession decisions (D3.3 follow-up) where the model allows it;
  // a luna model has no temperature 0 (spec R1 — its thresholds are re-measured in Phase B).
  const params = requestParams(model, { temperature: 0 });
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      content: JSON.stringify({ contradicts: false, confidence: 0.1, reasoning: '[MOCK] openai judge' }),
      usage: { tokensIn: 10, tokensOut: 5 },
      ...mockCallRecord(params),
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
      ...params,
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
    ...callRecord(raw, params),
  };
}

export const ANSWER_GRADER_MAX_TOKENS = 256; // one-line JSON + brief reasoning; avoids truncation→parse-fail (spec §2.1)

// Answer-correctness grader transport (offline eval — spec 2026-06-22). Mirrors
// contradictionJudgeInvoke exactly + an explicit max_tokens. The dispatcher
// (answer-grader.mjs) passes systemPrompt (ANSWER_SYSTEM_PROMPT) with the memory body
// already wrapped as untrusted data. One home for max_tokens, referenced once here.
export async function answerGradeInvoke(prompt, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.summarizerModel, systemPrompt = '', maxTokens } = opts;
  // Deterministic grading where the model allows it. Budget default unchanged; the
  // extraction judge overrides it (two arrays + reasoning).
  const params = requestParams(model, { temperature: 0, maxTokens: maxTokens ?? ANSWER_GRADER_MAX_TOKENS });
  if (env.UM_TEST_MOCK_SDK === '1') {
    return {
      content: JSON.stringify({ answers: false, confidence: 0.1, reasoning: '[MOCK] openai answer grader' }),
      usage: { tokensIn: 10, tokensOut: 5 },
      ...mockCallRecord(params),
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
      ...params,
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
    ...callRecord(raw, params),
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

// Extraction policy prompt: shared across all four providers since the #181
// cross-provider sync — policy text, provenance, and editing runbook live in
// facts-prompt.mjs (pinned by test/provider-prompts-snapshot.test.mjs).

function parseFactsJson(content) {
  // Tolerate accidental markdown fences (```json ... ```) — common LLM drift.
  // OpenAI also returns null content for refusals / content-filter stops,
  // so guard against TypeError before .replace runs.
  // Returns null (not []) when the reply is not a valid {"facts": string[]} object.
  const stripped = (content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed?.facts) && parsed.facts.every((f) => typeof f === 'string')) {
      return parsed.facts;
    }
  } catch { /* fall through */ }
  return null;
}

export async function factsInvoke(text, opts = {}) {
  const { client: providedClient, env = process.env, model = defaults.factsModel, temperature = 0, effort } = opts;
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
  // Deterministic by default (temperature 0), matching the two structured-output judges
  // (contradictionJudgeInvoke / answerGradeInvoke). Extraction is a single-shot structured
  // task — diversity buys no coverage, only run-to-run drift in dedup/supersession. The knob
  // stays overridable (opts.temperature) for the fidelity eval + diversity experiments; a
  // model without sampling params drops it (capabilitiesFor).
  const params = requestParams(model, { temperature, effort });
  let raw;
  try {
    raw = await client.chat.completions.create({
      ...params,
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
  // A malformed, truncated ('length'), filtered or refused reply also yields facts: [].
  // parseOk and stopReason let callers tell those from a clean abstention. A refusal can
  // arrive with finish_reason 'stop', so the message's refusal field wins.
  const { message, finish_reason } = raw.choices[0];
  const parsed = parseFactsJson(message.content);
  // requestParams / servedModel / reasoningTokens are the eval's record of what was asked
  // for and what answered (prereg 2026-10-23: request shape proven, alias moves visible);
  // production callers ignore them.
  return {
    facts: parsed ?? [],
    usage: extractUsage(raw),
    stopReason: message.refusal ? 'refusal' : (finish_reason ?? null),
    parseOk: parsed !== null,
    requestParams: params,
    servedModel: raw.model ?? null,
    reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}
