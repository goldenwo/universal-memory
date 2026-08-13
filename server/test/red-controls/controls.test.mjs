// server/test/red-controls/controls.test.mjs — makes the red controls RUN, and pins WHICH.
//
// WHY THIS FILE EXISTS. `run.mjs` is not named `*.test.mjs`, so no glob reaches it on its
// own. The CI commands enumerate test tiers explicitly rather than using `test/*/*.test.mjs`
// (.github/workflows/smoke.yml:120 and :338), and no workflow invokes `npm test` — whose
// script IS the only glob that would have matched. So the controls — the thing that turns
// "the tests pass" into "the tests would FAIL if the policy broke" — ran nowhere automated,
// and would have rotted silently the moment ranking.mjs moved. Worse, their failure mode on
// anchor drift is a thrown error nobody would ever see.
//
// `test/red-controls/*.test.mjs` is now named in BOTH smoke.yml steps, and this wrapper is
// what those globs pick up. run.mjs keeps its standalone CLI behaviour (exit code + a
// per-control report), which is what you want when iterating.
//
// THE ROSTER AND CASE COUNT ARE PINNED BELOW, deliberately. An earlier version asserted only
// the success banner — and passed with an EMPTY control array, printing "0 controls" and
// "all red controls behaved exactly as specified". That is the same "green while certifying
// strictly less" erosion the controls themselves exist to prevent, one level up. Adding or
// removing a control must now be a deliberate edit here.
//
// PINNED PER TABLE (spec DJ-11 / §6.4): run.mjs's own TABLES registry means a control now
// belongs to a policy table (decay or window today), and each table gets its own roster +
// case/sub-case counts + baseline banner wording. A third table is one entry in the map
// below, not a fork of this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Every control that must actually execute, and the shared case table it is scored against
 * — one entry per policy table in run.mjs's TABLES registry. Update deliberately, never to
 * make CI green.
 *
 * `cases`/`subcases` mirror run.mjs's baseline gate: `cases` is the GROUP count in the
 * table (test/helpers/{undated,window}-policy-cases.mjs), `subcases` the total sub-case
 * count across those groups — pinned separately because the group count alone cannot see a
 * dropped sub-case (decay's U6 non-numeric-score sub-case is the sole thing distinguishing
 * the shipped `typeof r.score !== 'number'` from a weaker `== null`, which would coerce a
 * string score). `banner` is the literal prefix run.mjs prints the baseline lines under —
 * decay keeps its pre-registry wording (`baseline: ...`); window uses the new general form
 * (`window baseline: ...`).
 */
const TABLES = {
  decay: {
    controls: ['RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6'], cases: 13, subcases: 22, banner: 'baseline',
  },
  window: {
    controls: ['RCW1', 'RCW2', 'RCW3', 'RCW4', 'RCW5'], cases: 11, subcases: 13, banner: 'window baseline',
  },
};

function runControls() {
  // Child process: run.mjs signals via process.exitCode, and importing it would set the
  // exit code of the TEST RUNNER instead — surfacing as a confusing non-zero exit rather
  // than a named failing test.
  const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
  return spawnSync(process.execPath, [runner], { encoding: 'utf8' });
}

test('red controls: every control passes its own flip/survive table', () => {
  const r = runControls();
  // Surface the runner's report on failure — it names which control misbehaved and how.
  assert.equal(r.status, 0, `red controls failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /all red controls behaved exactly as specified/);
});

test('red controls: the full roster actually RAN (an empty table must not pass)', () => {
  const r = runControls();
  for (const t of Object.values(TABLES)) {
    for (const id of t.controls) {
      assert.match(r.stdout, new RegExp(String.raw`^PASS ${id} `, 'm'), `${id} did not run`);
    }
  }
});

test('red controls: the baseline gate ran over the whole case table, per policy table', () => {
  // A literal count, not \d+ — dropping a case from either shared table would otherwise
  // leave both the runner and this wrapper green while covering less.
  const r = runControls();
  for (const [name, t] of Object.entries(TABLES)) {
    assert.match(r.stdout, new RegExp(String.raw`${t.banner}: all ${t.cases} cases pass`),
      `${name}: the case table changed size — re-pin its cases count deliberately\n${r.stdout}`);
    assert.match(r.stdout, new RegExp(String.raw`${t.banner}: ${t.subcases} sub-cases`),
      `${name}: a SUB-case was added or dropped — re-pin its subcases count deliberately\n${r.stdout}`);
  }
});
