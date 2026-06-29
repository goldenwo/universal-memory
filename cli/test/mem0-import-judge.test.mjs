import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJudgeResponse,
  KEEP_CATEGORIES,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  judgeFacts,
} from '../lib/mem0-import-judge.mjs';

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

test('buildJudgeSystemPrompt names every category', () => {
  const sys = buildJudgeSystemPrompt();
  for (const c of ['personal', 'dev', 'ephemeral', 'stale_ops', 'junk', 'ops_domain']) {
    assert.ok(sys.includes(c), `system prompt must mention ${c}`);
  }
});

test('buildJudgeUserPrompt lists each fact with its id', () => {
  const u = buildJudgeUserPrompt([{ mem0_id: 'x1', text: 'Golden uses EST' }]);
  assert.ok(u.includes('x1') && u.includes('Golden uses EST'));
});

test('judgeFacts: batches, resumes (skips already-judged), survives a batch fault', async () => {
  const facts = [
    { mem0_id: 'a', text: 'never read .env' },
    { mem0_id: 'b', text: 'Date is 2026-04-15' },
    { mem0_id: 'c', text: 'edge-catcher is private' },
  ];
  const calls = [];
  const invoke = async (sys, user) => {
    calls.push(user);
    if (user.includes('b')) throw new Error('rate limit'); // fault on the batch containing b
    return {
      content: JSON.stringify({ results: [{ mem0_id: 'c', category: 'dev', reason: 'ok' }] }),
      usage: { tokensIn: 5, tokensOut: 2 },
    };
  };
  // alreadyJudged contains 'a' → must be skipped (not re-invoked)
  const rows = await judgeFacts(facts, { invoke, batchSize: 1, alreadyJudged: new Set(['a']) });
  const by = Object.fromEntries(rows.map((r) => [r.mem0_id, r]));
  assert.equal(by.a, undefined, 'already-judged fact is not re-judged');
  assert.equal(by.b.category, 'unjudged', 'faulted batch → unjudged, not lost');
  assert.equal(by.c.category, 'dev');
  assert.ok(!calls.some((u) => u.includes("'a'")), 'no invoke for already-judged a');
});
