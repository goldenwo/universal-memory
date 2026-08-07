// server/test/helpers/undated-policy-cases.mjs — the undated-decay policy's case table,
// parameterised by the implementation under test.
//
// WHY THIS EXISTS. The red controls (RC1-RC4) must confirm that each mutation flips its
// NAMED set of cases and leaves its must-still-pass set green. That is only meaningful if
// the controls evaluate the SAME cases the suite asserts — two hand-maintained copies
// would drift, and a drifted control proves nothing about the tests that actually run.
// So the cases live here, and both `ranking-undated-policy.test.mjs` and
// `red-controls/run.mjs` consume them.
//
// Each case is `(decay, mod) => void` and signals failure by THROWING (node:assert).
// `mod` is the ranking module under test, so U10 can read the mutant's own exports.
//
// The LITERAL `Math.exp(-1)` rule from the test file applies here verbatim: never write
// `mod.UNDATED_FACTOR` in an assertion except in U10, whose whole job is to compare the
// export against the literal. Using the import elsewhere makes both sides of an identity
// move together under a retune, so RC1 could never go red.

import assert from 'node:assert/strict';
import {
  H, DAY, FIXED_NOW, withFixedNow, datedItem, undatedItem, datedExpect, mixedSet, DATED_PAIRS,
} from './undated-policy-fixtures.mjs';

export const CASES = {
  U1: [
    ['each scored undated item is exactly input x exp(-1) in a mixed set', (decay) => withFixedNow(() => {
      const byId = new Map(decay(mixedSet(), H).map((r) => [r.id, r]));
      assert.equal(byId.get('u-high').score, 0.8 * Math.exp(-1));
      assert.equal(byId.get('u-low').score, 0.2 * Math.exp(-1));
    })],
    ['an undated item is NOT graded on its createdAt', (decay) => withFixedNow(() => {
      // The fixture's createdAt is 120 days old; grading on it gives exp(-4), not exp(-1).
      const [out] = decay([undatedItem('u', 1.0, 120)], H);
      assert.equal(out.score, 1.0 * Math.exp(-1));
      assert.notEqual(out.score, 1.0 * Math.exp(-120 / H));
    })],
  ],

  U2: [
    ['an ALL-UNDATED set keeps its ordering, every scored item input x exp(-1)', (decay) => withFixedNow(() => {
      const out = decay([undatedItem('a', 0.9), undatedItem('b', 0.5), undatedItem('c', 0.1)], H);
      assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
      assert.equal(out[0].score, 0.9 * Math.exp(-1));
      assert.equal(out[1].score, 0.5 * Math.exp(-1));
      assert.equal(out[2].score, 0.1 * Math.exp(-1));
    })],
  ],

  // U3 owns EVERY dated-identity assertion, including the one on a mixed set. That
  // "dated items are untouched in a mixed set" case was originally filed under U1, which
  // made RC3 (mutating the dated factor) flip U1 — a case the control table says must
  // still pass. The control was right and the label was wrong: spec U1 is defined purely
  // over the UNDATED cohort. Keeping a dated assertion under U1 would have forced the
  // choice between relaxing a red control and living with a false failure.
  U3: [
    ['the dated items in a MIXED set are untouched by the policy', (decay) => withFixedNow(() => {
      const byId = new Map(decay(mixedSet(), H).map((r) => [r.id, r]));
      assert.equal(byId.get('d-old-high').score, datedExpect(120, 0.9));
      assert.equal(byId.get('d-new-low').score, datedExpect(1, 0.3));
    })],
    ['an ALL-DATED set is untouched — the dated branch is byte-identical', (decay) => withFixedNow(() => {
      const spec = [
        { id: 'old-high', age: 120, score: 0.9 },
        { id: 'new-low', age: 1, score: 0.3 },
        { id: 'mid', age: 30, score: 0.6 },
      ];
      const out = decay(spec.map((s) => datedItem(s.id, s.age, s.score)), H);
      for (const s of spec) assert.equal(out.find((r) => r.id === s.id).score, datedExpect(s.age, s.score));
      assert.deepEqual(out.map((r) => r.id), ['new-low', 'mid', 'old-high']);
    })],
  ],

  U4: [
    ['the undated factor is exp(-1) even with exactly ONE dated point', (decay) => withFixedNow(() => {
      const out = decay([datedItem('d', 45, 0.7), undatedItem('u', 0.8)], H);
      assert.equal(out.find((r) => r.id === 'u').score, 0.8 * Math.exp(-1));
      assert.equal(out.find((r) => r.id === 'd').score, datedExpect(45, 0.7));
    })],
  ],

  U5: [
    ['an undated item with NO score key is untouched — a score is never MINTED', (decay) => withFixedNow(() => {
      const [out] = decay([undatedItem('u-nascore', undefined)], H);
      assert.ok(!('score' in out), 'a score key must not be created');
      assert.equal(out.score, undefined);
      assert.notEqual(out.score, Math.exp(-1), 'minting 1 * factor would lift it from last to first');
    })],
    ['a score-less undated item still sorts LAST, not first', (decay) => withFixedNow(() => {
      const out = decay([undatedItem('u-nascore', undefined), ...mixedSet()], H);
      assert.equal(out[out.length - 1].id, 'u-nascore');
    })],
  ],

  U6: [
    ['an undated item with score 0 stays exactly 0 — not 1 x exp(-1)', (decay) => withFixedNow(() => {
      const [out] = decay([undatedItem('u-zero', 0)], H);
      assert.equal(out.score, 0);
      assert.notEqual(out.score, Math.exp(-1), '`score || 1` would turn a genuine 0 into the factor');
    })],
    ['a 0-scoring undated item never outranks a positive-scoring one', (decay) => withFixedNow(() => {
      const out = decay([undatedItem('u-zero', 0), undatedItem('u-small', 0.1)], H);
      assert.deepEqual(out.map((r) => r.id), ['u-small', 'u-zero']);
    })],
    ['a non-numeric score is left untouched rather than coerced', (decay) => withFixedNow(() => {
      for (const bad of [null, '0.9', undefined]) {
        const [out] = decay([{ id: 'u', createdAt: '2026-04-10T00:00:00Z', score: bad }], H);
        assert.equal(out.score, bad, `score ${JSON.stringify(bad)} must pass through untouched`);
        assert.notEqual(out.score, Math.exp(-1), 'a non-numeric score must not be coerced to the factor');
      }
    })],
  ],

  U7: [
    ['a score-less DATED item is still MINTED 1 x factor — the unchanged dated branch', (decay) => withFixedNow(() => {
      const item = { id: 'd-noscore', metadata: { valid_from: new Date(FIXED_NOW - 10 * DAY).toISOString() } };
      const [out] = decay([item], H);
      assert.equal(out.score, 1 * Math.exp(-10 / H));
    })],
  ],

  U8: [
    ['a common item scores identically in a subset and in a superset', (decay) => withFixedNow(() => {
      const common = () => [datedItem('d1', 20, 0.7), undatedItem('u1', 0.6)];
      const subset = decay(common(), H);
      const superset = decay(
        [...common(), datedItem('d2', 400, 0.95), undatedItem('u2', 0.05), undatedItem('u3', 0.99)], H,
      );
      for (const id of ['d1', 'u1']) {
        assert.equal(
          superset.find((r) => r.id === id).score,
          subset.find((r) => r.id === id).score,
          `${id} moved when unrelated items joined the set`,
        );
      }
    })],
    // The sub-case above CANNOT see the defect UNDATED_FACTOR's own comment names as the
    // reason for applying the constant unconditionally. Its subset already contains a dated
    // point, so an `anyDated` short-circuit is true on BOTH sides and the scores match.
    // Demonstrated: a mutant adding `if (!results.some(x => resolveItemDate(x) !== null))
    // return {...r};` flips U1, U2 and V3 — and U8 survives it.
    //
    // The discriminating shape is an ALL-UNDATED subset widened by one dated point: under
    // the short-circuit the undated item scores 1.0x alone and 0.368x once a dated point
    // joins, which is precisely "the factor depends on the rest of the returned set".
    ['an ALL-UNDATED subset keeps its scores when a DATED point joins (the anyDated short-circuit)', (decay) => withFixedNow(() => {
      const common = () => [undatedItem('u1', 0.6), undatedItem('u2', 0.4)];
      const alone = decay(common(), H);
      const widened = decay([...common(), datedItem('d1', 20, 0.7)], H);
      for (const id of ['u1', 'u2']) {
        assert.equal(
          widened.find((r) => r.id === id).score,
          alone.find((r) => r.id === id).score,
          `${id} changed when a DATED point joined — the factor is set-dependent`,
        );
      }
      // And pin the absolute value, so "identical but both wrong" cannot pass.
      assert.equal(alone.find((r) => r.id === 'u1').score, 0.6 * Math.exp(-1));
    })],
  ],

  U9: [
    ['the input array and its items are not mutated', (decay) => withFixedNow(() => {
      const input = mixedSet();
      const snapshot = JSON.stringify(input);
      const out = decay(input, H);
      assert.equal(JSON.stringify(input), snapshot, 'input was mutated');
      assert.notEqual(out, input, 'must return a NEW array');
      for (const item of out) assert.ok(!input.includes(item), 'items must be copies, not the originals');
    })],
  ],

  U10: [
    // The ONE place the import is compared to the literal.
    ['UNDATED_FACTOR is exactly Math.exp(-1)', (_decay, mod) => {
      assert.equal(mod.UNDATED_FACTOR, Math.exp(-1));
      assert.equal(mod.UNDATED_EFOLDINGS, 1);
    }],
    ['UNDATED_FACTOR is a constant strictly inside (0,1)', (_decay, mod) => {
      assert.ok(mod.UNDATED_FACTOR > 0 && mod.UNDATED_FACTOR < 1);
      assert.equal(typeof mod.UNDATED_FACTOR, 'number');
      assert.ok(Number.isFinite(mod.UNDATED_FACTOR));
    }],
  ],

  V1: [
    ['the DATED subsequence comes out in analytic decayed order', (decay) => withFixedNow(() => {
      const out = decay(mixedSet(), H);
      const datedOut = out.filter((r) => r.metadata?.valid_from).map((r) => r.id);
      const expected = [...DATED_PAIRS]
        .sort((a, b) => datedExpect(b.age, b.score) - datedExpect(a.age, a.score))
        .map((x) => x.id);
      assert.deepEqual(datedOut, expected);
      assert.deepEqual(expected, ['d-new-low', 'd-old-high']);
    })],
  ],

  V2: [
    ['the scored-UNDATED subsequence comes out in input-SCORE order', (decay) => withFixedNow(() => {
      const shuffled = [
        undatedItem('u-mid', 0.5), undatedItem('u-low', 0.2),
        undatedItem('u-high', 0.9), datedItem('d', 15, 0.6),
      ];
      const undatedOut = decay(shuffled, H)
        .filter((r) => !r.metadata?.valid_from && typeof r.score === 'number')
        .map((r) => r.id);
      assert.deepEqual(undatedOut, ['u-high', 'u-mid', 'u-low']);
    })],
    // Filed under V2 rather than V1: it asserts BOTH cohorts' internal orders, and V1
    // is named in RC3's mustFlip, where the flip must be derivable from the dated
    // subsequence alone. V1's remaining sub-case does exactly that, via the fixture's
    // decay-induced inversion — which is the property the control table depends on.
    ['only the interleaving between cohorts moves', (decay) => withFixedNow(() => {
      const out = decay(mixedSet(), H).map((r) => r.id);
      assert.ok(out.indexOf('d-new-low') < out.indexOf('d-old-high'), 'dated order changed');
      assert.ok(out.indexOf('u-high') < out.indexOf('u-low'), 'undated order changed');
    })],
  ],

  V3: [
    ['200 seeded iterations satisfy the four exact identities', (decay) => {
      // EXACT IDENTITIES, deliberately not `output <= input`: that weaker formulation is
      // FALSE on this very domain, twice over — a future date gives a factor above 1 (the
      // deliberately-unfixed missing upper clamp), and any negative score times a factor
      // in (0,1) increases.
      const rnd = xorshift32(V3_SEED);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const seen = { items: 0, dated: 0, undated: 0, future: 0, negative: 0, scoreless: 0, maxN: 0 };

      withFixedNow(() => {
        for (let iter = 0; iter < 200; iter++) {
          const n = Math.floor(rnd() * 21);
          const undatedFraction = rnd();
          seen.maxN = Math.max(seen.maxN, n);
          const input = [];
          const meta = new Map();

          for (let i = 0; i < n; i++) {
            const id = `i${iter}-${i}`;
            const score = pick(V3_SCORES);
            seen.items++;
            if (score === undefined) seen.scoreless++;
            if (typeof score === 'number' && score < 0) seen.negative++;
            if (rnd() < undatedFraction) {
              seen.undated++;
              input.push(undatedItem(id, score));
              meta.set(id, { dated: false, score });
            } else {
              const age = Math.floor(rnd() * 801) - 400;   // future INCLUDED
              seen.dated++;
              if (age < 0) seen.future++;
              input.push(datedItem(id, age, score));
              meta.set(id, { dated: true, score, age });
            }
          }

          const out = decay(input, H);
          assert.equal(out.length, input.length, `iter ${iter}: length changed`);

          for (const r of out) {
            const m = meta.get(r.id);
            if (m.dated) {
              assert.equal(r.score, (m.score || 1) * Math.exp(-m.age / H), `iter ${iter}: dated ${r.id}`);
            } else if (typeof m.score === 'number') {
              assert.equal(r.score, m.score * Math.exp(-1), `iter ${iter}: undated ${r.id}`);
            } else {
              assert.equal(r.score, undefined, `iter ${iter}: score-less undated ${r.id}`);
            }
          }

          for (let i = 1; i < out.length; i++) {
            assert.ok((out[i - 1].score || 0) >= (out[i].score || 0), `iter ${iter}: not sorted at ${i}`);
          }
        }
      });

      // Domain counters from THIS loop, not a replica: if the generator ever narrows, V3
      // would keep passing while quietly testing less.
      assert.ok(seen.items > 500, `too few items generated (${seen.items})`);
      assert.equal(seen.maxN, 20, 'the 0..20 item range must be exercised at its top');
      assert.ok(seen.dated > 100 && seen.undated > 100, `cohorts unbalanced: ${seen.dated}/${seen.undated}`);
      assert.ok(seen.future > 50, `too few FUTURE-dated items (${seen.future}) — the missing-clamp path`);
      assert.ok(seen.negative > 50, `too few NEGATIVE scores (${seen.negative}) — the other falsifier`);
      assert.ok(seen.scoreless > 50, `too few score-less items (${seen.scoreless}) — the mint guard`);
    }],
  ],
};

/** xorshift32 with a LITERAL seed — node:test has no seeded RNG and V3 must be pinned. */
export function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

export const V3_SEED = 0x5eed1234;
export const V3_SCORES = [undefined, 0, 0.5, 1.0, -0.4];

/**
 * Run every sub-case of `id` against `decay`/`mod`.
 * @returns {{passed: boolean, error?: Error, label?: string}}
 */
export function runCase(id, decay, mod) {
  for (const [label, run] of CASES[id]) {
    try { run(decay, mod); } catch (error) { return { passed: false, error, label }; }
  }
  return { passed: true };
}
