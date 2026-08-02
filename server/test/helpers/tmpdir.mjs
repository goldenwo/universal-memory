// server/test/helpers/tmpdir.mjs — the single way tests create temp dirs.
//
// WHY THIS EXISTS. Test temp dirs used to be created with a bare mkdtemp and
// abandoned. Measured 2026-08-02: ONE full server suite run left 308 dirs in
// the system temp dir, and ~82,000 `um-*` dirs had piled up on a dev box since
// April — 90% of everything in TMPDIR. Anything that scans the temp dir pays
// for that litter (an unrelated tool's SessionStart hook spent 4.2s per start
// walking it). The defect was never a cleanup call that failed; ~19 helper
// functions simply had no cleanup at all, and several files that did clean up
// used a trailing `rm` after the assertions, which is skipped on failure —
// exactly the runs that leak most.
//
// Registering cleanup HERE, once per test-file process, is what makes the leak
// unrepeatable: there is no per-call-site step left to forget, and cleanup no
// longer depends on the test reaching its own last line.
//
// Verified (server/test/tmpdir-no-leak.test.mjs drives each of these as a real
// child process and asserts an empty temp root): pass, assertion failure,
// async rejection, uncaught exception in a timer, and process.exit() mid-test.
// The `exit` listener is not redundant with `after` — it is the only one of the
// two that survives process.exit().
//
// KNOWN GAP, deliberate: a module-level `throw` during ESM evaluation kills the
// process without running `after` OR `exit` handlers, so dirs created at module
// scope before such a throw are unrecoverable. No mechanism can cover this, so
// call tempDir() inside a test rather than at module scope.
//
// Enforced by server/test/lint/no-raw-mkdtemp.test.mjs, which fails if a test
// file goes back to calling mkdtemp directly.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const created = [];

/**
 * mkdtemp with cleanup already arranged.
 *
 * @param {string} prefix Name prefix, e.g. 'um-oauth-ep-'. Keep the `um-`
 *   convention so a stray dir is still attributable to this project.
 * @returns {string} Absolute path to a fresh directory.
 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Drains `created`, so a second pass has nothing left to do — except for dirs
// the first pass could not remove, which are put back and retried at exit.
function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      // maxRetries is for Windows: a just-closed sqlite or log handle can hold
      // the file open for a few ms and yield EBUSY/EPERM on the first attempt.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Still held. On Windows an open better-sqlite3 handle locks its whole
      // directory, and THIS hook necessarily runs before the test file's own
      // `after` hooks: imports are evaluated first, so the `after(cleanup)`
      // below is registered before any hook the importing file declares. So a
      // failure here is expected whenever a file closes a DB in its own
      // `after` — requeue and let the `exit` pass, which runs strictly later,
      // collect it. A test run must never fail because of cleanup.
      created.push(dir);
    }
  }
}

after(cleanup);
process.on('exit', cleanup);
