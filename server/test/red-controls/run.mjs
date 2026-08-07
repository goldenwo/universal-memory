#!/usr/bin/env node
// server/test/red-controls/run.mjs — RC1-RC6 for the undated-decay policy.
//
// A passing test suite proves the tests pass. It does NOT prove they would FAIL if the
// implementation were wrong — and a test that cannot fail is worse than no test, because
// it reads as coverage. These controls close that gap: each deliberately breaks the policy
// in one specific way and asserts that exactly the NAMED cases go red while the named
// must-still-pass set stays green. Both halves matter — a mutation that reddens everything
// shows only that the tests are coupled, not that they are precise.
//
// MECHANISM. lib/ranking.mjs has ZERO imports (and no import.meta), so a mutant is just
// its source with one string replaced, imported straight from a `data:` URL. Nothing is
// written to disk: no temp dir to leak, no module shimming, and the real file is never
// touched. The cases come from test/helpers/undated-policy-cases.mjs — the SAME table
// ranking-undated-policy.test.mjs runs, so a control can never drift from the suite it
// certifies.
//
// EXIT 0 only when EVERY control behaves exactly as the table says.
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

import { CASES, runCase } from '../helpers/undated-policy-cases.mjs';

const RANKING = fileURLToPath(new URL('../../lib/ranking.mjs', import.meta.url));

/**
 * Each control: a named mutation of ranking.mjs, the cases it MUST flip, and the cases it
 * MUST still pass. Sourced from the spec's red-control table.
 */
const CONTROLS = [
  {
    id: 'RC1',
    what: 'UNDATED_FACTOR hardcoded to 1.0 (the pre-policy behaviour)',
    mutate: (src) => replaceOnce(src, 'export const UNDATED_FACTOR = Math.exp(-UNDATED_EFOLDINGS);',
      'export const UNDATED_FACTOR = 1.0;'),
    mustFlip: ['U1', 'U2', 'U4', 'U10', 'V3'],
    mustPass: ['U3', 'U5', 'U6', 'U7'],
    // U8 gained a sub-case pinning an ABSOLUTE undated value (0.6 x exp(-1)), so any change
    // to the magnitude necessarily flips it. Named rather than tolerated.
    alsoFlip: ['U8'],
    why: 'the policy is scoped to the undated branch and mints no score, so the dated cases and the guard cases are untouched by the magnitude',
  },
  {
    id: 'RC2',
    what: 'score guard removed — undated branch uses (r.score || 1) * f',
    mutate: (src) => replaceOnce(src,
      "      if (typeof r.score !== 'number') return { ...r };\n      return { ...r, score: r.score * UNDATED_FACTOR };",
      '      return { ...r, score: (r.score || 1) * UNDATED_FACTOR };'),
    mustFlip: ['U5', 'U6', 'V3'],
    mustPass: ['U1', 'U3'],
    alsoFlip: [],
    why: 'the minting defect is guarded independently of the factor, so a correctly-scored item is unaffected',
  },
  {
    id: 'RC3',
    what: 'UNDATED_FACTOR replaces the dated exp(-age/H) factor',
    mutate: (src) => replaceOnce(src, '    const factor = Math.exp(-ageDays / halfLifeDays);',
      '    const factor = UNDATED_FACTOR;'),
    mustFlip: ['U3', 'V1', 'V3'],
    mustPass: ['U1', 'U5'],
    // Breaking the whole dated branch necessarily reddens every case carrying a dated
    // assertion: U4 and U7 assert dated scores directly, and V2's second sub-case asserts
    // the dated/undated interleaving. Named so a FURTHER broadening is still caught.
    alsoFlip: ['U4', 'U7', 'V2'],
    why: 'the dated cohort is genuinely guarded — this is only derivable because the fixture carries a decay-induced rank inversion',
  },
  {
    id: 'RC4',
    what: 'undated branch grades on createdAt (the fallback D-h removed)',
    mutate: (src) => replaceOnce(src,
      '      return { ...r, score: r.score * UNDATED_FACTOR };',
      '      const ca = Date.parse(r.createdAt ?? r.created_at ?? "");\n'
      + '      if (Number.isFinite(ca)) return { ...r, score: r.score * Math.exp(-((now - ca) / DAY_MS) / halfLifeDays) };\n'
      + '      return { ...r, score: r.score * UNDATED_FACTOR };'),
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
    alsoFlip: ['V3', 'U1'],
    why: 'the constant is applied UNCONDITIONALLY so an item factor never depends on the rest of the returned set. This is the exact defect that rationale names — and until U8 gained an all-undated subset, NOTHING in the suite could see it: the short-circuit mutant flipped U1/U2/V3 while U8 survived',
  },
  {
    id: 'RC6',
    what: 'the undated branch MUTATES in place instead of returning a copy',
    mutate: (src) => replaceOnce(src,
      '      return { ...r, score: r.score * UNDATED_FACTOR };',
      [
        '      r.score = r.score * UNDATED_FACTOR;',
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

  // Sanity gate: every case must PASS against the real implementation first. Without it a
  // control could "flip" a case that was already broken, and the run would certify nothing.
  const real = await import(pathToFileURL(RANKING).href);
  for (const id of Object.keys(CASES)) {
    const r = runCase(id, real.applyTemporalDecay, real);
    checks++;
    if (!r.passed) failures.push(`BASELINE ${id} (${r.label}) fails against the REAL implementation: ${r.error.message}`);
  }
  if (failures.length > 0) {
    console.error(`baseline is not green:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  const subCases = Object.values(CASES).reduce((n, v) => n + v.length, 0);
  console.log(`baseline: all ${Object.keys(CASES).length} cases pass against lib/ranking.mjs`);
  // Sub-case total too: the group count alone cannot see a DROPPED sub-case, and some
  // groups have a single sub-case carrying the only guard for a whole branch.
  console.log(`baseline: ${subCases} sub-cases`);

  for (const c of CONTROLS) {
    // A control that names NO case it must redden asserts nothing, yet would print PASS
    // with its `what` string intact — the CI log would actively misreport. Neutering a
    // control is a subtler erosion than deleting it, and the roster pin cannot see it.
    if (c.mustFlip.length === 0) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      failures.push(`${c.id}: mustFlip is EMPTY — a control that names no case it must redden certifies nothing`);
      continue;
    }
    // Per-control try/catch: a drifted mutation anchor throws, and without this the
    // first drift would abort the run with the later controls never evaluated.
    let mod;
    try {
      mod = await loadMutant(c.id, c.mutate, src);
    } catch (err) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      failures.push(`${c.id}: could not build the mutant — ${err.message}`);
      continue;
    }
    const flipped = [];
    const survived = [];

    for (const id of Object.keys(CASES)) {
      const r = runCase(id, mod.applyTemporalDecay, mod);
      checks++;
      (r.passed ? survived : flipped).push(id);
    }

    // alsoFlip entries are CLAIMS about what those cases still assert ("U4 and U7 assert
    // dated scores directly"). If one silently stops flipping, the control stays green while
    // certifying strictly less — the erosion this runner exists to prevent. So they are
    // required to flip too; the two lists differ only in the failure message.
    const missingFlips = [...c.mustFlip, ...(c.alsoFlip ?? [])].filter((id) => !flipped.includes(id));
    const brokenPasses = c.mustPass.filter((id) => !survived.includes(id));
    // Flips outside BOTH named sets are gated too. Without this a future broadening of a
    // mutation could redden strictly more cases and the run would still report success —
    // and a mutation that reddens everything shows only that the tests are coupled.
    const unexpected = flipped.filter((id) => !c.mustFlip.includes(id) && !(c.alsoFlip ?? []).includes(id));

    const ok = missingFlips.length === 0 && brokenPasses.length === 0 && unexpected.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} — ${c.what}`);
    console.log(`       flipped: [${flipped.join(', ')}]`);
    console.log(`       expected to flip: [${c.mustFlip.join(', ')}] · expected to survive: [${c.mustPass.join(', ')}]`);

    if (missingFlips.length > 0) {
      failures.push(`${c.id}: did NOT flip ${missingFlips.join(', ')} — those cases do not actually guard this defect`);
    }
    if (unexpected.length > 0) {
      failures.push(
        `${c.id}: flipped ${unexpected.join(', ')}, which is in NEITHER named set — the mutation is `
        + 'broader than the control describes. Narrow the mutation, or add the case to alsoFlip WITH a '
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
