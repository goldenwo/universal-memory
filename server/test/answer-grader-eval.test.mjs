// server/test/answer-grader-eval.test.mjs — pins the Layer-1 reliability eval pure-fns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, sweepThresholds, PRECISION_FLOOR } from '../eval/answer-grader-eval.mjs';

const judged = [
  { gold: true,  answers: true,  confidence: 0.9,  ok: true },  // tp at τ≤0.9
  { gold: true,  answers: true,  confidence: 0.6,  ok: true },  // tp at τ≤0.6 else fn
  { gold: false, answers: true,  confidence: 0.95, ok: true },  // fp (hard negative the judge got wrong)
  { gold: false, answers: false, confidence: 0.1,  ok: true },  // tn
  { gold: true,  answers: false, confidence: 0,    ok: false }, // parse-fail → excluded
];

test('computeMetrics: excludes parse-fails and computes precision/recall at τ', () => {
  const m = computeMetrics(judged, 0.8);
  // at τ=0.8: row0 tp, row1 fn (0.6<0.8), row2 fp, row3 tn; row4 excluded
  assert.deepEqual({ tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn }, { tp: 1, fp: 1, fn: 1, tn: 1 });
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(m.graded, 4); // parse-fail excluded
});

test('sweepThresholds: one row per threshold', () => {
  const rows = sweepThresholds({ judged, thresholds: [0.6, 0.8, 0.95] });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tau, 0.6);
});

test('PRECISION_FLOOR is the single pinned constant 0.90', () => {
  assert.equal(PRECISION_FLOOR, 0.90);
});
