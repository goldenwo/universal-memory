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
  H, withFixedNow, undatedItem, datedExpect, mixedSet,
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
