// server/test/lane-eval.test.mjs — Gap-5 P2 lane eval-harness unit tests.
//
// TDD: written FIRST (before eval/lane-eval.mjs exists).
//
// Imports ONLY the PURE exported functions. The CLI path lazy-imports its live
// deps (embed / buildLanePrototypes / classifyByPrototypes) inside runOnce, so a plain
// import here stays offline — mirrors test/d3-eval.test.mjs.
//
// Lane classification is MULTI-CLASS with an abstain (null) option. The routing
// confusion the metric pins:
//   TP = predicted a lane AND it matches expected        (correct route)
//   FP = predicted a lane that is WRONG                   (misroute, or routed a
//                                                          should-stay-null fact)
//   FN = predicted null but expected a lane              (missed route — benign)
//   TN = predicted null and expected null               (correct abstention)
// precision = TP/(TP+FP) — of all routes, fraction correct (the precision-killer
// metric: a wrong route wakes D3 on a mismatched partition). recall = TP/(TP+FN).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  computeMetrics,
  sweepGrid,
  pickThreshold,
  buildConfusion,
  analyzeScores,
  formatSummaryTable,
  loadFixtureJsonl,
  defaultTaus,
  defaultMargins,
} from '../eval/lane-eval.mjs';

function approx(actual, expected, eps = 1e-9, msg = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} expected ≈${expected}, got ${actual}`);
}

// ── computeMetrics ───────────────────────────────────────────────────────────
// Hand-built predictions:
//   r1 work/work       → TP
//   r2 work/work       → TP
//   r3 personal/work   → FP  (misroute to the wrong lane)
//   r4 work/null       → FP  (routed a should-stay-null fact)
//   r5 null/research   → FN  (missed route)
//   r6 null/null       → TN  (correct abstain)
// → tp=2 fp=2 fn=1 tn=1 ; P=2/4=0.5 R=2/3

const PREDS = [
  { predicted: 'work', expected: 'work' },
  { predicted: 'work', expected: 'work' },
  { predicted: 'personal', expected: 'work' },
  { predicted: 'work', expected: null },
  { predicted: null, expected: 'research' },
  { predicted: null, expected: null },
];

test('computeMetrics: tp/fp/fn/tn + P/R at a (τ, margin) cell', () => {
  const m = computeMetrics(PREDS, { tau: 0.5, margin: 0 });
  assert.equal(m.tau, 0.5);
  assert.equal(m.margin, 0);
  assert.equal(m.tp, 2, 'tp');
  assert.equal(m.fp, 2, 'fp = misroute + routed-null');
  assert.equal(m.fn, 1, 'fn');
  assert.equal(m.tn, 1, 'tn');
  assert.equal(m.routed, 4, 'routed = tp+fp');
  assert.equal(m.shouldRoute, 3, 'shouldRoute = tp+fn');
  approx(m.precision, 0.5, 1e-9, 'precision');
  approx(m.recall, 2 / 3, 1e-9, 'recall');
  assert.ok(m.f1 > 0 && m.fHalf > 0, 'F-scores positive');
  // F0.5 weights precision more than recall; here P<R so F0.5 < F1.
  assert.ok(m.fHalf < m.f1, 'F0.5 < F1 when precision < recall');
});

test('computeMetrics: precision null when nothing is routed (all abstain)', () => {
  const allAbstain = [
    { predicted: null, expected: 'work' },
    { predicted: null, expected: null },
  ];
  const m = computeMetrics(allAbstain, { tau: 0.9, margin: 0 });
  assert.equal(m.tp, 0);
  assert.equal(m.fp, 0);
  assert.equal(m.routed, 0);
  assert.equal(m.precision, null, 'precision null when tp+fp == 0');
  approx(m.recall, 0, 1e-9, 'recall 0 (one missed route, tp+fn=1)');
});

test('computeMetrics: recall null when nothing should be routed (all expected null)', () => {
  const allNull = [
    { predicted: null, expected: null },
    { predicted: 'work', expected: null },
  ];
  const m = computeMetrics(allNull, { tau: 0.5, margin: 0 });
  assert.equal(m.shouldRoute, 0);
  assert.equal(m.recall, null, 'recall null when tp+fn == 0');
  approx(m.precision, 0, 1e-9, 'precision 0 (one routed-null FP)');
});

// ── sweepGrid (DI: classify injected, no real classifier imported) ───────────

test('sweepGrid: one metric row per (τ, margin) cell via the injected classify', () => {
  // Stub: each row carries a fixed top score; classify routes to row.lane iff
  // score ≥ threshold (margin ignored by the stub). Mirrors how the CLI injects
  // a closure over the real classifyByPrototypes.
  const rows = [
    { expected_lane: 'work', _score: 0.55, _lane: 'work' },
    { expected_lane: null, _score: 0.55, _lane: 'work' }, // a null-expected fact that scores high → FP risk
  ];
  const classify = (row, { threshold }) => (row._score >= threshold ? row._lane : null);
  const grid = sweepGrid({ rows, taus: [0.40, 0.60], margins: [0], classify });
  assert.equal(grid.length, 2, 'one row per cell (2 τ × 1 margin)');

  const lo = grid.find((g) => g.tau === 0.40);
  // τ=0.40 ≤ 0.55 → both route to 'work': TP (work/work) + FP (work/null).
  assert.equal(lo.tp, 1);
  assert.equal(lo.fp, 1);
  approx(lo.precision, 0.5, 1e-9, 'τ=0.40 precision');
  approx(lo.recall, 1, 1e-9, 'τ=0.40 recall');

  const hi = grid.find((g) => g.tau === 0.60);
  // τ=0.60 > 0.55 → both abstain: FN (null/work) + TN (null/null).
  assert.equal(hi.tp, 0);
  assert.equal(hi.fp, 0);
  assert.equal(hi.precision, null, 'τ=0.60 precision null (nothing routed)');
});

test('sweepGrid: covers the full τ × margin product', () => {
  const rows = [{ expected_lane: 'work', _score: 1, _lane: 'work' }];
  const classify = (row) => row._lane;
  const grid = sweepGrid({ rows, taus: [0.3, 0.4], margins: [0, 0.05, 0.1], classify });
  assert.equal(grid.length, 6, '2 τ × 3 margins');
  // every (τ,margin) pair present exactly once
  const keys = new Set(grid.map((g) => `${g.tau}|${g.margin}`));
  assert.equal(keys.size, 6);
});

// ── pickThreshold (2D grid, precision floor, maximize recall) ────────────────

test('pickThreshold: max-recall cell among those meeting the precision floor', () => {
  const grid = [
    { tau: 0.40, margin: 0, precision: 0.80, recall: 0.95, f1: 0, fHalf: 0, tp: 1, fp: 1, fn: 0, tn: 0 },
    { tau: 0.50, margin: 0, precision: 0.96, recall: 0.70, f1: 0, fHalf: 0, tp: 1, fp: 0, fn: 0, tn: 1 },
    { tau: 0.60, margin: 0, precision: 1.00, recall: 0.50, f1: 0, fHalf: 0, tp: 1, fp: 0, fn: 1, tn: 1 },
    { tau: 0.50, margin: 0.05, precision: 0.97, recall: 0.60, f1: 0, fHalf: 0, tp: 1, fp: 0, fn: 0, tn: 1 },
  ];
  const chosen = pickThreshold(grid, { precisionFloor: 0.95 });
  assert.equal(chosen.meetsFloor, true);
  // Feasible (P≥0.95): τ0.50/m0 (R0.70), τ0.60/m0 (R0.50), τ0.50/m0.05 (R0.60).
  // Max recall = 0.70 → τ=0.50, margin=0.
  approx(chosen.tau, 0.50, 1e-9, 'chosen τ');
  approx(chosen.margin, 0, 1e-9, 'chosen margin');
  approx(chosen.precision, 0.96, 1e-9, 'chosen precision');
  approx(chosen.recall, 0.70, 1e-9, 'chosen recall (maximized subject to floor)');
});

test('pickThreshold: never meets floor → meetsFloor:false with diagnostics', () => {
  const grid = [
    { tau: 0.40, margin: 0, precision: 0.70, recall: 0.9, f1: 0, fHalf: 0, tp: 7, fp: 3, fn: 1, tn: 1 },
    { tau: 0.60, margin: 0, precision: 0.88, recall: 0.5, f1: 0, fHalf: 0, tp: 4, fp: 1, fn: 4, tn: 1 },
  ];
  const chosen = pickThreshold(grid, { precisionFloor: 0.95 });
  assert.equal(chosen.meetsFloor, false);
  assert.equal(chosen.precisionFloor, 0.95);
  approx(chosen.bestPrecision, 0.88, 1e-9, 'bestPrecision diagnostic');
  approx(chosen.bestPrecisionTau, 0.60, 1e-9, 'τ of best precision');
  approx(chosen.bestPrecisionMargin, 0, 1e-9, 'margin of best precision');
});

test('pickThreshold: tie-break prefers higher precision, then lower margin, then lower τ', () => {
  // Two feasible cells with EQUAL max recall 0.80 → pick higher precision (0.99).
  const grid = [
    { tau: 0.50, margin: 0, precision: 0.96, recall: 0.80, f1: 0, fHalf: 0, tp: 1, fp: 0, fn: 0, tn: 0 },
    { tau: 0.55, margin: 0, precision: 0.99, recall: 0.80, f1: 0, fHalf: 0, tp: 1, fp: 0, fn: 0, tn: 0 },
  ];
  const chosen = pickThreshold(grid, { precisionFloor: 0.95 });
  approx(chosen.precision, 0.99, 1e-9, 'higher precision wins the recall tie');
  approx(chosen.tau, 0.55, 1e-9);
});

// ── buildConfusion ───────────────────────────────────────────────────────────

test('buildConfusion: expected × predicted matrix incl. the null (abstain) axis', () => {
  const preds = [
    { predicted: 'work', expected: 'work' },
    { predicted: 'personal', expected: 'work' }, // work bleeds into personal
    { predicted: 'work', expected: null }, // a null fact routed to work
    { predicted: null, expected: 'research' }, // research abstained
  ];
  const { matrix } = buildConfusion(preds, ['work', 'personal', 'research', 'writing']);
  assert.equal(matrix.work.work, 1, 'work→work');
  assert.equal(matrix.work.personal, 1, 'work→personal (bleed)');
  assert.equal(matrix.null.work, 1, 'null→work (false route)');
  assert.equal(matrix.research.null, 1, 'research→null (abstain)');
  // untouched cells are 0
  assert.equal(matrix.writing.writing, 0);
});

// ── analyzeScores ────────────────────────────────────────────────────────────

test('analyzeScores: top-score distribution split by route correctness', () => {
  // scored rows carry the winning cosine (top1) + the expected/predicted at a cell.
  const scoredRows = [
    { top1: 0.80, outcome: 'correct' },
    { top1: 0.70, outcome: 'correct' },
    { top1: 0.55, outcome: 'misroute' },
    { top1: 0.40, outcome: 'abstain_ok' },
  ];
  const r = analyzeScores(scoredRows);
  assert.equal(r.correct.count, 2);
  approx(r.correct.min, 0.70, 1e-9);
  approx(r.correct.max, 0.80, 1e-9);
  assert.equal(r.misroute.count, 1);
  approx(r.misroute.max, 0.55, 1e-9);
});

// ── formatSummaryTable ───────────────────────────────────────────────────────

test('formatSummaryTable: non-empty string with expected section tokens', () => {
  const result = {
    fixtureCounts: { byCategory: { work: 12, noise: 8 }, byExpectedLane: { work: 12, null: 8 }, total: 20 },
    precisionFloor: 0.95,
    grid: [
      { tau: 0.40, margin: 0, tp: 10, fp: 2, fn: 0, tn: 8, precision: 0.83, recall: 1.0, f1: 0.9, fHalf: 0.86 },
      { tau: 0.50, margin: 0, tp: 9, fp: 0, fn: 1, tn: 8, precision: 1.0, recall: 0.9, f1: 0.95, fHalf: 0.98 },
    ],
    chosen: { meetsFloor: true, tau: 0.50, margin: 0, precision: 1.0, recall: 0.9, f1: 0.95, fHalf: 0.98 },
    confusion: { lanes: ['work'], matrix: { work: { work: 9, null: 1 }, null: { work: 0, null: 8 } } },
    scores: { correct: { count: 9, min: 0.6, p25: 0.62, median: 0.7, p75: 0.78, max: 0.9, mean: 0.71 },
              misroute: { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null } },
  };
  const out = formatSummaryTable(result);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0, 'non-empty');
  for (const token of ['τ', 'precision', 'recall', 'F0.5', 'Confusion', 'Chosen']) {
    assert.ok(out.includes(token), `summary must mention "${token}"`);
  }
});

// ── loadFixtureJsonl ─────────────────────────────────────────────────────────

test('loadFixtureJsonl: round-trips a 2-line .jsonl incl. an expected_lane:null row', async () => {
  const p = join(tmpdir(), `lane-eval-test-${process.pid}-${Date.now()}.jsonl`);
  const row1 = { text: 'sprint planning notes', expected_lane: 'work', category: 'work' };
  const row2 = { text: 'it might rain', expected_lane: null, category: 'noise' };
  await writeFile(p, JSON.stringify(row1) + '\n' + JSON.stringify(row2) + '\n\n', 'utf8');
  try {
    const rows = await loadFixtureJsonl(p);
    assert.equal(rows.length, 2, 'two parsed objects, blank line filtered');
    assert.equal(rows[0].expected_lane, 'work');
    assert.equal(rows[1].expected_lane, null, 'null lane preserved');
  } finally {
    await rm(p, { force: true });
  }
});

// ── default sweep ranges ─────────────────────────────────────────────────────

test('defaultTaus: 0.30..0.80 step 0.02, 2-decimal, strictly increasing', () => {
  const t = defaultTaus();
  approx(t[0], 0.30, 1e-9, 'starts at 0.30');
  approx(t[t.length - 1], 0.80, 1e-9, 'ends at 0.80');
  for (let i = 0; i < t.length; i++) {
    approx(t[i], Math.round(t[i] * 100) / 100, 1e-9, `value ${i} 2-decimal`);
    if (i > 0) assert.ok(t[i] > t[i - 1], 'strictly increasing');
  }
});

test('defaultMargins: includes 0 (no-margin baseline) and is non-decreasing', () => {
  const m = defaultMargins();
  approx(m[0], 0, 1e-9, 'first margin is 0');
  for (let i = 1; i < m.length; i++) assert.ok(m[i] > m[i - 1], 'strictly increasing');
});
