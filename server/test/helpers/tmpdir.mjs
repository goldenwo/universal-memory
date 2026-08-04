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
// KNOWN GAPS, deliberate:
//   1. A module-level `throw` during ESM evaluation kills the process without
//      running `after` OR `exit` handlers, so dirs created at module scope
//      before such a throw are unrecoverable. No mechanism can cover this, so
//      call tempDir() inside a test rather than at module scope.
//   2. Termination by signal (Ctrl-C, a CI job cancellation, the runner killing
//      a hung file) runs no `exit` listener either, so an interrupted run leaks
//      everything it had open. Covering it means installing SIGINT/SIGTERM
//      handlers, which would clobber any a test installs — not worth it for a
//      case the CI sweep already catches on the next green run.
//
// Enforced by server/test/lint/no-raw-mkdtemp.test.mjs, which fails if a test
// file goes back to calling mkdtemp directly.

import { mkdtempSync, rmSync, writeSync } from 'node:fs';
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
  // Everything this function returns is later handed to a recursive+force
  // delete, and `prefix` is not always a literal — several call sites forward a
  // caller-supplied value. Two ways that bites, both rejected here rather than
  // discovered later: `path.join` DROPS an empty segment, so tempDir('') builds
  // a SIBLING of the temp root (verified: `<tmp>root` + 6 chars, not a child)
  // which the CI sweep cannot see; and a separator or `..` walks the delete
  // clean out of the temp dir.
  if (typeof prefix !== 'string' || prefix === '' || /[\\/]|\.\./.test(prefix)) {
    throw new TypeError(
      `tempDir(prefix): expected a non-empty name with no path separators or '..', got ${JSON.stringify(prefix)}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Drains `created`, so a second pass has nothing left to do — except for dirs
// the first pass could not remove, which are put back and retried at exit.
//
// `final` marks the exit pass: the last chance to remove anything, so a failure
// there is a real leak and gets reported rather than requeued into a list
// nothing will ever read again.
//
// Note there is deliberately no maxRetries/retryDelay here. rmSync ACCEPTS both
// and silently ignores them on the recursive path — measured on Node 25.2.1
// (win32) against a directory pinned by a live handle: {maxRetries:20,
// retryDelay:500} throws EPERM in 0.1 ms, identical to the default, where an
// honoured retry would have cost ~10 s. (Only the async fs.rm implements them,
// and async is unusable in an `exit` listener.) They read as a Windows
// transient-retry guard while doing nothing, so the two passes are the whole
// mechanism.
function cleanup(final) {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if (!final) {
        // Still held. On Windows an open better-sqlite3 handle locks its whole
        // directory, and THIS hook necessarily runs before the test file's own
        // `after` hooks: imports are evaluated first, so the `after` below is
        // registered before any hook the importing file declares. So a failure
        // here is expected whenever a file closes a DB in its own `after` —
        // requeue and let the `exit` pass, which runs strictly later, collect
        // it. A test run must never fail because of cleanup.
        created.push(dir);
      } else {
        // Out of passes. Say so: an unreported leak here is indistinguishable
        // from the pre-fix behaviour this helper exists to end, and it is
        // Windows-only, so the Linux CI sweep cannot see it either. writeSync
        // because an `exit` listener may not queue async work.
        writeSync(2, `um-tmpdir-leak: ${err.code ?? 'ERR'} ${dir}\n`);
      }
    }
  }
}

// KEEPING `after` IS DELIBERATE — decided 2026-08-03, pinned so it is not
// re-argued. A review round proposed dropping it and relying on the `exit`
// listener alone, since cleanup() is synchronous and `exit` runs strictly
// later, so `after` adds no coverage and is the only reason the requeue above
// exists. The stated hazard: because this module's `after` is registered at
// import time it necessarily runs BEFORE the importing file's own `after`, so
// on POSIX it rm -rf's the directory of a still-open better-sqlite3 handle
// before that file closes it.
//
// Real in shape, benign in effect. POSIX permits unlinking an open file and
// the descriptor stays valid, so sqlite's close path writes into an unlinked
// temp file and the bytes are discarded — which is exactly the desired outcome
// for a temp test DB. Linux CI has been green across this the whole time.
// Dropping it would be a simplification bought against a live suite with no
// demonstrated defect, so it is not taken. Revisit only if a real flake appears
// (symptom to look for: a sqlite "disk I/O error" or a WAL/journal complaint
// during a test file's own `after`, POSIX only).
after(() => cleanup(false));
process.on('exit', () => cleanup(true));
