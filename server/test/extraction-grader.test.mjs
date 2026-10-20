// server/test/extraction-grader.test.mjs — offline parse/fail-safe tests for judgeExtraction.
// Uses the _providerOverride seam (a fake answerGradeInvoke); no live SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeExtraction } from '../lib/extraction-grader.mjs';

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
