// server/test/helpers/relative-imputation-cases.mjs — the relative undated-imputation
// policy's TABLE-RESIDENT case table (#297 spec §6.2), parameterised by the module under test.
//
// Fourth entry in test/red-controls/run.mjs's TABLES registry (RCR1-RCR6, spec §6.3). Same
// contract as its three siblings: the SAME table is run by ranking-relative.test.mjs in the
// real suite AND by red-controls/run.mjs against deliberately-broken copies of ranking.mjs,
// so a control can never drift from the suite it certifies.
//
// Each case is `(fn, mod) => void` and signals failure by THROWING (node:assert). `fn` is
// `mod.applyTemporalDecay` (the registry's fnName for this table); cases that pin the pure
// statistic reach `mod.datedAgeQuantile` / `mod.undatedFactorFor` through `mod`, exactly as
// the clamp table picks its function per case (spec §6.2, the W10 precedent).
//
// MEMBERSHIP RULE (spec §6.2): only cases a `data:` mutant of lib/ranking.mjs can reach live
// here — R1, R2, R3-pure, R4, R5, R9, R12, R13. R3-cache / R6 / R7 / R8 / R8b / R10 / R11
// exercise the cache module, doSearch, buildStats or the control page and are plain
// *.test.mjs files OUTSIDE the registry by construction.
//
// FIXTURE-COMPOSITION RULE (spec §6.2, round 8): every case's item set that reaches
// applyTemporalDecay includes at least one DATED, numerically-scored item that carries no
// `createdAt`, so the existing controls RC2 (score guard), RC4 (createdAt grading) and RC5
// (any-dated short-circuit) provably cannot reach this table. An all-undated set would leak
// RC5; a score-less undated item would leak RC2.
//
// LITERALS: every expected number is hand-computed (`Math.exp(-6/30)`, `Math.exp(-0.25)`,
// the type-7 median of a listed cohort) — never the export — except R13, the quantile
// tripwire, which is the one place `mod.UNDATED_QUANTILE` is compared to the literal 0.5
// (the U10 pattern; spec §4.6 / D27 enumerates the sites that move with it).

import assert from 'node:assert/strict';
import { filterSystemDocs } from '../../lib/system-docs.mjs';
import { H, DAY, FIXED_NOW, withFixedNow, datedItem, undatedItem } from './undated-policy-fixtures.mjs';
import { WINDOW, IN_MS } from './window-policy-fixtures.mjs';

const MIN = 60 * 1000;
const SKEW_MS = 5 * MIN; // CLOCK_SKEW_TOLERANCE_MS — written as a literal on purpose (the tripwire discipline)

/** A dated item without any `createdAt` — the fixture rule's required member. */
const dated = (id, ageDays, score = 0.5) => ({
  id, score, metadata: { valid_from: new Date(FIXED_NOW - ageDays * DAY).toISOString() },
});
/** An undated item that carries NO createdAt (the fixture rule: RC4 must stay unreachable). */
const undated = (id, score = 0.5) => ({ id, score, metadata: {} });
/** A dated item stamped `msAhead` milliseconds in the FUTURE relative to FIXED_NOW. */
const future = (id, msAhead, score = 0.5) => ({
  id, score, metadata: { valid_from: new Date(FIXED_NOW + msAhead).toISOString() },
});

const byId = (out) => new Map(out.map((r) => [r.id, r]));

export const CASES = {
  R1: [
    ['odd n: the type-7 median of a 5-point cohort, the undated member skipped, factor at H=30', (_decay, mod) => withFixedNow(() => {
      // Ages 2, 4, 6, 9, 30 → type-7 median = a[2] = 6 (h = (5-1)*0.5 = 2, no interpolation).
      // The system doc is excluded BY THE CALLER (spec P4: the cache applies
      // filterSystemDocs + isRecallable before the statistic); it carries a huge age so
      // forgetting to filter would move the median.
      const items = filterSystemDocs([
        dated('d2', 2), dated('d4', 4), dated('d6', 6), dated('d9', 9), dated('d30', 30),
        undated('u'),
        { id: 'sys', score: 0.9, metadata: { id: '_um_embedding_stamp', valid_from: new Date(FIXED_NOW - 400 * DAY).toISOString() } },
      ]);
      // minCohort: 1 is DELIBERATE (spec §6.2 R1): R3-pure is the only case exercising the default.
      const q = mod.datedAgeQuantile(items, { minCohort: 1, now: FIXED_NOW });
      assert.equal(q.n, 5);
      assert.equal(q.futureExcluded, 0);
      assert.equal(q.belowMinCohort, false);
      assert.equal(q.ageDays, 6);
      assert.equal(mod.undatedFactorFor(q.ageDays, 30), Math.exp(-6 / 30));
    })],
    ['even n: type-7 interpolates halfway between the two middle ages', (_decay, mod) => withFixedNow(() => {
      // Ages 1, 3, 8, 20 → h = (4-1)*0.5 = 1.5 → a[1] + 0.5*(a[2]-a[1]) = 3 + 2.5 = 5.5.
      const q = mod.datedAgeQuantile([dated('a', 1), dated('b', 3), dated('c', 8), dated('d', 20), undated('u')], { minCohort: 1, now: FIXED_NOW });
      assert.equal(q.n, 4);
      assert.equal(q.ageDays, 5.5);
      assert.equal(mod.undatedFactorFor(5.5, 30), Math.exp(-5.5 / 30));
    })],
  ],

  R2: [
    ['beyond-skew future points are EXCLUDED from n and counted in futureExcluded', (_decay, mod) => withFixedNow(() => {
      const items = [
        dated('d1', 1), dated('d3', 3), dated('d5', 5),
        future('f10', 10 * MIN), future('f1d', DAY), future('f1y', 365 * DAY),
      ];
      const q = mod.datedAgeQuantile(items, { minCohort: 1, now: FIXED_NOW });
      assert.equal(q.n, 3);
      assert.equal(q.futureExcluded, 3);
      assert.equal(q.ageDays, 3); // median of 1, 3, 5 — the future points did not drag it toward 0
    })],
    ['a within-skew point counts, at age exactly 0 (the clamp only absorbs the skew window)', (_decay, mod) => withFixedNow(() => {
      // Three points 2 minutes "in the future" (< CLOCK_SKEW_TOLERANCE_MS = 5 min): all in C, all age 0.
      const q = mod.datedAgeQuantile([future('a', 2 * MIN), future('b', 2 * MIN), future('c', 2 * MIN)], { minCohort: 1, now: FIXED_NOW });
      assert.equal(q.n, 3);
      assert.equal(q.futureExcluded, 0);
      assert.equal(q.ageDays, 0);
    })],
    ['the skew boundary: exactly now + skew is INCLUDED (age 0); one millisecond beyond is EXCLUDED', (_decay, mod) => withFixedNow(() => {
      // Spec §4.1: "at or before now + CLOCK_SKEW_TOLERANCE_MS". Pinned at the edge so a one-
      // character drift of the comparison (`>` → `>=`) reddens (code review 2026-09-04).
      const edge = mod.datedAgeQuantile([future('edge', SKEW_MS), dated('d1', 1)], { minCohort: 1, now: FIXED_NOW });
      assert.equal(edge.n, 2);
      assert.equal(edge.futureExcluded, 0);
      assert.equal(edge.ageDays, 0.5); // ages {0, 1} → type-7 median 0.5
      const beyond = mod.datedAgeQuantile([future('beyond', SKEW_MS + 1), dated('d1', 1)], { minCohort: 1, now: FIXED_NOW });
      assert.equal(beyond.n, 1);
      assert.equal(beyond.futureExcluded, 1);
      assert.equal(beyond.ageDays, 1);
    })],
    ['an all-future cohort → n = 0 → ageDays null → the FALLBACK constant, never factor 1.0', (_decay, mod) => withFixedNow(() => {
      const q = mod.datedAgeQuantile([future('a', DAY), future('b', 2 * DAY), undated('u')], { minCohort: 1, now: FIXED_NOW });
      assert.equal(q.n, 0);
      assert.equal(q.futureExcluded, 2);
      assert.equal(q.ageDays, null);
      assert.equal(mod.undatedFactorFor(q.ageDays, 30), Math.exp(-0.25));
    })],
  ],

  'R3-pure': [
    ['n = 19 → ageDays null with belowMinCohort; n = 20 → the median (the DEFAULT minCohort)', (_decay, mod) => withFixedNow(() => {
      const cohort = (n) => Array.from({ length: n }, (_, i) => dated(`d${i + 1}`, i + 1)); // ages 1..n
      const below = mod.datedAgeQuantile(cohort(19), { now: FIXED_NOW });
      assert.equal(below.n, 19);
      assert.equal(below.belowMinCohort, true);
      assert.equal(below.ageDays, null);
      const at = mod.datedAgeQuantile(cohort(20), { now: FIXED_NOW });
      assert.equal(at.n, 20);
      assert.equal(at.belowMinCohort, false);
      // Ages 1..20 → h = 19*0.5 = 9.5 → a[9] + 0.5*(a[10]-a[9]) = 10 + 0.5 = 10.5. q-SENSITIVE
      // literal (spec §4.6 lists the move-together sites; this one fails loud on a q change).
      assert.equal(at.ageDays, 10.5);
    })],
  ],

  R4: [
    ['every scored undated item is exactly input × the passed factor; the dated branch is byte-identical to the no-opts call', (decay) => withFixedNow(() => {
      const set = () => [dated('d-new', 1, 0.3), dated('d-old', 120, 0.9), undated('u-high', 0.8), undated('u-low', 0.2)];
      const withOpt = byId(decay(set(), H, { undatedFactor: Math.exp(-6 / 30) }));
      const noOpts = byId(decay(set(), H));
      assert.equal(withOpt.get('u-high').score, 0.8 * Math.exp(-6 / 30));
      assert.equal(withOpt.get('u-low').score, 0.2 * Math.exp(-6 / 30));
      assert.equal(withOpt.get('d-new').score, noOpts.get('d-new').score);
      assert.equal(withOpt.get('d-old').score, noOpts.get('d-old').score);
    })],
  ],

  R5: [
    ['neutrality identity (I3): an undated item and a dated item aged exactly A_q end with equal scores at equal input', (decay, mod) => withFixedNow(() => {
      // 21 dated points aged 1..21 → type-7 median = a[10] = 11 (h = 20*0.5 = 10). The dated
      // comparison item is built at the LITERAL 11, never at the function's output, so a
      // statistic that returns the wrong age (RCR1) breaks the identity instead of following it.
      const cohort = Array.from({ length: 21 }, (_, i) => dated(`c${i + 1}`, i + 1));
      const q = mod.datedAgeQuantile(cohort, { now: FIXED_NOW });
      assert.equal(q.n, 21);
      const uf = mod.undatedFactorFor(q.ageDays, H);
      const out = byId(decay([undated('u', 0.5), dated('at-aq', 11, 0.5)], H, { undatedFactor: uf }));
      assert.ok(Math.abs(out.get('u').score - out.get('at-aq').score) < 1e-12,
        `undated ${out.get('u').score} must equal dated-at-A_q ${out.get('at-aq').score}`);
      assert.ok(Math.abs(out.get('u').score - 0.5 * Math.exp(-11 / 30)) < 1e-12);
    })],
  ],

  R9: [
    ['an invalid undatedFactor (0, > 1, NaN, string) falls back to exp(-0.25) — never a minted or inflated score', (decay) => withFixedNow(() => {
      for (const bad of [0, 1.5, NaN, 'x', -0.5, Infinity]) {
        const out = byId(decay([dated('d', 3, 0.7), undated('u', 0.6)], H, { undatedFactor: bad }));
        assert.equal(out.get('u').score, 0.6 * Math.exp(-0.25), `undatedFactor=${String(bad)} must fall back`);
        assert.equal(out.get('d').score, 0.7 * Math.exp(-3 / 30));
      }
    })],
  ],

  R12: [
    ['I3 across H values in one process: the factor is derived from the request\'s H, never cached with one', (decay, mod) => withFixedNow(() => {
      const AQ = 28.7; // the cached, H-INDEPENDENT statistic (spec D12)
      for (const h of [5, 90]) {
        const uf = mod.undatedFactorFor(AQ, h);
        assert.ok(Math.abs(uf - Math.exp(-28.7 / h)) < 1e-15, `H=${h}`);
        const out = byId(decay([undated('u', 0.5), dated('at-aq', AQ, 0.5)], h, { undatedFactor: uf }));
        assert.ok(Math.abs(out.get('u').score - out.get('at-aq').score) < 1e-12, `H=${h}: undated must equal dated-at-A_q`);
      }
    })],
    ['sign guard (D18): a non-finite or ≤ 0 H returns exactly the fallback constant, never an inflation', (_decay, mod) => {
      for (const h of [-30, 0, NaN, -Infinity, 'abc']) {
        assert.equal(mod.undatedFactorFor(28.7, h), Math.exp(-0.25), `H=${String(h)}`);
      }
      assert.equal(mod.undatedFactorFor(null, 30), Math.exp(-0.25));
      assert.equal(mod.undatedFactorFor(undefined, 30), Math.exp(-0.25));
      // A non-finite statistic must never reach the two re-rankers as a NaN their guards would
      // resolve differently (code review 2026-09-04).
      for (const a of [NaN, Infinity, -Infinity]) {
        assert.equal(mod.undatedFactorFor(a, 30), Math.exp(-0.25), `ageDays=${String(a)}`);
      }
      // The upper clamp (#238's parity rule on the derivation): a negative age never inflates.
      assert.equal(mod.undatedFactorFor(-5, 30), 1);
      assert.equal(mod.undatedFactorFor(0, 30), 1);
    }],
    ['I5 at every value the derivation can emit: both re-rankers scale the same undated item identically, incl. the exp underflow floor', (decay, mod) => withFixedNow(() => {
      // exp(-A_q/H) underflows to exactly 0 past A_q/H ≈ 745; a raw 0 would be REJECTED by both
      // arms' range guards, which fall back DIFFERENTLY (decay → the constant, window → 1). The
      // derivation floors at Number.MIN_VALUE so the value stays in (0, 1] (code review 2026-09-04).
      const item = () => ({ id: 'u', score: 0.6, metadata: {} });
      for (const [aq, h] of [[0, 30], [28.7, 30], [28.7, 0.02], [1e6, 30], [28.7, 1e-9]]) {
        const uf = mod.undatedFactorFor(aq, h);
        assert.ok(uf > 0 && uf <= 1, `A_q=${aq} H=${h}: ${uf} must sit in (0, 1]`);
        const viaWindow = mod.applyTemporalWindow([{ id: 'd-in', score: 0.9, metadata: { valid_from: new Date(IN_MS).toISOString() } }, item()], WINDOW, { undatedFactor: uf })
          .find((r) => r.id === 'u').score;
        const viaDecay = decay([dated('d', 3), item()], h, { undatedFactor: uf }).find((r) => r.id === 'u').score;
        assert.equal(viaWindow, viaDecay, `A_q=${aq} H=${h}: window ${viaWindow} vs decay ${viaDecay}`);
      }
      assert.equal(mod.undatedFactorFor(28.7, 0.02), Number.MIN_VALUE, 'the underflow floor is the smallest positive double, never 0');
    })],
  ],

  R13: [
    // The quantile tripwire (spec §4.6 / D27): the ONE place the export is compared to the literal.
    // Sites that move with it: R1/R3-pure/R5 literals, the §6.4 property oracle, .env.example's
    // decay paragraph, the ranking.mjs header. The openapi/GPT prose is q-agnostic on purpose.
    ['UNDATED_QUANTILE is exactly 0.5', (_decay, mod) => {
      assert.equal(mod.UNDATED_QUANTILE, 0.5);
      assert.equal(mod.UNDATED_MIN_COHORT, 20);
    }],
  ],
};

/**
 * Run every sub-case of `id` against `fn`/`mod`.
 * @returns {{passed: boolean, error?: Error, label?: string}}
 */
export function runCase(id, fn, mod) {
  for (const [label, run] of CASES[id]) {
    try { run(fn, mod); } catch (error) { return { passed: false, error, label }; }
  }
  return { passed: true };
}

export { datedItem, undatedItem };
