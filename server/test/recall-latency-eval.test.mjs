// server/test/recall-latency-eval.test.mjs — B4 recall-latency eval unit tests.
//
// Mirrors the checkpoint-cost-eval.mjs / dedup-effectiveness-eval.mjs pattern:
// PURE aggregation logic lives in eval/recall-latency-eval.mjs as a named
// export (percentiles), unit-tested here with NO live server / no I/O / no
// provider calls. The CLI shim (arg parsing, HTTP calls to a live server or
// the Pi, warmup + timed search loop) is guarded by IS_MAIN and only
// exercised by the keyed runs, never by this suite.
//
// Nearest-rank convention (matches eval/lib/stats.mjs's rankValue): for a
// percentile p in [0,100] over a sorted-ascending copy of n samples,
// idx = clamp(ceil((p/100)*n) - 1, 0, n-1). Deliberately a fresh, minimal
// implementation local to this module rather than reusing lib/stats.mjs's
// summarize() — that helper takes [label, q-in-[0,1]] pairs and returns an
// object with min/max/mean baked in; this eval only needs a plain
// {p50, p95, p99} shape keyed by the requested percentile numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentiles } from '../eval/recall-latency-eval.mjs';

test('percentiles: n=1 — every requested percentile equals the single value', () => {
  const result = percentiles([42], [50, 95, 99]);
  assert.deepEqual(result, { 50: 42, 95: 42, 99: 42 });
});

test('percentiles: n=100 exact ranks — 1..100 ascending', () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const result = percentiles(samples, [50, 95, 99]);
  // idx = ceil(p/100 * 100) - 1 = p - 1 -> sorted[p-1] = p
  assert.equal(result[50], 50);
  assert.equal(result[95], 95);
  assert.equal(result[99], 99);
});

test('percentiles: unsorted input is sorted internally before ranking', () => {
  const samples = [30, 10, 50, 20, 40, 90, 60, 80, 70, 100];
  const sortedExpectation = percentiles([...samples].sort((a, b) => a - b), [50, 95, 99]);
  const result = percentiles(samples, [50, 95, 99]);
  assert.deepEqual(result, sortedExpectation);
});

test('percentiles: unsorted input does not mutate the caller\'s array', () => {
  const samples = [5, 3, 1, 4, 2];
  const copy = [...samples];
  percentiles(samples, [50]);
  assert.deepEqual(samples, copy);
});

test('percentiles: empty samples array throws', () => {
  assert.throws(() => percentiles([], [50, 95, 99]), /empty/);
});

test('percentiles: requesting an unlisted percentile key is simply absent (only requested keys are returned)', () => {
  const result = percentiles([1, 2, 3, 4, 5], [50]);
  assert.deepEqual(Object.keys(result), ['50']);
});
