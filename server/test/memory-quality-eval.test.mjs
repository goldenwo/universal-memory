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
//   - ndcgAtK: binary-relevance nDCG@k; rank-sensitive; absent/empty/no-target → 0; multi-target IDCG
//   - staleReturnRate: rate of surfacedOriginal over FIRED rows; empty→null; all-false→0
//   - noAnswerPrecision: rate of correct-empty over distractors; empty→null; all-correct→1
//   - fireRate: rate of detector-fired rows; empty→null
//   - formatSummaryTable: non-empty string with expected section tokens; null-tolerant
//   - loadFixtureJsonl: round-trip temp jsonl; malformed line throws WITH line number
//   - parseArgs: --recall / --staleness / --out-prefix / --out

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recallAtK,
  aggregateRecall,
  reciprocalRank,
  mrr,
  ndcgAtK,
  recallByParaphraseLevel,
  crossSessionRecall,
  extractionFidelity,
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
  sweepBounceGate,
  collectBounceRows,
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

// --- ndcgAtK ---------------------------------------------------------------
// Binary-relevance nDCG@k = DCG@k / IDCG@k, gain ∈ {0,1}, discount 1/log2(rank+1)
// (1-based rank). Rank-sensitive (unlike recallAtK's 0/1) and multi-target-ready.

test('ndcgAtK: target at rank 1 → 1 at every k (ideal)', () => {
  assert.deepEqual(ndcgAtK(['t', 'a', 'b', 'c'], ['t'], KS), { 1: 1, 3: 1, 5: 1, 10: 1 });
});

test('ndcgAtK: target at rank 3 → miss@1, 1/log2(4)=0.5 at @3+', () => {
  const r = ndcgAtK(['a', 'b', 't', 'c'], ['t'], KS);
  assert.equal(r[1], 0);
  assert.equal(r[3], 0.5);
  assert.equal(r[5], 0.5);
  assert.equal(r[10], 0.5);
});

test('ndcgAtK: rank-sensitive — rank 2 = 1/log2(3), distinct from recall(1)/RR(0.5)', () => {
  const r = ndcgAtK(['a', 't', 'b'], ['t'], KS);
  assert.equal(r[1], 0);
  assert.ok(Math.abs(r[3] - 1 / Math.log2(3)) < 1e-12); // ≈0.6309
});

test('ndcgAtK: target at rank 7 → only @10 nonzero = 1/log2(8)', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 't', 'g'];
  const r = ndcgAtK(ranked, ['t'], KS);
  assert.equal(r[1], 0);
  assert.equal(r[3], 0);
  assert.equal(r[5], 0);
  assert.ok(Math.abs(r[10] - 1 / Math.log2(8)) < 1e-12); // 1/3
});

test('ndcgAtK: target absent → 0 at every k', () => {
  assert.deepEqual(ndcgAtK(['a', 'b', 'c'], ['t'], KS), { 1: 0, 3: 0, 5: 0, 10: 0 });
});

test('ndcgAtK: empty results → 0 at every k', () => {
  assert.deepEqual(ndcgAtK([], ['t'], KS), { 1: 0, 3: 0, 5: 0, 10: 0 });
});

test('ndcgAtK: empty target set → 0 at every k (IDCG=0, defensive)', () => {
  assert.deepEqual(ndcgAtK(['a', 'b'], [], KS), { 1: 0, 3: 0, 5: 0, 10: 0 });
});

test('ndcgAtK: multiple targets at ranks 1+2 → 1 at k≥1 (IDCG matches DCG)', () => {
  const r = ndcgAtK(['x', 'y', 'b'], ['x', 'y'], KS);
  assert.equal(r[1], 1);  // top-1 fills the one available ideal slot
  assert.equal(r[3], 1);
  assert.equal(r[10], 1);
});

test('ndcgAtK: duplicate target id in ranked list credited once → nDCG ≤ 1', () => {
  // A malformed ranked list repeating the single target must not push DCG past IDCG.
  const r = ndcgAtK(['t', 't', 'a'], ['t'], KS);
  assert.equal(r[1], 1);
  assert.equal(r[3], 1);  // NOT 1 + 1/log2(3) — the second 't' is not double-counted
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

test('answerCorrectnessPass routes through bounceTopHit (gate applied, empty=correct non-answer)', async () => {
  const corpus = { // doSearch stub: returns a top hit per query, score keyed by query
    search: async (q) => ({ results: q === 'empty' ? [] : [{ body: `body:${q}`, score: q === 'high' ? 0.9 : 0.4 }] }),
  };
  const doSearch = async (q, _l, _s, _f, ctx) => ctx.memory.search(q);
  const gradeAnswer = async (_q, body) => ({ ok: true, answers: body.includes('yes'), confidence: 0.9 });
  const res = await answerCorrectnessPass({
    gradeAnswer, doSearch, memory: corpus,
    recallRows: [{ id: 'r1', query: 'yes' }, { id: 'r2', query: 'high' }],     // answerable
    noAnswerRows: [{ id: 'n1', query: 'no' }, { id: 'n2', query: 'empty' }],    // unanswerable
    model: 'stub', tau: 0.05, high: 0.55,
  });
  // r1 in-band, grader 'yes' → answered; r2 high-score → skipped (trusted answered): correctness 2/2
  assert.equal(res.answerCorrectness.rate, 1);
  // n1 in-band, grader 'no' → flagged (not answered = correct abstain); n2 empty → correct non-answer
  assert.equal(res.noAnswer.precision, 1);
  assert.equal(res.noAnswer.leaks, 0);
  // skipRate: 1 of 4 graded queries skipped (r2)
  assert.ok(res.bouncer.skipRate > 0 && res.bouncer.skipRate < 1);
});

test('sweepBounceGate: lower gate raises skipRate; pins the lowest gate holding both floors', async () => {
  // pre-collected rows: {answerable, score, answers, confidence}; non-answers score 0.4, a real
  // answer also at 0.4, plus a non-answer that scores high (0.7) → leaks if the gate is below 0.7.
  const rows = [
    { answerable: true,  score: 0.9, answers: true,  confidence: 0.9 },
    { answerable: true,  score: 0.4, answers: true,  confidence: 0.9 },
    { answerable: false, score: 0.4, answers: false, confidence: 0.9 }, // in-band non-answer → graded → correct abstain
    { answerable: false, score: 0.7, answers: false, confidence: 0.9 }, // high-scoring non-answer → leaks if gate<0.7
  ];
  const grid = [0.3, 0.5, 0.8];
  const { sweep, chosen } = await sweepBounceGate({ rows, grid, tau: 0.05, floors: { answerCorrectness: 0.5, noAnswerPrecision: 0.95 } });
  assert.equal(sweep.length, 3);
  // gate 0.8 keeps both non-answers graded (precision 1.0); 0.5 lets the 0.7 non-answer leak → precision <1.
  assert.equal(chosen.high, 0.8);
  assert.ok(chosen.skipRate >= 0);
});

test('§4b: the eval routes the verdict through bounceTopHit (no inline copy)', () => {
  const src = readFileSync(new URL('../eval/memory-quality-eval.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('bounceTopHit'), 'eval must import/call bounceTopHit');
  // No property-access verdict re-implementation (e.g. `v.confidence >=` / `r.confidence >=`).
  // The live helper owns the verdict; the sweep delegates to it. (Prose like "confidence>=tau"
  // has no leading dot and is intentionally not matched.)
  assert.doesNotMatch(src, /\.confidence\s*>=/, 'eval must not re-implement the grader verdict — route through bounceTopHit');
});

test('collectBounceRows collects raw per-query grades (score + answers + confidence + ok; empty→null)', async () => {
  const memory = { search: async (q) => ({ results: q === 'empty' ? [] : [{ body: `b:${q}`, score: 0.5 }] }) };
  const doSearch = async (q, _l, _s, _f, ctx) => ctx.memory.search(q);
  const gradeAnswer = async (_q, body) => ({ answers: body.includes('yes'), confidence: 0.9, ok: true });
  const rows = await collectBounceRows({ gradeAnswer, doSearch, memory, recallRows: [{ id: 'r1', query: 'yes' }], noAnswerRows: [{ id: 'n1', query: 'no' }, { id: 'n2', query: 'empty' }], model: 'stub' });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { id: 'r1', answerable: true, score: 0.5, answers: true, confidence: 0.9, ok: true });
  assert.equal(rows[1].answerable, false);
  assert.equal(rows[2].score, null);            // empty result → null score
});

// --- recallByParaphraseLevel ----------------------------------------------

test('recallByParaphraseLevel: groups by level and aggregates recall@k per level', () => {
  const details = [
    { paraphrase_level: 'lexical',    recallByK: { 1: 1, 3: 1, 5: 1, 10: 1 } },
    { paraphrase_level: 'lexical',    recallByK: { 1: 1, 3: 1, 5: 1, 10: 1 } },
    { paraphrase_level: 'paraphrase', recallByK: { 1: 0, 3: 1, 5: 1, 10: 1 } },
    { paraphrase_level: 'paraphrase', recallByK: { 1: 1, 3: 1, 5: 1, 10: 1 } },
    { paraphrase_level: 'oblique',    recallByK: { 1: 0, 3: 0, 5: 1, 10: 1 } },
  ];
  const r = recallByParaphraseLevel(details, KS);
  assert.deepEqual(r.counts, { lexical: 2, paraphrase: 2, oblique: 1 });
  assert.deepEqual(r.byLevel.lexical, { 1: 1, 3: 1, 5: 1, 10: 1 });
  assert.deepEqual(r.byLevel.paraphrase, { 1: 0.5, 3: 1, 5: 1, 10: 1 });
  assert.deepEqual(r.byLevel.oblique, { 1: 0, 3: 0, 5: 1, 10: 1 });
});

test('recallByParaphraseLevel: gap is lexical minus level (positive = worse than lexical)', () => {
  const details = [
    { paraphrase_level: 'lexical',    recallByK: { 1: 1, 5: 1 } },
    { paraphrase_level: 'paraphrase', recallByK: { 1: 0, 5: 1 } },
  ];
  const r = recallByParaphraseLevel(details, [1, 5]);
  assert.deepEqual(r.gaps.paraphraseVsLexical, { 1: 1, 5: 0 });
});

test('recallByParaphraseLevel: absent lexical anchor → gaps null', () => {
  const details = [{ paraphrase_level: 'paraphrase', recallByK: { 1: 1, 5: 1 } }];
  const r = recallByParaphraseLevel(details, [1, 5]);
  assert.deepEqual(r.gaps.paraphraseVsLexical, { 1: null, 5: null });
  assert.equal(r.byLevel.lexical, undefined);
});

test('recallByParaphraseLevel: empty details → empty byLevel, null gaps', () => {
  const r = recallByParaphraseLevel([], [1, 5]);
  assert.deepEqual(r.byLevel, {});
  assert.deepEqual(r.counts, {});
  assert.deepEqual(r.gaps.paraphraseVsLexical, { 1: null, 5: null });
  assert.deepEqual(r.gaps.obliqueVsLexical, { 1: null, 5: null });
});

// --- formatSummaryTable: paraphrase-level block ---------------------------

test('formatSummaryTable: renders paraphrase-level block when present', () => {
  const result = {
    provider: 'openai', model: 'm',
    recall: {
      ks: [1, 3, 5, 10], queryCount: 5, aggregate: { 1: 0.8, 3: 0.9, 5: 1, 10: 1 }, mrr: 0.85,
      byParaphraseLevel: {
        byLevel: { lexical: { 1: 1, 5: 1 }, paraphrase: { 1: 0.5, 5: 0.9 }, oblique: { 1: 0.2, 5: 0.7 } },
        counts: { lexical: 2, paraphrase: 2, oblique: 1 },
        gaps: { paraphraseVsLexical: { 5: 0.1 }, obliqueVsLexical: { 5: 0.3 } },
      },
    },
  };
  const s = formatSummaryTable(result);
  assert.match(s, /By paraphrase level/);
  assert.match(s, /lexical/);
  assert.match(s, /gap@5 vs lexical/);
});

test('formatSummaryTable: omits paraphrase-level block when absent (null-tolerant)', () => {
  const result = { provider: 'openai', model: 'm', recall: { ks: [1], queryCount: 1, aggregate: { 1: 1 }, mrr: 1 } };
  const s = formatSummaryTable(result);
  assert.doesNotMatch(s, /By paraphrase level/);
});

// --- crossSessionRecall ----------------------------------------------------

test('crossSessionRecall: answer span in the rank-1 body → hit at every k, RR=1', () => {
  const per = [{ id: 'a', answerNorm: '36 hours', bodies: ['... 36 hours ...', 'other'] }];
  const r = crossSessionRecall(per, KS);
  assert.deepEqual(r.aggregate, { 1: 1, 3: 1, 5: 1, 10: 1 });
  assert.equal(r.mrr, 1);
  assert.deepEqual(r.misses, []);
});

test('crossSessionRecall: answer span in the rank-3 body → miss@1, hit@3+, RR=1/3', () => {
  const per = [{ id: 'a', answerNorm: 'ed25519', bodies: ['no', 'nope', 'we chose ed25519 keys'] }];
  const r = crossSessionRecall(per, KS);
  assert.deepEqual(r.aggregate, { 1: 0, 3: 1, 5: 1, 10: 1 });
  assert.equal(r.mrr, 0.333);
  assert.deepEqual(r.misses, []);
});

test('crossSessionRecall: answer span absent → miss, RR=0, id recorded', () => {
  const per = [{ id: 'a', answerNorm: 'never appears', bodies: ['x', 'y'] }];
  const r = crossSessionRecall(per, KS);
  assert.deepEqual(r.aggregate, { 1: 0, 3: 0, 5: 0, 10: 0 });
  assert.equal(r.mrr, 0);
  assert.deepEqual(r.misses, ['a']);
});

test('crossSessionRecall: mean over a hit and a miss', () => {
  const per = [
    { id: 'a', answerNorm: 'foo', bodies: ['foo here'] },
    { id: 'b', answerNorm: 'bar', bodies: ['no match'] },
  ];
  const r = crossSessionRecall(per, [1, 5]);
  assert.deepEqual(r.aggregate, { 1: 0.5, 5: 0.5 });
  assert.equal(r.mrr, 0.5);
  assert.deepEqual(r.misses, ['b']);
});

test('crossSessionRecall: empty input → null aggregate + null mrr', () => {
  const r = crossSessionRecall([], [1, 5]);
  assert.deepEqual(r.aggregate, { 1: null, 5: null });
  assert.equal(r.mrr, null);
  assert.deepEqual(r.misses, []);
});

// --- extractionFidelity ----------------------------------------------------

test('extractionFidelity: micro-averaged precision/recall over graded rows', () => {
  const judged = [
    { id: 'a', ok: true, goldTotal: 2, goldMatched: 2, extractedTotal: 2, extractedSupported: 2 },
    { id: 'b', ok: true, goldTotal: 2, goldMatched: 1, extractedTotal: 3, extractedSupported: 2 },
  ];
  const r = extractionFidelity(judged);
  assert.equal(r.recall, 0.75);
  assert.equal(r.precision, 0.8);
  assert.equal(r.graded, 2);
  assert.equal(r.parseFails, 0);
});

test('extractionFidelity: parse-fail rows excluded from denominators', () => {
  const judged = [
    { id: 'a', ok: true, goldTotal: 1, goldMatched: 1, extractedTotal: 1, extractedSupported: 1 },
    { id: 'b', ok: false },
  ];
  const r = extractionFidelity(judged);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.graded, 1);
  assert.equal(r.parseFails, 1);
});

test('extractionFidelity: noise rows (gold empty) tracked as abstentions, neutral in micro-averages', () => {
  const judged = [
    { id: 'a', ok: true, goldTotal: 1, goldMatched: 1, extractedTotal: 1, extractedSupported: 1 },
    { id: 'noise-ok', ok: true, goldTotal: 0, goldMatched: 0, extractedTotal: 0, extractedSupported: 0 },
    { id: 'noise-bad', ok: true, goldTotal: 0, goldMatched: 0, extractedTotal: 2, extractedSupported: 0 },
  ];
  const r = extractionFidelity(judged);
  assert.equal(r.noiseTotal, 2);
  assert.equal(r.noiseAbstained, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 0.333);
});

test('extractionFidelity: empty input → null precision/recall', () => {
  const r = extractionFidelity([]);
  assert.equal(r.precision, null);
  assert.equal(r.recall, null);
  assert.equal(r.f1, null);
  assert.equal(r.graded, 0);
});
