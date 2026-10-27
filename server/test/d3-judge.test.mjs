// server/test/d3-judge.test.mjs — D3.2 contradiction judge unit tests
//
// Three behaviours verified here:
//   (a) Provider + model resolution: UM_CONTRADICTION_PROVIDER resolved first;
//       the judge's model is the CONTRADICTION provider's own default, not the
//       summarizer provider's. (R3-G1 rule.)
//   (b) JSON parse fail-safe: malformed content from the invoke → no throw,
//       returns { contradicts:false }.
//   (c) Temporal-context guard in system prompt: the §3.4 guard wording
//       reaches the LLM system prompt.
//
// All tests use the _providerOverride seam (mirrors summarize.mjs pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeContradiction, JUDGE_BACKENDS } from '../lib/contradiction-judge.mjs';

// ── (a) Provider + model resolution (R3-G1) ─────────────────────────────────
//
// Scenario: UM_CONTRADICTION_PROVIDER=anthropic, UM_SUMMARIZER_PROVIDER=openai
// The model that arrives at the invoke MUST be anthropic's own default
// (claude-haiku-5-5), NOT openai's default (gpt-6-luna).

test('judge: R3-G1 — uses contradiction-provider own default model, not summarizer provider default', async () => {
  const savedContra = process.env.UM_CONTRADICTION_PROVIDER;
  const savedSumm   = process.env.UM_SUMMARIZER_PROVIDER;
  process.env.UM_CONTRADICTION_PROVIDER = 'anthropic';
  process.env.UM_SUMMARIZER_PROVIDER    = 'openai';

  let capturedModel;
  const stubProvider = {
    contradictionJudgeInvoke: async (prompt, opts) => {
      capturedModel = opts.model;
      return { content: JSON.stringify({ contradicts: false, confidence: 0.1, reasoning: 'stub' }), usage: { tokensIn: 1, tokensOut: 1 } };
    },
    defaults: { summarizerModel: 'stub-model' },
  };

  await judgeContradiction('older fact', 'newer fact', { _providerOverride: stubProvider });

  // R3-G1: the model must be anthropic's own summarizerModel default, not openai's.
  const anthropicDefault = JUDGE_BACKENDS.anthropic.defaults.summarizerModel;
  assert.equal(capturedModel, anthropicDefault, `expected anthropic default model '${anthropicDefault}', got '${capturedModel}'`);
  assert.notEqual(capturedModel, JUDGE_BACKENDS.openai.defaults.summarizerModel,
    'model must NOT be the openai (summarizer-provider) default');

  process.env.UM_CONTRADICTION_PROVIDER = savedContra;
  process.env.UM_SUMMARIZER_PROVIDER    = savedSumm;
});

// A blank provider or model variable is unset (the summarize.mjs convention, model migration
// Phase B review): the judge falls through to the next link instead of sending model '' or
// dispatching to a provider named ''.
test('judge: a blank UM_CONTRADICTION_PROVIDER / UM_CONTRADICTION_MODEL falls through the chain', async () => {
  const VARS = ['UM_CONTRADICTION_PROVIDER', 'UM_CONTRADICTION_MODEL', 'UM_SUMMARIZER_PROVIDER'];
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  let seen;
  const stub = { contradictionJudgeInvoke: async (p, o) => { seen = o.model; return { content: '{"contradicts":false,"confidence":0}', usage: {} }; } };
  try {
    for (const k of VARS) delete process.env[k];
    process.env.UM_CONTRADICTION_PROVIDER = '';
    process.env.UM_CONTRADICTION_MODEL = '';
    process.env.UM_SUMMARIZER_PROVIDER = 'anthropic';
    const v = await judgeContradiction('a', 'b', { _providerOverride: stub });
    assert.equal(v.ok, true);
    assert.equal(seen, JUDGE_BACKENDS.anthropic.defaults.summarizerModel);
  } finally {
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// ── (b) JSON parse fail-safe ─────────────────────────────────────────────────
//
// If the provider returns non-JSON / malformed content, the dispatcher must
// not throw. It returns { contradicts:false, confidence:0, reasoning:'parse-fail' }.

test('judge: parse failure → fail-safe { contradicts:false } without throw', async () => {
  const stubProvider = {
    contradictionJudgeInvoke: async () => ({
      content: 'This is not JSON at all!!!',
      usage: { tokensIn: 5, tokensOut: 5 },
    }),
    defaults: { summarizerModel: 'stub-model' },
  };

  let result;
  await assert.doesNotReject(async () => {
    result = await judgeContradiction('a', 'b', { provider: 'openai', _providerOverride: stubProvider });
  }, 'dispatcher must not throw on parse failure');

  assert.equal(result.contradicts, false, 'fail-safe must set contradicts=false');
  assert.equal(result.confidence, 0, 'fail-safe must set confidence=0');
  assert.equal(result.reasoning, 'parse-fail', 'fail-safe must set reasoning=parse-fail');
});

// ── (c) Temporal-context guard in system prompt ──────────────────────────────
//
// §3.4 mandates the judge system prompt contains the temporal-context guard:
// time-scoped / past-tense / dated statements must not be flagged as contradictions.
// We capture the systemPrompt passed to contradictionJudgeInvoke and assert
// it includes the key guard wording.

test('judge: system prompt contains temporal-context guard (§3.4 R1-Lens-B-G4)', async () => {
  let capturedSystemPrompt;
  const stubProvider = {
    contradictionJudgeInvoke: async (prompt, opts) => {
      capturedSystemPrompt = opts.systemPrompt;
      return {
        content: JSON.stringify({ contradicts: false, confidence: 0.5, reasoning: 'temporal ok' }),
        usage: { tokensIn: 10, tokensOut: 5 },
      };
    },
    defaults: { summarizerModel: 'stub-model' },
  };

  await judgeContradiction('I work at Acme', 'I work at Beta', { provider: 'openai', _providerOverride: stubProvider });

  assert.ok(capturedSystemPrompt, 'systemPrompt must be passed to provider invoke');

  // The guard must mention time-scoped / past-tense reasoning.
  // Checking for the core semantic terms (case-insensitive) per §3.4 intent.
  const lower = capturedSystemPrompt.toLowerCase();
  assert.ok(
    lower.includes('time-scoped') || lower.includes('past-tense') || lower.includes('dated'),
    `system prompt must mention temporal-context guard; got: ${capturedSystemPrompt.slice(0, 300)}`,
  );
  assert.ok(
    lower.includes('temporal') || lower.includes('past') || lower.includes('time'),
    `system prompt must reference time/temporal concepts; got: ${capturedSystemPrompt.slice(0, 300)}`,
  );
});

// ── (d) ok / failCause and the R1 call record (model migration Phase B, spec R1) ──
//
// The eval harnesses read why a verdict failed (an invoke-error is excluded and counted
// toward the 5% rule; a parse-fail is measured), and the in-band path counts an
// invoke-error as judge_error. The fail-safe verdicts themselves are unchanged.

const R1 = { requestParams: { model: 'm', temperature: 0 }, servedModel: 'm', systemFingerprint: 'fp_1', reasoningTokens: 0, stopReason: 'stop' };
const judgeVia = (invoke) => judgeContradiction('older', 'newer', { provider: 'openai', _providerOverride: { contradictionJudgeInvoke: invoke } });

test('judge: a parsed verdict is ok and carries the five R1 fields', async () => {
  const v = await judgeVia(async () => ({ content: '{"contradicts":true,"confidence":0.9,"reasoning":"r"}', usage: { tokensIn: 1, tokensOut: 1 }, ...R1 }));
  assert.equal(v.ok, true);
  assert.equal(v.failCause, undefined);
  assert.equal(v.contradicts, true);
  assert.equal(v.confidence, 0.9);
  for (const [k, val] of Object.entries(R1)) assert.deepEqual(v[k], val, k);
});

test('judge: a parse-fail is ok:false, failCause parse-fail, keeps the R1 fields and the fail-safe verdict', async () => {
  const v = await judgeVia(async () => ({ content: 'not json', usage: { tokensIn: 1, tokensOut: 1 }, ...R1 }));
  assert.deepEqual({ ok: v.ok, failCause: v.failCause, contradicts: v.contradicts, confidence: v.confidence, reasoning: v.reasoning },
    { ok: false, failCause: 'parse-fail', contradicts: false, confidence: 0, reasoning: 'parse-fail' });
  assert.equal(v.stopReason, 'stop');
  assert.deepEqual(v.requestParams, R1.requestParams);
});

test('judge: a throwing invoke is ok:false, failCause invoke-error, with the fail-safe verdict and no response fields', async () => {
  const v = await judgeVia(async () => { throw new Error('429'); });
  assert.deepEqual({ ok: v.ok, failCause: v.failCause, contradicts: v.contradicts, confidence: v.confidence },
    { ok: false, failCause: 'invoke-error', contradicts: false, confidence: 0 });
  assert.equal('requestParams' in v, false, 'an invoke-error carries no response');
});

test('judge: an unknown provider is an invoke-error (the call could not be made), fail-safe', async () => {
  const v = await judgeContradiction('a', 'b', { provider: 'not-a-provider' });
  assert.equal(v.ok, false);
  assert.equal(v.failCause, 'invoke-error');
  assert.equal(v.contradicts, false);
});
