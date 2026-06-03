// server/test/d3-eval.test.mjs — D3.3 Task 3.1 contradiction eval-harness unit tests
//
// TDD: written FIRST (before eval/d3-eval.mjs exists), per task description.
//
// Imports ONLY the PURE exported functions. Importing the module must NOT
// trigger any live LLM/embed call — the CLI path lazy-imports its live deps
// (judgeContradiction / embed / cosine) inside runOnce, so a plain
// `import { ... } from '../eval/d3-eval.mjs'` here stays offline.
//
// Coverage (per task spec):
//   - isComparable: lane / persona eligibility gate (R1-B1 mirror)
//   - computeMetrics: tp/fp/fn/tn + precision/recall/f1 at chosen τ;
//       high-confidence FP lowers precision at low τ, excluded at high τ;
//       non-comparable rows ignored
//   - sweepThresholds: one row per threshold
//   - pickThreshold: lowest qualifying τ at floor; meetsFloor:false diagnostics
//   - analyzeRetrieval: percentile stats per label group; null-cosine skipped;
//       empty group → null stats
//   - formatSummaryTable: non-empty string with expected section tokens
//   - loadFixtureJsonl: round-trip a temp 2-line .jsonl

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isComparable,
  computeMetrics,
  sweepThresholds,
  pickThreshold,
  analyzeRetrieval,
  formatSummaryTable,
  loadFixtureJsonl,
  defaultThresholds,
} from '../eval/d3-eval.mjs';

// Helper: float compare to a small epsilon.
function approx(actual, expected, eps = 1e-9, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} expected ≈${expected}, got ${actual}`,
  );
}

// ── isComparable ─────────────────────────────────────────────────────────────

test('isComparable: same lane → true', () => {
  assert.equal(
    isComparable({ olderLane: 'work', newerLane: 'work', olderPersona: null, newerPersona: null }),
    true,
  );
});

test('isComparable: different lane → false', () => {
  assert.equal(
    isComparable({ olderLane: 'work', newerLane: 'home', olderPersona: null, newerPersona: null }),
    false,
  );
});

test('isComparable: same persona (lanes null) → true', () => {
  assert.equal(
    isComparable({ olderLane: null, newerLane: null, olderPersona: 'gamer', newerPersona: 'gamer' }),
    true,
  );
});

test('isComparable: both lane+persona absent → false', () => {
  assert.equal(
    isComparable({ olderLane: null, newerLane: null, olderPersona: null, newerPersona: null }),
    false,
  );
});

test('isComparable: cross-persona → false', () => {
  assert.equal(
    isComparable({ olderLane: null, newerLane: null, olderPersona: 'professional', newerPersona: 'personal' }),
    false,
  );
});

// ── computeMetrics ───────────────────────────────────────────────────────────
//
// Hand-built judged set (5 comparable + 1 non-comparable). At τ=0.80:
//   r1 contradiction/true/0.95 → TP
//   r2 contradiction/true/0.90 → TP
//   r3 not        /true/0.85 → FP  (high-confidence false positive)
//   r4 contradiction/false/0.0 → FN
//   r5 not        /false/0.0 → TN
//   r6 NON-COMPARABLE not/true/0.99 → ignored entirely
// → tp=2 fp=1 fn=1 tn=1 ; P=2/3 R=2/3 F1=2/3
// At τ=0.88 the conf-0.85 FP drops out → fp=0, P=1.0, R=2/3.

const JUDGED = [
  { label: 'contradiction', contradicts: true,  confidence: 0.95, comparable: true },
  { label: 'contradiction', contradicts: true,  confidence: 0.90, comparable: true },
  { label: 'not',           contradicts: true,  confidence: 0.85, comparable: true },
  { label: 'contradiction', contradicts: false, confidence: 0.00, comparable: true },
  { label: 'not',           contradicts: false, confidence: 0.00, comparable: true },
  { label: 'not',           contradicts: true,  confidence: 0.99, comparable: false }, // must be ignored
];

test('computeMetrics: tp/fp/fn/tn + P/R/F1 at τ=0.80', () => {
  const m = computeMetrics(JUDGED, 0.80);
  assert.equal(m.tau, 0.80);
  assert.equal(m.tp, 2, 'tp');
  assert.equal(m.fp, 1, 'fp');
  assert.equal(m.fn, 1, 'fn');
  assert.equal(m.tn, 1, 'tn');
  assert.equal(m.comparableCount, 5, 'comparableCount excludes the non-comparable row');
  assert.equal(m.predictedPositives, 3, 'predictedPositives = tp+fp');
  assert.equal(m.actualPositives, 3, 'actualPositives = tp+fn');
  approx(m.precision, 2 / 3, 1e-9, 'precision');
  approx(m.recall, 2 / 3, 1e-9, 'recall');
  approx(m.f1, 2 / 3, 1e-9, 'f1');
  // F0.5 with P=R → equals P (== R).
  approx(m.fHalf, 2 / 3, 1e-9, 'fHalf');
});

test('computeMetrics: high-confidence FP excluded at higher τ raises precision to 1.0', () => {
  const m = computeMetrics(JUDGED, 0.88);
  assert.equal(m.tp, 2, 'tp unchanged (0.95, 0.90 still ≥ 0.88)');
  assert.equal(m.fp, 0, 'the conf-0.85 FP is excluded at τ=0.88');
  assert.equal(m.fn, 1, 'fn');
  approx(m.precision, 1.0, 1e-9, 'precision is perfect once the FP drops out');
  approx(m.recall, 2 / 3, 1e-9, 'recall unchanged');
});

test('computeMetrics: non-comparable high-confidence contradiction never counted', () => {
  // Only the single non-comparable row, contradicts:true conf:0.99 → no tp/fp.
  const onlyNonComparable = [
    { label: 'not', contradicts: true, confidence: 0.99, comparable: false },
  ];
  const m = computeMetrics(onlyNonComparable, 0.80);
  assert.equal(m.comparableCount, 0, 'no comparable rows');
  assert.equal(m.tp, 0);
  assert.equal(m.fp, 0);
  assert.equal(m.fn, 0);
  assert.equal(m.tn, 0);
  assert.equal(m.precision, null, 'precision null when tp+fp == 0');
  assert.equal(m.recall, null, 'recall null when tp+fn == 0');
  assert.equal(m.f1, 0, 'f1 is 0 when P/R null');
  assert.equal(m.fHalf, 0, 'fHalf is 0 when P/R null');
});

// ── sweepThresholds ──────────────────────────────────────────────────────────

test('sweepThresholds: one metric row per threshold', () => {
  const thresholds = [0.70, 0.80, 0.90];
  const rows = sweepThresholds({ judged: JUDGED, thresholds });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tau), thresholds);
});

// ── pickThreshold ────────────────────────────────────────────────────────────

test('pickThreshold: returns lowest τ meeting the precision floor', () => {
  // Sweep where precision climbs to 1.0 at τ=0.88 (FP drops out) and stays 1.0.
  const sweep = sweepThresholds({ judged: JUDGED, thresholds: [0.80, 0.85, 0.88, 0.90, 0.95] });
  const chosen = pickThreshold(sweep, { precisionFloor: 0.98 });
  assert.equal(chosen.meetsFloor, true);
  // At 0.80 P=0.667 (<floor); at 0.85 the FP (conf 0.85) still counts → P=0.667.
  // At 0.88 the FP drops → P=1.0. Lowest qualifying τ is 0.88.
  approx(chosen.tau, 0.88, 1e-9, 'lowest qualifying τ');
  approx(chosen.precision, 1.0, 1e-9, 'chosen precision');
  approx(chosen.recall, 2 / 3, 1e-9, 'chosen recall (maximized at lowest qualifying τ)');
});

test('pickThreshold: never meets floor → meetsFloor:false with diagnostics', () => {
  // All rows are not/true at high confidence → precision is always 0.
  const allFp = [
    { label: 'not', contradicts: true, confidence: 0.99, comparable: true },
    { label: 'not', contradicts: true, confidence: 0.95, comparable: true },
  ];
  const sweep = sweepThresholds({ judged: allFp, thresholds: [0.80, 0.90] });
  const chosen = pickThreshold(sweep, { precisionFloor: 0.98 });
  assert.equal(chosen.meetsFloor, false);
  assert.equal(chosen.precisionFloor, 0.98);
  // bestPrecision is the highest observed non-null precision (here 0 at both τ).
  assert.equal(chosen.bestPrecision, 0, 'bestPrecision diagnostic');
  assert.ok(typeof chosen.bestPrecisionTau === 'number', 'bestPrecisionTau is reported');
});

// ── analyzeRetrieval ─────────────────────────────────────────────────────────

test('analyzeRetrieval: per-group percentile stats; null-cosine skipped', () => {
  const judged = [
    // contradiction group cosines: 0.10, 0.20, 0.30, 0.40, 0.50
    { label: 'contradiction', comparable: true, cosine: 0.30 },
    { label: 'contradiction', comparable: true, cosine: 0.10 },
    { label: 'contradiction', comparable: true, cosine: 0.50 },
    { label: 'contradiction', comparable: true, cosine: 0.20 },
    { label: 'contradiction', comparable: true, cosine: 0.40 },
    // not group cosines: 0.60, 0.80
    { label: 'not', comparable: true, cosine: 0.60 },
    { label: 'not', comparable: true, cosine: 0.80 },
    // skipped: null cosine, and a comparable:false row
    { label: 'contradiction', comparable: true, cosine: null },
    { label: 'contradiction', comparable: false, cosine: 0.99 },
  ];
  const r = analyzeRetrieval(judged);
  assert.equal(r.contradiction.count, 5, 'null-cosine + non-comparable skipped');
  approx(r.contradiction.min, 0.10, 1e-9, 'contradiction min');
  approx(r.contradiction.max, 0.50, 1e-9, 'contradiction max');
  approx(r.contradiction.median, 0.30, 1e-9, 'contradiction median (nearest-rank)');
  approx(r.contradiction.mean, 0.30, 1e-9, 'contradiction mean');
  assert.equal(r.not.count, 2, 'not group count');
  approx(r.not.min, 0.60, 1e-9, 'not min');
  approx(r.not.max, 0.80, 1e-9, 'not max');
});

test('analyzeRetrieval: empty group → null stats', () => {
  const judged = [
    { label: 'contradiction', comparable: true, cosine: 0.25 },
    // no `not` rows with a numeric cosine
  ];
  const r = analyzeRetrieval(judged);
  assert.equal(r.contradiction.count, 1);
  assert.equal(r.not.count, 0);
  assert.equal(r.not.min, null);
  assert.equal(r.not.median, null);
  assert.equal(r.not.max, null);
  assert.equal(r.not.mean, null);
});

// ── formatSummaryTable ───────────────────────────────────────────────────────

test('formatSummaryTable: non-empty string with expected section tokens', () => {
  const judged = [
    { olderFact: 'a', newerFact: 'b', olderLane: 'work', newerLane: 'work', olderPersona: null, newerPersona: null,
      label: 'contradiction', category: 'same-lane-contradiction', comparable: true, contradicts: true, confidence: 0.95, reasoning: '', cosine: 0.20 },
    { olderFact: 'c', newerFact: 'd', olderLane: 'work', newerLane: 'work', olderPersona: null, newerPersona: null,
      label: 'not', category: 'same-lane-unrelated', comparable: true, contradicts: false, confidence: 0.0, reasoning: '', cosine: 0.70 },
    { olderFact: 'e', newerFact: 'f', olderLane: 'work', newerLane: 'sidegig', olderPersona: null, newerPersona: null,
      label: 'not', category: 'cross-lane', comparable: false, contradicts: true, confidence: 0.99, reasoning: '', cosine: 0.65 },
  ];
  const thresholds = [0.80, 0.90];
  const sweep = sweepThresholds({ judged, thresholds });
  const chosen = pickThreshold(sweep, { precisionFloor: 0.98 });
  const retrieval = analyzeRetrieval(judged);
  const result = {
    fixtureCounts: {
      byCategory: { 'same-lane-contradiction': 1, 'same-lane-unrelated': 1, 'cross-lane': 1 },
      byLabel: { contradiction: 1, not: 2 },
      comparable: 2,
      nonComparable: 1,
    },
    thresholds,
    precisionFloor: 0.98,
    sweep,
    chosen,
    retrieval,
    judged,
  };
  const out = formatSummaryTable(result);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0, 'non-empty');
  for (const token of ['τ', 'precision', 'recall', 'F1', 'F0.5', 'Retrieval']) {
    assert.ok(out.includes(token), `summary must mention "${token}"`);
  }
});

// ── loadFixtureJsonl ─────────────────────────────────────────────────────────

test('loadFixtureJsonl: round-trips a 2-line .jsonl from tmpdir', async () => {
  const p = join(tmpdir(), `d3-eval-test-${process.pid}-${Date.now()}.jsonl`);
  const row1 = { olderFact: 'x', newerFact: 'y', olderLane: 'work', newerLane: 'work', olderPersona: null, newerPersona: null, label: 'contradiction', category: 'same-lane-contradiction' };
  const row2 = { olderFact: 'm', newerFact: 'n', olderLane: 'work', newerLane: 'home', olderPersona: null, newerPersona: null, label: 'not', category: 'cross-lane' };
  // Include a trailing newline + a blank line to confirm blank-line filtering.
  await writeFile(p, JSON.stringify(row1) + '\n' + JSON.stringify(row2) + '\n\n', 'utf8');
  try {
    const rows = await loadFixtureJsonl(p);
    assert.equal(rows.length, 2, 'two parsed objects, blank lines filtered');
    assert.equal(rows[0].olderFact, 'x');
    assert.equal(rows[1].category, 'cross-lane');
  } finally {
    await rm(p, { force: true });
  }
});

// ── defaultThresholds ────────────────────────────────────────────────────────

test('defaultThresholds: 0.70..0.99 step 0.01, 2-decimal rounded', () => {
  const t = defaultThresholds();
  assert.equal(t[0], 0.70, 'starts at 0.70');
  assert.equal(t[t.length - 1], 0.99, 'ends at 0.99');
  // ~30 values; assert each is rounded to 2 decimals and strictly increasing.
  for (let i = 0; i < t.length; i++) {
    approx(t[i], Math.round(t[i] * 100) / 100, 1e-9, `value ${i} is 2-decimal`);
    if (i > 0) assert.ok(t[i] > t[i - 1], 'strictly increasing');
  }
  assert.ok(t.length >= 29 && t.length <= 31, `~30 values, got ${t.length}`);
});
