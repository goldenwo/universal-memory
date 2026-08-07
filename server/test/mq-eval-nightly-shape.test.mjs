// server/test/mq-eval-nightly-shape.test.mjs — the nightly drift gate's artifact shape.
//
// `memory-quality-eval.mjs` IS the nightly drift gate (.github/workflows/nightly.yml runs
// `runOnce --gate mq-gate-thresholds.json`), whose floors were pinned from two live runs
// under a comment reading "never weaken to make CI green; re-pin only with a committed
// 2-run re-measurement". Anything that silently moves that run's output invalidates the
// pinned floors.
//
// The undated-arm work added two things to code the gate SHARES:
//   - `seedCorpus` — a `valid_from` pass-through (byte-identity pinned in mq-eval-backdate)
//   - `recallPass` — an opt-in `captureScores` that adds `topScores` to each detail row
//
// Both are default-inert. This file PROVES that rather than asserting it, which is the
// cheap half of the spec's before/after nightly comparison: the deterministic shape cannot
// drift without a test going red. (The graded half — answerCorrectness / noAnswer /
// staleness fireRate — runs through an LLM and needs a real doubled keyed run; that is not
// something a unit test can stand in for, and it is not claimed here.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recallPass } from '../eval/memory-quality-eval.mjs';

/**
 * The EXACT per-row detail keys the nightly artifact has always carried. Pinned as a set so
 * that ANY future addition — not just topScores — fails here and has to be a deliberate
 * re-pin rather than a silent shape change.
 */
const NIGHTLY_DETAIL_KEYS = [
  'bestNonTargetCos', 'id', 'ndcgByK', 'paraphrase_level', 'query',
  'rank1', 'recallByK', 'rr', 'targetCos', 'target_ref', 'topIds', 'twin',
];

const rows = [
  { id: 'r1', query: 'q1', target_ref: 'r1:0', paraphrase_level: 'paraphrase', seed_facts: [{ text: 'fact one', lane: 'work' }] },
  { id: 'r2', query: 'q2', target_ref: 'r2:0', paraphrase_level: 'oblique', seed_facts: [{ text: 'fact two', lane: 'home' }] },
];
const seeds = [
  { eval_ref: 'r1:0', text: 'fact one', lane: 'work', writeId: 'p1', event: 'ADD' },
  { eval_ref: 'r2:0', text: 'fact two', lane: 'home', writeId: 'p2', event: 'ADD' },
];

function deps() {
  return {
    memory: {},
    NOOP_METRICS: {},
    embed: async () => ({ vector: [1, 0, 0], tokensIn: 1, tokensOut: 0, costUsd: 0 }),
    cosineStrict: () => 0.1,
    doSearch: async (query) => ({
      results: query === 'q1'
        ? [{ id: 'p1', score: 0.9 }, { id: 'p2', score: 0.4 }]
        : [{ id: 'p2', score: 0.8 }, { id: 'p1', score: 0.3 }],
    }),
    rows,
    seeds,
    ks: [1, 3, 5, 10],
    cost: { embedTokensIn: 0, embedTokensOut: 0, embedCostUsd: 0 },
    latency: { umAdd: [], doSearch: [] },
  };
}

test('nightly shape: the DEFAULT recall pass carries exactly the historical detail keys', async () => {
  const out = await recallPass(deps());
  for (const d of out.details) {
    assert.deepEqual(Object.keys(d).sort(), NIGHTLY_DETAIL_KEYS,
      'the nightly artifact\'s per-row shape changed — re-pin deliberately or revert');
  }
});

test('nightly shape: topScores is ABSENT by default — the opt-in cannot leak into the gate', async () => {
  const out = await recallPass(deps());
  for (const d of out.details) {
    assert.ok(!('topScores' in d), 'captureScores must default OFF for the shared gate path');
  }
});

test('nightly shape: captureScores:true adds topScores and changes NOTHING else', async () => {
  // The undated arm needs the scores; the gate must not see them. Proving the two runs
  // differ by exactly that one key is what makes the opt-in safe.
  const plain = await recallPass(deps());
  const scored = await recallPass({ ...deps(), captureScores: true });

  assert.equal(scored.details.length, plain.details.length);
  for (let i = 0; i < plain.details.length; i++) {
    const extra = Object.keys(scored.details[i]).filter((k) => !(k in plain.details[i]));
    assert.deepEqual(extra, ['topScores'], 'captureScores must add exactly one key');
    for (const k of Object.keys(plain.details[i])) {
      assert.deepEqual(scored.details[i][k], plain.details[i][k], `${k} moved when scores were captured`);
    }
    assert.ok(Array.isArray(scored.details[i].topScores));
  }
});

test('nightly shape: the top-level recall keys are unchanged by the opt-in', async () => {
  // evaluateGate reads metric PATHS off this object; an absent path scores as a breach.
  const plain = await recallPass(deps());
  const scored = await recallPass({ ...deps(), captureScores: true });
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'details'));
  assert.deepEqual(strip(scored), strip(plain));
});

test('nightly shape: aggregate recall is computed identically with and without capture', async () => {
  const plain = await recallPass(deps());
  const scored = await recallPass({ ...deps(), captureScores: true });
  assert.deepEqual(scored.aggregate, plain.aggregate);
  assert.deepEqual(scored.mrr, plain.mrr);
});
