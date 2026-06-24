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
