/**
 * server/test/eval-dedup-threshold-sweep.test.mjs — Smoke test for the D1
 * threshold-tuning sweep harness.
 *
 * Spec: docs/plans/2026-05-09-d1-threshold-eval-spec.md §8 + Acceptance A6.
 * Plan: docs/plans/2026-05-09-d1-threshold-eval-plan.md §B (TDD red first).
 *
 * Lives at server/test/eval-dedup-threshold-sweep.test.mjs (prefix-style
 * filename, NOT a subdir) so the npm-test glob `test/**\/*.test.mjs` picks
 * it up while the harness directory `server/eval/` stays out of test reach.
 *
 * Imports the harness from ../eval/dedup-threshold-sweep.mjs (sibling to lib/, test/).
 *
 * Coverage:
 *   B.1.1-B.1.3 — sweepThresholds metric math (3-pair synthetic, mock embedder).
 *   B.1.4       — pickElbow() highest-τ tie-breaker on a 4-τ band (≤ 5 → no plateau).
 *   B.1.5       — pickElbow() plateau detection on a 6-τ band (> 5 → midpoint).
 *   B.1.6       — cosine() defensive normalization (L2-normalized + un-normalized inputs).
 *   B.1.7       — wilsonCi() sanity (small-n + all-success edge).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sweepThresholds,
  pickElbow,
  cosine,
  wilsonCi,
} from '../eval/dedup-threshold-sweep.mjs';

// ---------------------------------------------------------------------------
// Mock-embedder helper. Vectors chosen so dot product = target cosine (both
// vectors L2-normalized, 2D, first vector = [1, 0]).
// ---------------------------------------------------------------------------

/**
 * Build a 2D unit vector with the given dot product against [1, 0].
 * For target cosine c: v = [c, sqrt(1 - c²)]. Both vectors L2-normalized.
 */
function unitForCosine(c) {
  return [c, Math.sqrt(Math.max(0, 1 - c * c))];
}

/**
 * Make a mock embedder over a {text -> vector} dictionary. Async per the
 * production embedder contract `(text) => Promise<{vector: number[]}>`.
 */
function makeMockEmbedder(table) {
  return async (text) => {
    if (!(text in table)) throw new Error(`mock embedder: no vector for "${text}"`);
    return { vector: table[text] };
  };
}

// ---------------------------------------------------------------------------
// B.1.1-B.1.3 — sweepThresholds metric math.
// 3-pair synthetic fixture: 1 identical (cos 0.99), 1 paraphrase (cos 0.92),
// 1 unrelated (cos 0.40). Three threshold checks per spec §8.
// ---------------------------------------------------------------------------

const SYNTHETIC_PAIRS = [
  { a: 'id-a', b: 'id-b', label: 'identical',  source: 'preferences', projectContext: 'same-project' },
  { a: 'pa-a', b: 'pa-b', label: 'paraphrase', source: 'preferences', projectContext: 'same-project' },
  { a: 'un-a', b: 'un-b', label: 'unrelated',  source: 'preferences', projectContext: 'same-project' },
];

const SYNTHETIC_VECTORS = {
  'id-a': [1, 0], 'id-b': unitForCosine(0.99),
  'pa-a': [1, 0], 'pa-b': unitForCosine(0.92),
  'un-a': [1, 0], 'un-b': unitForCosine(0.40),
};

test('B.1.1: sweepThresholds at τ=0.30 — all 3 merge (below lowest cosine)', async () => {
  // Cosines are 0.99 / 0.92 / 0.40. τ=0.30 is below the lowest, so all 3 merge.
  // (Original spec/plan said τ=0.50; that would leave the 0.40 unrelated pair
  // unmerged, so τ=0.30 is the correct "all merge" threshold for this fixture.)
  const embedder = makeMockEmbedder(SYNTHETIC_VECTORS);
  const result = await sweepThresholds({ pairs: SYNTHETIC_PAIRS, embedder, thresholds: [0.30] });
  const row = result.perThreshold[0];
  assert.equal(row.tau, 0.30);
  assert.equal(row.paraphraseRecall, 1.0, 'paraphrase merges at low τ');
  assert.equal(row.unrelatedPrecision, 0.0, 'unrelated also merges → precision = 0');
  assert.equal(row.identicalRecall, 1.0);
  assert.equal(row.fHalf, 0.0, 'F_0.5 collapses when precision = 0');
  assert.equal(row.combined, 0.0, 'combined collapses when precision = 0');
});

test('B.1.2: sweepThresholds at τ=0.95 — only identical merges (paraphrase 0.92 < 0.95)', async () => {
  const embedder = makeMockEmbedder(SYNTHETIC_VECTORS);
  const result = await sweepThresholds({ pairs: SYNTHETIC_PAIRS, embedder, thresholds: [0.95] });
  const row = result.perThreshold[0];
  assert.equal(row.tau, 0.95);
  assert.equal(row.paraphraseRecall, 0.0, 'paraphrase 0.92 < 0.95 → no merge');
  assert.equal(row.unrelatedPrecision, 1.0);
  assert.equal(row.identicalRecall, 1.0, 'identical 0.99 ≥ 0.95');
  assert.equal(row.fHalf, 0.0, 'F_0.5 collapses when recall = 0');
  assert.equal(row.combined, 0.0);
});

test('B.1.3: sweepThresholds at τ=0.91 — perfect-elbow datapoint', async () => {
  const embedder = makeMockEmbedder(SYNTHETIC_VECTORS);
  const result = await sweepThresholds({ pairs: SYNTHETIC_PAIRS, embedder, thresholds: [0.91] });
  const row = result.perThreshold[0];
  assert.equal(row.tau, 0.91);
  assert.equal(row.paraphraseRecall, 1.0, 'paraphrase 0.92 ≥ 0.91');
  assert.equal(row.unrelatedPrecision, 1.0, 'unrelated 0.40 < 0.91');
  assert.equal(row.identicalRecall, 1.0);
  // F_0.5 = 1.25 × P × R / (0.25 × P + R) = 1.25 × 1 × 1 / 1.25 = 1.0
  assert.equal(row.fHalf, 1.0);
  assert.equal(row.combined, 1.0);
});

test('B.1.3-aux: sweepThresholds emits per-pair cosines + fixtureCounts + maxCosinePerTier', async () => {
  const embedder = makeMockEmbedder(SYNTHETIC_VECTORS);
  const result = await sweepThresholds({ pairs: SYNTHETIC_PAIRS, embedder, thresholds: [0.30] });

  assert.equal(result.pairScores.length, 3);
  // Tolerate fp noise on cosine reconstruction.
  const eps = 1e-9;
  const idScore = result.pairScores.find((p) => p.label === 'identical').cosine;
  assert.ok(Math.abs(idScore - 0.99) < eps, `identical cosine ≈ 0.99 (got ${idScore})`);
  assert.deepEqual(result.fixtureCounts, { identical: 1, paraphrase: 1, unrelated: 1, total: 3 });
  assert.ok(Math.abs(result.maxCosinePerTier.unrelated - 0.40) < eps);
});

// ---------------------------------------------------------------------------
// B.1.4 — pickElbow() highest-τ tie-breaker on 4-τ band (≤ 5 → no plateau).
// Spec §4.5 step 4 + Plan B.1.4.
// ---------------------------------------------------------------------------

test('B.1.4: pickElbow returns highest τ in CI-overlap band (4-τ band, no plateau)', () => {
  // Construction per plan B.1.4 — band = {0.90, 0.91, 0.92, 0.93} all overlap τ=0.91 max CI
  // [0.78, 0.94]. τ=0.85, 0.86, 0.95 lie outside the band.
  const perThreshold = [
    { tau: 0.85, fHalf: 0.50, fHalfCi: [0.40, 0.60] },  // 0.60 < 0.78 — no overlap
    { tau: 0.86, fHalf: 0.55, fHalfCi: [0.45, 0.65] },  // 0.65 < 0.78 — no overlap
    { tau: 0.90, fHalf: 0.85, fHalfCi: [0.75, 0.92] },  // overlap [0.78, 0.94]
    { tau: 0.91, fHalf: 0.87, fHalfCi: [0.78, 0.94] },  // MAX — band anchor
    { tau: 0.92, fHalf: 0.86, fHalfCi: [0.77, 0.93] },  // overlap
    { tau: 0.93, fHalf: 0.84, fHalfCi: [0.74, 0.91] },  // overlap
    { tau: 0.95, fHalf: 0.65, fHalfCi: [0.50, 0.75] },  // 0.75 < 0.78 — no overlap
  ];
  const elbow = pickElbow(perThreshold);

  assert.equal(elbow.tau, 0.93, 'highest-τ tie-breaker (DP3) → 0.93 wins');
  assert.deepEqual(elbow.bandTaus, [0.90, 0.91, 0.92, 0.93]);
  assert.equal(elbow.plateau, false, '4 contiguous τ ≤ 5 → not plateau-flagged');
  // Runner-up is the second-highest in band (0.92).
  assert.equal(elbow.runnerUpTau, 0.92);
});

// ---------------------------------------------------------------------------
// B.1.5 — pickElbow() plateau detection on 6-τ band (> 5 → midpoint).
// Spec §4.5 step 5 + Plan B.1.5.
// ---------------------------------------------------------------------------

test('B.1.5: pickElbow flags plateau when band > 5 contiguous τ + picks midpoint', () => {
  // Same shape as B.1.4 but 6 contiguous τ all overlap τ=0.91 max CI [0.78, 0.94].
  const perThreshold = [
    { tau: 0.86, fHalf: 0.55, fHalfCi: [0.45, 0.65] },  // outside
    { tau: 0.88, fHalf: 0.84, fHalfCi: [0.74, 0.91] },  // overlap
    { tau: 0.89, fHalf: 0.85, fHalfCi: [0.75, 0.92] },  // overlap
    { tau: 0.90, fHalf: 0.85, fHalfCi: [0.75, 0.92] },  // overlap
    { tau: 0.91, fHalf: 0.87, fHalfCi: [0.78, 0.94] },  // MAX
    { tau: 0.92, fHalf: 0.86, fHalfCi: [0.77, 0.93] },  // overlap
    { tau: 0.93, fHalf: 0.84, fHalfCi: [0.74, 0.91] },  // overlap
    { tau: 0.95, fHalf: 0.65, fHalfCi: [0.50, 0.75] },  // outside
  ];
  const elbow = pickElbow(perThreshold);

  assert.deepEqual(elbow.bandTaus, [0.88, 0.89, 0.90, 0.91, 0.92, 0.93]);
  assert.equal(elbow.plateau, true, '6 contiguous τ > 5 → plateau flagged');
  // Midpoint of 6-element band: bandTaus[Math.floor(6/2)] = bandTaus[3] = 0.91.
  assert.equal(elbow.tau, 0.91, 'plateau midpoint by floor(length/2)');
});

// ---------------------------------------------------------------------------
// B.1.6 — cosine() defensive normalization correctness.
// Plan B.1.6 + Spec R4.
// ---------------------------------------------------------------------------

test('B.1.6: cosine() on L2-normalized inputs equals dot product (idempotent normalization)', () => {
  const unitA = [1, 0];
  const unitB = [0.6, 0.8];  // norm = 1
  const expected = 1 * 0.6 + 0 * 0.8;  // = 0.6
  const actual = cosine(unitA, unitB);
  assert.ok(Math.abs(actual - expected) < 1e-12, `cosine(unit, unit) ≈ dot (got ${actual} expected ${expected})`);
});

test('B.1.6: cosine() on un-normalized inputs returns true cosine via full formula', () => {
  const scaledA = [3, 0];   // norm = 3
  const scaledB = [3, 4];   // norm = 5
  // dot = 3*3 + 0*4 = 9; cosine = 9 / (3*5) = 0.6
  const actual = cosine(scaledA, scaledB);
  assert.ok(Math.abs(actual - 0.6) < 1e-12, `cosine(scaled, scaled) ≈ 0.6 (got ${actual})`);
});

test('B.1.6: cosine() handles orthogonal vectors → 0', () => {
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
});

// ---------------------------------------------------------------------------
// B.1.7 — wilsonCi() sanity values.
// Plan B.1.7.
// ---------------------------------------------------------------------------

test('B.1.7: wilsonCi(8, 10) ≈ [0.49, 0.94]', () => {
  const [lo, hi] = wilsonCi(8, 10);
  assert.ok(Math.abs(lo - 0.49) < 0.02, `lower bound ≈ 0.49 (got ${lo})`);
  assert.ok(Math.abs(hi - 0.94) < 0.02, `upper bound ≈ 0.94 (got ${hi})`);
});

test('B.1.7: wilsonCi(25, 25) — all-success edge has lower bound > 0.86', () => {
  const [lo, hi] = wilsonCi(25, 25);
  assert.ok(lo > 0.86, `lower bound > 0.86 (got ${lo})`);
  assert.ok(hi <= 1.0 && hi > 0.99, `upper bound ≈ 1.0 (got ${hi})`);
});

test('B.1.7: wilsonCi(0, 10) — zero-success edge has upper bound < 0.31', () => {
  // Symmetric edge case to the all-success one.
  const [lo, hi] = wilsonCi(0, 10);
  assert.ok(lo >= 0.0 && lo < 0.05, `lower bound ≈ 0 (got ${lo})`);
  assert.ok(hi < 0.31, `upper bound < 0.31 (got ${hi})`);
});
