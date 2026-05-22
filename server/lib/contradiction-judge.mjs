// server/lib/contradiction-judge.mjs — provider-neutral contradiction judge
//
// Mirrors the BACKENDS / dispatch pattern of summarize.mjs.
//
// Provider resolution (§3.4):
//   opts.provider → UM_CONTRADICTION_PROVIDER → UM_SUMMARIZER_PROVIDER → 'openai'
//
// Model resolution (R3-G1 — critical):
//   opts.model → UM_CONTRADICTION_MODEL → the RESOLVED contradiction-provider's
//   own defaults.summarizerModel. Never bleeds a model name from a different provider.

import * as openaiP    from './provider/openai.mjs';
import * as anthropicP from './provider/anthropic.mjs';
import * as googleP    from './provider/google.mjs';
import * as ollamaP    from './provider/ollama.mjs';

// §3.4 temporal-context guard — must appear verbatim in every judge system prompt.
// Exported so tests can assert exact presence without re-spelling the string.
export const TEMPORAL_GUARD_INSTRUCTION =
  'Treat any time-scoped / past-tense / dated statement as compatible with a ' +
  'differing present-tense statement; only flag a contradiction when both facts ' +
  'assert the same temporal frame. ' +
  'If either fact is time-scoped (e.g. "I worked at Acme until 2024", ' +
  '"used to live in X", "previously...", or carries an explicit past date), ' +
  'they can both be true and must NOT be judged a contradiction. ' +
  'The createdAt ordering establishes write-order, not truth-period — reason about ' +
  'the CONTENT\'s temporal frame, not timestamps.';

const JUDGE_SYSTEM_PROMPT =
  'You are a contradiction judge for a personal memory store. ' +
  'Given an OLDER fact and a NEWER fact from the same person, decide whether ' +
  'the newer fact contradicts (i.e. logically invalidates) the older one.\n\n' +
  TEMPORAL_GUARD_INSTRUCTION + '\n\n' +
  'Output ONLY a JSON object with exactly these fields — no preamble, no markdown fences:\n' +
  '{"contradicts": <boolean>, "confidence": <number 0..1>, "reasoning": "<brief explanation>"}\n\n' +
  'When in doubt, err toward contradicts=false (fail-safe: false supersessions are silent recall loss).';

export const JUDGE_BACKENDS = {
  openai:    { invoke: openaiP.contradictionJudgeInvoke,    requires: openaiP.requires,    defaults: openaiP.defaults },
  anthropic: { invoke: anthropicP.contradictionJudgeInvoke, requires: anthropicP.requires, defaults: anthropicP.defaults },
  google:    { invoke: googleP.contradictionJudgeInvoke,    requires: googleP.requires,    defaults: googleP.defaults },
  ollama:    { invoke: ollamaP.contradictionJudgeInvoke,    requires: ollamaP.requires,    defaults: ollamaP.defaults },
};

/**
 * Decide whether newerFact contradicts olderFact using a configured LLM judge.
 *
 * @param {string} olderFact - The existing / older fact text
 * @param {string} newerFact - The incoming / newer fact text
 * @param {object} opts - Options / DI overrides
 * @param {string}   [opts.provider]          - Provider name override (first in resolution chain)
 * @param {string}   [opts.model]             - Model override
 * @param {object}   [opts.client]            - Pre-made provider SDK client (for stubbing)
 * @param {Function} [opts.fetch]             - fetch replacement for ollama (for stubbing)
 * @param {string}   [opts.host]              - Ollama host override
 * @param {object}   [opts._providerOverride] - Test seam: object with contradictionJudgeInvoke;
 *                                              bypasses backend dispatch entirely.
 * @returns {Promise<{contradicts: boolean, confidence: number, reasoning: string, usage: object}>}
 */
export async function judgeContradiction(olderFact, newerFact, opts = {}) {
  // Provider resolution: opts.provider → UM_CONTRADICTION_PROVIDER → UM_SUMMARIZER_PROVIDER → 'openai'
  const providerName =
    opts.provider ??
    process.env.UM_CONTRADICTION_PROVIDER ??
    process.env.UM_SUMMARIZER_PROVIDER ??
    'openai';

  const b = JUDGE_BACKENDS[providerName];

  // R3-G1: model is resolved against the CONTRADICTION provider's own default —
  // never the summarizer provider's default, never UM_SUMMARIZER_MODEL.
  const model =
    opts.model ??
    process.env.UM_CONTRADICTION_MODEL ??
    b?.defaults?.summarizerModel;

  // Test seam: _providerOverride bypasses backend dispatch (mirrors summarize.mjs).
  const invoke = opts._providerOverride?.contradictionJudgeInvoke ?? b?.invoke;

  if (!invoke) {
    // Unknown / missing provider — fail-safe.
    return { contradicts: false, confidence: 0, reasoning: 'parse-fail', usage: { tokensIn: 0, tokensOut: 0 } };
  }

  const prompt =
    `OLDER FACT:\n${olderFact}\n\nNEWER FACT:\n${newerFact}`;

  let raw;
  try {
    raw = await invoke(prompt, {
      ...opts,
      model,
      client: opts.client,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
    });
  } catch {
    // Invoke error → fail-safe (same as parse failure).
    return { contradicts: false, confidence: 0, reasoning: 'parse-fail', usage: { tokensIn: 0, tokensOut: 0 } };
  }

  const usage = raw.usage ?? { tokensIn: 0, tokensOut: 0 };

  // Strict JSON parse; ANY throw → fail-safe.
  // Fail toward NOT superseding — a false supersession is silent recall loss.
  try {
    const stripped = (raw.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(stripped);
    return {
      contradicts: Boolean(parsed.contradicts),
      confidence:  typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning:   typeof parsed.reasoning  === 'string' ? parsed.reasoning  : '',
      usage,
    };
  } catch {
    return { contradicts: false, confidence: 0, reasoning: 'parse-fail', usage };
  }
}
