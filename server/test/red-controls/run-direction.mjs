#!/usr/bin/env node
// server/test/red-controls/run-direction.mjs — RCD1-RCD2 (#276 supersession-direction rule),
// a SIBLING of run.mjs in its house style.
//
// A passing test suite proves the tests pass. It does NOT prove they would FAIL if the
// implementation were wrong — and a test that cannot fail is worse than no test, because
// it reads as coverage. These controls close that gap for the direction table: each
// deliberately breaks the rule in one specific way and asserts that exactly the NAMED cases
// go red while the named must-still-pass set stays green. Both halves matter — a mutation
// that reddens everything shows only that the tests are coupled, not that they are precise.
//
// MECHANISM. A mutant is lib/supersede.mjs's source with one string replaced, imported
// straight from a `data:` URL — nothing is written to disk, the real file is never touched.
// One difference from run.mjs, forced by the module: supersede.mjs has RELATIVE imports
// (./contradiction-judge.mjs, ./ranking.mjs), which a data: URL cannot resolve, so each
// relative specifier is rewritten to the absolute file URL of the real file before the
// mutant is built. Still nothing on disk.
//
// TABLE. The direction cases live in test/helpers/direction-policy-cases.mjs — the SAME
// table supersession-direction.test.mjs runs in the real suite — so a control can never
// drift from the suite it certifies. Why a sibling runner and not a fifth TABLES entry in
// run.mjs: that registry loads ONE zero-import module (ranking.mjs) per mutant and runs the
// union of every table against it; a second module would need per-module grouping of the
// union gate. One table, one module, one runner keeps both mechanisms simple.
//
// EXIT 0 only when EVERY control behaves exactly as its table says.
//
// Wired into the suite by controls-direction.test.mjs — this file is not `*.test.mjs`, so
// no glob reaches it on its own and the controls would otherwise never run in CI.
//
// If a control flips something OUTSIDE its named set, the fixture or the table is wrong —
// fix THAT. Never relax an expectation to make this runner green: a weakened control is
// strictly worse than a red one, because it silently certifies tests that no longer bite.
//
// Run:  node test/red-controls/run-direction.mjs

import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CASES, runCase } from '../helpers/direction-policy-cases.mjs';

const SUPERSEDE = fileURLToPath(new URL('../../lib/supersede.mjs', import.meta.url));
const LIB_DIR = new URL('../../lib/', import.meta.url);
const FN = 'resolveSupersessionDirection';
const BANNER = 'direction baseline';

/**
 * The rule under control (spec 2026-09-10-276 §4.1):
 *   assertedAt unusable -> ambiguous · stored truth null -> ambiguous · stored beyond now+skew
 *   -> stored-future · incoming > stored -> incoming-newer · incoming < stored -> stored-newer
 *   · equal -> ambiguous. Act iff incoming-newer.
 *
 * Flip matrix (certified by the gate below):
 *   RCD1 (arrival order reinstated: every call resolves incoming-newer, the #276 defect)
 *        flips every group that expects a stored-newer / stored-future / ambiguous somewhere:
 *        K1 (the live pair), D1 (earlier + equal sub-cases), D2, D3, D5 (stored-side
 *        sub-case), D6, D7, D8, D9, D10 (stored-newer sub-case). Survives: K2, D4 and D11,
 *        whose only expectation is incoming-newer with the same re-serialised instants.
 *   RCD2 (missing stored truth falls through to incoming-newer instead of abstaining)
 *        flips exactly the groups whose stored side has NO usable truth time and which reach
 *        that arm: D2, D3, D5. D6/D7 survive because the assertedAt / argument-shape arms
 *        precede it; K1 survives because its stored side carries a usable instant.
 */
const CONTROLS = [
  {
    id: 'RCD1',
    what: 'arrival order reinstated — every call resolves incoming-newer (the #276 defect)',
    mutate: (src) => replaceOnce(src,
      "  if (!incoming || !stored) return result('ambiguous');",
      "  return result('incoming-newer');"),
    mustFlip: ['K1', 'D1', 'D2', 'D3', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'],
    mustPass: ['K2', 'D4', 'D11'],
    why: 'K2, D4 and D11 expect incoming-newer with instants computed the same way, so "always newer" cannot be told apart from the rule there — every other group asserts an abstain or a stored-newer somewhere, and that is exactly what write order destroys',
  },
  {
    id: 'RCD2',
    what: 'missing stored truth falls through to incoming-newer instead of abstaining',
    mutate: (src) => replaceOnce(src,
      "  if (storedMs === null) return result('ambiguous');",
      "  if (storedMs === null) return result('incoming-newer');"),
    mustFlip: ['D2', 'D3', 'D5'],
    mustPass: ['K1', 'K2', 'D1', 'D4', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11'],
    why: 'only a stored side with no usable truth time reaches this arm; the assertedAt and argument-shape arms precede it (D6, D7) and every other group carries a usable stored instant',
  },
];

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

/** Rewrite `from './x.mjs'` to the absolute file URL of lib/x.mjs so a data: URL can resolve it. */
function absolutiseImports(src) {
  let out = src.replace(/from '\.\/([^']+)'/g, (_m, rel) => `from '${new URL(rel, LIB_DIR).href}'`);
  // A relative specifier the regex missed would surface as an unresolvable data: import
  // with the whole base64 mutant in the message — fail loudly and readably instead.
  if (/from '\.\.?\//.test(out)) throw new Error('a relative import survived absolutisation — extend the rewrite');
  if (out.includes('import.meta')) throw new Error('supersede.mjs uses import.meta — a data: mutant cannot reproduce it');
  return out;
}

/** Import a mutated copy of supersede.mjs from memory — nothing touches the filesystem. */
async function loadMutant(id, mutate, src) {
  const mutated = mutate(src);
  if (mutated === src) throw new Error(`${id}: mutation produced an identical source — it would be a FALSE GREEN`);
  const url = `data:text/javascript;base64,${Buffer.from(absolutiseImports(mutated), 'utf8').toString('base64')}`;
  return import(url);
}

async function main() {
  const failures = [];
  let checks = 0;
  const src = await readFile(SUPERSEDE, 'utf8');
  const ids = Object.keys(CASES);

  // Sanity gate: every case must PASS against the real implementation first. Without it a
  // control could "flip" a case that was already broken, and the run would certify nothing.
  const real = await import(pathToFileURL(SUPERSEDE).href);
  for (const id of ids) {
    const r = runCase(id, real[FN], real);
    checks++;
    if (!r.passed) failures.push(`BASELINE ${id} (${r.label}) fails against the REAL implementation: ${r.error.message}`);
  }
  if (failures.length > 0) {
    console.error(`baseline is not green:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  const subCases = Object.values(CASES).reduce((n, v) => n + v.length, 0);
  console.log(`${BANNER}: all ${ids.length} cases pass`);
  console.log(`${BANNER}: ${subCases} sub-cases`);

  for (const c of CONTROLS) {
    if (c.mustFlip.length === 0) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      failures.push(`${c.id}: mustFlip is EMPTY — a control that names no case it must redden certifies nothing`);
      continue;
    }
    // Every case is in exactly one named set — a control that leaves a case unnamed is
    // silently tolerating whatever it does there.
    const named = new Set([...c.mustFlip, ...c.mustPass]);
    const unnamed = ids.filter((id) => !named.has(id));
    if (unnamed.length > 0) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      failures.push(`${c.id}: cases ${unnamed.join(', ')} are in NEITHER named set — declare each one`);
      continue;
    }
    let mod;
    try {
      mod = await loadMutant(c.id, c.mutate, src);
    } catch (err) {
      console.log(`FAIL ${c.id} — ${c.what}`);
      failures.push(`${c.id}: could not build the mutant — ${String(err.message).split(' from "data:')[0]}`);
      continue;
    }
    const flipped = [];
    const survived = [];
    for (const id of ids) {
      const r = runCase(id, mod[FN], mod);
      checks++;
      (r.passed ? survived : flipped).push(id);
    }
    const missingFlips = c.mustFlip.filter((id) => !flipped.includes(id));
    const brokenPasses = c.mustPass.filter((id) => !survived.includes(id));
    const unexpected = flipped.filter((id) => !c.mustFlip.includes(id));
    const ok = missingFlips.length === 0 && brokenPasses.length === 0 && unexpected.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} — ${c.what}`);
    console.log(`       flipped: [${flipped.join(', ')}]`);
    console.log(`       expected to flip: [${c.mustFlip.join(', ')}] · expected to survive: [${c.mustPass.join(', ')}]`);
    if (missingFlips.length > 0) {
      failures.push(`${c.id}: did NOT flip ${missingFlips.join(', ')} — those cases do not actually guard this defect`);
    }
    if (unexpected.length > 0) {
      failures.push(
        `${c.id}: flipped ${unexpected.join(', ')}, which is not in its named flip set — the mutation is broader `
        + 'than the control describes. Narrow the mutation, or re-derive the set from the rule. Never widen it silently.',
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
  console.log('all direction red controls behaved exactly as specified');
}

await main();
