// server/test/red-controls/controls.test.mjs — makes the red controls RUN.
//
// WHY THIS FILE EXISTS AT ALL. `run.mjs` is not named `*.test.mjs`, and every automated
// path globs only `test/*.test.mjs` / `test/*/*.test.mjs` (server/package.json's test
// script and both smoke.yml steps). So the controls — the thing that converts "the tests
// pass" into "the tests would FAIL if the policy broke" — were reachable only by someone
// typing the command by hand, and would have rotted silently the moment ranking.mjs moved.
// Worse, their failure mode on drift is a thrown mutation-anchor error nobody would see.
//
// This wrapper is deliberately thin: `run.mjs` keeps its standalone CLI behaviour (it sets
// process.exitCode and prints a per-control report, which is what you want when iterating),
// and this file just makes the existing globs pick it up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('red controls RC1-RC5 all behave exactly as their table specifies', () => {
  // Run as a child process: run.mjs signals via process.exitCode, and importing it would
  // set the exit code of the TEST runner instead — a failure that would surface as a
  // confusing non-zero exit rather than a named failing test.
  const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [runner], { encoding: 'utf8' });

  // Surface the runner's own report on failure — it names which control misbehaved and in
  // which direction, which is the whole diagnostic value.
  assert.equal(r.status, 0, `red controls failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /all red controls behaved exactly as specified/);
  assert.match(r.stdout, /baseline: all \d+ cases pass/, 'the baseline gate must have run');
});
