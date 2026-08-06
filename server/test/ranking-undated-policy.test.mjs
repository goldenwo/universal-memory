// server/test/ranking-undated-policy.test.mjs — the undated-point decay policy.
//
// An undated result used to keep its score untouched under decay. That read as "neutral,
// never penalised", and it was — until every DATED point started being multiplied by
// exp(-age/H) < 1. At that moment a factor of 1.0 stopped being the middle of the range
// and became the TOP of it: undated points were strictly better than every dated one.
// The policy imputes a flat one e-folding instead.
//
// ┌─ READ THIS BEFORE "TIDYING" THE ASSERTIONS ────────────────────────────────────────┐
// │ Every assertion below writes the LITERAL `Math.exp(-1)`, never the imported        │
// │ UNDATED_FACTOR. Replacing the literals with the import looks like an obvious DRY   │
// │ cleanup and is exactly what house convention would normally encourage — but it     │
// │ would make both sides of every identity move together under a retune, so the       │
// │ assertions would hold for ANY constant and stop testing anything at all. It would  │
// │ also silently void the red control that mutates UNDATED_FACTOR, and make the       │
// │ createdAt guards in ranking.test.mjs tautological. Nothing else in the repo would  │
// │ catch it. U10 is the ONE exception: its whole job is to compare the export to the  │
// │ literal. A red control mutating UNDATED_FACTOR is planned and depends on this.     │
// └────────────────────────────────────────────────────────────────────────────────────┘
//
// The oracle is ANALYTIC — `(score || 1) * Math.exp(-age/H)` with a pinned Date.now —
// never a vendored copy of the pre-change function, which would rot silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTemporalDecay, UNDATED_FACTOR, UNDATED_EFOLDINGS } from '../lib/ranking.mjs';
import {
  H, DAY, FIXED_NOW, withFixedNow, datedItem, undatedItem, datedExpect, mixedSet, DATED_PAIRS,
} from './helpers/undated-policy-fixtures.mjs';

test('the fixture really does invert the dated cohort under decay (guards the guards)', () => {
  // Derived FROM mixedSet(), never from retyped literals. An earlier version asserted
  // `0.9 > 0.3` and hand-typed the ages — which is constant-true and would have stayed
  // green after a fixture edit that removed the inversion entirely, silently defanging
  // every order-based assertion that rests on this property.
  withFixedNow(() => {
    const set = mixedSet();
    const dated = set.filter((r) => r.metadata?.valid_from);
    assert.ok(dated.length >= 2, 'the fixture must carry >=2 dated points');

    const ageOf = (r) => (Date.now() - Date.parse(r.metadata.valid_from)) / 86400000;
    const [a, b] = dated;
    const cosineOrder = a.score - b.score;
    const decayedOrder = datedExpect(ageOf(a), a.score) - datedExpect(ageOf(b), b.score);

    assert.notEqual(cosineOrder, 0, 'the two dated points must differ in cosine');
    assert.ok(
      Math.sign(cosineOrder) !== Math.sign(decayedOrder),
      'decay must INVERT the dated cohort\'s order, or order-only assertions are insensitive',
    );
  });
});

// --- U10: the constant itself ----------------------------------------------

test('U10: UNDATED_FACTOR is exactly Math.exp(-1)', () => {
  // The ONE place the import is compared to the literal — this is what pins the magnitude
  // so a silent retune cannot pass unnoticed.
  assert.equal(UNDATED_FACTOR, Math.exp(-1));
  assert.equal(UNDATED_EFOLDINGS, 1);
});

test('U10: UNDATED_FACTOR is a compile-time constant strictly inside (0,1)', () => {
  assert.ok(UNDATED_FACTOR > 0 && UNDATED_FACTOR < 1);
  assert.equal(typeof UNDATED_FACTOR, 'number');
  assert.ok(Number.isFinite(UNDATED_FACTOR));
});

// --- U1: the policy on a mixed set -----------------------------------------

test('U1: each scored undated item is exactly input x exp(-1) in a mixed set', () => {
  withFixedNow(() => {
    const out = applyTemporalDecay(mixedSet(), H);
    const byId = new Map(out.map((r) => [r.id, r]));
    assert.equal(byId.get('u-high').score, 0.8 * Math.exp(-1));
    assert.equal(byId.get('u-low').score, 0.2 * Math.exp(-1));
  });
});

test('U1: the dated items in that same set are untouched by the policy', () => {
  // The dated branch must stay byte-identical; only the interleaving between cohorts moves.
  withFixedNow(() => {
    const out = applyTemporalDecay(mixedSet(), H);
    const byId = new Map(out.map((r) => [r.id, r]));
    assert.equal(byId.get('d-old-high').score, datedExpect(120, 0.9));
    assert.equal(byId.get('d-new-low').score, datedExpect(1, 0.3));
  });
});

test('U1: an undated item is NOT graded on its createdAt', () => {
  // The fixture's createdAt is 120 days old; grading on it would give exp(-4), not exp(-1).
  withFixedNow(() => {
    const [out] = applyTemporalDecay([undatedItem('u', 1.0, 120)], H);
    assert.equal(out.score, 1.0 * Math.exp(-1));
    assert.notEqual(out.score, 1.0 * Math.exp(-120 / H));
  });
});

// --- the score guard: the reason the undated branch is not a one-liner ------
//
// These cover `typeof r.score !== 'number'`. Without them the guard can be DELETED and
// replaced with the forbidden `(r.score || 1) * UNDATED_FACTOR` while every other test
// stays green — every other fixture carries a positive numeric score, for which the
// guarded and unguarded expressions are numerically identical.

test('U5: an undated item with NO score key is left untouched — a score is never MINTED', () => {
  withFixedNow(() => {
    const [out] = applyTemporalDecay([undatedItem('u-nascore', undefined)], H);
    assert.ok(!('score' in out), 'a score key must not be created');
    assert.equal(out.score, undefined);
    assert.notEqual(out.score, Math.exp(-1), 'minting 1 * factor would lift it from last to first');
  });
});

test('U5: a score-less undated item still sorts LAST, not first', () => {
  // This is the ordering consequence: `(r.score || 1) * f` = 0.3679 would beat a dated
  // item at 0.29, so a scoreless item would jump the whole result set.
  withFixedNow(() => {
    const out = applyTemporalDecay([undatedItem('u-nascore', undefined), ...mixedSet()], H);
    assert.equal(out[out.length - 1].id, 'u-nascore');
  });
});

test('U6: an undated item with score 0 stays exactly 0 — not 1 x exp(-1)', () => {
  withFixedNow(() => {
    const [out] = applyTemporalDecay([undatedItem('u-zero', 0)], H);
    assert.equal(out.score, 0);
    assert.notEqual(out.score, Math.exp(-1), '`score || 1` would turn a genuine 0 into the factor');
  });
});

test('U6: a 0-scoring undated item never outranks a positive-scoring one', () => {
  // The inversion `score || 1` would cause: 0.0 -> 0.3679 beats a genuine 0.1 -> 0.0368.
  withFixedNow(() => {
    const out = applyTemporalDecay([undatedItem('u-zero', 0), undatedItem('u-small', 0.1)], H);
    assert.deepEqual(out.map((r) => r.id), ['u-small', 'u-zero']);
  });
});

test('U6: a non-numeric score is left untouched rather than coerced', () => {
  // This loop is the sole discriminator between the shipped `typeof !== 'number'` guard
  // and a narrower `=== undefined` one: null and '0.9' are non-numeric but defined.
  // `undefined` here is the key-PRESENT-but-undefined case, distinct from U5's absent key.
  withFixedNow(() => {
    for (const bad of [null, '0.9', undefined]) {
      const item = { id: 'u', createdAt: '2026-04-10T00:00:00Z', score: bad };
      const [out] = applyTemporalDecay([item], H);
      assert.equal(out.score, bad, `score ${JSON.stringify(bad)} must pass through untouched`);
      assert.notEqual(out.score, Math.exp(-1), 'a non-numeric score must not be coerced to the factor');
    }
  });
});

test('U9: the input array and its items are not mutated', () => {
  withFixedNow(() => {
    const input = mixedSet();
    const snapshot = JSON.stringify(input);
    const out = applyTemporalDecay(input, H);
    assert.equal(JSON.stringify(input), snapshot, 'input was mutated');
    assert.notEqual(out, input, 'must return a NEW array');
    for (const item of out) assert.ok(!input.includes(item), 'items must be copies, not the originals');
  });
});

// --- U2 / U3 / U4: the cohorts in isolation, and at the small-sample edge ---

test('U2: an ALL-UNDATED set keeps its ordering, and every scored item is input x exp(-1)', () => {
  // A uniform positive multiplier cannot reorder anything — which is precisely why an
  // all-undated corpus would make this policy unmeasurable (the delta would be exactly 0).
  withFixedNow(() => {
    const input = [undatedItem('a', 0.9), undatedItem('b', 0.5), undatedItem('c', 0.1)];
    const out = applyTemporalDecay(input, H);
    assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
    assert.equal(out[0].score, 0.9 * Math.exp(-1));
    assert.equal(out[1].score, 0.5 * Math.exp(-1));
    assert.equal(out[2].score, 0.1 * Math.exp(-1));
  });
});

test('U3: an ALL-DATED set is untouched by the policy — the dated branch is byte-identical', () => {
  withFixedNow(() => {
    const spec = [
      { id: 'old-high', age: 120, score: 0.9 },
      { id: 'new-low', age: 1, score: 0.3 },
      { id: 'mid', age: 30, score: 0.6 },
    ];
    const out = applyTemporalDecay(spec.map((s) => datedItem(s.id, s.age, s.score)), H);
    for (const s of spec) {
      assert.equal(out.find((r) => r.id === s.id).score, datedExpect(s.age, s.score));
    }
    // The decay-induced order, which is what makes this fixture discriminating.
    assert.deepEqual(out.map((r) => r.id), ['new-low', 'mid', 'old-high']);
  });
});

test('U4: the undated factor is exp(-1) even with exactly ONE dated point in the set', () => {
  // Set-independence at the smallest sample. A median-of-result-set estimator would be
  // degenerate here — at n=1 every item takes the same multiplier and decay becomes an
  // ordering no-op — so this pins that no such estimator crept in.
  withFixedNow(() => {
    const out = applyTemporalDecay([datedItem('d', 45, 0.7), undatedItem('u', 0.8)], H);
    assert.equal(out.find((r) => r.id === 'u').score, 0.8 * Math.exp(-1));
    assert.equal(out.find((r) => r.id === 'd').score, datedExpect(45, 0.7));
  });
});

test('U7: a score-less DATED item is still MINTED 1 x factor — the unchanged dated branch', () => {
  // The never-mint guard is scoped to the UNDATED branch ONLY. The dated branch keeps its
  // `(r.score || 1)`, so a well-meaning "make both branches consistent" edit fails here.
  withFixedNow(() => {
    const item = { id: 'd-noscore', metadata: { valid_from: new Date(FIXED_NOW - 10 * DAY).toISOString() } };
    const [out] = applyTemporalDecay([item], H);
    assert.equal(out.score, 1 * Math.exp(-10 / H));
  });
});

test('U8: a common item scores identically in a subset and in a superset containing it', () => {
  // Set-independence stated as an experiment: an item's factor must not depend on what
  // else happened to be returned alongside it.
  withFixedNow(() => {
    const common = () => [datedItem('d1', 20, 0.7), undatedItem('u1', 0.6)];
    const subset = applyTemporalDecay(common(), H);
    const superset = applyTemporalDecay(
      [...common(), datedItem('d2', 400, 0.95), undatedItem('u2', 0.05), undatedItem('u3', 0.99)],
      H,
    );
    for (const id of ['d1', 'u1']) {
      assert.equal(
        superset.find((r) => r.id === id).score,
        subset.find((r) => r.id === id).score,
        `${id} moved when unrelated items joined the set`,
      );
    }
  });
});

// --- V1 / V2: each cohort's internal order is preserved ---------------------

test('V1: the DATED subsequence comes out in analytic decayed order', () => {
  withFixedNow(() => {
    const out = applyTemporalDecay(mixedSet(), H);
    const datedOut = out.filter((r) => r.metadata?.valid_from).map((r) => r.id);
    // Derived from DATED_PAIRS, not retyped: that export exists precisely so a fixture
    // edit cannot leave this expectation stale while the test stays green.
    const expected = [...DATED_PAIRS]
      .sort((a, b) => datedExpect(b.age, b.score) - datedExpect(a.age, a.score))
      .map((x) => x.id);
    assert.deepEqual(datedOut, expected);
    // The fixture inverts under decay, so this is genuinely sensitive rather than
    // incidentally true of the input order.
    assert.deepEqual(expected, ['d-new-low', 'd-old-high']);
  });
});

test('V2: the scored-UNDATED subsequence comes out in input-SCORE order, not input-ARRAY order', () => {
  // One positive constant preserves sign and order, so the undated cohort's internal
  // ranking must be exactly its cosine ranking. Fed in DELIBERATELY SHUFFLED array order
  // so the expectation is not merely "unchanged from how they arrived" — otherwise any
  // order-preserving implementation satisfies it and the test discriminates nothing.
  withFixedNow(() => {
    const shuffled = [
      undatedItem('u-mid', 0.5),
      undatedItem('u-low', 0.2),
      undatedItem('u-high', 0.9),
      datedItem('d', 15, 0.6),
    ];
    const out = applyTemporalDecay(shuffled, H);
    const undatedOut = out
      .filter((r) => !r.metadata?.valid_from && typeof r.score === 'number')
      .map((r) => r.id);
    assert.deepEqual(undatedOut, ['u-high', 'u-mid', 'u-low']);
  });
});

test('V1+V2 together: ONLY the interleaving between the cohorts moves', () => {
  withFixedNow(() => {
    const out = applyTemporalDecay(mixedSet(), H).map((r) => r.id);
    assert.ok(out.indexOf('d-new-low') < out.indexOf('d-old-high'), 'dated order changed');
    assert.ok(out.indexOf('u-high') < out.indexOf('u-low'), 'undated order changed');
  });
});

// --- V3: property test over the full domain, as EXACT identities -----------

/** xorshift32 with a LITERAL seed — node:test has no seeded RNG and V3 must be pinned. */
function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

const V3_SEED = 0x5eed1234;
const V3_SCORES = [undefined, 0, 0.5, 1.0, -0.4];

test('V3: 200 seeded iterations satisfy the four exact identities', () => {
  // EXACT IDENTITIES, deliberately not `output <= input`: that weaker formulation is FALSE
  // on this very domain, twice over — a future date gives a factor above 1 (the
  // deliberately-unfixed missing upper clamp), and any negative score times a factor in
  // (0,1) increases. The identities are strictly stronger and stay honest about both.
  const rnd = xorshift32(V3_SEED);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  // Domain counters, incremented from THIS loop — not from a replica. An earlier version
  // asserted the domain in a separate test that re-implemented the generator, so narrowing
  // the real age range here left the replica (and the suite) green while V3 silently
  // stopped sweeping future dates. Observe the generator you actually run.
  const seen = { items: 0, dated: 0, undated: 0, future: 0, negative: 0, scoreless: 0, maxN: 0 };

  withFixedNow(() => {
    for (let iter = 0; iter < 200; iter++) {
      const n = Math.floor(rnd() * 21);          // 0..20 items
      const undatedFraction = rnd();             // drawn per iteration in [0,1]
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
          const age = Math.floor(rnd() * 801) - 400;   // -400..400 days, future INCLUDED
          seen.dated++;
          if (age < 0) seen.future++;
          input.push(datedItem(id, age, score));
          meta.set(id, { dated: true, score, age });
        }
      }

      const out = applyTemporalDecay(input, H);
      assert.equal(out.length, input.length, `iter ${iter}: length changed`);

      for (const r of out) {
        const m = meta.get(r.id);
        if (m.dated) {
          // Covers both "numeric score" and "no score": `(score || 1)` is the shipped
          // dated expression, and a 0 falls through it exactly as 1 does, by design.
          assert.equal(r.score, (m.score || 1) * Math.exp(-m.age / H), `iter ${iter}: dated ${r.id}`);
        } else if (typeof m.score === 'number') {
          assert.equal(r.score, m.score * Math.exp(-1), `iter ${iter}: undated ${r.id}`);
        } else {
          // `=== undefined` rather than key-absence, deliberately. `undatedItem` OMITS the
          // key when score is undefined, so key-absence would happen to pass here — but
          // `datedItem` always writes it, and any generator that produced a present-but-
          // undefined score would leave the key there after the spread. `=== undefined` is
          // true either way, and it is exactly what the sort comparator reads.
          assert.equal(r.score, undefined, `iter ${iter}: score-less undated ${r.id}`);
        }
      }

      for (let i = 1; i < out.length; i++) {
        assert.ok((out[i - 1].score || 0) >= (out[i].score || 0), `iter ${iter}: not sorted at ${i}`);
      }
    }
  });

  // The identities above are only as strong as the domain that produced them. If the
  // generator ever narrows, V3 would keep passing while quietly testing less — in
  // particular it would stop covering the two cases that falsify `output <= input`, which
  // is the whole reason this test is written as exact identities.
  assert.ok(seen.items > 500, `too few items generated (${seen.items})`);
  assert.equal(seen.maxN, 20, 'the 0..20 item range must be exercised at its top');
  assert.ok(seen.dated > 100 && seen.undated > 100, `cohorts unbalanced: ${seen.dated} dated / ${seen.undated} undated`);
  assert.ok(seen.future > 50, `too few FUTURE-dated items (${seen.future}) — the missing-clamp path`);
  assert.ok(seen.negative > 50, `too few NEGATIVE scores (${seen.negative}) — the other falsifier`);
  assert.ok(seen.scoreless > 50, `too few score-less items (${seen.scoreless}) — the mint guard`);
});

test('V3 corollary: a FUTURE-dated item is inflated above 1 — the unfixed clamp, pinned', () => {
  // Deliberately NOT fixed by this change: an upper clamp would alter the DATED cohort's
  // ordering and break the "dated order unchanged" invariant. Pinned here so the separate
  // issue that fixes it has a ready witness, and so it cannot be "fixed" here unnoticed.
  withFixedNow(() => {
    const [out] = applyTemporalDecay([datedItem('future', -10, 0.5)], H);
    assert.equal(out.score, 0.5 * Math.exp(10 / H));
    assert.ok(out.score > 0.5, 'a future date currently INFLATES the score');
  });
});
