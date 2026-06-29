import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeResponse, KEEP_CATEGORIES } from '../lib/mem0-import-judge.mjs';

test('parseJudgeResponse: validates enum, derives keep, falls back to unjudged', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const content = JSON.stringify({
    results: [
      { mem0_id: 'a', category: 'personal', reason: 'durable pref' },
      { mem0_id: 'b', category: 'dev', reason: 'project fact' },
      { mem0_id: 'c', category: 'ephemeral', reason: 'timestamp' },
      { mem0_id: 'd', category: 'banana', reason: 'hallucinated' }, // off-enum → unjudged
      // 'e' missing entirely → unjudged
    ],
  });
  const rows = parseJudgeResponse(content, ids);
  const by = Object.fromEntries(rows.map((r) => [r.mem0_id, r]));
  assert.equal(by.a.category, 'personal');
  assert.equal(by.a.keep, true);
  assert.equal(by.b.keep, true);
  assert.equal(by.c.category, 'ephemeral');
  assert.equal(by.c.keep, false);
  assert.equal(by.d.category, 'unjudged'); // off-enum is NOT a silent drop
  assert.equal(by.d.keep, false);
  assert.equal(by.e.category, 'unjudged'); // missing row preserved as unjudged
  assert.equal(rows.length, 5);
  assert.ok(KEEP_CATEGORIES.includes('personal') && KEEP_CATEGORIES.includes('dev'));
});

test('parseJudgeResponse: malformed JSON → all rows unjudged, none lost', () => {
  const rows = parseJudgeResponse('not json{', ['x', 'y']);
  assert.deepEqual(rows.map((r) => r.category), ['unjudged', 'unjudged']);
  assert.equal(rows.length, 2);
});
