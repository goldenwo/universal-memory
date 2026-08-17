// server/test/helpers/clamp-policy-cases.mjs — the #238 upper-clamp case table.
//
// Third policy table in test/red-controls/run.mjs's TABLES registry (the seat its
// module header reserved for exactly this fix). Same contract as its two siblings
// (undated-policy-cases.mjs / window-policy-cases.mjs): the SAME table is run by
// ranking-undated-policy.test.mjs in the real suite AND by red-controls/run.mjs
// against deliberately-broken copies of ranking.mjs, so a control can never drift
// from the suite it certifies.
//
// The policy under pin: applyTemporalDecay's dated factor is
// `Math.min(1, Math.exp(-ageDays / halfLifeDays))` — a future valid_from (negative
// age) ranks at COSINE PARITY (factor exactly 1), never inflated above it (#238;
// pre-fix a 2099 date literally overflowed exp() to score Infinity).
//
// Flip matrix (declared in run.mjs, certified by the union gate):
//   RCC1 (clamp removed)            flips C1, C2; passes C3 (exp(0)=1 either way).
//   RC3  (dated factor → UNDATED_FACTOR) flips C1, C3; passes C2 (equal factors
//        still tie).

import assert from 'node:assert/strict';
import { H, withFixedNow, datedItem } from './undated-policy-fixtures.mjs';

export const CASES = {
  C1: [
    ['a FUTURE-dated item ranks at cosine parity — factor exactly 1, never inflated', (decay) => {
      withFixedNow(() => {
        const [out] = decay([datedItem('future', -10, 0.5)], H);
        // Exact identity, not <=: 0.5 * 1. Pre-#238 this was 0.5 * exp(10/30) ≈ 0.6978.
        assert.equal(out.score, 0.5);
      });
    }],
  ],

  C2: [
    ['two future-dated items at equal cosine tie exactly, regardless of offset', (decay) => {
      // DIFFERENT future offsets are the teeth: unclamped code gives −1d and −10d
      // different factors (1.034 vs 1.395) and breaks the tie; the clamp gives both
      // factor exactly 1. Equal cosine (0.5) isolates the tie claim.
      withFixedNow(() => {
        const out = decay([datedItem('f-near', -1, 0.5), datedItem('f-far', -10, 0.5)], H);
        assert.equal(out[0].score, 0.5);
        assert.equal(out[1].score, 0.5);
        // Stable sort on an exact tie preserves input order.
        assert.deepEqual(out.map((r) => r.id), ['f-near', 'f-far']);
      });
    }],
  ],

  C3: [
    ['age exactly 0 — factor exactly 1 (exp(0) clamps to itself; boundary is fix-neutral)', (decay) => {
      // Fix-neutral by design: unclamped exp(0) is already 1, so this case passes RED
      // and GREEN. Its certification comes from RC3's declared flip (factor →
      // UNDATED_FACTOR ≠ 1 reddens it), not from RCC1 — see the flip matrix above.
      withFixedNow(() => {
        const [out] = decay([datedItem('now', 0, 0.5)], H);
        assert.equal(out.score, 0.5);
      });
    }],
  ],
};

export function runCase(id, decay, mod) {
  for (const [label, run] of CASES[id]) {
    try { run(decay, mod); } catch (error) { return { passed: false, error, label }; }
  }
  return { passed: true };
}
