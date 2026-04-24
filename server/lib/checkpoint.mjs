// server/lib/checkpoint.mjs — session-end checkpoint orchestration
//
// Pipeline order:
//   1. Validate project slug
//   2. Acquire lockdir (lockdir.mjs — atomic mkdir + stale recovery)
//   3. Cost-cap check (per-day, per-project telemetry file)
//   4. Read raw captures (per-file lockdir coordination)
//   5. Summarize transcript
//   6. Two-phase write summary file (phase-1: .tmp; phase-2: rename + state.md)
//   7. Blocking reindex (3x retry + UPSTREAM_FAILURE on exhaustion — §5.4)
//   8. Update telemetry
//   9. Release lockdir (finally)
//
// B.10 (v0.6) changes vs B.9 baseline:
//   • Part A: replaces `proper-lockfile` + inline mkdir(lockdir) with shared
//     acquireLockdir/releaseLockdir from lockdir.mjs (also B.9 in append-turn).
//   • Part B (spec §4.2.2 two-phase write):
//       phase-1: write <summary>.md.tmp
//       phase-2: rename .tmp → final, then update state.md (also two-phase)
//     Phase-2 failure rewrites the .tmp file with `status: orphan_summary`
//     frontmatter so next session-start can recover (see hooks/session-start.sh
//     orphan detection).
//   • Part C (spec §5.4 blocking reindex):
//     memory_checkpoint is a semantic consistency point — reindex MUST block
//     and retry 3x with 100/200/400ms backoff + 0-50ms jitter. Retry-exhausted
//     surfaces UPSTREAM_FAILURE (B.1 stable-codes table). Contrast: append-turn
//     (B.9) is best-effort fire-and-forget.
//     TODO(C.11): swap the manual retry loop here for the shared withRetry()
//     helper once retry.mjs lands. The constants RETRY_DELAYS_MS / JITTER_MAX_MS
//     here are the same values C.11 will adopt; the only delta is the helper
//     factoring + structured-log emission.

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLockdir, releaseLockdir } from './lockdir.mjs';
import { summarize as defaultSummarize } from './summarize.mjs';
import { updateState as defaultUpdateState } from './update-state.mjs';
import { getLogger } from './logger.mjs';
import { currentRequestId } from './request-context.mjs';

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(LIB_DIR, '../config/checkpoint.json');
const DEFAULT_SUMMARIZE_PROMPT_PATH = path.resolve(LIB_DIR, '../config/prompts/summarize.txt');

// B.12 followup: O_NOFOLLOW — refuse to follow symlinks at the open() syscall level.
// Closes the lstat→open TOCTOU race: even if an attacker swaps the path for
// a symlink between our lstat() check and our open(), the kernel rejects
// the open() with ELOOP and the redirection fails atomically.
//
// CRITICAL Windows compatibility: fsConstants.O_NOFOLLOW is `undefined` on
// Windows (NTFS has a different threat model — symlink creation requires
// SeCreateSymbolicLinkPrivilege). ORing `undefined` into open flags yields
// NaN, which fs.open rejects with ERR_INVALID_ARG_TYPE — meaning every vault
// write would fail on Windows. Coercing to 0 via `?? 0` makes the flag a
// no-op on Windows, preserving cross-platform writes. Windows-specific
// TOCTOU exposure is documented as a v0.7 hardening item; the existing
// lstat-based refusal upstream covers the lstat-refusal layer cross-platform.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const VALID_SLUG = /^[a-zA-Z0-9._-]+$/;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024; // 1 MB — DoS guard

// Spec §5.4 retry policy for blocking reindex
const DEFAULT_RETRY_DELAYS_MS = [100, 200, 400];
const DEFAULT_RETRY_JITTER_MAX_MS = 50;

const LOCK_TIMEOUT_MS = 10_000;
const RAW_LOCK_TIMEOUT_MS = 5_000;

/**
 * Rewrite a .tmp summary file to set `status: orphan_summary` in its frontmatter.
 * Best-effort: failures here are logged but not propagated — the original phase-2
 * error is what should surface to the caller.
 */
async function markOrphanSummary(tmpPath) {
  try {
    const content = await fs.readFile(tmpPath, 'utf8');
    // Insert `status: orphan_summary` immediately after the opening `---\n` line,
    // before any other frontmatter fields. Idempotent: if status: already exists,
    // replace it; else insert after the opening fence.
    let updated;
    if (/^status:\s*\S+$/m.test(content)) {
      updated = content.replace(/^status:\s*\S+$/m, 'status: orphan_summary');
    } else {
      updated = content.replace(/^---\n/, '---\nstatus: orphan_summary\n');
    }
    // B.12 followup: open with O_NOFOLLOW so a planted symlink at the .tmp
    // path is rejected atomically by the kernel (ELOOP on POSIX) instead of
    // followed and overwriting an attacker-chosen target. NOFOLLOW is a
    // no-op on Windows (constants.O_NOFOLLOW is undefined → coerced to 0).
    const fh = await fs.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
    try { await fh.writeFile(updated, 'utf8'); } finally { await fh.close(); }
  } catch (err) {
    getLogger().warn({
      request_id: currentRequestId(),
      component: 'checkpoint',
      path: tmpPath,
      err_message: err?.message ?? String(err),
    }, 'failed to mark orphan_summary');
  }
}

/**
 * Run a full session-end checkpoint for a project.
 *
 * @param {object} args
 * @param {string} args.project          - Project slug (required)
 * @param {string} [args.since]          - Window start ISO string (v0.5: reads all)
 * @param {string} [args.until]          - Window end ISO string (v0.5: reads all)
 * @param {boolean}[args.skip_state_merge] - If true, skip state.md merge
 * @param {object} [ctx]                 - DI overrides for testing
 * @param {object} [ctx.config]          - Config object (default: checkpoint.json)
 * @param {string} [ctx.vaultDir]        - Vault directory override
 * @param {Function}[ctx.summarizeFn]    - Summarize function override
 * @param {Function}[ctx.updateStateFn]  - updateState function override
 * @param {Function}[ctx.reindexFn]      - Reindex function override
 * @param {string} [ctx.model]           - Model override
 * @param {number[]}[ctx.retryDelaysMs]  - Test override for retry backoff (default 100/200/400)
 * @param {number} [ctx.retryJitterMaxMs]- Test override for retry jitter (default 50ms)
 * @returns {Promise<object>}
 */
export async function doCheckpoint(args, ctx = {}) {
  const {
    project,
    since = null,
    until = null,
    skip_state_merge = false,
  } = args;

  // Validate project slug
  if (!project || !VALID_SLUG.test(project)) {
    return {
      schema_version: 1,
      ok: false,
      error: `invalid project: ${JSON.stringify(String(project ?? '').slice(0, 64))}`,
      code: 'INPUT_INVALID',
    };
  }

  // C.8 (§4.2): typeof-string guard on caller-supplied since/until.
  // Both are passed to .slice(0, 10) below; non-string inputs (numeric
  // epoch, boolean, object) either throw TypeError or coerce silently
  // depending on Node version. Hard-fail at the lib boundary with
  // stable code:'INPUT_INVALID' so the HTTP layer (handleCheckpointRequest)
  // maps to 400 via the unified envelope (B.13).
  if (since !== null && since !== undefined && typeof since !== 'string') {
    return {
      schema_version: 1,
      ok: false,
      error: `field 'since' must be ISO 8601 string, got ${typeof since}`,
      code: 'INPUT_INVALID',
    };
  }
  if (until !== null && until !== undefined && typeof until !== 'string') {
    return {
      schema_version: 1,
      ok: false,
      error: `field 'until' must be ISO 8601 string, got ${typeof until}`,
      code: 'INPUT_INVALID',
    };
  }

  // Config + DI
  const config = ctx.config ?? JSON.parse(await fs.readFile(DEFAULT_CONFIG_PATH, 'utf8'));
  const vaultDir = ctx.vaultDir ?? process.env.UM_VAULT_DIR;
  const summarizeFn = ctx.summarizeFn ?? defaultSummarize;
  const updateStateFn = ctx.updateStateFn ?? defaultUpdateState;
  const reindexFn = ctx.reindexFn ?? (async () => {});
  const retryDelaysMs = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryJitterMaxMs = ctx.retryJitterMaxMs ?? DEFAULT_RETRY_JITTER_MAX_MS;

  // Load summarize system prompt (mirrors update-state.mjs prompt-resolution priority)
  let systemPrompt = ctx.systemPrompt;
  if (!systemPrompt) {
    const promptDir = process.env.UM_PROMPT_DIR;
    const promptPath = promptDir
      ? path.join(promptDir, 'summarize.txt')
      : DEFAULT_SUMMARIZE_PROMPT_PATH;
    try {
      systemPrompt = await fs.readFile(promptPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        getLogger().error({
          request_id: currentRequestId(),
          component: 'checkpoint',
          path: promptPath,
        }, 'summarize prompt missing');
        return {
          schema_version: 1,
          ok: false,
          error: 'summarize prompt file missing — check $UM_PROMPT_DIR or reinstall plugin',
        };
      }
      throw err;
    }
  }

  const t0 = Date.now();

  // B.10 Part A: acquire state.md lockdir via the shared lockdir.mjs primitive.
  // - Uses atomic mkdir + EEXIST contention (verified cross-process on NTFS / Linux / macOS).
  // - Adaptive stale recovery (10 min default, 2 min when disk < 100MB).
  // - Process-exit cleanup (SIGINT/SIGTERM/uncaughtException) of HELD set.
  const lockdir = path.join(vaultDir, 'state', project, 'state.md.lockdir');
  await fs.mkdir(path.dirname(lockdir), { recursive: true });
  const acquired = await acquireLockdir(lockdir, {
    timeoutMs: 0,                                // fail fast — caller can retry
    staleMs: config.lockdir_stale_timeout_ms,    // honor config-specified stale timeout
  }).catch((err) => {
    // Surface unexpected acquireLockdir errors as a clean ok:false envelope
    return { _acquireError: err };
  });
  if (acquired === false) {
    return { schema_version: 1, ok: false, error: 'checkpoint_in_progress' };
  }
  if (acquired && acquired._acquireError) {
    return { schema_version: 1, ok: false, error: `lock_acquire_failed: ${acquired._acquireError.code ?? acquired._acquireError.message}` };
  }

  try {
    // Cost cap check
    const today = new Date().toISOString().slice(0, 10);
    const costPath = path.join(vaultDir, '.telemetry', `${today}-${project}.count`);
    let daySpent = 0;
    try { daySpent = parseFloat(await fs.readFile(costPath, 'utf8')) || 0; } catch {}
    if (daySpent >= config.cost_cap_usd_per_day_per_project) {
      return { schema_version: 1, ok: false, error: 'cost cap hit' };
    }

    // Read raw captures — filter by since/until window, enforce MAX_TRANSCRIPT_BYTES cap.
    // B.10 Part A: per-raw-file coordination now uses lockdir.mjs (sibling .lockdir),
    // not proper-lockfile's .lock. This keeps the cross-process story consistent with
    // append-turn writes (B.9) which use the same .lockdir convention. Bash stop.sh
    // continues to use perl flock against the .lock path — the cross-process race
    // between bash-perl and node-lockdir is the same as v0.5 (documented, low risk
    // in practice; B.11 will migrate the bash side to .lockdir to close it).
    const rawDir = path.join(vaultDir, 'captures', project, 'raw');
    const rawFiles = await fs.readdir(rawDir).catch(() => []);

    // Parse since/until into date strings (YYYY-MM-DD) for filename comparison
    const sinceDate = since ? since.slice(0, 10) : null;
    const untilDate = until ? until.slice(0, 10) : new Date().toISOString().slice(0, 10);

    // Filter: only .md files whose YYYY-MM-DD prefix falls within [sinceDate, untilDate]
    const filteredFiles = rawFiles
      .filter(f => f.endsWith('.md'))
      .filter(f => {
        const fileDate = f.slice(0, 10); // YYYY-MM-DD prefix
        if (sinceDate && fileDate < sinceDate) return false;
        if (untilDate && fileDate > untilDate) return false;
        return true;
      })
      .sort();

    let transcript = '';
    let transcriptTruncated = false;
    for (const f of filteredFiles) {
      const rawFilePath = path.join(rawDir, f);
      const rawLockdir = rawFilePath + '.lockdir';
      const rawAcquired = await acquireLockdir(rawLockdir, { timeoutMs: RAW_LOCK_TIMEOUT_MS });
      if (!rawAcquired) {
        // Skip this file rather than fail the whole checkpoint — best-effort read,
        // matches v0.5 proper-lockfile behavior on contention.
        getLogger().warn({
          request_id: currentRequestId(),
          component: 'checkpoint',
          file: f,
        }, 'could not acquire raw lock; skipping');
        continue;
      }
      try {
        const chunk = await fs.readFile(rawFilePath, 'utf8') + '\n\n';
        if (Buffer.byteLength(transcript + chunk, 'utf8') > MAX_TRANSCRIPT_BYTES) {
          transcriptTruncated = true;
          break;
        }
        transcript += chunk;
      } finally {
        await releaseLockdir(rawLockdir);
      }
    }
    if (transcriptTruncated) {
      transcript += `\n\n[transcript truncated at ${MAX_TRANSCRIPT_BYTES} bytes; use since=<date> to window the checkpoint]\n`;
    }

    // Summarize (pass systemPrompt so the curated UM format is used, not generic output)
    const { summary, costUsd, tokensIn, tokensOut } = await summarizeFn(transcript, {
      backend: process.env.UM_SUMMARIZER,
      model: ctx.model ?? config.summary_model,
      systemPrompt,
    });

    // ----- B.10 Part B: two-phase write -----
    // Phase 1: write <summary>.md.tmp with full frontmatter (no `status:` field —
    //          a successful phase-2 leaves the final file un-statused; phase-2
    //          failure rewrites the .tmp with `status: orphan_summary`).
    // Phase 2: atomic rename → final, then update state.md (itself two-phase).
    //          Failures in phase-2 leave the .tmp with status: orphan_summary
    //          for next-session-start orphan recovery.
    const summaryId = `session-${today}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const summaryRelPath = `sessions/${project}/${summaryId}.md`;
    const absSummaryPath = path.join(vaultDir, summaryRelPath);
    const tmpSummaryPath = absSummaryPath + '.tmp';
    await fs.mkdir(path.dirname(absSummaryPath), { recursive: true });

    // Symlink guards on both .tmp and final paths (preserves Fix 3 from v0.5).
    const tmpSymCheck = await fs.lstat(tmpSummaryPath).catch(() => null);
    if (tmpSymCheck && tmpSymCheck.isSymbolicLink()) {
      return { schema_version: 1, ok: false, error: 'target is a symlink; refusing to write' };
    }
    const summaryStatCheck = await fs.lstat(absSummaryPath).catch(() => null);
    if (summaryStatCheck && summaryStatCheck.isSymbolicLink()) {
      return { schema_version: 1, ok: false, error: 'target is a symlink; refusing to write' };
    }

    // Frontmatter — reindexDoc requires type/id/title to index into mem0.
    const now = new Date();
    const frontmatter = [
      '---',
      `type: session_summary`,
      `id: ${summaryId}`,
      `title: Session summary ${today} for ${project}`,
      `project: ${project}`,
      `valid_from: ${now.toISOString()}`,
      `tokens_in: ${tokensIn}`,
      `tokens_out: ${tokensOut}`,
      `cost_usd: ${costUsd.toFixed(6)}`,
      '---',
      '',
    ].join('\n');
    const summaryWithFm = frontmatter + summary;

    // Phase 1: write .tmp
    // B.12 followup: open with O_NOFOLLOW so a planted symlink at the .tmp
    // path is rejected atomically by the kernel (ELOOP on POSIX) instead of
    // followed and overwriting an attacker-chosen target. NOFOLLOW is a
    // no-op on Windows (constants.O_NOFOLLOW is undefined → coerced to 0).
    {
      const fh = await fs.open(tmpSummaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
      try { await fh.writeFile(summaryWithFm, 'utf8'); } finally { await fh.close(); }
    }

    // Phase 2: update state.md first, then rename .tmp → final.
    // Ordering rationale: state.md is the contention-prone path (lockdir,
    // disk-full, lstat symlink check). If state.md update fails, the summary
    // .tmp is still in place — markOrphanSummary marks it for recovery and we
    // never advance to the rename. If rename fails AFTER state.md succeeds
    // (rare: EBUSY on Windows, ENOSPC mid-rename), the state.md references a
    // summary that exists only as `.tmp`; we still mark it orphan_summary so
    // session-start recovery can re-attempt the rename to its canonical name.
    let stateUpdated = false;
    let statePath = null;
    try {
      // State.md merge (also two-phase: state.md.tmp → rename to state.md)
      if (!skip_state_merge) {
        const oldStatePath = path.join(vaultDir, 'state', project, 'state.md');
        let oldStateMd = '';
        try { oldStateMd = await fs.readFile(oldStatePath, 'utf8'); } catch {}
        const stateResult = await updateStateFn(
          { oldStateMd, newSummary: summary, projectId: project },
          { summarizeFn },
        );
        // Symlink guard on state.md target before rename (preserves Fix 3).
        const stateSymCheck = await fs.lstat(oldStatePath).catch(() => null);
        if (stateSymCheck && stateSymCheck.isSymbolicLink()) {
          return { schema_version: 1, ok: false, error: 'target is a symlink; refusing to write' };
        }
        const stateTmpPath = oldStatePath + '.tmp';
        // B.12 followup: open with O_NOFOLLOW so a planted symlink at the .tmp
        // path is rejected atomically by the kernel (ELOOP on POSIX) instead of
        // followed and overwriting an attacker-chosen target. NOFOLLOW is a
        // no-op on Windows (constants.O_NOFOLLOW is undefined → coerced to 0).
        {
          const fh = await fs.open(stateTmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
          try { await fh.writeFile(stateResult.mergedMd, 'utf8'); } finally { await fh.close(); }
        }
        await fs.rename(stateTmpPath, oldStatePath);
        stateUpdated = true;
        statePath = `state/${project}/state.md`;
      }

      // Final rename — the summary becomes durably reachable at its canonical path.
      await fs.rename(tmpSummaryPath, absSummaryPath);
    } catch (phase2Err) {
      // Phase 2 failed. Mark the .tmp (if still present) as orphan_summary so
      // next-session-start orphan recovery can finish the job. If rename
      // succeeded but state.md failed first (impossible with the ordering
      // above), we'd re-stage a .tmp; the ordering keeps that branch dead but
      // we keep the safety net for defensive future edits.
      const tmpStillThere = await fs.stat(tmpSummaryPath).catch(() => null);
      if (tmpStillThere) {
        await markOrphanSummary(tmpSummaryPath);
      } else {
        try {
          // B.12 followup: open with O_NOFOLLOW so a planted symlink at the
          // .tmp path is rejected atomically by the kernel (ELOOP on POSIX)
          // instead of followed and overwriting an attacker-chosen target.
          // NOFOLLOW is a no-op on Windows (constants.O_NOFOLLOW is undefined
          // → coerced to 0).
          const fh = await fs.open(tmpSummaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
          try { await fh.writeFile(summaryWithFm, 'utf8'); } finally { await fh.close(); }
          await markOrphanSummary(tmpSummaryPath);
        } catch (restageErr) {
          getLogger().warn({
            request_id: currentRequestId(),
            component: 'checkpoint',
            path: tmpSummaryPath,
            err_message: restageErr?.message ?? String(restageErr),
          }, 'phase-2 orphan re-stage failed');
        }
      }
      const isLockContention =
        phase2Err.code === 'EBUSY' || phase2Err.code === 'STATE_LOCK_CONTENTION';
      const out = {
        schema_version: 1,
        ok: false,
        error: isLockContention
          ? { code: 'STATE_LOCK_CONTENTION', message: `checkpoint phase 2: state.md update contention: ${phase2Err.message}` }
          : phase2Err.message ?? String(phase2Err),
      };
      return out;
    }

    // ----- B.10 Part C: blocking reindex with retry (spec §5.4) -----
    // memory_checkpoint is a consistency point — reindex BLOCKS the response.
    // 3 retries with 100/200/400 ms backoff + 0–retryJitterMaxMs ms jitter.
    // Retry-exhausted surfaces UPSTREAM_FAILURE (B.1 stable-codes table).
    // TODO(C.11): replace this manual loop with the shared withRetry() helper
    //             in server/lib/retry.mjs once it lands.
    let reindexErr;
    let reindexSucceeded = false;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        await reindexFn(summaryRelPath);
        reindexSucceeded = true;
        break;
      } catch (err) {
        reindexErr = err;
        getLogger().warn({
          request_id: currentRequestId(),
          component: 'checkpoint',
          attempt: attempt + 1,
          project,
          err_message: err?.message ?? String(err),
        }, 'reindex attempt failed');
        if (attempt === retryDelaysMs.length) break; // budget exhausted
        const delay = retryDelaysMs[attempt] + Math.floor(Math.random() * (retryJitterMaxMs + 1));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (!reindexSucceeded) {
      return {
        schema_version: 1,
        ok: false,
        error: {
          code: 'UPSTREAM_FAILURE',
          message: `checkpoint reindex failed after ${retryDelaysMs.length} retries: ${reindexErr?.message ?? String(reindexErr)}`,
        },
        // Diagnostic context — caller can surface or log
        summary_id: summaryId,
        summary_path: summaryRelPath,
      };
    }

    // Update per-day telemetry
    try {
      await fs.mkdir(path.dirname(costPath), { recursive: true });
      // B.12 followup: open with O_NOFOLLOW so a planted symlink at the
      // telemetry path is rejected atomically by the kernel (ELOOP on POSIX)
      // instead of followed and overwriting an attacker-chosen target.
      // NOFOLLOW is a no-op on Windows (constants.O_NOFOLLOW is undefined
      // → coerced to 0).
      const fh = await fs.open(costPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
      try { await fh.writeFile(String(daySpent + costUsd), 'utf8'); } finally { await fh.close(); }
    } catch {}

    const result = {
      schema_version: 1,
      ok: true,
      summary_id: summaryId,
      summary_path: summaryRelPath,
      state_updated: stateUpdated,
      state_path: statePath,
      cost_usd: costUsd,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      duration_ms: Date.now() - t0,
    };
    if (transcriptTruncated) result.truncated = true;
    return result;
  } finally {
    await releaseLockdir(lockdir);
  }
}
