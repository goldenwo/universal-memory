// server/test/ranking-relative-property.test.mjs — #297 spec §6.4 property test.
//
// 200 seeded random cohorts (n ∈ [20, 400], ages ∈ [−5, 400] d, H ∈ {7, 30, 90}, plus
// H ∈ {−30, 0} asserting the fallback constant): `undatedFactorFor(A_q, H)` equals
// `min(1, exp(−A_q/H))` with A_q recomputed by an INDEPENDENT type-7 quantile written here
// (never the module's), and the I3 neutrality identity holds through applyTemporalDecay for
// every cohort. Negative ages are FUTURE dates: beyond CLOCK_SKEW_TOLERANCE_MS they are
// excluded from the oracle's cohort (spec D11), within it they clamp to 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTemporalDecay, datedAgeQuantile, undatedFactorFor, CLOCK_SKEW_TOLERANCE_MS } from '../lib/ranking.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-04T00:00:00.000Z');
const SEED = 0x297c0de;

/** xorshift32 with a LITERAL seed — node:test has no seeded RNG; the run must be reproducible. */
function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/** Independent type-7 (linear interpolation) quantile — the oracle, not the implementation. */
function quantile7(values, q) {
  const a = [...values].sort((x, y) => x - y);
  const h = (a.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return a[lo] + (h - lo) * (a[hi] - a[lo]);
}

test('§6.4: factor == min(1, exp(-A_q/H)) with an independent type-7 A_q, and I3 holds through applyTemporalDecay', () => {
  const rnd = xorshift32(SEED);
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    let excludedTotal = 0;
    for (let iter = 0; iter < 200; iter++) {
      const n = 20 + Math.floor(rnd() * 381); // 20..400
      const ageDaysList = Array.from({ length: n }, () => -5 + rnd() * 405); // −5..400 d
      const items = ageDaysList.map((age, i) => ({
        id: `p${i}`, score: 0.5, metadata: { valid_from: new Date(NOW - age * DAY).toISOString() },
      }));

      // Oracle cohort: drop beyond-skew future points, clamp within-skew negatives to 0.
      const oracleAges = [];
      for (const it of items) {
        const ms = new Date(it.metadata.valid_from).getTime();
        if (ms > NOW + CLOCK_SKEW_TOLERANCE_MS) { excludedTotal++; continue; }
        oracleAges.push(Math.max(0, (NOW - ms) / DAY));
      }
      const q = datedAgeQuantile(items, { now: NOW });
      assert.equal(q.n, oracleAges.length, `iter ${iter}: cohort size`);
      assert.equal(q.futureExcluded, n - oracleAges.length, `iter ${iter}: futureExcluded`);

      if (oracleAges.length < 20) {
        assert.equal(q.ageDays, null);
        assert.equal(q.belowMinCohort, true);
        continue;
      }
      const aq = quantile7(oracleAges, 0.5);
      assert.ok(Math.abs(q.ageDays - aq) < 1e-9, `iter ${iter}: A_q ${q.ageDays} vs oracle ${aq}`);

      for (const h of [7, 30, 90]) {
        const expected = Math.min(1, Math.exp(-aq / h));
        const uf = undatedFactorFor(q.ageDays, h);
        assert.ok(Math.abs(uf - expected) < 1e-12, `iter ${iter} H=${h}: factor ${uf} vs ${expected}`);
        // I3: an undated item and a dated item aged exactly A_q receive the same factor.
        const pair = applyTemporalDecay([
          { id: 'u', score: 0.5, metadata: {} },
          { id: 'd', score: 0.5, metadata: { valid_from: new Date(NOW - aq * DAY).toISOString() } },
        ], h, { undatedFactor: uf });
        const u = pair.find((r) => r.id === 'u').score;
        const d = pair.find((r) => r.id === 'd').score;
        assert.ok(Math.abs(u - d) < 1e-9, `iter ${iter} H=${h}: I3 undated ${u} vs dated-at-A_q ${d}`);
      }
      for (const h of [-30, 0]) {
        assert.equal(undatedFactorFor(q.ageDays, h), Math.exp(-0.25), `iter ${iter} H=${h}: fallback`);
      }
    }
    assert.ok(excludedTotal > 0, 'the domain must have produced beyond-skew future points (D11 exercised)');
  } finally {
    Date.now = originalNow;
  }
});
