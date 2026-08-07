// server/test/ranking-undated-policy.test.mjs — the undated-point decay policy.
//
// An undated result used to keep its score untouched under decay. That read as "neutral,
// never penalised", and it was — until every DATED point started being multiplied by
// exp(-age/H) < 1. At that moment a factor of 1.0 stopped being the middle of the range
// and became the TOP of it: undated points were strictly better than every dated one.
// The policy imputes a flat 0.25 e-foldings instead.
//
// ┌─ READ THIS BEFORE "TIDYING" THE ASSERTIONS ────────────────────────────────────────┐
// │ Every assertion writes the LITERAL `Math.exp(-0.25)`, never the imported           │
// │ UNDATED_FACTOR. Replacing the literals with the import looks like an obvious DRY   │
// │ cleanup and is exactly what house convention would normally encourage — but it     │
// │ would make both sides of every identity move together under a retune, so the       │
// │ assertions would hold for ANY constant and stop testing anything at all. It would  │
// │ also silently void red control RC1, and make the createdAt guards in               │
// │ ranking.test.mjs tautological. Nothing else in the repo would catch it. U10 is the │
// │ ONE exception: its whole job is to compare the export against the literal.         │
// └────────────────────────────────────────────────────────────────────────────────────┘
//
// The case bodies live in ./helpers/undated-policy-cases.mjs because test/red-controls/
// run.mjs runs the SAME table against deliberately-broken copies of ranking.mjs to prove
// each case can actually fail. Two hand-maintained copies would drift, and a drifted red
// control certifies nothing about the tests that really run.
//
// The oracle is ANALYTIC — `(score || 1) * Math.exp(-age/H)` with a pinned Date.now —
// never a vendored copy of the pre-change function, which would rot silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as ranking from '../lib/ranking.mjs';
import { applyTemporalDecay } from '../lib/ranking.mjs';
import {
  H, withFixedNow, datedItem, datedExpect, mixedSet,
} from './helpers/undated-policy-fixtures.mjs';
import { CASES } from './helpers/undated-policy-cases.mjs';

// --- the shared case table (U1-U10, V1-V3) ---------------------------------

for (const [id, subCases] of Object.entries(CASES)) {
  for (const [label, run] of subCases) {
    test(`${id}: ${label}`, () => run(applyTemporalDecay, ranking));
  }
}

// --- file-local: properties of the FIXTURE rather than of the policy -------

test('the fixture really does invert the dated cohort under decay (guards the guards)', () => {
  // Derived FROM mixedSet(), never from retyped literals. An earlier version asserted
  // `0.9 > 0.3` and hand-typed the ages — constant-true, and it would have stayed green
  // after a fixture edit that removed the inversion entirely, silently defanging every
  // order-based assertion that rests on this property (V1 above, and RC3's ability to
  // flip it).
  withFixedNow(() => {
    const dated = mixedSet().filter((r) => r.metadata?.valid_from);
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
