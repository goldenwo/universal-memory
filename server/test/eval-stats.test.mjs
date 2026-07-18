// server/test/eval-stats.test.mjs — unit tests for the shared eval stats helper.
//
// TDD: written FIRST (before eval/lib/stats.mjs exists), per the eval-stats
// extraction. The nearest-rank percentile + distribution-summary pattern lived
// in three eval harnesses (memory-quality-eval, lane-eval, d3-eval); rule-of-three
// → extracted here. These tests pin the byte-for-byte behavior all three rely on:
//   - percentile: nearest-rank value at idx=clamp(ceil(q*n)-1, 0, n-1); the mq
//       contract (filters non-finite, sorts a copy, empty/null → null).
//   - summarize: { count, ...requested percentiles, min, max, mean } over the
//       finite sample; the configurable generalization of summarizeLatency (mq)
//       and distStats (lane/d3) — the percentile list is a param so each consumer
//       keeps its own set/labels with no JSON shape change.
//
// Pure functions — no live calls, runs fully offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { percentile, summarize } from '../eval/lib/stats.mjs';

// --- percentile (nearest-rank) ---------------------------------------------

test('percentile: empty sample → null', () => {
  assert.equal(percentile([], 0.5), null);
});

test('percentile: null/undefined sample → null', () => {
  assert.equal(percentile(null, 0.5), null);
  assert.equal(percentile(undefined, 0.95), null);
});

test('percentile: single sample → that value for any q', () => {
  assert.equal(percentile([7], 0), 7);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([7], 1), 7);
});

test('percentile: nearest-rank over unsorted input (sorts a copy)', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20); // ceil(0.5*4)-1=1 → 2nd-smallest
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
});

test('percentile: q=0 → min, q=1 → max', () => {
  assert.equal(percentile([5, 1, 9, 3], 0), 1);
  assert.equal(percentile([5, 1, 9, 3], 1), 9);
});

test('percentile: p95 over 20 samples picks the 19th-smallest (nearest-rank)', () => {
  const s = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assert.equal(percentile(s, 0.95), 19); // ceil(0.95*20)=19 → idx18 → value 19
});

test('percentile: drops non-finite entries (NaN / ±Infinity) before ranking', () => {
  // finite set is [10,20,30]; q=1 → max of finite = 30 (Infinity must not win).
  assert.equal(percentile([10, NaN, 20, Infinity, 30, -Infinity], 1), 30);
  assert.equal(percentile([NaN, Infinity], 0.5), null); // no finite values → null
});

// --- summarize (configurable distribution summary) -------------------------

test('summarize: empty sample → count 0, all stats null', () => {
  assert.deepEqual(
    summarize([], [['p50', 0.5], ['p95', 0.95]]),
    { count: 0, p50: null, p95: null, min: null, max: null, mean: null },
  );
});

test('summarize: null/undefined sample → count 0, all stats null', () => {
  assert.deepEqual(summarize(null, [['median', 0.5]]), { count: 0, median: null, min: null, max: null, mean: null });
});

test('summarize: single sample → every stat is that value', () => {
  assert.deepEqual(
    summarize([7], [['p50', 0.5], ['p95', 0.95]]),
    { count: 1, p50: 7, p95: 7, min: 7, max: 7, mean: 7 },
  );
});

test('summarize: no percentiles param → just count/min/max/mean', () => {
  assert.deepEqual(summarize([10, 20, 30]), { count: 3, min: 10, max: 30, mean: 20 });
});

test('summarize: reproduces summarizeLatency (mq) shape — { count, p50, p95, min, max, mean }', () => {
  assert.deepEqual(
    summarize([10, 20, 30, 40], [['p50', 0.5], ['p95', 0.95]]),
    { count: 4, p50: 20, p95: 40, min: 10, max: 40, mean: 25 },
  );
});

test('summarize: reproduces distStats (lane/d3) shape — count/min/p25/median/p75/max/mean values', () => {
  const s = summarize([10, 20, 30, 40, 50], [['p25', 0.25], ['median', 0.5], ['p75', 0.75]]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 10);
  assert.equal(s.p25, 20); // ceil(0.25*5)-1=1 → 2nd-smallest
  assert.equal(s.median, 30); // ceil(0.5*5)-1=2 → 3rd-smallest
  assert.equal(s.p75, 40); // ceil(0.75*5)-1=3 → 4th-smallest
  assert.equal(s.max, 50);
  assert.equal(s.mean, 30);
});

test('summarize: custom percentile labels and order are honored', () => {
  const s = summarize([1, 2, 3, 4], [['lo', 0.1], ['hi', 0.9]]);
  assert.equal(s.lo, 1); // ceil(0.1*4)-1=0 → min
  assert.equal(s.hi, 4); // ceil(0.9*4)-1=3 → max
  assert.equal(s.count, 4);
  assert.equal(s.mean, 2.5);
});

test('summarize: drops non-finite entries from count/min/max/mean', () => {
  // finite set is [10,20,30] → count 3, mean 20, max 30 (Infinity excluded).
  assert.deepEqual(
    summarize([10, NaN, 20, Infinity, 30], [['median', 0.5]]),
    { count: 3, median: 20, min: 10, max: 30, mean: 20 },
  );
});
