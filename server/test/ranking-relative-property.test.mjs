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
    let clampHits = 0; // within-skew future points clamped to age 0 — the D11/§4.1 clamp branch
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
        if (ms > NOW) clampHits++;
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

      // H set includes a SUB-DAY value (0.5 d): at A_q up to 400 d the factor spans 1 down to
      // e^-800 — below the exp underflow — so the derivation's floor is exercised here too.
      for (const h of [0.5, 7, 30, 90]) {
        const expected = Math.min(1, Math.max(Number.MIN_VALUE, Math.exp(-aq / h)));
        const uf = undatedFactorFor(q.ageDays, h);
        assert.ok(uf > 0 && uf <= 1, `iter ${iter} H=${h}: ${uf} must sit in (0, 1]`);
        // Compared in E-FOLDINGS (scale-free): an absolute 1e-12 tolerance is larger than the
        // factor itself over most of the H=7 domain and would let a 1000x-wrong deep-tail
        // value through (code review 2026-09-04).
        // Past the deep tail (< 1e-300: subnormal / underflow territory) double precision carries
        // only a few bits, so the check is membership in the tail, not e-foldings.
        if (expected < 1e-300) assert.ok(uf < 1e-300, `iter ${iter} H=${h}: ${uf} must sit in the deep tail`);
        else assert.ok(Math.abs(Math.log(uf) - Math.log(expected)) < 1e-9, `iter ${iter} H=${h}: -ln factor ${-Math.log(uf)} vs ${-Math.log(expected)}`);
        // I3: an undated item and a dated item aged exactly A_q receive the same factor.
        const pair = applyTemporalDecay([
          { id: 'u', score: 0.5, metadata: {} },
          { id: 'd', score: 0.5, metadata: { valid_from: new Date(NOW - aq * DAY).toISOString() } },
        ], h, { undatedFactor: uf });
        const u = pair.find((r) => r.id === 'u').score;
        const d = pair.find((r) => r.id === 'd').score;
        // I3 in e-foldings as well. In the deep tail the DATED branch has no floor (N2 — it may
        // underflow to exactly 0) while the undated derivation floors at Number.MIN_VALUE, so
        // there the identity is "both at the floor of the range", never "undated above dated".
        if (expected < 1e-300) assert.ok(u < 1e-300 && d < 1e-300, `iter ${iter} H=${h}: deep tail — undated ${u}, dated ${d}`);
        // Tolerance: the dated item's age passes through an ISO string (ms resolution), so its
        // e-folding count can differ from A_q's by up to ~2 ms / (DAY × H) — 2.3e-8 at H = 0.5 d.
        else assert.ok(Math.abs(Math.log(u) - Math.log(d)) < 1e-9 + 2 / (DAY * h), `iter ${iter} H=${h}: I3 undated ${u} vs dated-at-A_q ${d}`);
      }
      for (const h of [-30, 0]) {
        assert.equal(undatedFactorFor(q.ageDays, h), Math.exp(-0.25), `iter ${iter} H=${h}: fallback`);
      }
    }
    assert.ok(excludedTotal > 0, 'the domain must have produced beyond-skew future points (D11 exercised)');
    assert.ok(clampHits > 0, 'the domain must have produced within-skew future points (the clamp branch exercised)');

    // The min-cohort branch is unreachable in the n ∈ [20, 400] domain above, so it is exercised
    // explicitly here: below-floor cohorts report null with belowMinCohort, and the derived factor
    // is the fallback constant (spec D4/D14).
    for (let n = 1; n < 20; n++) {
      const items = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, score: 0.5, metadata: { valid_from: new Date(NOW - (i + 1) * DAY).toISOString() } }));
      const q = datedAgeQuantile(items, { now: NOW });
      assert.equal(q.n, n);
      assert.equal(q.ageDays, null, `n=${n}`);
      assert.equal(q.belowMinCohort, true, `n=${n}`);
      assert.equal(undatedFactorFor(q.ageDays, 30), Math.exp(-0.25));
    }
  } finally {
    Date.now = originalNow;
  }
});
