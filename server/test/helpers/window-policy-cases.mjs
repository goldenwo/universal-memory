// server/test/helpers/window-policy-cases.mjs — the window-undated joint-imputation
// policy's case table, parameterised by the implementation under test.
//
// WHY THIS EXISTS. Same reason as ./undated-policy-cases.mjs (the decay table beside this
// one): the window-scoped red controls (RCW1-RCW5, spec §6.4) must confirm that each
// mutation flips its NAMED set of cases and leaves its must-still-pass set green, and that
// is only meaningful if the controls evaluate the SAME cases the suite asserts — two
// hand-maintained copies would drift, and a drifted control proves nothing about the tests
// that actually run. So the cases live here, and both `temporal-window.test.mjs` and
// `red-controls/run.mjs` (via an open table registry, keyed by table name — spec §6.4) are
// meant to consume them.
//
// Each case is `(applyWindow, mod) => void` and signals failure by THROWING (node:assert).
// `mod` is the ranking module under test, so W8/W11 can read the mutant's own exports.
//
// ┌─ READ THIS BEFORE "TIDYING" THE ASSERTIONS ────────────────────────────────────────┐
// │ Every magnitude assertion writes the LITERAL `Math.exp(-0.25)`, never the imported  │
// │ `UNDATED_FACTOR`. Replacing the literals with the import looks like an obvious DRY  │
// │ cleanup — it is exactly what house convention would normally encourage — but it     │
// │ would make both sides of every identity move together under a retune, so the        │
// │ assertions would hold for ANY constant and stop testing anything at all. It would   │
// │ also silently void the RCW red controls (their whole job is to prove a case CAN     │
// │ fail). Two deliberate exceptions, each pinning a DIFFERENT claim (spec §6):         │
// │   W8  — imports on BOTH sides: the same undated item through the real               │
// │         `applyTemporalWindow(…, {undatedFactor: mod.UNDATED_FACTOR})` and the real   │
// │         `mod.applyTemporalDecay`. This pins JOINTNESS, not magnitude — it stays      │
// │         green under a joint retune because both sides move together.                │
// │   W11 — import IN (`mod.UNDATED_FACTOR` as the opt), LITERAL out (`Math.exp(-0.25)`  │
// │         in the assertion). This is the retune tripwire: it is the ONE window-side    │
// │         unit case that reddens on any `UNDATED_EFOLDINGS` retune — W1/JV1 supply     │
// │         their factor as an explicit literal opt to a pure function, so a constant     │
// │         change cannot move them; they pin mutants, not the shipped value.            │
// └────────────────────────────────────────────────────────────────────────────────────┘
//
// W10 (doSearch-level #237 resolution) and W12 (doSearch-level `_temporalWidened` gate) are
// deliberately NOT in this table — spec §6.4's membership rule scopes the shared table to
// unit-level cases a mutant of `lib/ranking.mjs` can actually reach; both W10 and W12
// statically import the real module at the call-site level and appear in no automated flip
// set. They land as Task 10.

import assert from 'node:assert/strict';
import {
  WINDOW, IN_MS, dated, undated, mixedPool,
} from './window-policy-fixtures.mjs';

const DAY_MS = 86400000;

export const CASES = {
  W1: [['each scored undated item is input x exp(-0.25) exactly; pool is numeric-nonzero only', (applyWindow) => {
    const out = applyWindow(mixedPool(), WINDOW, { undatedFactor: Math.exp(-0.25) });
    const byId = new Map(out.map((r) => [r.id, r]));
    assert.equal(byId.get('u-high').score, 0.8 * Math.exp(-0.25));
    assert.equal(byId.get('u-low').score, 0.2 * Math.exp(-0.25));
  }]],
  W2: [
    ['opt omitted: undated untouched (todays behaviour, byte-identical)', (applyWindow) => {
      const byId = new Map(applyWindow(mixedPool(), WINDOW, {}).map((r) => [r.id, r]));
      assert.equal(byId.get('u-high').score, 0.8);
      assert.equal(byId.get('u-low').score, 0.2);
    }],
    ['undatedFactor: 1 short-circuits identically', (applyWindow) => {
      const byId = new Map(applyWindow(mixedPool(), WINDOW, { undatedFactor: 1 }).map((r) => [r.id, r]));
      assert.equal(byId.get('u-high').score, 0.8);
    }],
  ],
  W3: [['degenerate factors behave as 1 — never a filter, never an inflation', (applyWindow) => {
    for (const bad of [0, NaN, -1, 1.5, Infinity]) {
      const byId = new Map(applyWindow(mixedPool(), WINDOW, { undatedFactor: bad }).map((r) => [r.id, r]));
      assert.equal(byId.get('u-high').score, 0.8, `factor ${bad} must fall back to 1`);
      assert.equal(byId.size, 4, `factor ${bad} must not drop items`);
    }
  }]],
  W4: [
    ['score-less undated stays score-less and sorts last (never mint)', (applyWindow) => {
      const out = applyWindow([...mixedPool(), undated('u-nascore', undefined)], WINDOW, { undatedFactor: Math.exp(-0.25) });
      const item = out.find((r) => r.id === 'u-nascore');
      assert.ok(!('score' in item));
      assert.equal(out[out.length - 1].id, 'u-nascore');
    }],
    ['score: 0 stays exactly 0', (applyWindow) => {
      const out = applyWindow([...mixedPool(), { id: 'u-zero', score: 0, metadata: {} }], WINDOW, { undatedFactor: Math.exp(-0.25) });
      assert.equal(out.find((r) => r.id === 'u-zero').score, 0);
    }],
  ],
  W5: [['dated scores byte-identical with the factor passed vs omitted', (applyWindow) => {
    const withF = new Map(applyWindow(mixedPool(), WINDOW, { undatedFactor: Math.exp(-0.25) }).map((r) => [r.id, r.score]));
    const without = new Map(applyWindow(mixedPool(), WINDOW, {}).map((r) => [r.id, r.score]));
    assert.equal(withF.get('d-in'), without.get('d-in'));
    assert.equal(withF.get('d-out'), without.get('d-out'));
  }]],
  W6: [['order within the scored undated cohort is preserved', (applyWindow) => {
    const pool = [dated('d-in', 0.9, IN_MS), undated('a', 0.8), undated('b', 0.5), undated('c', 0.1)];
    const out = applyWindow(pool, WINDOW, { undatedFactor: Math.exp(-0.25) }).filter((r) => r.id !== 'd-in');
    assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
  }]],
  W7: [['an all-undated pool never activates the window — input returned unchanged', (applyWindow) => {
    const pool = [undated('a', 0.8), undated('b', 0.5)];
    const out = applyWindow(pool, WINDOW, { undatedFactor: Math.exp(-0.25) });
    assert.deepEqual(out.map((r) => [r.id, r.score]), [['a', 0.8], ['b', 0.5]]);
  }]],
  W8: [['jointness: window at UNDATED_FACTOR equals decay on the same undated item', (applyWindow, mod) => {
    const item = () => ({ id: 'u', score: 0.6, metadata: {} });
    const viaWindow = applyWindow([dated('d-in', 0.9, IN_MS), item()], WINDOW, { undatedFactor: mod.UNDATED_FACTOR })
      .find((r) => r.id === 'u').score;
    const viaDecay = mod.applyTemporalDecay([item()], 30).find((r) => r.id === 'u').score;
    assert.equal(viaWindow, viaDecay); // deliberately import-vs-import: pins JOINTNESS, not magnitude
  }]],
  W9: [['purity: input array and items not mutated with the new opt', (applyWindow) => {
    const pool = mixedPool();
    const snapshot = JSON.stringify(pool);
    applyWindow(pool, WINDOW, { undatedFactor: Math.exp(-0.25) });
    assert.equal(JSON.stringify(pool), snapshot);
  }]],
  W11: [['retune tripwire: the IMPORT in, the LITERAL out', (applyWindow, mod) => {
    const out = applyWindow([dated('d-in', 0.9, IN_MS), undated('u', 0.6)], WINDOW, { undatedFactor: mod.UNDATED_FACTOR });
    assert.equal(out.find((r) => r.id === 'u').score, 0.6 * Math.exp(-0.25)); // reddens on any UNDATED_EFOLDINGS retune
  }]],
  JV1: [['seeded property: exact identities on every branch', (applyWindow) => {
    // EXACT IDENTITIES, deliberately not `output <= input`: matches V3's convention on the
    // decay table — a weaker formulation would pass while testing less.
    const rnd = xorshift32(JV1_SEED);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const spanDays = (WINDOW.end - WINDOW.start) / DAY_MS;
    const falloff = Math.min(30, Math.max(1, spanDays * 0.5)); // recomputed analytically — never windowFalloffDays()
    const seen = {
      items: 0, datedIn: 0, datedOut: 0, undated: 0, negative: 0, scoreless: 0, maxN: 0, skipped: 0,
    };
    let nonSkipped = 0;

    for (let iter = 0; iter < 200; iter++) {
      const n = Math.floor(rnd() * 21); // 0..20
      seen.maxN = Math.max(seen.maxN, n);
      const uf = pick(JV1_FACTORS);
      const validFactor = Number.isFinite(uf) && uf > 0 && uf < 1;
      const input = [];
      const meta = new Map();
      let hasDatedIn = false;

      for (let i = 0; i < n; i++) {
        const id = `i${iter}-${i}`;
        const score = pick(JV1_SCORES);
        seen.items++;
        if (score === undefined) seen.scoreless++;
        if (typeof score === 'number' && score < 0) seen.negative++;

        const kind = pick(['dated-in', 'dated-out', 'undated']);
        if (kind === 'dated-in') {
          seen.datedIn++;
          hasDatedIn = true;
          const ms = WINDOW.start + Math.floor(rnd() * (WINDOW.end - WINDOW.start + 1));
          input.push(dated(id, score, ms));
          meta.set(id, { kind, score });
        } else if (kind === 'dated-out') {
          seen.datedOut++;
          const dEdge = (1 + Math.floor(rnd() * 400)) * DAY_MS;
          const ms = rnd() < 0.5 ? WINDOW.start - dEdge : WINDOW.end + dEdge;
          input.push(dated(id, score, ms));
          meta.set(id, { kind, score, dEdge });
        } else {
          seen.undated++;
          input.push(undated(id, score));
          meta.set(id, { kind, score });
        }
      }

      // D-b1: zero in-window candidates leaves the window inactive — a different branch
      // entirely (input returned unchanged), already covered by W7. Skip so JV1 stays
      // scoped to the branch it exists to pin.
      if (!hasDatedIn) { seen.skipped++; continue; }
      nonSkipped++;

      const out = applyWindow(input, WINDOW, { undatedFactor: uf });
      assert.equal(out.length, input.length, `iter ${iter}: length changed`);

      for (const r of out) {
        const m = meta.get(r.id);
        if (m.kind === 'dated-in') {
          assert.equal(r.score, m.score, `iter ${iter}: dated-in ${r.id}`);
        } else if (m.kind === 'dated-out') {
          const expected = (m.score || 1) * Math.max(Math.exp(-(m.dEdge / DAY_MS) / falloff), 0.05);
          assert.equal(r.score, expected, `iter ${iter}: dated-out ${r.id}`);
        } else if (validFactor && typeof m.score === 'number') {
          assert.equal(r.score, m.score * uf, `iter ${iter}: undated-scaled ${r.id}`);
        } else {
          assert.equal(r.score, m.score === undefined ? undefined : m.score, `iter ${iter}: undated-untouched ${r.id}`);
        }
      }
    }

    // Domain counters from THIS loop, not a replica — see V3's rationale (undated-policy-cases.mjs).
    assert.ok(nonSkipped >= 30, `too few non-skipped iterations (${nonSkipped})`);
    assert.ok(seen.items > 500, `too few items generated (${seen.items})`);
    assert.equal(seen.maxN, 20, 'the 0..20 item range must be exercised at its top');
    assert.ok(
      seen.datedIn > 50 && seen.datedOut > 50 && seen.undated > 50,
      `cohorts unbalanced: datedIn=${seen.datedIn} datedOut=${seen.datedOut} undated=${seen.undated}`,
    );
    assert.ok(seen.negative > 30, `too few NEGATIVE scores (${seen.negative})`);
    assert.ok(seen.scoreless > 30, `too few score-less items (${seen.scoreless})`);
  }]],
};

export function runCase(id, fn, mod) {
  for (const [label, body] of CASES[id]) {
    try { body(fn, mod); } catch (error) { return { passed: false, label, error }; }
  }
  return { passed: true }; // matches the decay table's success shape exactly — verified against undated-policy-cases.mjs's runCase
}

/** xorshift32 with a LITERAL seed — node:test has no seeded RNG and JV1 must be pinned. */
function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

const JV1_SEED = 0x1337beef;
const JV1_SCORES = [undefined, 0, 0.5, 1.0, -0.3];
const JV1_FACTORS = [undefined, 1, Math.exp(-0.25), 0, NaN, 1.5];
