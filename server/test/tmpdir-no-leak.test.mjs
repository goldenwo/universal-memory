// server/test/tmpdir-no-leak.test.mjs — the temp-dir leak must not come back.
//
// History: test temp dirs were created with a bare mkdtemp and never removed.
// One full suite run left 308 dirs behind; ~82,000 `um-*` dirs had accumulated
// on a dev box since April (90% of everything in TMPDIR), and any tool that
// scanned the temp dir paid for it. See server/test/helpers/tmpdir.mjs.
//
// The fix has two halves, and so does this file's coverage:
//   1. Every call site goes through tempDir()  — enforced statically by
//      test/lint/no-raw-mkdtemp.test.mjs.
//   2. tempDir() cleans up even when the test does NOT reach its last line —
//      enforced here, by running a fixture in a child process once per failure
//      mode with an isolated TMPDIR and counting what survives.
//
// Half 2 is the one that matters: the original defect was not a cleanup call
// that failed, it was cleanup that was absent or trailing (skipped on failure).
// A test that only exercised the happy path would not have caught it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/tmpdir.mjs';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/tmpdir-leak-modes.fixture.mjs');

// Every way a test process can end. `pass` is the control; the rest are the
// paths a trailing `rm` would miss. `process-exit` skips node:test's `after`
// hooks entirely and is only survivable via the helper's `exit` listener.
const MODES = ['pass', 'assert-fail', 'async-reject', 'uncaught-timer', 'process-exit'];

// Runs the fixture with its own TMPDIR so nothing else on the box can be
// mistaken for a leftover, and returns the dirs the fixture says it created.
function runFixture(mode) {
  const root = tempDir('um-leaktest-root-');
  const record = join(tempDir('um-leaktest-rec-'), 'created.txt');
  writeFileSync(record, '');

  const env = {
    ...process.env,
    // All three: Node picks TMPDIR on POSIX, TEMP/TMP on Windows.
    TMPDIR: root, TEMP: root, TMP: root,
    LEAK_FIXTURE_MODE: mode,
    LEAK_FIXTURE_RECORD: record,
  };
  // node:test sets NODE_TEST_CONTEXT in its children. Inheriting it makes the
  // nested runner log "run() is being called recursively" and skip the file —
  // exiting 0 having run nothing, which would look exactly like a clean run.
  delete env.NODE_TEST_CONTEXT;

  // timeout: nothing above this applies one — node:test has no default per-test
  // timeout — so a fixture that hangs would wedge the whole suite until the
  // workflow-level timeout killed it, and the signal-killed children would then
  // leak their own temp dirs and make the sweep blame the wrong thing.
  const res = spawnSync(process.execPath, ['--test', FIXTURE], {
    encoding: 'utf8', env, timeout: 60_000, killSignal: 'SIGKILL',
  });

  const created = readFileSync(record, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  // Surfaced in every assertion below: when the child fails to run at all, the
  // bare counts are indistinguishable from a passing cleanup.
  const why = `mode=${mode} child_status=${res.status}${res.error ? ` spawn_error=${res.error.message}` : ''}\n${res.stderr || ''}`;
  return { root, created, why, signal: res.signal };
}

for (const mode of MODES) {
  test(`tempDir leaves nothing behind when a test ends via: ${mode}`, () => {
    const { root, created, why, signal } = runFixture(mode);

    // The fixture records its dir BEFORE branching on the mode, so an
    // unrecognised mode records 1 dir, falls through to its `default: throw`,
    // cleans up normally, and satisfies every assertion below. Renaming a MODE
    // entry would silently collapse all five termination paths into one generic
    // throw while this file stayed green — so prove the child took the path it
    // was asked to take, not merely that it cleaned up.
    assert.ok(!why.includes('unknown LEAK_FIXTURE_MODE'), `fixture did not recognise mode=${mode} — ${why}`);
    assert.notEqual(signal, 'SIGKILL', `fixture timed out for mode=${mode} — ${why}`);

    // Without this the assertions below would also pass if the fixture had
    // silently done nothing at all.
    assert.equal(created.length, 1, `fixture recorded ${created.length} dirs, expected 1 — ${why}`);
    assert.equal(existsSync(created[0]), false, `${created[0]} survived mode=${mode}`);
    assert.deepEqual(readdirSync(root), [], `isolated TMPDIR not empty after mode=${mode}`);
  });
}

// tempDir() is the single mandated holder of a recursive+force delete, and five
// call sites forward a caller-supplied prefix into it (api-stats, capture-events,
// control-routes, stats-payload, stats). These are the inputs that would put the
// delete somewhere other than a fresh child of the temp root.
test('tempDir rejects a prefix that would escape the temp root', () => {
  for (const bad of ['', '../escape-', 'a/b-', 'a\\b-', '..', null, undefined, 7]) {
    assert.throws(() => tempDir(bad), TypeError, `tempDir(${JSON.stringify(bad)}) should have thrown`);
  }
  // '' is the subtle one: path.join drops an empty segment, so it would create a
  // SIBLING of the temp root rather than a child — invisible to the CI sweep.
  assert.throws(() => tempDir(''), /non-empty/);
});

test('negative control: bypassing tempDir() DOES leak, so the checks above can see a leak', () => {
  const { root, created, why } = runFixture('raw-leak-control');

  assert.equal(created.length, 1, `control fixture recorded no dir — ${why}`);
  assert.equal(existsSync(created[0]), true, 'the unmanaged dir should have survived — the leak check may be looking in the wrong place');
  assert.deepEqual(
    readdirSync(root).map((e) => e.replace(/[A-Za-z0-9]{6}$/, '')),
    ['um-leakprobe-raw-'],
    'isolated TMPDIR should contain exactly the deliberately-leaked dir',
  );
});
