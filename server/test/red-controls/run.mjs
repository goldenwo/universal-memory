#!/usr/bin/env node
// server/test/red-controls/run.mjs — RC1-RC6 (undated-decay policy) + RCW1-RCW5
// (window-undated joint-imputation policy, spec §6.4), via an open TABLES registry.
//
// A passing test suite proves the tests pass. It does NOT prove they would FAIL if the
// implementation were wrong — and a test that cannot fail is worse than no test, because
// it reads as coverage. These controls close that gap: each deliberately breaks a policy
// in one specific way and asserts that exactly the NAMED cases go red while the named
// must-still-pass set stays green. Both halves matter — a mutation that reddens everything
// shows only that the tests are coupled, not that they are precise.
//
// MECHANISM. lib/ranking.mjs has ZERO imports (and no import.meta), so a mutant is just
// its source with one string replaced, imported straight from a `data:` URL. Nothing is
// written to disk: no temp dir to leak, no module shimming, and the real file is never
// touched. Both policy tables live in the SAME file, so one mutant load carries both
// `applyTemporalDecay` and `applyTemporalWindow` regardless of which table the control
// belongs to — which is exactly what makes the union evaluation below possible.
//
// TABLES REGISTRY (spec DJ-11). Each policy owns a case table sourced from
// test/helpers/*-policy-cases.mjs — the SAME tables ranking-undated-policy.test.mjs and
// temporal-window.test.mjs run, so a control can never drift from the suite it certifies.
// A third policy table (e.g. #238's clamp) is meant to be one entry here, not four edits
// scattered through this file.
//
// UNION EVALUATION. Every control's mutant is run against EVERY table's cases, not just
// its own — for each `[name, tbl]` in TABLES, `tbl.runCase(id, mod[tbl.fnName], mod)` runs
// over `Object.keys(tbl.CASES)`. A flip in a table other than the control's own is a
// cross-table leak, and the `unexpected` gate below catches it mechanically UNLESS the
// control names it in `alsoFlip` as expected-by-mechanism. Only two entries do:
//   RC1 → alsoFlip includes 'W11': W11 is the window table's retune tripwire and reddens
//         on ANY change to UNDATED_FACTOR/UNDATED_FALLBACK_EFOLDINGS BY DESIGN, so RC1's hardcoded
//         magnitude necessarily reaches it.
//   RC5 → alsoFlip includes 'W8': W8 pins JOINTNESS by calling `mod.applyTemporalDecay`
//         directly on its own undated item, so a mutant of decay's own conditionality
//         moves W8's decay-side operand too.
// Every OTHER cross-table flip (RC2-RC4/RC6 into window, any RCW into decay) is a hard
// failure. This is what makes the spec's "isolation verified both ways" a CHECKED property
// instead of a vacuous one.
//
// W10 (doSearch-level #237 resolution) is in NO control's flip set: it cannot be
// table-resident because doSearch statically imports the real ranking.mjs, so no `data:`
// mutant can reach it. Its relationship to RCW1 (the same omitted/1 identity W2 pins at
// unit level) is a MANUAL claim recorded on the PR, not an automated one — see the task
// report for the captured transcript.
//
// EXIT 0 only when EVERY control behaves exactly as its table says.
//
// Wired into the suite by controls.test.mjs — this file is not `*.test.mjs`, so no glob
// reaches it on its own and the controls would otherwise never run in CI.
//
// If a control flips something OUTSIDE its named set, the fixture or the table is wrong —
// fix THAT. Never relax an expectation to make this runner green: a weakened control is
// strictly worse than a red one, because it silently certifies tests that no longer bite.
//
// Run:  node test/red-controls/run.mjs

import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { CASES as DECAY_CASES, runCase as runDecayCase } from '../helpers/undated-policy-cases.mjs';
import { CASES as WINDOW_CASES, runCase as runWindowCase } from '../helpers/window-policy-cases.mjs';
import { CASES as CLAMP_CASES, runCase as runClampCase } from '../helpers/clamp-policy-cases.mjs';

const RANKING = fileURLToPath(new URL('../../lib/ranking.mjs', import.meta.url));

/**
 * Open registry (spec DJ-11): a third policy table (#238's clamp) is one entry, not four
 * edits. `banner`/`baselineSuffix` drive the baseline print generically (see the print loop
 * in main()) — decay's values reproduce its pre-registry wording exactly, so the OUTPUT is
 * unchanged even though the print code is now table-agnostic.
 */
const TABLES = {
  decay: {
    CASES: DECAY_CASES, runCase: runDecayCase, fnName: 'applyTemporalDecay',
    banner: 'baseline', baselineSuffix: ' against lib/ranking.mjs',
  },
  window: {
    CASES: WINDOW_CASES, runCase: runWindowCase, fnName: 'applyTemporalWindow',
    banner: 'window baseline', baselineSuffix: '',
  },
  // #238's upper clamp — the third seat this registry's header reserved.
  clamp: {
    CASES: CLAMP_CASES, runCase: runClampCase, fnName: 'applyTemporalDecay',
    banner: 'clamp baseline', baselineSuffix: '',
  },
};

// GUARD (review finding I1): the union gate further down keys flips/survivors by BARE case
// id across flat arrays (`flipped.includes(id)`), which assumes ids are globally unique
// across every table. A colliding id would let a foreign survivor mask a genuine own-table
// break, and let a foreign flip get silently excused whenever it happens to match a
// mustFlip/alsoFlip entry meant for the OTHER table. Assert disjointness once, at startup,
// so the extension path this registry exists for (e.g. #238's clamp) fails loudly on a
// naming collision instead of silently corrupting the gate.
{
  const owner = new Map(); // case id -> table name
  for (const [name, t] of Object.entries(TABLES)) {
    for (const id of Object.keys(t.CASES)) {
      if (owner.has(id)) {
        throw new Error(`TABLES registry: case id "${id}" is used by both "${owner.get(id)}" and "${name}" — case ids must be globally unique across every table.`);
      }
      owner.set(id, name);
    }
  }
}

/**
 * Each control: a named mutation of ranking.mjs, the cases it MUST flip (in its own
 * table), and the cases it MUST still pass (in its own table). `table` resolves which
 * entry of TABLES the control belongs to for baseline/roster purposes — but every
 * control's mutant is evaluated against the UNION of every table's cases (see the module
 * header). Sourced from the spec's red-control table (§6.4 for the window entries).
 */
const CONTROLS = [
  {
    id: 'RC1',
    table: 'decay',
    what: 'UNDATED_FACTOR hardcoded to 1.0 (the pre-policy behaviour)',
    mutate: (src) => replaceOnce(src, 'export const UNDATED_FACTOR = Math.exp(-UNDATED_FALLBACK_EFOLDINGS);',
      'export const UNDATED_FACTOR = 1.0;'),
    mustFlip: ['U1', 'U2', 'U4', 'U10', 'V3'],
    mustPass: ['U3', 'U5', 'U6', 'U7'],
    // U8 gained a sub-case pinning an ABSOLUTE undated value (0.6 x exp(-0.25)), so any change
    // to the magnitude necessarily flips it. Named rather than tolerated.
    // W11 (window table) is the retune tripwire — it reddens on ANY UNDATED_FACTOR change BY
    // DESIGN (spec §6.4 rule-2 correction), so this control's hardcoded magnitude reaches it
    // too. Cross-table and expected-by-mechanism, so it is named here rather than left for the
    // `unexpected` gate to (correctly) fail on.
    alsoFlip: ['U8', 'W11'],
    why: 'the policy is scoped to the undated branch and mints no score, so the dated cases and the guard cases are untouched by the magnitude. W11 is the one window-table case that is ALSO scoped to this exact magnitude (by design, as its own tripwire), so it is the sole window-side exception.',
  },
  {
    id: 'RC2',
    table: 'decay',
    what: 'score guard removed — undated branch uses (r.score || 1) * f',
    mutate: (src) => replaceOnce(src,
      "      if (typeof r.score !== 'number') return { ...r };\n      return { ...r, score: r.score * imputedFactor };",
      '      return { ...r, score: (r.score || 1) * imputedFactor };'),
    mustFlip: ['U5', 'U6', 'V3'],
    mustPass: ['U1', 'U3'],
    alsoFlip: [],
    why: 'the minting defect is guarded independently of the factor, so a correctly-scored item is unaffected',
  },
  {
    id: 'RC3',
    table: 'decay',
    what: 'UNDATED_FACTOR replaces the dated min(1, exp(-age/H)) factor',
    mutate: (src) => replaceOnce(src, '    const factor = Math.min(1, Math.exp(-ageDays / halfLifeDays));',
      '    const factor = UNDATED_FACTOR;'),
    mustFlip: ['U3', 'V1', 'V3'],
    mustPass: ['U1', 'U5'],
    // Breaking the whole dated branch necessarily reddens every case carrying a dated
    // assertion: U4 and U7 assert dated scores directly, and V2's second sub-case asserts
    // the dated/undated interleaving. Named so a FURTHER broadening is still caught.
    // Cross-table (clamp): C1 reddens (0.7788 != the clamped 1 at a future age), C3
    // reddens (0.7788 != 1 at age 0), and C2 reddens too — its ABSOLUTE parity
    // assertions (0.5 exactly) see the factor change even though the tie itself
    // survives at equal factors. Expected-by-mechanism, so named here — the
    // RC1 -> W11 precedent.
    alsoFlip: ['U4', 'U7', 'V2', 'C1', 'C2', 'C3'],
    why: 'the dated cohort is genuinely guarded — this is only derivable because the fixture carries a decay-induced rank inversion. C1-C3 are the clamp-table cases scoped to the same dated factor this control replaces: C2 asserts ABSOLUTE cosine parity (0.5 exactly), deliberately stronger than a tie-only check, so the factor swap reddens it even though the tie itself survives at equal factors.',
  },
  {
    id: 'RC4',
    table: 'decay',
    what: 'undated branch grades on createdAt (the fallback D-h removed)',
    mutate: (src) => replaceOnce(src,
      '      return { ...r, score: r.score * imputedFactor };',
      '      const ca = Date.parse(r.createdAt ?? r.created_at ?? "");\n'
      + '      if (Number.isFinite(ca)) return { ...r, score: r.score * Math.exp(-((now - ca) / DAY_MS) / halfLifeDays) };\n'
      + '      return { ...r, score: r.score * imputedFactor };'),
    mustFlip: ['U1', 'V3'],
    mustPass: ['U3'],
    // Every undated fixture item carries a 120-day-old createdAt (deliberately, so this
    // control is not inert), so any case asserting an undated SCORE also reddens — including
    // U8's absolute-value sub-case.
    alsoFlip: ['U2', 'U4', 'U8'],
    why: 'catches a future contributor reinstating the createdAt fallback — an arrival stamp must never be a ranking date',
  },
  {
    id: 'RC5',
    table: 'decay',
    what: 'an anyDated short-circuit — skip the policy when the set holds no dated point',
    mutate: (src) => replaceOnce(src,
      "      if (typeof r.score !== 'number') return { ...r };",
      [
        '      if (!results.some((x) => resolveItemDate(x) !== null)) return { ...r };',
        "      if (typeof r.score !== 'number') return { ...r };",
      ].join('\n')),
    mustFlip: ['U2', 'U8'],
    mustPass: ['U3', 'U5', 'U6', 'U7'],
    // V3 draws all-undated iterations, so the short-circuit fires there. So does U1's
    // "an undated item is NOT graded on its createdAt" sub-case, which decays a SINGLE
    // undated item — an all-undated set by construction. (Named by label, not ordinal: an
    // earlier version said "third sub-case" and went stale when a dated sub-case moved to
    // U3.) U4/V1/V2 mixed sets always hold a dated point, so the short-circuit never fires
    // and they correctly survive.
    // W8 (window table) also flips: it calls `mod.applyTemporalDecay` directly on the same
    // undated item to pin cross-policy jointness (spec §6.4 rule-2 correction), so a mutant
    // that changes decay's own conditionality necessarily moves W8's decay-side operand.
    // Cross-table and expected-by-mechanism, named here rather than left for `unexpected`.
    alsoFlip: ['V3', 'U1', 'W8'],
    why: 'the constant is applied UNCONDITIONALLY so an item factor never depends on the rest of the returned set. This is the exact defect that rationale names — and until U8 gained an all-undated subset, NOTHING in the suite could see it: the short-circuit mutant flipped U1/U2/V3 while U8 survived. W8 calls the mutated decay function directly, so it inherits the same short-circuit and is the sole window-side exception.',
  },
  {
    id: 'RC6',
    table: 'decay',
    what: 'the undated branch MUTATES in place instead of returning a copy',
    mutate: (src) => replaceOnce(src,
      '      return { ...r, score: r.score * imputedFactor };',
      [
        '      r.score = r.score * imputedFactor;',
        '      return r;',
      ].join('\n')),
    mustFlip: ['U9'],
    mustPass: ['U3', 'U7'],
    // Mutating in place still produces the RIGHT score, so every value assertion survives;
    // only the purity case can see it. That is exactly why U9 needed a control: it was the
    // one case in the table no mutation could redden, so nothing proved it bites.
    alsoFlip: [],
    why: 'purity is a documented contract (a new array, items never mutated) and callers rely on it — but a value-only test suite cannot distinguish a copy from an in-place write',
  },
  {
    id: 'RCC1',
    table: 'clamp',
    what: 'the #238 upper clamp removed — dated factor back to bare exp(-age/H)',
    mutate: (src) => replaceOnce(src, '    const factor = Math.min(1, Math.exp(-ageDays / halfLifeDays));',
      '    const factor = Math.exp(-ageDays / halfLifeDays);'),
    mustFlip: ['C1', 'C2'],
    mustPass: ['C3'],
    // C3 is genuinely unreachable by THIS mutant (exp(0) is already 1, clamped or not) —
    // its certification comes from RC3's declared cross-table flip instead, so no clamp
    // case is certifiable-by-nothing. Cross-table (decay): V3's property domain forces
    // future ages (its counters assert future > 50), so the unclamped identity reddens
    // it — expected-by-mechanism, the RC1 -> W11 precedent.
    alsoFlip: ['V3'],
    why: 'unclamping inflates future-dated factors (C1: 1.395 != 1; C2: 1.034 vs 1.395 breaks the exact tie) while every past-age case is untouched — min(1, ·) is a no-op on the past domain.',
  },
  {
    id: 'RCW1',
    table: 'window',
    what: 'uf resolution ignores the opt entirely — unconditional imputation (approach B by accident)',
    mutate: (src) => replaceOnce(src,
      '  const uf = Number.isFinite(undatedFactor) && undatedFactor > 0 && undatedFactor <= 1\n    ? undatedFactor\n    : 1;',
      '  const uf = UNDATED_FACTOR;'),
    mustFlip: ['W2', 'W3', 'JV1'],
    mustPass: ['W1', 'W11', 'W5', 'W4'],
    // W8 (#297 spec §6.1): jointness is now pinned at a NON-constant factor passed to both arms,
    // so a window that ignores the opt and imputes the module constant necessarily diverges from
    // decay's side. Expected-by-mechanism (measured at plan T6(a)); declared per spec §6.3, never
    // absorbed by weakening W8 back to the constant.
    alsoFlip: ['W8'],
    why: 'W1/W11 pass a factor the mutant coincidentally equals; the typeof half of the guard still short-circuits score-less items; W8 now passes a non-constant factor and so reddens by design',
  },
  {
    id: 'RCW2',
    table: 'window',
    what: 'never-mint guard removed — whole undated branch becomes (r.score || 1) * uf',
    mutate: (src) => replaceOnce(src,
      "      if (uf === 1 || typeof r.score !== 'number') return { ...r };\n      return { ...r, score: r.score * uf };",
      '      return { ...r, score: (r.score || 1) * uf };'),
    mustFlip: ['W4', 'JV1'],
    mustPass: ['W1', 'W2'],
    alsoFlip: [],
    why: 'W1/W2 pools are pinned numeric-nonzero, where (score||1)*uf === score*uf',
  },
  {
    id: 'RCW3',
    table: 'window',
    what: 'the factor leaks onto dated in-window items',
    mutate: (src) => replaceOnce(src,
      '    if (isInWindow(r, window)) return { ...r };',
      "    if (isInWindow(r, window)) return typeof r.score === 'number' ? { ...r, score: r.score * uf } : { ...r };"),
    mustFlip: ['W5', 'JV1'],
    mustPass: ['W1'],
    alsoFlip: [],
    why: 'W1 asserts only undated outputs; dated leakage is exactly what W5/JV1 pin',
  },
  {
    id: 'RCW4',
    table: 'window',
    what: 'window-native constant: the undated multiply uses exp(-1) instead of uf',
    mutate: (src) => replaceOnce(src,
      '      return { ...r, score: r.score * uf };',
      '      return { ...r, score: r.score * Math.exp(-1) };'),
    mustFlip: ['W8', 'W1', 'W11', 'JV1'],
    mustPass: ['W2', 'W5'],
    alsoFlip: [],
    why: 'the uf === 1 short-circuit is untouched, so the omitted/1 path still returns early',
  },
  {
    id: 'RCW5',
    table: 'window',
    what: 'range check dropped from the factor guard, nullish default kept',
    mutate: (src) => replaceOnce(src,
      '  const uf = Number.isFinite(undatedFactor) && undatedFactor > 0 && undatedFactor <= 1\n    ? undatedFactor\n    : 1;',
      '  const uf = undatedFactor ?? 1;'),
    mustFlip: ['W3', 'JV1'],
    mustPass: ['W1', 'W2'],
    alsoFlip: [],
    why: 'the omitted-opt path is untouched, so the mutant isolates the range check',
  },
];

/** Replace exactly one occurrence, failing loudly if the anchor drifted. */
function replaceOnce(src, needle, replacement) {
  const count = src.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(
      `mutation anchor matched ${count} times, expected exactly 1.\nAnchor:\n${needle}\n`
      + 'The source moved under the control. Re-anchor the mutation — do NOT loosen it.',
    );
  }
  return src.replace(needle, replacement);
}

/** Import a mutated copy of ranking.mjs from memory — nothing touches the filesystem. */
async function loadMutant(id, mutate, src) {
  const mutated = mutate(src);
  if (mutated === src) throw new Error(`${id}: mutation produced an identical source — it would be a FALSE GREEN`);
  const url = `data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`;
  return import(url);
}

async function main() {
  const failures = [];
  let checks = 0;
  const src = await readFile(RANKING, 'utf8');

  // Sanity gate: every case, in EVERY table, must PASS against the real implementation
  // first. Without it a control could "flip" a case that was already broken, and the run
  // would certify nothing.
  const real = await import(pathToFileURL(RANKING).href);
  for (const [name, t] of Object.entries(TABLES)) {
    for (const id of Object.keys(t.CASES)) {
      const r = t.runCase(id, real[t.fnName], real);
      checks++;
      if (!r.passed) failures.push(`BASELINE ${name}/${id} (${r.label}) fails against the REAL implementation: ${r.error.message}`);
    }
  }
  if (failures.length > 0) {
    console.error(`baseline is not green:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  // Baselines print per table, GENERICALLY, off each table's own `banner` + `baselineSuffix`
  // (review finding I2). An earlier version special-cased `name === 'decay'` here, which let
  // run.mjs's own `decay.banner` value silently disagree with controls.test.mjs's pinned
  // copy — the special case made the field dead code, and nothing caught the drift. The
  // OUTPUT is still pinned byte-identical (controls.test.mjs asserts it literally); this loop
  // is what keeps that true generically, so a third table needs no changes here — only a new
  // TABLES entry with its own banner/baselineSuffix.
  for (const t of Object.values(TABLES)) {
    const count = Object.keys(t.CASES).length;
    // Sub-case total too: the group count alone cannot see a DROPPED sub-case, and some
    // groups have a single sub-case carrying the only guard for a whole branch.
    const subCases = Object.values(t.CASES).reduce((n, v) => n + v.length, 0);
    console.log(`${t.banner}: all ${count} cases pass${t.baselineSuffix}`);
    console.log(`${t.banner}: ${subCases} sub-cases`);
  }

  for (const c of CONTROLS) {
    // A control that names NO case it must redden asserts nothing, yet would print PASS
    // with its `what` string intact — the CI log would actively misreport. Neutering a
    // control is a subtler erosion than deleting it, and the roster pin cannot see it.
    if (c.mustFlip.length === 0) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      failures.push(`${c.id}: mustFlip is EMPTY — a control that names no case it must redden certifies nothing`);
      continue;
    }
    const t = TABLES[c.table];
    if (!t) throw new Error(`${c.id}: unknown table "${c.table}" — register it in TABLES first`);

    // Per-control try/catch: a drifted mutation anchor throws, and without this the
    // first drift would abort the run with the later controls never evaluated.
    let mod;
    try {
      mod = await loadMutant(c.id, c.mutate, src);
    } catch (err) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      // Truncate at the data: URL. Node's resolver error embeds the ENTIRE base64 mutant,
      // so on the failure mode this file explicitly anticipates ("what if ranking.mjs ever
      // gains an import") all controls emit tens of KB of base64 and bury the one
      // actionable line — for a failure whose whole job is to say what the contributor broke.
      failures.push(`${c.id}: could not build the mutant — ${String(err.message).split(' from "data:')[0]}`);
      continue;
    }

    // Evaluate the mutant against the UNION of every table's cases (spec DJ-11 / §6.4), not
    // just the control's own table. A flip in a FOREIGN table is always outside the
    // control's named sets unless explicitly claimed in alsoFlip, so the `unexpected` gate
    // below catches cross-table leakage mechanically — this is what makes "isolation
    // verified both ways" a checked property instead of a vacuous one.
    const flipped = [];
    const survived = [];
    for (const tbl of Object.values(TABLES)) {
      for (const id of Object.keys(tbl.CASES)) {
        const r = tbl.runCase(id, mod[tbl.fnName], mod);
        checks++;
        (r.passed ? survived : flipped).push(id);
      }
    }

    const ownIds = new Set(Object.keys(t.CASES));
    const ownFlipped = flipped.filter((id) => ownIds.has(id));
    const foreignFlipped = flipped.filter((id) => !ownIds.has(id));

    // alsoFlip entries are CLAIMS about what those cases still assert ("U4 and U7 assert
    // dated scores directly", or — for RC1/RC5's two cross-table entries — "W11/W8 are
    // scoped to this exact mechanism"). If one silently stops flipping, the control stays
    // green while certifying strictly less — the erosion this runner exists to prevent. So
    // they are required to flip too; the two lists differ only in the failure message.
    const missingFlips = [...c.mustFlip, ...(c.alsoFlip ?? [])].filter((id) => !flipped.includes(id));
    const brokenPasses = c.mustPass.filter((id) => !survived.includes(id));
    // Flips outside BOTH named sets are gated too — own-table AND cross-table. Without this
    // a future broadening of a mutation could redden strictly more cases (in either table)
    // and the run would still report success.
    const unexpected = flipped.filter((id) => !c.mustFlip.includes(id) && !(c.alsoFlip ?? []).includes(id));

    const ok = missingFlips.length === 0 && brokenPasses.length === 0 && unexpected.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} — ${c.what}`);
    console.log(`       flipped: [${ownFlipped.join(', ')}]`);
    if (foreignFlipped.length > 0) console.log(`       cross-table flipped: [${foreignFlipped.join(', ')}]`);
    console.log(`       expected to flip: [${c.mustFlip.join(', ')}] · expected to survive: [${c.mustPass.join(', ')}]`);

    if (missingFlips.length > 0) {
      failures.push(`${c.id}: did NOT flip ${missingFlips.join(', ')} — those cases do not actually guard this defect`);
    }
    if (unexpected.length > 0) {
      failures.push(
        `${c.id}: flipped ${unexpected.join(', ')}, which is in NEITHER named set (own-table or cross-table) — the `
        + 'mutation is broader than the control describes. Narrow the mutation, or add the case to alsoFlip WITH a '
        + 'reason. Never widen it silently.',
      );
    }
    if (brokenPasses.length > 0) {
      failures.push(
        `${c.id}: flipped ${brokenPasses.join(', ')}, which must still pass (${c.why}). `
        + 'The fixture or the control table is wrong — fix that, do NOT relax the expectation.',
      );
    }
  }

  console.log(`\n${checks} case-evaluations across ${CONTROLS.length} controls + baseline`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} RED-CONTROL FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('all red controls behaved exactly as specified');
}

await main();
