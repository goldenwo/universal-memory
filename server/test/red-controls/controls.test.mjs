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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Every control that must actually execute. Update deliberately, never to make CI green. */
const CONTROLS = ['RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6'];

/** Case GROUPS in the shared table. Literal, so silently dropping one reddens this test. */
const CASE_COUNT = 13;

/**
 * SUB-cases across those groups. Pinned SEPARATELY because the group count cannot see a
 * dropped sub-case — and some groups have exactly one sub-case carrying the only guard for
 * a whole branch (U6's non-numeric-score case is the sole thing distinguishing the shipped
 * `typeof r.score !== 'number'` from a weaker `== null`, which would coerce a string score).
 */
const SUBCASE_COUNT = 21;

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
  for (const id of CONTROLS) {
    assert.match(r.stdout, new RegExp(String.raw`^PASS ${id} `, 'm'), `${id} did not run`);
  }
});

test('red controls: the baseline gate ran over the whole case table', () => {
  // A literal count, not \d+ — dropping a case from the shared table would otherwise leave
  // both the runner and this wrapper green while covering less.
  const r = runControls();
  assert.match(r.stdout, new RegExp(String.raw`baseline: all ${CASE_COUNT} cases pass`),
    `the case table changed size — re-pin CASE_COUNT deliberately\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(String.raw`baseline: ${SUBCASE_COUNT} sub-cases`),
    `a SUB-case was added or dropped — re-pin SUBCASE_COUNT deliberately\n${r.stdout}`);
});
