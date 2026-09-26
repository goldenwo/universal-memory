// server/test/red-controls/controls-direction.test.mjs — makes the #276 direction red
// controls RUN, and pins WHICH.
//
// run-direction.mjs is not named `*.test.mjs`, so no glob reaches it on its own (see
// controls.test.mjs for why that matters: a control that runs nowhere automated rots
// silently). This wrapper is what the `test/red-controls/*.test.mjs` globs pick up.
//
// THE ROSTER AND CASE COUNT ARE PINNED BELOW, deliberately. Asserting only the success
// banner would pass with an EMPTY control array — the same "green while certifying strictly
// less" erosion the controls exist to prevent, one level up. Adding or removing a control,
// a case, or a sub-case must be a deliberate edit here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `cases` is the GROUP count in test/helpers/direction-policy-cases.mjs (K1, K2, D1-D11),
 * `subcases` the total sub-case count across those groups — pinned separately because the
 * group count alone cannot see a dropped sub-case. `banner` is the literal prefix
 * run-direction.mjs prints its baseline lines under.
 */
const PIN = {
  // #318: RCD3 added; D11 grew from 1 to 5 sub-cases (22 -> 26).
  controls: ['RCD1', 'RCD2', 'RCD3'], cases: 13, subcases: 26, banner: 'direction baseline',
};

function runControls() {
  // Child process: the runner signals via process.exitCode, and importing it would set the
  // exit code of the TEST RUNNER instead — a confusing non-zero exit rather than a named
  // failing test.
  const runner = fileURLToPath(new URL('./run-direction.mjs', import.meta.url));
  return spawnSync(process.execPath, [runner], { encoding: 'utf8' });
}

test('direction red controls: every control passes its own flip/survive table', () => {
  const r = runControls();
  assert.equal(r.status, 0, `direction red controls failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /all direction red controls behaved exactly as specified/);
});

test('direction red controls: the full roster actually RAN (an empty table must not pass)', () => {
  const r = runControls();
  for (const id of PIN.controls) {
    assert.match(r.stdout, new RegExp(String.raw`^PASS ${id} `, 'm'), `${id} did not run`);
  }
});

test('direction red controls: the baseline gate ran over the whole case table', () => {
  // Literal counts, anchored with `^` + the `'m'` flag — dropping a case or a sub-case from
  // the shared table would otherwise leave both the runner and this wrapper green while
  // covering less.
  const r = runControls();
  assert.match(r.stdout, new RegExp(String.raw`^${PIN.banner}: all ${PIN.cases} cases pass`, 'm'),
    `the direction case table changed size — re-pin its cases count deliberately\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(String.raw`^${PIN.banner}: ${PIN.subcases} sub-cases`, 'm'),
    `a direction SUB-case was added or dropped — re-pin its subcases count deliberately\n${r.stdout}`);
});
