// Reindex archive phase — extracted from cli/reindex.mjs in v0.8.
//
// Phase 7 ships standalone because its concerns (operator-facing report +
// best-effort checkpoint archival) are orthogonal to the swap mechanics
// in cli/lib/swap.mjs. The split was pure refactor.

import fs from 'node:fs/promises';

/**
 * Phase 7 (report) — print the operator-facing summary + restart instruction,
 * advance `phase_completed: 7`, and clean up the checkpoint state file.
 *
 * The restart instruction is load-bearing: the running server caches its
 * embedder and Memory client at boot, so even a successful alias swap won't
 * be observed by a long-running server until it restarts. The report makes
 * this requirement explicit.
 *
 * Cleanup behavior:
 *   • If `statePath` is provided, the state file is renamed to
 *     `<path>.archive.json` on a BEST-EFFORT basis. The atomic phase-advance
 *     (phase_completed=7) happens FIRST so the run is durably "complete" even
 *     if the rename fails. Archive failure is logged as a warning suggesting
 *     manual cleanup, but does not throw — a leftover state.json next to a
 *     phase=7 checkpoint is a non-fatal cleanup issue, not a correctness one.
 *   • Windows note: `fs.rename` over an existing target can throw
 *     `EEXIST`/`EPERM` (depending on Node version + filesystem). We mirror the
 *     unlink-fallback pattern from `server/lib/vault-write.mjs` to keep the
 *     happy path working on NTFS.
 *   • If the operator passed `--keep-old=false`, that decision is honored at
 *     the orchestrator level — phase 7 reports it, but the actual collection
 *     drop is delegated to a separate cleanup pass (out of scope for the
 *     phase-function unit; DE12's e2e exercises real cleanup).
 *
 * Atomic-phase-advance: same optional-state pattern as phases 4-6. Phase 7's
 * advance is the LAST checkpoint write; after it completes the next
 * `--resume` will see `phase_completed: 7` and exit cleanly with a "nothing
 * to do" message. The archive rename runs AFTER the atomic advance so the
 * durable "phase 7 complete" record exists even when archive fails.
 *
 * @param {object} params
 * @param {object} [params.state] - Mutable checkpoint state.
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint]
 * @param {string} [params.statePath] - Path to the checkpoint state file. When
 *   provided, the file is renamed to `<path>.archive.json` after the final
 *   atomic write so the state directory is clean for future runs.
 * @param {{ stdout?: { write: (s: string) => any } }} [params.io] - Output
 *   sink (DI for tests). Defaults to `process.stdout`.
 * @param {{ rename?: (a: string, b: string) => Promise<void>, unlink?: (p: string) => Promise<void> }} [params.fs]
 *   Filesystem injection (tests can stub rename + unlink without touching
 *   disk). `unlink` is invoked for the Windows EEXIST/EPERM fallback path.
 * @returns {Promise<{ archivedTo: string|null }>}
 */
export async function runPhase7Report({
  state,
  checkpoint,
  statePath,
  io = { stdout: process.stdout },
  fs: fsLike,
} = {}) {
  // Render summary + restart instruction. Use a defensive accessor so a stub
  // io.stdout that doesn't implement `write` doesn't crash the phase.
  const out = io && io.stdout && typeof io.stdout.write === 'function'
    ? io.stdout
    : { write: () => {} };

  const fromShape = state?.from
    ? `${state.from.provider}/${state.from.model}/${state.from.dim ?? '?'}`
    : '(no prior stamp)';
  const toShape = state?.to
    ? `${state.to.provider}/${state.to.model}/${state.to.dim ?? '?'}`
    : '(unknown)';
  const processedCount = Array.isArray(state?.processed_ids)
    ? state.processed_ids.length
    : (state?.processed_ids?.size ?? 0);
  const verify = state?.verify ?? null;

  out.write(
    `reindex complete; restart the server to load the new collection\n` +
    `From: ${fromShape}\n` +
    `To:   ${toShape}\n` +
    `Entries processed: ${processedCount}\n` +
    (state?.estimate
      ? `Estimate: ${state.estimate.entries} entries / ~${state.estimate.tokens} tokens / ~$${(state.estimate.cost_usd ?? 0).toFixed(4)} USD\n`
      : '') +
    (verify
      ? `Verify: matches=${verify.matches}` +
        (verify.expected != null ? ` (expected=${verify.expected}, actual=${verify.actual})` : '') +
        `\n`
      : '') +
    `Target collection: ${state?.target_collection ?? '(unknown)'}\n`,
  );

  // Atomic-phase-advance: this MUST happen before the archive rename so the
  // run is durably "complete" (phase_completed=7) even if the archive step
  // fails. A leftover state.json sitting next to a phase=7 checkpoint is a
  // cleanup issue, not a correctness issue — a subsequent --resume sees
  // phase_completed=7 and exits cleanly.
  if (state && checkpoint) {
    state.phase_completed = 7;
    await checkpoint.write(state);
  }

  // Archive checkpoint state file (BEST-EFFORT). Renaming preserves a
  // forensic trail without polluting the active state slot. On Windows,
  // fs.rename over an existing target throws EEXIST/EPERM — we mirror the
  // unlink-fallback pattern from server/lib/vault-write.mjs:124-130 to keep
  // the happy path working on NTFS. If the rename ultimately fails we warn
  // and continue (the run IS complete; archive is a janitor step).
  let archivedTo = null;
  if (statePath) {
    const fsImpl = fsLike ?? fs;
    if (typeof fsImpl.rename === 'function') {
      const target = `${statePath}.archive.json`;
      try {
        await fsImpl.rename(statePath, target);
        archivedTo = target;
      } catch (err) {
        if ((err.code === 'EEXIST' || err.code === 'EPERM') && typeof fsImpl.unlink === 'function') {
          // Windows: rename-over-existing not always atomic. Unlink target
          // then retry the rename once.
          try { await fsImpl.unlink(target); } catch { /* ignore */ }
          try {
            await fsImpl.rename(statePath, target);
            archivedTo = target;
          } catch (err2) {
            out.write(
              `[reindex] archive rename failed: ${err2.message}; manual cleanup of ${statePath} recommended\n`,
            );
          }
        } else {
          out.write(
            `[reindex] archive rename failed: ${err.message}; manual cleanup of ${statePath} recommended\n`,
          );
        }
      }
    }
  }

  return { archivedTo };
}
