// server/test/extraction-grader.test.mjs — offline parse/fail-safe tests for judgeExtraction.
// Uses the _providerOverride seam (a fake answerGradeInvoke); no live SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeExtraction, EXTRACTION_GRADER_FALLBACK_MODEL } from '../lib/extraction-grader.mjs';

const fake = (content) => ({ answerGradeInvoke: async () => ({ content, usage: { tokensIn: 1, tokensOut: 1 } }) });

test('judgeExtraction: parses aligned boolean arrays', async () => {
  const r = await judgeExtraction('in', ['g1', 'g2'], ['e1'], {
    _providerOverride: fake(JSON.stringify({ goldMatched: [true, false], extractedSupported: [true], reasoning: 'x' })),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.goldMatched, [true, false]);
  assert.deepEqual(r.extractedSupported, [true]);
});

test('judgeExtraction: length mismatch → fail-safe ok:false', async () => {
  const r = await judgeExtraction('in', ['g1', 'g2'], ['e1'], {
    _providerOverride: fake(JSON.stringify({ goldMatched: [true], extractedSupported: [true] })),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.goldMatched, [false, false]); // fail-safe shape matches the asked-about lengths
  assert.deepEqual(r.extractedSupported, [false]);
});

test('judgeExtraction: malformed JSON → fail-safe ok:false', async () => {
  const r = await judgeExtraction('in', ['g1'], ['e1', 'e2'], { _providerOverride: fake('not json') });
  assert.equal(r.ok, false);
  assert.deepEqual(r.goldMatched, [false]);
  assert.deepEqual(r.extractedSupported, [false, false]);
});

test('judgeExtraction: strips ```json fences before parsing', async () => {
  const r = await judgeExtraction('in', ['g1'], ['e1'], {
    _providerOverride: fake('```json\n{"goldMatched":[true],"extractedSupported":[false]}\n```'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.goldMatched, [true]);
  assert.deepEqual(r.extractedSupported, [false]);
});

// --- #181: failCause distinguishes WHY ok:false (infra-flake carve-out signal) ---

test('judgeExtraction failCause: throwing invoke → invoke-error (the re-run candidate class)', async () => {
  const r = await judgeExtraction('in', ['g1'], ['e1'], {
    _providerOverride: { answerGradeInvoke: async () => { throw new Error('429 simulated'); } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.failCause, 'invoke-error');
});

test('judgeExtraction failCause: malformed JSON → parse-fail', async () => {
  const r = await judgeExtraction('in', ['g1'], ['e1'], { _providerOverride: fake('not json') });
  assert.equal(r.ok, false);
  assert.equal(r.failCause, 'parse-fail');
});

test('judgeExtraction failCause: length mismatch → misaligned', async () => {
  const r = await judgeExtraction('in', ['g1', 'g2'], ['e1'], {
    _providerOverride: fake(JSON.stringify({ goldMatched: [true], extractedSupported: [true], reasoning: 'x' })),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failCause, 'misaligned');
});

test('judgeExtraction failCause: override without answerGradeInvoke → no-invoke', async () => {
  const r = await judgeExtraction('in', ['g1'], ['e1'], { _providerOverride: {}, provider: 'not-a-provider' });
  assert.equal(r.ok, false);
  assert.equal(r.failCause, 'no-invoke');
});

test('judgeExtraction: an empty extracted list matches no gold fact, without asking the judge', async () => {
  // Measured 2026-10-20 (always-abstain control): given EXTRACTED (0), gpt-4o-mini marked gold
  // facts matched on 49 of 50 rows — reading them off the INPUT — so an abstaining extractor
  // paid no recall cost. Nothing extracted can express a gold fact; the answer is fixed.
  let called = false;
  const override = { answerGradeInvoke: async () => { called = true; return { content: '{"goldMatched":[true,true],"extractedSupported":[],"reasoning":"x"}' }; } };
  const v = await judgeExtraction('Alice moved to Berlin and works at Acme.', ['Alice lives in Berlin', 'Alice works at Acme'], [], { _providerOverride: override });
  assert.equal(called, false);
  assert.deepEqual(v.goldMatched, [false, false]);
  assert.deepEqual(v.extractedSupported, []);
  assert.equal(v.ok, true);
});

test('judgeExtraction: recall is judged without the INPUT, precision without the GOLD list', async () => {
  // Measured 2026-10-20 (first-gold control): with INPUT in view, gpt-4o-mini credited gold
  // facts the EXTRACTED list did not contain on 17 of 17 multi-fact rows (recall 0.973 where
  // 56/77 = 0.727 was right). Recall compares the two lists only; precision needs the INPUT.
  const prompts = [];
  const override = { answerGradeInvoke: async (prompt, opts) => {
    prompts.push({ prompt, system: opts.systemPrompt });
    return { content: JSON.stringify({ goldMatched: [true, false], extractedSupported: [true], reasoning: 'x' }), usage: { tokensIn: 2, tokensOut: 1 } };
  } };
  const v = await judgeExtraction('SECRET-INPUT-TEXT standup at 9:30am, capped at 15 minutes',
    ['GOLD-ONE standup is at 9:30am', 'GOLD-TWO standup is capped at 15 minutes'], ['standup is at 9:30am'], { _providerOverride: override });
  assert.equal(prompts.length, 2);
  const recall = prompts.find((p) => p.prompt.includes('GOLD-ONE'));
  const precision = prompts.find((p) => p.prompt.includes('SECRET-INPUT-TEXT'));
  assert.ok(recall && precision && recall !== precision);
  assert.equal(recall.prompt.includes('SECRET-INPUT-TEXT'), false, 'recall prompt must not carry the INPUT');
  assert.equal(precision.prompt.includes('GOLD-ONE'), false, 'precision prompt must not carry the GOLD list');
  assert.deepEqual(v.goldMatched, [true, false]);
  assert.deepEqual(v.extractedSupported, [true]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.usage, { tokensIn: 4, tokensOut: 2 });
});

// --- The fallback grader model (model migration Phase B, G's verdict) ---

// gpt-5.6-luna was the only eligible extraction grader in Phase B window 2 (0c4ca22), and is
// preferred over the gpt-6-luna facts default anyway (no same-model grading). It is the
// library's fallback and the fidelity eval's default; opts.model and the env still win.
test('judgeExtraction: model resolves opts.model → UM_EXTRACTION_GRADER_MODEL → gpt-5.6-luna', async () => {
  assert.equal(EXTRACTION_GRADER_FALLBACK_MODEL, 'gpt-5.6-luna');
  const seen = [];
  const override = { answerGradeInvoke: async (prompt, opts) => {
    seen.push(opts.model);
    return { content: JSON.stringify({ goldMatched: [true], extractedSupported: [true], reasoning: 'x' }), usage: {} };
  } };
  const saved = process.env.UM_EXTRACTION_GRADER_MODEL;
  try {
    delete process.env.UM_EXTRACTION_GRADER_MODEL;
    await judgeExtraction('in', ['g'], ['e'], { _providerOverride: override });
    process.env.UM_EXTRACTION_GRADER_MODEL = 'env-model';
    await judgeExtraction('in', ['g'], ['e'], { _providerOverride: override });
    await judgeExtraction('in', ['g'], ['e'], { _providerOverride: override, model: 'opts-model' });
  } finally {
    if (saved === undefined) delete process.env.UM_EXTRACTION_GRADER_MODEL; else process.env.UM_EXTRACTION_GRADER_MODEL = saved;
  }
  assert.deepEqual(seen, ['gpt-5.6-luna', 'gpt-5.6-luna', 'env-model', 'env-model', 'opts-model', 'opts-model']);
});

// --- R1 call records, per judge call (model migration Phase B, spec R1) ---

test('judgeExtraction: passes each judge call\'s R1 fields through in calls[], recall first, with its latency', async () => {
  const override = { answerGradeInvoke: async (prompt) => {
    const recall = prompt.startsWith('GOLD');
    return {
      content: JSON.stringify(recall ? { goldMatched: [true] } : { extractedSupported: [false] }),
      usage: { tokensIn: 1, tokensOut: 1 },
      requestParams: { model: 'm', max_tokens: 768 }, servedModel: recall ? 'm-r' : 'm-p',
      systemFingerprint: null, reasoningTokens: 0, stopReason: 'stop',
    };
  } };
  const v = await judgeExtraction('in', ['g1'], ['e1'], { _providerOverride: override });
  assert.equal(v.calls.length, 2);
  assert.deepEqual(v.calls.map((c) => [c.question, c.ok, c.servedModel]), [['recall', true, 'm-r'], ['precision', true, 'm-p']]);
  for (const c of v.calls) {
    assert.deepEqual(c.requestParams, { model: 'm', max_tokens: 768 });
    assert.equal(c.stopReason, 'stop');
    assert.equal(typeof c.ms, 'number');
  }
});

test('judgeExtraction: a failed call keeps its own failCause in calls[]; an invoke-error call has no response fields', async () => {
  const override = { answerGradeInvoke: async (prompt) => {
    if (prompt.startsWith('GOLD')) throw new Error('500');
    return { content: 'not json', usage: {}, requestParams: { model: 'm' }, servedModel: 'm', systemFingerprint: null, reasoningTokens: 0, stopReason: 'length' };
  } };
  const v = await judgeExtraction('in', ['g1'], ['e1'], { _providerOverride: override });
  assert.equal(v.ok, false);
  const [recall, precision] = v.calls;
  assert.deepEqual([recall.ok, recall.failCause, 'requestParams' in recall], [false, 'invoke-error', false]);
  assert.deepEqual([precision.ok, precision.failCause, precision.stopReason], [false, 'parse-fail', 'length']);
});

test('judgeExtraction: nothing extracted → no judge calls recorded', async () => {
  const v = await judgeExtraction('in', ['g1'], [], { _providerOverride: fake('{}') });
  assert.deepEqual(v.calls, []);
});
