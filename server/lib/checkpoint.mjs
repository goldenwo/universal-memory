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
//     C.11: B.10's manual loop has been replaced with the shared withRetry()
//     helper from retry.mjs. The legacy DI hooks (ctx.retryDelaysMs,
//     ctx.retryJitterMaxMs) are still honored for fast-running tests; they
//     are translated into withRetry opts (maxRetries / baseDelayMs / jitterMaxMs).
//     The per-attempt structured-warn log is preserved by intercepting
//     reindexFn rejections before re-throwing into withRetry.

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLockdir, releaseLockdir } from './lockdir.mjs';
import { summarize as defaultSummarize } from './summarize.mjs';
import { updateState as defaultUpdateState } from './update-state.mjs';
import { withRetry } from './retry.mjs';
import { getLogger } from './logger.mjs';
import { safeLog, obsFallback } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';
import { lockContentionsTotal } from './metrics.mjs';
import { applyDefaultProject, TOOL_IDS, validateLanePersonaSlug } from './default-project.mjs';
import { detectContradictionsInBatch as defaultDetectContradictions } from './contradiction-batch.mjs';
import { supersedePoint as defaultSupersedePoint } from './supersede.mjs';

// R1 review A1, fix #1: lock-contention metric. Stable label only — never
// raw lockdir paths (per-project expansion would explode cardinality).
function emitLockContentionMetric(lockPath) {
  try {
    lockContentionsTotal.inc({ lock_path: lockPath });
  } catch (e) {
    obsFallback(e, `metrics:lock_contentions:${lockPath}`);
  }
}

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

// Project slug validation lives in ./default-project.mjs (v1.1 F1).
// applyDefaultProject() handles the falsy → soft-default + invalid → null
// branches; this file no longer carries its own copy of the slug regex.
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
    // C.9 (§4.2.0): pino emit must never throw out of a checkpoint path.
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      component: 'checkpoint',
      path: tmpPath,
      err_message: err?.message ?? String(err),
    }, 'failed to mark orphan_summary'), 'log:checkpoint:orphan-mark-failed');
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
    project: rawProject,
    since = null,
    until = null,
    skip_state_merge = false,
    lane: rawLane = null,
    persona: rawPersona = null,
  } = args;

  // v1.1 F1 unification: falsy `project` → soft-default to UM_DEFAULT_PROJECT
  // (caller omitted; was a hard-fail before F1 per A1 audit finding F1+F5).
  // Wrong-type or regex-mismatch values still hard-fail — silently substituting
  // would lose the operator's signal and risk wrong-bucket session summaries.
  const project = applyDefaultProject({
    project: rawProject,
    tool: TOOL_IDS.MEMORY_CHECKPOINT,
    logger: getLogger(),
    requestId: currentRequestId(),
  });
  if (project === null) {
    return {
      schema_version: 1,
      ok: false,
      error: `invalid project: ${JSON.stringify(String(rawProject ?? '').slice(0, 64))}`,
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

  // D3.2: validate lane/persona slugs (same validator as add.mjs; throws INPUT_INVALID on bad input).
  // Absent (null/undefined/empty) is valid — the detector's own gate handles that case.
  let lane, persona;
  try {
    lane = validateLanePersonaSlug({ value: rawLane, fieldName: 'lane' });
    persona = validateLanePersonaSlug({ value: rawPersona, fieldName: 'persona' });
  } catch (slugErr) {
    return {
      schema_version: 1,
      ok: false,
      error: slugErr.message,
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

  // D3.2: DI hooks for the contradiction detector + supersede.
  // ctx.qdrantClient / ctx.collection / ctx.userId: operator-supplied partition context.
  // ctx._detectContradictions: injected in tests; defaults to real detectContradictionsInBatch.
  // ctx._supersede: injected in tests; defaults to real supersedePoint.
  const qdrantClient = ctx.qdrantClient ?? undefined;
  const collection = ctx.collection ?? undefined;
  const userId = ctx.userId ?? undefined;
  const _detectContradictions = ctx._detectContradictions ?? defaultDetectContradictions;
  const _supersede = ctx._supersede ?? defaultSupersedePoint;
  // Thresholds (D3.3 Task 3.2): two INDEPENDENT cutoffs. Pass through if set;
  // undefined lets the detector apply its own eval-derived default.
  //   - UM_AUTOSUPERSEDE_THRESHOLD           → judge-confidence gate (judgeThreshold)
  //   - UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD → embedding retrieval cosine (retrievalThreshold)
  const autoJudgeThreshold = process.env.UM_AUTOSUPERSEDE_THRESHOLD
    ? Number(process.env.UM_AUTOSUPERSEDE_THRESHOLD)
    : undefined;
  const autoRetrievalThreshold = process.env.UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD
    ? Number(process.env.UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD)
    : undefined;

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
        safeLog(() => getLogger().error({
          request_id: currentRequestId(),
          component: 'checkpoint',
          path: promptPath,
        }, 'summarize prompt missing'), 'log:checkpoint:prompt-missing');
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
    // R1 review A1, fix #1: contention metric. Stable label — raw path includes
    // the project slug, which would explode cardinality with N projects.
    emitLockContentionMetric('checkpoint:state');
    return { schema_version: 1, ok: false, error: 'checkpoint_in_progress' };
  }
  if (acquired && acquired._acquireError) {
    emitLockContentionMetric('checkpoint:state');
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
        // R1 review A1, fix #1: contention metric. Per-raw-file collisions
        // bucket under 'checkpoint:raw' for stable label cardinality.
        emitLockContentionMetric('checkpoint:raw');
        safeLog(() => getLogger().warn({
          request_id: currentRequestId(),
          component: 'checkpoint',
          file: f,
        }, 'could not acquire raw lock; skipping'), 'log:checkpoint:raw-lock-skip');
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
          safeLog(() => getLogger().warn({
            request_id: currentRequestId(),
            component: 'checkpoint',
            path: tmpSummaryPath,
            err_message: restageErr?.message ?? String(restageErr),
          }, 'phase-2 orphan re-stage failed'), 'log:checkpoint:phase2-orphan-failed');
        }
      }
      const isLockContention =
        phase2Err.code === 'EBUSY' || phase2Err.code === 'STATE_LOCK_CONTENTION';
      if (isLockContention) {
        // R1 review A1, fix #1: phase-2 rename / state.md write contention metric.
        emitLockContentionMetric('checkpoint:summary');
      }
      const out = {
        schema_version: 1,
        ok: false,
        error: isLockContention
          ? { code: 'STATE_LOCK_CONTENTION', message: `checkpoint phase 2: state.md update contention: ${phase2Err.message}` }
          : phase2Err.message ?? String(phase2Err),
      };
      return out;
    }

    // ----- D3.2: auto-supersession contradiction pass (flag-off by default) -----
    // Strict opt-in: ONLY the literal string 'true' enables this pass.
    // Runs after the durable summary write (absSummaryPath exists on disk),
    // before reindex — so a detection failure can never jeopardise the already-
    // persisted summary (spec §7 warn-not-throw; must never break the pipeline).
    //
    // The detector's own eligibility gate (!lane && !persona → return []) means
    // that when both are absent this block is a fast no-op even when the flag is on.
    //
    // reindexFn reads from disk (it receives summaryRelPath, a path string).
    // Appending the digest to absSummaryPath BEFORE reindex is therefore correct:
    // the digest travels into the index without any in-memory content patching.
    //
    // v1.2 flip (D3.3): ON by default — opt-out polarity (mirrors UM_DEDUP_ENABLED);
    // only the literal lowercase 'false' disables. The eligibility gate above keeps
    // this a fast no-op for unpartitioned (no lane/persona) checkpoints even when on.
    if (process.env.UM_AUTOSUPERSEDE_ENABLED !== 'false') {
      try {
        const detections = await _detectContradictions(transcript, {
          userId, lane, persona, collection, client: qdrantClient,
          judgeThreshold: autoJudgeThreshold,
          retrievalThreshold: autoRetrievalThreshold,
        });
        if (detections.length > 0) {
          for (const d of detections) {
            await _supersede({ client: qdrantClient, collection, id: d.targetId, supersededBy: d.supersededBy });
          }
          // Build the supersession digest block (spec §3.7 format).
          // One bullet per superseded pair: target, replacing, partition, confidence, reason, undo.
          const laneStr = lane || '-';
          const personaStr = persona || '-';
          const bullets = detections.map((d) =>
            `- target \`${d.targetId}\` → superseded by \`${d.supersededBy}\` (confidence ${d.confidence})\n` +
            `  - reason: ${String(d.reasoning ?? '').replace(/\s+/g, ' ').trim()}\n` +
            `  - undo: \`memory_supersede {"action":"unsupersede","id":"${d.targetId}"}\``
          ).join('\n');
          const digest =
            `\n\n## Auto-superseded (D3.2)\n\n` +
            `Partition: lane=${laneStr} persona=${personaStr}\n\n` +
            `${bullets}\n`;
          // Append to the already-written summary file so the digest is indexed
          // by the reindexFn that reads from disk below.
          await fs.appendFile(absSummaryPath, digest, 'utf8');
        }
      } catch (err) {
        safeLog(
          () => getLogger().warn({
            request_id: currentRequestId(),
            component: 'checkpoint',
            err_message: err?.message ?? String(err),
          }, 'auto-supersede pass failed (non-fatal)'),
          'log:checkpoint:autosupersede-failed',
        );
      }
    }

    // ----- B.10 Part C: blocking reindex with retry (spec §5.4) -----
    // memory_checkpoint is a consistency point — reindex BLOCKS the response.
    // 3 retries with 100/200/400 ms backoff + 0–retryJitterMaxMs ms jitter.
    // Retry-exhausted surfaces UPSTREAM_FAILURE (B.1 stable-codes table).
    //
    // C.11: now uses the shared withRetry() helper from retry.mjs. Legacy DI
    // hooks (ctx.retryDelaysMs, ctx.retryJitterMaxMs) are translated into
    // helper opts: the maxRetries count is the array length, baseDelayMs is
    // the first non-zero entry (or 0 if all zeros — fast-test case). When the
    // caller does not override, withRetry's own defaults (100ms base, 50ms
    // jitter, 3 retries) are used and exactly match the §5.4 spec.
    let attemptCount = 0;
    let lastReindexErr;
    let reindexSucceeded = false;
    try {
      const callerOverridesDelays =
        ctx.retryDelaysMs !== undefined || ctx.retryJitterMaxMs !== undefined;
      // R1 review A1, fix #1: thread op label for um_mem0_ops_total. Even when
      // tests override the timing knobs, the op label stays so the metric still
      // reflects every checkpoint reindex (success or fail).
      const retryOpts = callerOverridesDelays
        ? {
            // Legacy hooks: keep test backwards compat. retryDelaysMs.length is
            // the retry count; baseDelayMs/jitterMaxMs translate the per-step
            // values. Tests pass [0,0,0] + 0 to skip waits entirely.
            maxRetries: retryDelaysMs.length,
            baseDelayMs: retryDelaysMs[0] ?? 0,
            jitterMaxMs: retryJitterMaxMs,
            op: 'reindex',
          }
        : { op: 'reindex' }; // let withRetry honor UM_UPSTREAM_RETRY_MAX + spec defaults
      await withRetry(async () => {
        attemptCount += 1;
        try {
          await reindexFn(summaryRelPath);
        } catch (err) {
          lastReindexErr = err;
          // Preserve B.10's per-attempt warning log so operators can correlate
          // transient mem0/qdrant blips with checkpoint runs (B.1 observability).
          safeLog(() => getLogger().warn({
            request_id: currentRequestId(),
            component: 'checkpoint',
            attempt: attemptCount,
            project,
            err_message: err?.message ?? String(err),
          }, 'reindex attempt failed'), 'log:checkpoint:reindex-attempt-failed');
          throw err; // let withRetry decide whether to back off + try again
        }
      }, retryOpts);
      reindexSucceeded = true;
    } catch (wrappedErr) {
      // withRetry wraps the retry-exhausted error in { code: 'UPSTREAM_FAILURE',
      // cause: lastErr }. We preserve the legacy result envelope shape (string
      // count "after N retries" + diagnostic context) so existing tests that
      // assert on result.error.code keep working.
      void wrappedErr;
    }
    if (!reindexSucceeded) {
      const totalRetries = ctx.retryDelaysMs !== undefined ? retryDelaysMs.length : 3;
      return {
        schema_version: 1,
        ok: false,
        error: {
          code: 'UPSTREAM_FAILURE',
          message: `checkpoint reindex failed after ${totalRetries} retries: ${lastReindexErr?.message ?? String(lastReindexErr)}`,
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
