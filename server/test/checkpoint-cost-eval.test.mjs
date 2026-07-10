// server/test/checkpoint-cost-eval.test.mjs — B2 checkpoint-cost eval unit tests.
//
// Mirrors the lane-eval.mjs / d3-eval.mjs pattern: PURE aggregation logic lives
// in eval/checkpoint-cost-eval.mjs as a named export (aggregateCostRuns), unit-
// tested here with NO live server / no I/O / no provider calls. The CLI shim
// (arg parsing, HTTP calls to a live server, qdrant + vault cleanup) is guarded
// by IS_MAIN and only exercised by the keyed run, never by this suite.
//
// Median semantics: TRUE median (mean of the two middle values for even n) —
// deliberately NOT the nearest-rank percentile convention used elsewhere in the
// eval suite (lib/stats.mjs), because this eval's median is reported as a
// central-tendency headline number, not a latency-style percentile. p95 IS
// nearest-rank (the house convention for tail percentiles).
//
// Fail-loud contract: a run missing `cost_usd` throws — no silent skip, since
// a dropped cost sample would silently understate the reported cost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCostRuns } from '../eval/checkpoint-cost-eval.mjs';

test('aggregateCostRuns: odd n — median is the middle value', () => {
  const runs = [
    { cost_usd: 0.01, tokens_in: 100, tokens_out: 50 },
    { cost_usd: 0.03, tokens_in: 300, tokens_out: 150 },
    { cost_usd: 0.02, tokens_in: 200, tokens_out: 100 },
  ];
  const result = aggregateCostRuns(runs);
  assert.equal(result.n, 3);
  assert.equal(result.cost_usd.median, 0.02);
  assert.equal(result.tokens_in.median, 200);
  assert.equal(result.tokens_out.median, 100);
});

test('aggregateCostRuns: even n — median is the mean of the middle two', () => {
  const runs = [
    { cost_usd: 0.01, tokens_in: 100, tokens_out: 10 },
    { cost_usd: 0.02, tokens_in: 200, tokens_out: 20 },
    { cost_usd: 0.03, tokens_in: 300, tokens_out: 30 },
    { cost_usd: 0.04, tokens_in: 400, tokens_out: 40 },
  ];
  const result = aggregateCostRuns(runs);
  assert.equal(result.n, 4);
  // middle two are 0.02 and 0.03 -> mean 0.025
  assert.equal(result.cost_usd.median, 0.025);
  assert.equal(result.tokens_in.median, 250);
  assert.equal(result.tokens_out.median, 25);
});

test('aggregateCostRuns: n=1 — median and p95 both equal the single value', () => {
  const runs = [{ cost_usd: 0.005, tokens_in: 50, tokens_out: 25 }];
  const result = aggregateCostRuns(runs);
  assert.equal(result.n, 1);
  assert.equal(result.cost_usd.median, 0.005);
  assert.equal(result.cost_usd.p95, 0.005);
  assert.equal(result.tokens_in.median, 50);
  assert.equal(result.tokens_out.median, 25);
});

test('aggregateCostRuns: p95 uses nearest-rank over cost_usd', () => {
  // 20 ascending values 1..20 (cost_usd). Nearest-rank p95 over n=20:
  // idx = clamp(ceil(0.95*20)-1, 0, 19) = ceil(19)-1 = 18 -> sorted[18] = 19.
  const runs = Array.from({ length: 20 }, (_, i) => ({
    cost_usd: i + 1,
    tokens_in: 0,
    tokens_out: 0,
  }));
  const result = aggregateCostRuns(runs);
  assert.equal(result.n, 20);
  assert.equal(result.cost_usd.p95, 19);
});

test('aggregateCostRuns: a run missing cost_usd throws (fail-loud, no silent skip)', () => {
  const runs = [
    { cost_usd: 0.01, tokens_in: 10, tokens_out: 5 },
    { tokens_in: 20, tokens_out: 10 }, // missing cost_usd
  ];
  assert.throws(() => aggregateCostRuns(runs), /cost_usd/);
});

test('aggregateCostRuns: an empty runs array throws (no aggregate over zero samples)', () => {
  assert.throws(() => aggregateCostRuns([]), /empty/);
});
