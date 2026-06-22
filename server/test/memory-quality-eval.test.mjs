// server/test/memory-quality-eval.test.mjs — end-to-end memory-quality eval
// harness unit tests (Tier-1 pass: recall@k + MRR + stale-return + no-answer).
//
// TDD: written FIRST (before eval/memory-quality-eval.mjs implements its bodies),
// per docs/plans/2026-06-15-memory-quality-eval-plan.md Phase 1 (T1.1–T1.3).
//
// Imports ONLY the PURE exported scoring functions. Importing the module must NOT
// trigger any live umAdd/doSearch/embed/qdrant call — the CLI path lazy-imports its
// live deps inside runOnce (the lane/d3 faithfulness contract), so a plain import
// here stays fully offline.
//
// Coverage (plan T1.1):
//   - recallAtK: per-query hit@k for target at rank 1 / mid / beyond k / absent;
//       empty results; k > result count; multi-target (any match); empty targets
//   - aggregateRecall: mean per k over queries; empty → null
//   - reciprocalRank + mrr: 1/rank, first-target-wins, absent→0; mean; empty→null
//   - staleReturnRate: rate of surfacedOriginal over FIRED rows; empty→null; all-false→0
//   - noAnswerPrecision: rate of correct-empty over distractors; empty→null; all-correct→1
//   - fireRate: rate of detector-fired rows; empty→null
//   - formatSummaryTable: non-empty string with expected section tokens; null-tolerant
//   - loadFixtureJsonl: round-trip temp jsonl; malformed line throws WITH line number
//   - parseArgs: --recall / --staleness / --out-prefix / --out

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recallAtK,
  aggregateRecall,
  reciprocalRank,
  mrr,
  staleReturnRate,
  noAnswerPrecision,
  answerCorrectnessRate,
  fireRate,
  formatSummaryTable,
  loadFixtureJsonl,
  parseArgs,
  evaluateGate,
  formatGateReport,
  answerCorrectnessPass,
} from '../eval/memory-quality-eval.mjs';

const KS = [1, 3, 5, 10];

// --- recallAtK -------------------------------------------------------------

test('recallAtK: target at rank 1 → hit at every k', () => {
  const r = recallAtK(['t', 'a', 'b', 'c'], ['t'], KS);
  assert.deepEqual(r, { 1: 1, 3: 1, 5: 1, 10: 1 });
});

test('recallAtK: target at rank 3 → miss@1, hit@3+', () => {
  const r = recallAtK(['a', 'b', 't', 'c'], ['t'], KS);
  assert.deepEqual(r, { 1: 0, 3: 1, 5: 1, 10: 1 });
});

test('recallAtK: target at rank 7 → only hit@10', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 't', 'g'];
  const r = recallAtK(ranked, ['t'], KS);
  assert.deepEqual(r, { 1: 0, 3: 0, 5: 0, 10: 1 });
});

test('recallAtK: target absent → miss at every k', () => {
  const r = recallAtK(['a', 'b', 'c'], ['t'], KS);
  assert.deepEqual(r, { 1: 0, 3: 0, 5: 0, 10: 0 });
});

test('recallAtK: empty results → miss at every k', () => {
  const r = recallAtK([], ['t'], KS);
  assert.deepEqual(r, { 1: 0, 3: 0, 5: 0, 10: 0 });
});

test('recallAtK: k larger than result count uses what is there', () => {
  // 2 results, target at rank 2 → hit@3/5/10 (k clamped to available), miss@1.
  const r = recallAtK(['a', 't'], ['t'], KS);
  assert.deepEqual(r, { 1: 0, 3: 1, 5: 1, 10: 1 });
});

test('recallAtK: multiple acceptable targets — any match counts', () => {
  const r = recallAtK(['a', 'x', 'b'], ['t', 'x'], KS);
  assert.deepEqual(r, { 1: 0, 3: 1, 5: 1, 10: 1 });
});

test('recallAtK: empty target set → miss at every k (defensive)', () => {
  const r = recallAtK(['a', 'b'], [], KS);
  assert.deepEqual(r, { 1: 0, 3: 0, 5: 0, 10: 0 });
});

// --- aggregateRecall -------------------------------------------------------

test('aggregateRecall: mean per k over queries', () => {
  const perQuery = [
    { 1: 1, 3: 1, 5: 1, 10: 1 },
    { 1: 0, 3: 1, 5: 1, 10: 1 },
  ];
  assert.deepEqual(aggregateRecall(perQuery, KS), { 1: 0.5, 3: 1, 5: 1, 10: 1 });
});

test('aggregateRecall: empty input → null per k (no data)', () => {
  assert.deepEqual(aggregateRecall([], KS), { 1: null, 3: null, 5: null, 10: null });
});

// --- reciprocalRank + mrr --------------------------------------------------

test('reciprocalRank: rank 1 → 1.0', () => {
  assert.equal(reciprocalRank(['t', 'a'], ['t']), 1);
});

test('reciprocalRank: rank 4 → 0.25', () => {
  assert.equal(reciprocalRank(['a', 'b', 'c', 't'], ['t']), 0.25);
});

test('reciprocalRank: absent → 0', () => {
  assert.equal(reciprocalRank(['a', 'b'], ['t']), 0);
});

test('reciprocalRank: first matching target wins', () => {
  // target 'y' at rank 2, 'x' at rank 4 → 1/2.
  assert.equal(reciprocalRank(['a', 'y', 'b', 'x'], ['x', 'y']), 0.5);
});

test('mrr: mean of reciprocal ranks', () => {
  assert.equal(mrr([1, 0.5, 0]), 0.5);
});

test('mrr: empty → null', () => {
  assert.equal(mrr([]), null);
});

// --- staleReturnRate (over detector-FIRED rows only) -----------------------

test('staleReturnRate: fraction surfacing the demoted original', () => {
  const fired = [
    { surfacedOriginal: true },
    { surfacedOriginal: false },
    { surfacedOriginal: false },
  ];
  assert.equal(staleReturnRate(fired), 1 / 3);
});

test('staleReturnRate: none stale → 0', () => {
  assert.equal(staleReturnRate([{ surfacedOriginal: false }, { surfacedOriginal: false }]), 0);
});

test('staleReturnRate: no fired rows → null (unmeasurable)', () => {
  assert.equal(staleReturnRate([]), null);
});

// --- noAnswerPrecision (over unanswerable queries; topHitAnswered = grader verdict) ---

test('noAnswerPrecision: fraction whose top hit did NOT answer', () => {
  const rows = [
    { topHitAnswered: false },
    { topHitAnswered: false },
    { topHitAnswered: true },
  ];
  assert.equal(noAnswerPrecision(rows), 2 / 3);
});

test('noAnswerPrecision: all correctly non-answers → 1', () => {
  assert.equal(noAnswerPrecision([{ topHitAnswered: false }]), 1);
});

test('noAnswerPrecision: empty → null', () => {
  assert.equal(noAnswerPrecision([]), null);
});

// --- answerCorrectnessRate (over answerable queries) -----------------------

test('answerCorrectnessRate: fraction whose top hit answered', () => {
  assert.equal(answerCorrectnessRate([{ topHitAnswered: true }, { topHitAnswered: true }, { topHitAnswered: false }]), 2 / 3);
});

test('answerCorrectnessRate: empty → null', () => {
  assert.equal(answerCorrectnessRate([]), null);
});

// --- answerCorrectnessPass (Layer-2 orchestration; injected stubs, no live calls) ---

test('answerCorrectnessPass: applies tau, excludes parse-fails, splits answerable/no-answer', async () => {
  const doSearch = async (q) => ({ results: q.startsWith('ANS') ? [{ id: '1', body: 'the answer' }] : [{ id: '2', body: 'topical neighbour' }] });
  const gradeAnswer = async (_q, body) => body === 'the answer'
    ? { answers: true, confidence: 0.95, ok: true }
    : { answers: true, confidence: 0.4, ok: true }; // neighbour: answers but LOW confidence
  const out = await answerCorrectnessPass({
    gradeAnswer, doSearch, memory: {},
    recallRows: [{ id: 'a', query: 'ANS q1' }],
    noAnswerRows: [{ id: 'n', query: 'NO q1' }],
    model: 'm', tau: 0.8,
  });
  assert.equal(out.answerCorrectness.rate, 1);   // 0.95 >= 0.8 → answered
  assert.equal(out.noAnswer.precision, 1);        // neighbour 0.4 < 0.8 → not answered → correct non-answer
  assert.equal(out.answerGrader.parseFails, 0);
});

test('answerCorrectnessPass: zero doSearch results on unanswerable = correct non-answer', async () => {
  const doSearch = async () => ({ results: [] });
  const gradeAnswer = async () => { throw new Error('should not be called when no results'); };
  const out = await answerCorrectnessPass({
    gradeAnswer, doSearch, memory: {}, recallRows: [], noAnswerRows: [{ id: 'n', query: 'q' }], model: 'm', tau: 0.05,
  });
  assert.equal(out.noAnswer.precision, 1); // no hit → not answered → correct
});

test('answerCorrectnessPass: parse-fails excluded from denominators (→ null rates)', async () => {
  const doSearch = async () => ({ results: [{ id: '1', body: 'x' }] });
  const gradeAnswer = async () => ({ answers: false, confidence: 0, ok: false }); // parse-fail
  const out = await answerCorrectnessPass({
    gradeAnswer, doSearch, memory: {},
    recallRows: [{ id: 'a', query: 'q' }],
    noAnswerRows: [{ id: 'n', query: 'q2' }],
    model: 'm', tau: 0.05,
  });
  assert.equal(out.answerCorrectness.rate, null);
  assert.equal(out.noAnswer.precision, null);
  assert.equal(out.answerGrader.parseFails, 2);
});

// --- fireRate (detector supersession-recall signal) ------------------------

test('fireRate: fraction of rows where the detector fired', () => {
  assert.equal(fireRate([{ fired: true }, { fired: false }, { fired: true }, { fired: false }]), 0.5);
});

test('fireRate: empty → null', () => {
  assert.equal(fireRate([]), null);
});

// --- formatSummaryTable ----------------------------------------------------

test('formatSummaryTable: renders the headline sections, null-tolerant', () => {
  const result = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    recall: {
      ks: KS,
      queryCount: 2,
      aggregate: { 1: 0.5, 3: 1, 5: 1, 10: 1 },
      collisionExcludedAggregate: { 1: 0.5, 3: 1, 5: 1, 10: 1 },
      mrr: 0.75,
    },
    staleness: { total: 5, fired: 4, fireRate: 0.8, staleReturnRate: 0.25 },
    noAnswer: null, // exercise null tolerance
  };
  const s = formatSummaryTable(result);
  assert.equal(typeof s, 'string');
  assert.ok(s.includes('Recall@'), 'has recall section');
  assert.ok(s.includes('MRR'), 'has MRR');
  assert.ok(/[Ss]tale-return/.test(s), 'has stale-return');
  assert.ok(s.includes('openai'), 'has provider');
});

// --- loadFixtureJsonl ------------------------------------------------------

test('loadFixtureJsonl: round-trips a temp jsonl, drops blank lines', async () => {
  const p = join(tmpdir(), `mq-eval-fixture-${process.pid}.jsonl`);
  await writeFile(p, '{"id":"r1","query":"q1"}\n\n{"id":"r2","query":"q2"}\n', 'utf8');
  try {
    const rows = await loadFixtureJsonl(p);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'r1');
    assert.equal(rows[1].query, 'q2');
  } finally {
    await rm(p, { force: true });
  }
});

test('loadFixtureJsonl: malformed line throws WITH the 1-based line number', async () => {
  const p = join(tmpdir(), `mq-eval-bad-${process.pid}.jsonl`);
  await writeFile(p, '{"id":"ok"}\n{not json}\n', 'utf8');
  try {
    await assert.rejects(() => loadFixtureJsonl(p), /line 2/);
  } finally {
    await rm(p, { force: true });
  }
});

// --- parseArgs -------------------------------------------------------------

test('parseArgs: recall + staleness + out-prefix', () => {
  const argv = ['node', 'script', '--recall', 'a.jsonl', '--staleness', 'b.jsonl', '--out-prefix', 'eval/results/2026-06-15-mq'];
  const a = parseArgs(argv);
  assert.equal(a.recall, 'a.jsonl');
  assert.equal(a.staleness, 'b.jsonl');
  assert.equal(a.outPrefix, 'eval/results/2026-06-15-mq');
});

test('parseArgs: explicit --out overrides prefix scheme', () => {
  const a = parseArgs(['node', 'script', '--recall', 'a.jsonl', '--out', 'x.json']);
  assert.equal(a.out, 'x.json');
});

// --- drift gate (evaluateGate + formatGateReport + --gate) ------------------

// Committed-floor config mirror — keep in sync with eval/mq-gate-thresholds.json.
const GATE_CFG = {
  thresholds: [
    { metric: 'recall@1',        path: ['recall', 'aggregate', '1'],       direction: 'min', floor: 0.90 },
    { metric: 'recall@5',        path: ['recall', 'aggregate', '5'],       direction: 'min', floor: 0.96 },
    { metric: 'mrr',             path: ['recall', 'mrr'],                   direction: 'min', floor: 0.95 },
    { metric: 'staleReturnRate', path: ['staleness', 'staleReturnRate'],   direction: 'max', floor: 0.00 },
    { metric: 'fireRate',        path: ['staleness', 'fireRate'],          direction: 'min', floor: 0.80 },
    { metric: 'seedCount',       path: ['recall', 'seedCount'],            direction: 'min', floor: 50 },
    { metric: 'stalenessTotal',  path: ['staleness', 'total'],             direction: 'min', floor: 18 },
  ],
};
// A healthy v1.5.0-baseline-shaped result (clears every floor). Factory so each
// test mutates its OWN copy without cross-test bleed.
const passResult = () => ({
  recall: { aggregate: { '1': 0.98, '5': 1.0 }, mrr: 0.99, seedCount: 50 },
  staleness: { staleReturnRate: 0.0, fireRate: 1.0, total: 18 },
});

test('evaluateGate: passes when every metric clears its floor', () => {
  const g = evaluateGate(passResult(), GATE_CFG);
  assert.equal(g.pass, true);
  assert.equal(g.checked, 7);
  assert.deepEqual(g.breaches, []);
});

test('evaluateGate: min-direction breach (recall regressed)', () => {
  const r = passResult(); r.recall.aggregate['1'] = 0.80;
  const g = evaluateGate(r, GATE_CFG);
  assert.equal(g.pass, false);
  assert.equal(g.breaches.length, 1);
  assert.equal(g.breaches[0].metric, 'recall@1');
  assert.equal(g.breaches[0].reason, 'below_floor');
  assert.equal(g.breaches[0].observed, 0.80);
});

test('evaluateGate: max-direction breach (one stale fact resurfaced — zero tolerance)', () => {
  const r = passResult(); r.staleness.staleReturnRate = 0.0556; // 1 of 18 fired rows leaked
  const g = evaluateGate(r, GATE_CFG);
  assert.equal(g.pass, false);
  assert.equal(g.breaches[0].metric, 'staleReturnRate');
  assert.equal(g.breaches[0].direction, 'max');
});

test('evaluateGate: corpus-intactness breach (partial seeding cannot pass vacuously)', () => {
  const r = passResult(); r.recall.seedCount = 12; // a dedup cascade silently dropped seeds
  const g = evaluateGate(r, GATE_CFG);
  assert.equal(g.pass, false);
  assert.equal(g.breaches[0].metric, 'seedCount');
});

test('evaluateGate: floors are INCLUSIVE (observed == floor passes)', () => {
  const r = {
    recall: { aggregate: { '1': 0.90, '5': 0.96 }, mrr: 0.95, seedCount: 50 },
    staleness: { staleReturnRate: 0.0, fireRate: 0.80, total: 18 },
  };
  assert.equal(evaluateGate(r, GATE_CFG).pass, true);
});

test('evaluateGate: a gated metric that is null is a BREACH (unmeasured, not a silent pass)', () => {
  const r = passResult(); r.staleness.staleReturnRate = null; r.staleness.fireRate = null;
  const g = evaluateGate(r, GATE_CFG);
  assert.equal(g.pass, false);
  const reasons = g.breaches.map((b) => `${b.metric}:${b.reason}`);
  assert.ok(reasons.includes('staleReturnRate:unmeasured'));
  assert.ok(reasons.includes('fireRate:unmeasured'));
});

test('evaluateGate: a missing path segment is unmeasured (not a crash)', () => {
  const g = evaluateGate({ recall: {} }, GATE_CFG);
  assert.equal(g.pass, false);
  assert.ok(g.breaches.every((b) => b.reason === 'unmeasured' || b.reason === 'below_floor'));
});

test('evaluateGate: empty thresholds → vacuous pass, checked 0', () => {
  const g = evaluateGate(passResult(), { thresholds: [] });
  assert.deepEqual(g, { pass: true, checked: 0, breaches: [] });
});

test('formatGateReport: PASS header has no BREACH lines', () => {
  const out = formatGateReport(evaluateGate(passResult(), GATE_CFG));
  assert.match(out, /mq drift gate: PASS/);
  assert.doesNotMatch(out, /BREACH/);
});

test('formatGateReport: FAIL lists each breach with the comparator', () => {
  const r = passResult(); r.recall.aggregate['1'] = 0.50;
  const out = formatGateReport(evaluateGate(r, GATE_CFG));
  assert.match(out, /mq drift gate: FAIL/);
  assert.match(out, /BREACH recall@1: observed 0.5 fails >= 0.9/);
});

test('parseArgs: --gate captures the thresholds path', () => {
  const a = parseArgs(['node', 'x.mjs', '--recall', 'r.jsonl', '--gate', 'eval/mq-gate-thresholds.json']);
  assert.equal(a.gate, 'eval/mq-gate-thresholds.json');
  assert.equal(a.recall, 'r.jsonl');
});
