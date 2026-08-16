// server/lib/checkpoint.mjs — session-end checkpoint orchestration
//
// PR-1 rewrite (spec: docs/plans/2026-08-15-checkpoint-chunked-summarization-
// spec.md §4.5-§4.8). doCheckpoint is now ORCHESTRATION-ONLY: it owns the
// whole-run lock + heartbeat, the durable per-project cursor (checkpoint-
// cursor.mjs), the chunk-assembly loop (chunk-builder.mjs), and the run-level
// result envelope + HTTP-status error mapping (§4.6/§4.7). Every actual
// summarize -> two-phase write -> cursor advance -> auto-supersede -> reindex
// -> telemetry step for ONE chunk lives in checkpoint-chunk-txn.mjs
// (runChunkTransaction) — this file never writes a summary or state.md
// itself; it only acquires the run lock, resolves config, loads/advances the
// cursor loop, and (windowed mode only) assembles the legacy raw-file window.
//
// Two run modes:
//   - DEFAULT (no since/until): the durable cursor drives buildNextChunk in a
//     loop, up to max_chunks_per_run chunks, each committed as an
//     independently-crash-safe transaction (§4.5/§4.6). This is the no-loss,
//     at-least-once, idempotent-at-the-doc-layer path.
//   - WINDOWED (since and/or until supplied — §4.8): bypasses the durable
//     cursor entirely (no read, no write) — an intentionally duplicative,
//     ad-hoc re-summarization of an explicit date window. To avoid a second,
//     drifting copy of the summarize/write/reindex pipeline, the legacy
//     file-window assembly below feeds its single assembled transcript
//     through runChunkTransaction as ONE synthetic chunk, with
//     `prevCursor: null` + `skipCursorAdvance: true` (a no-cursor sentinel —
//     see checkpoint-chunk-txn.mjs's matching doc comment on that option).
//
// Stale-comment correction (spec §4.5.4): the old phase-2 comments here used
// to promise "next-session-start orphan recovery" — that client-side branch
// was retired under API-always (hooks/session-start.sh's own header says so)
// and no recovery code exists anywhere, in this file or the txn module it now
// delegates to. An orphaned `.tmp` simply means the chunk never committed, so
// its content is re-digested (default mode, via the un-advanced cursor) or
// re-assembled into the window (windowed mode, which never persists
// anything) on the next run — inert disk litter, not unfinished work.
// Orphan-litter cleanup stays a non-goal (spec §2).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLockdir, releaseLockdir } from './lockdir.mjs';
import { summarize as defaultSummarize } from './summarize.mjs';
import { updateState as defaultUpdateState } from './update-state.mjs';
import { getLogger } from './logger.mjs';
import { safeLog, obsFallback } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';
import { lockContentionsTotal } from './metrics.mjs';
import { applyDefaultProject, TOOL_IDS, validateLanePersonaSlug } from './default-project.mjs';
import { recordCaptureEvent, CAPTURE_EVENTS } from './capture-events.mjs';
import { loadCursor } from './checkpoint-cursor.mjs';
import { buildNextChunk } from './chunk-builder.mjs';
import { runChunkTransaction } from './checkpoint-chunk-txn.mjs';
import {
  resolveChunkingConfig, resolveFloor, makeTurnHeaderRe, HEARTBEAT_INTERVAL_MS,
  DEFAULT_MIN_TRANSCRIPT_BYTES, DEFAULT_MIN_TRANSCRIPT_TURNS,
} from './checkpoint-config.mjs';

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

// Project slug validation lives in ./default-project.mjs (v1.1 F1).
// applyDefaultProject() handles the falsy → soft-default + invalid → null
// branches; this file no longer carries its own copy of the slug regex.

// §4.4/§4.8: an absolute per-run assembly ceiling — WINDOWED MODE ONLY now.
// The default (cursor) path never reaches this: chunk math caps each chunk at
// chunk_max_bytes and the whole run at chunk_max_bytes × max_chunks_per_run
// (600KB with shipped defaults), both well under this 1MB DoS guard, and
// nothing is ever dropped there (backlog_remaining reports the remainder
// instead). Windowed mode has no chunk loop to bound it, so the legacy cap
// survives there unchanged (spec §4.4's last bullet).
const MAX_TRANSCRIPT_BYTES = 1024 * 1024; // 1 MB — DoS guard

const RAW_LOCK_TIMEOUT_MS = 5_000;

/**
 * Run a full session-end checkpoint for a project.
 *
 * @param {object} args
 * @param {string} args.project          - Project slug (required)
 * @param {string} [args.since]          - Window start ISO string (windowed mode, §4.8)
 * @param {string} [args.until]          - Window end ISO string (windowed mode, §4.8)
 * @param {boolean}[args.skip_state_merge] - If true, skip state.md merge
 * @param {string} [args.lane]           - D3.2 partition slug for the auto-supersede detector
 * @param {string} [args.persona]        - D3.2 partition slug for the auto-supersede detector
 * @param {object} [ctx]                 - DI overrides for testing
 * @param {object} [ctx.config]          - Config object (default: checkpoint.json)
 * @param {string} [ctx.vaultDir]        - Vault directory override
 * @param {Function}[ctx.summarizeFn]    - Summarize function override
 * @param {Function}[ctx.updateStateFn]  - updateState function override
 * @param {Function}[ctx.reindexFn]      - Reindex function override
 * @param {string} [ctx.model]           - Model override
 * @param {number[]}[ctx.retryDelaysMs]  - Test override for reindex retry backoff (default 100/200/400)
 * @param {number} [ctx.retryJitterMaxMs]- Test override for reindex retry jitter (default 50ms)
 * @param {number} [ctx.heartbeatIntervalMs] - Test override for the whole-run lock heartbeat (default 30s, §4.5)
 * @param {string} [ctx.systemPrompt]    - Test override for the summarize system prompt (default: read from disk once per run)
 * @param {object} [ctx.qdrantClient]    - D3.2 partitioned MCP context for the auto-supersede detector
 * @param {string} [ctx.collection]      - D3.2 partitioned MCP context for the auto-supersede detector
 * @param {string} [ctx.userId]          - D3.2 partitioned MCP context for the auto-supersede detector
 * @param {Function}[ctx._detectContradictions] - Test override for the D3.2 contradiction detector
 * @param {Function}[ctx._supersede]     - Test override for the D3.2 supersede call
 * @param {string} [ctx.surface]         - capture.checkpoint counter attribution (#159 spec §6)
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

  // Task-6 review MINOR 12: an empty/whitespace-only since/until string must
  // not silently select windowed mode (§4.8 bypasses the cursor entirely) —
  // treat it exactly like an absent field. Runs after the typeof guard above
  // so a genuinely wrong-typed value still reports its own INPUT_INVALID.
  const normalizedSince = typeof since === 'string' && since.trim() === '' ? null : since;
  const normalizedUntil = typeof until === 'string' && until.trim() === '' ? null : until;

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
  const chunkingCfg = resolveChunkingConfig(config);
  // #185 floors, resolved exactly as checkpoint-chunk-txn.mjs resolves them
  // for its own thin gate — this run layer needs the SAME resolved bytes
  // floor for two reasons: (1) chunk-builder.mjs's fill-to-floor rule
  // (§4.4, Task-6 review IMPORTANT 2) needs it threaded in as
  // `minChunkBytes` so it never hands the txn a sub-floor chunk while
  // content pends; (2) the abstention envelope's diagnostic log line
  // (MINOR 8) reports the floors that actually fired, not just the
  // resulting bytes/turns counts.
  const minTranscriptBytes = resolveFloor(
    'UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES', config.min_transcript_bytes, DEFAULT_MIN_TRANSCRIPT_BYTES);
  const minTranscriptTurns = resolveFloor(
    'UM_CHECKPOINT_MIN_TRANSCRIPT_TURNS', config.min_transcript_turns, DEFAULT_MIN_TRANSCRIPT_TURNS);

  // Load summarize system prompt (mirrors update-state.mjs prompt-resolution
  // priority). Per-run, not per-chunk: read once off disk here and threaded
  // into every chunk's txn as deps.systemPrompt — the txn module's own
  // contract documents that an omitted prompt silently degrades every chunk
  // to a generic, non-UM-format summary rather than failing, so loading it
  // once at the top of the run (ENOENT → error envelope, unchanged from
  // today) is this file's job, not checkpoint-chunk-txn.mjs's.
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

  // §4.5: whole-run lock heartbeat. lockdir.mjs's stale-recovery window drops
  // to 120s under low disk (DEFAULT_LOW_DISK_STALE_MS) — a multi-chunk run can
  // easily outlive that. Refreshing the lockdir's mtime on this cadence (well
  // under the low-disk threshold, by import — pinned in Task 8's I6 test)
  // makes takeover impossible for any LIVE run in every stale regime, while a
  // SIGKILLed run simply stops beating and stale recovery proceeds exactly as
  // today. Cleared in the same `finally` that releases the lock. Heartbeat
  // I/O errors warn, never throw (safeLog) — a missed refresh is not fatal to
  // the run in progress, only a (bounded, self-correcting) staleness risk.
  const heartbeatIntervalMs = ctx.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(() => {
    const now = new Date();
    fs.utimes(lockdir, now, now).catch((err) => {
      safeLog(() => getLogger().warn({
        request_id: currentRequestId(),
        component: 'checkpoint',
        project,
        err_message: err?.message ?? String(err),
      }, 'checkpoint heartbeat: lockdir mtime refresh failed'), 'log:checkpoint:heartbeat-failed');
    });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  try {
    // Run-start cost-cap check — the legacy exact 'cost cap hit' string
    // envelope (pinned, §8). Distinct from the txn's own per-chunk mid-run
    // cap check (stopped:{reason:'cost_cap'}, always a SUCCESS envelope —
    // chunks already committed this run stay committed).
    const today = new Date().toISOString().slice(0, 10);
    const costPath = path.join(vaultDir, '.telemetry', `${today}-${project}.count`);
    let daySpent = 0;
    try { daySpent = parseFloat(await fs.readFile(costPath, 'utf8')) || 0; } catch {}
    if (daySpent >= config.cost_cap_usd_per_day_per_project) {
      return { schema_version: 1, ok: false, error: 'cost cap hit' };
    }

    // DI deps shared by every runChunkTransaction call this run (default
    // mode's loop, or windowed mode's single synthetic chunk). Every field
    // left undefined here threads through to the txn module's own defaults
    // (real summarize/updateState/reindex/detectContradictions/supersede) —
    // exactly the same fallback contract this file used to apply itself.
    const txnDeps = {
      summarizeFn: ctx.summarizeFn ?? defaultSummarize,
      updateStateFn: ctx.updateStateFn ?? defaultUpdateState,
      reindexFn: ctx.reindexFn ?? (async () => {}),
      detectContradictions: ctx._detectContradictions,
      supersedePoint: ctx._supersede,
      qdrantClient: ctx.qdrantClient,
      collection: ctx.collection,
      userId: ctx.userId,
      systemPrompt,
      model: ctx.model,
      retryDelaysMs: ctx.retryDelaysMs,
      retryJitterMaxMs: ctx.retryJitterMaxMs,
    };

    // §4.8: since/until (either one) selects windowed mode — the cursor is
    // bypassed entirely. Neither present (or present-but-blank, MINOR 12
    // above) → the default, cursor-driven path.
    const isWindowed = normalizedSince !== null || normalizedUntil !== null;
    if (isWindowed) {
      return await runWindowedMode({
        vaultDir, project, since: normalizedSince, until: normalizedUntil, config, chunkingCfg, lane, persona,
        skipStateMerge: skip_state_merge, surface: ctx.surface, txnDeps, t0,
        minTranscriptBytes, minTranscriptTurns,
      });
    }
    return await runDefaultMode({
      vaultDir, project, config, chunkingCfg, lane, persona,
      skipStateMerge: skip_state_merge, surface: ctx.surface, txnDeps, t0,
      minTranscriptBytes, minTranscriptTurns,
    });
  } finally {
    clearInterval(heartbeatTimer);
    await releaseLockdir(lockdir);
  }
}

// ---------------------------------------------------------------------------
// Default (cursor-driven) run mode — spec §4.5/§4.6
// ---------------------------------------------------------------------------

/**
 * Default run mode. Loads the durable per-project cursor, then loops
 * chunk-builder.mjs (buildNextChunk) → checkpoint-chunk-txn.mjs
 * (runChunkTransaction) up to `chunkingCfg.maxChunksPerRun` times, threading
 * each committed chunk's `nextCursor` into the NEXT chunk's `prevCursor` —
 * max-persist (§4.1) only holds if threaded; this is a pinned integration
 * invariant (Task 5 carry #1), not an incidental detail.
 */
async function runDefaultMode({
  vaultDir, project, config, chunkingCfg, lane, persona, skipStateMerge, surface, txnDeps, t0,
  minTranscriptBytes, minTranscriptTurns,
}) {
  const { cursor: initialCursor } = await loadCursor({ vaultDir, project });

  // Bound acquire/release for chunk-builder's DI seam (spec §4.4: "bind
  // lockdir.mjs's acquire/release with RAW_LOCK_TIMEOUT_MS as today").
  const acquireLock = async (lockPath) => {
    const got = await acquireLockdir(lockPath, { timeoutMs: RAW_LOCK_TIMEOUT_MS });
    if (!got) {
      // Mirrors windowed mode's per-raw-file contention metric. Unlike
      // windowed mode's best-effort skip, the chunked path's response to
      // this is no-skip-ahead (I3): the RUN stops here, it never reads past
      // this file — see the raw_lock branch below.
      emitLockContentionMetric('checkpoint:raw');
      safeLog(() => getLogger().warn({
        request_id: currentRequestId(),
        component: 'checkpoint',
        project,
        file: path.basename(lockPath, '.lockdir'),
      }, 'could not acquire raw lock; run stops here (no-skip-ahead, I3)'), 'log:checkpoint:raw-lock-stop');
    }
    return got;
  };

  const acc = {
    chunksDone: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
    lastSummaryId: null, lastSummaryPath: null,
    stateUpdated: false, statePath: null,
  };
  const envCtx = { project, surface, t0, minBytes: minTranscriptBytes, minTurns: minTranscriptTurns };

  let cursor = initialCursor;
  const buildArgs = () => ({
    vaultDir, project, cursor, chunkMaxBytes: chunkingCfg.chunkMaxBytes,
    // §4.4 fill-to-floor (Task-6 review IMPORTANT 2): the SAME resolved
    // bytes floor the txn's own #185 gate uses, so the builder never hands
    // it a sub-floor chunk while content still pends — see chunk-builder.mjs's
    // matching doc comment.
    minChunkBytes: minTranscriptBytes,
    acquireLock, releaseLock: releaseLockdir,
  });

  for (let i = 0; i < chunkingCfg.maxChunksPerRun; i += 1) {
    const built = await buildNextChunk(buildArgs());

    if (built.exhausted) {
      // Backlog fully drained (or, on the very first iteration with zero
      // chunks committed, nothing was ever pending — indistinguishable in
      // effect from "pending but thin", so it gets the SAME abstention
      // envelope, matching the drain script's own framing (spec §5:
      // "nothing digestible pending") and the pinned no-captures-dir test.
      if (acc.chunksDone === 0) {
        return abstentionEnvelope(envCtx, { transcriptBytes: 0, transcriptTurns: 0 });
      }
      return successEnvelope(acc, envCtx, { backlogRemaining: false });
    }

    if (built.stopped?.reason === 'raw_lock') {
      // spec §4.4: "if a chunk came with it, run its txn first; then stop
      // with stopped:{reason:'raw_lock'}". A genuine terminal failure
      // (0-chunk provider failure / phase2 / cursor_write / reindex) or an
      // UNRELATED stop-the-loop success (cost_cap / provider partial) still
      // takes precedence — those are real, independent stop conditions that
      // happen to have landed on this same chunk. But round-2 review: a
      // THIN result here must NEVER be classified as complete (abstention
      // or thin_tail) — the builder stopped because the NEXT file is
      // transiently locked, not because nothing more exists (spec §4.4:
      // "only a TRUE end-of-corpus tail can ever be thin"; a `buildNextChunk`
      // `exhausted` signal — handled above, a separate branch — is the only
      // thing that means genuinely nothing pends). Intercepted BEFORE
      // classifyAndApply so its normal thin -> abstention/thin_tail mapping
      // (correct for every OTHER caller, including windowed mode, which
      // never has a raw_lock context) never fires here; symmetric across
      // chunksDone === 0 (would-be abstention) and chunksDone > 0
      // (would-be thin_tail) — both become backlog_remaining:true,
      // stopped:{reason:'raw_lock'} instead.
      if (built.chunk) {
        const txnResult = await runChunkTransaction(
          { vaultDir, project, chunk: built.chunk, prevCursor: cursor, config, chunkingCfg, lane, persona, surface, skipStateMerge },
          txnDeps,
        );
        if (txnResult.thin) {
          return successEnvelope(acc, envCtx, { backlogRemaining: true, stopped: { reason: 'raw_lock' } });
        }
        const outcome = classifyAndApply(txnResult, acc, envCtx);
        if (outcome.done) return outcome.envelope;
        cursor = outcome.nextCursor;
      }
      return successEnvelope(acc, envCtx, { backlogRemaining: true, stopped: { reason: 'raw_lock' } });
    }

    // Normal chunk.
    const txnResult = await runChunkTransaction(
      { vaultDir, project, chunk: built.chunk, prevCursor: cursor, config, chunkingCfg, lane, persona, surface, skipStateMerge },
      txnDeps,
    );
    const outcome = classifyAndApply(txnResult, acc, envCtx);
    if (outcome.done) return outcome.envelope;
    cursor = outcome.nextCursor;
  }

  // max_chunks_per_run reached without exhausting the backlog or otherwise
  // stopping. Peek one more chunk (never committed) purely to distinguish an
  // exact-fit finish (no more pending → no stopped reason) from real
  // remaining backlog (spec §4.6: chunk_cap is reported only "with more
  // pending").
  const peek = await buildNextChunk(buildArgs());
  if (peek.exhausted) {
    return successEnvelope(acc, envCtx, { backlogRemaining: false });
  }
  return successEnvelope(acc, envCtx, { backlogRemaining: true, stopped: { reason: 'chunk_cap' } });
}

// ---------------------------------------------------------------------------
// Windowed run mode — spec §4.8
// ---------------------------------------------------------------------------

/**
 * Windowed mode (since and/or until supplied). Bypasses the durable cursor
 * entirely: no read, no write. KEEPS the legacy raw-file window assembly +
 * MAX_TRANSCRIPT_BYTES truncation (an ad-hoc, intentionally duplicative
 * re-summarization of an explicit date range — not the crash-safe, idempotent
 * default path), then feeds the single assembled transcript through
 * runChunkTransaction as ONE synthetic chunk with `prevCursor: null` +
 * `skipCursorAdvance: true` (see that option's doc comment in
 * checkpoint-chunk-txn.mjs) rather than duplicating the summarize/write/
 * reindex pipeline a second time in this file.
 */
async function runWindowedMode({
  vaultDir, project, since, until, config, chunkingCfg, lane, persona, skipStateMerge, surface, txnDeps, t0,
  minTranscriptBytes, minTranscriptTurns,
}) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  const rawFiles = await fs.readdir(rawDir).catch(() => []);

  // Parse since/until into date strings (YYYY-MM-DD) for filename comparison.
  const sinceDate = since ? since.slice(0, 10) : null;
  const untilDate = until ? until.slice(0, 10) : new Date().toISOString().slice(0, 10);

  // Filter: only .md files whose YYYY-MM-DD prefix falls within [sinceDate, untilDate].
  const filteredFiles = rawFiles
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      const fileDate = f.slice(0, 10);
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
      // Best-effort read (unchanged legacy behavior for this ad-hoc path):
      // windowed mode has no cursor to resume from, so skipping a contended
      // file — rather than stopping the whole window, which the default
      // mode's no-skip-ahead rule requires — is the existing tradeoff here.
      emitLockContentionMetric('checkpoint:raw');
      safeLog(() => getLogger().warn({
        request_id: currentRequestId(),
        component: 'checkpoint',
        file: f,
      }, 'could not acquire raw lock; skipping'), 'log:checkpoint:raw-lock-skip');
      continue;
    }
    try {
      const chunkText = await fs.readFile(rawFilePath, 'utf8') + '\n\n';
      if (Buffer.byteLength(transcript + chunkText, 'utf8') > MAX_TRANSCRIPT_BYTES) {
        transcriptTruncated = true;
        break;
      }
      transcript += chunkText;
    } finally {
      await releaseLockdir(rawLockdir);
    }
  }

  const chunk = buildWindowedChunk({ transcript, filteredFiles, sinceDate });
  const txnResult = await runChunkTransaction(
    {
      vaultDir, project, chunk, prevCursor: null, config, chunkingCfg,
      lane, persona, surface, skipStateMerge, skipCursorAdvance: true,
    },
    txnDeps,
  );

  const acc = {
    chunksDone: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
    lastSummaryId: null, lastSummaryPath: null,
    stateUpdated: false, statePath: null,
  };
  const envCtx = { project, surface, t0, minBytes: minTranscriptBytes, minTurns: minTranscriptTurns };
  const outcome = classifyAndApply(txnResult, acc, envCtx);
  if (outcome.done) return outcome.envelope;

  // Windowed mode never loops (one chunk, no cursor) — a commit here always
  // means the whole requested window is done; there is no cursor-sense
  // "backlog" left to report.
  const envelope = successEnvelope(acc, envCtx, { backlogRemaining: false });
  // Legacy MAX_TRANSCRIPT_BYTES truncation is orthogonal to the chunked
  // path's backlog_remaining-derived alias (this window has no cursor/
  // backlog concept of its own) — carried through independently, exactly as
  // the pre-chunking code did (spec §4.8: "KEEP ... truncated: true").
  if (transcriptTruncated) envelope.truncated = true;
  return envelope;
}

/** Turn ISOs found in `transcript`, min/max by parsed epoch; falls back to file dates, then now(). */
function windowCoversRange(transcript, filteredFiles) {
  const headerRe = makeTurnHeaderRe('gm');
  let min = null;
  let max = null;
  for (const m of transcript.matchAll(headerRe)) {
    const iso = m[0].slice(3, m[0].indexOf(' ', 3));
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (min === null || ms < min.ms) min = { iso, ms };
    if (max === null || ms > max.ms) max = { iso, ms };
  }
  if (min && max) return { coversFrom: min.iso, coversUntil: max.iso };
  // Legacy headerless content (or genuinely no turns anywhere in the window):
  // fall back to the filtered files' own dates at UTC midnight — mirrors
  // chunk-builder.mjs's never-headered-blob fallback (spec §4.5 step 4).
  if (filteredFiles.length > 0) {
    return {
      coversFrom: `${filteredFiles[0].slice(0, 10)}T00:00:00.000Z`,
      coversUntil: `${filteredFiles[filteredFiles.length - 1].slice(0, 10)}T00:00:00.000Z`,
    };
  }
  const now = new Date().toISOString();
  return { coversFrom: now, coversUntil: now };
}

/**
 * Build the single synthetic §4.4-shaped chunk windowed mode feeds into
 * runChunkTransaction. startFile/startOffset/endFile/endOffset only need to
 * be stable and well-formed here (they feed the deterministic-summary-id
 * hash) — not byte-exact against any real cursor, since this mode never
 * reads or writes one (§4.8's no-cursor sentinel, skipCursorAdvance).
 */
function buildWindowedChunk({ transcript, filteredFiles, sinceDate }) {
  const turnCount = (transcript.match(makeTurnHeaderRe('gm')) ?? []).length;
  const { coversFrom, coversUntil } = windowCoversRange(transcript, filteredFiles);
  const startFile = filteredFiles[0] ?? `${sinceDate ?? '0000-00-00'}.md`;
  const endFile = filteredFiles[filteredFiles.length - 1] ?? startFile;
  return {
    text: transcript,
    turnCount,
    startFile,
    startOffset: 0,
    endFile,
    endOffset: Buffer.byteLength(transcript, 'utf8'),
    boundary: 'turn',
    coversFrom,
    coversUntil,
  };
}

// ---------------------------------------------------------------------------
// Shared: txn-result → envelope mapping (spec §4.6/§4.7) — used by both modes
// ---------------------------------------------------------------------------

/**
 * Translate one checkpoint-chunk-txn.mjs result into either a mutation of the
 * run-level accumulator (`committed` — loop continues, caller re-reads
 * `outcome.nextCursor`) or a terminal envelope to return immediately
 * (`done: true` — every other shape). This is the single place the §4.6/§4.7
 * txn-result → HTTP-envelope mapping lives, so default mode's loop and
 * windowed mode's single call can never drift apart.
 */
function classifyAndApply(txnResult, acc, envCtx) {
  if (txnResult.committed) {
    const c = txnResult.committed;
    acc.chunksDone += 1;
    acc.costUsd += c.costUsd;
    acc.tokensIn += c.tokensIn;
    acc.tokensOut += c.tokensOut;
    acc.lastSummaryId = c.summaryId;
    acc.lastSummaryPath = c.summaryPath;
    acc.stateUpdated = c.stateUpdated;
    acc.statePath = c.statePath;
    return { done: false, nextCursor: c.nextCursor };
  }

  // Ledger carry #3 (Task 5 → 6): thin on the FIRST chunk of this run
  // (chunks_done still 0) is the legacy abstention envelope, byte-for-byte —
  // the txn itself does not emit the 'abstained' counter; that happens here,
  // at the run layer. A thin TAIL after >=1 committed chunk is instead a
  // success with thin_tail:true (never the abstention envelope, spec §4.5.2).
  if (txnResult.thin) {
    if (acc.chunksDone === 0) {
      return {
        done: true,
        envelope: abstentionEnvelope(envCtx, {
          transcriptBytes: txnResult.transcriptBytes,
          transcriptTurns: txnResult.transcriptTurns,
        }),
      };
    }
    return { done: true, envelope: successEnvelope(acc, envCtx, { backlogRemaining: false, thinTail: true }) };
  }

  if (txnResult.stopped?.reason === 'cost_cap') {
    // §4.5 step 1: mid-run cap is ALWAYS a success envelope (chunks already
    // committed this run stay committed), unlike the run-start check above.
    return { done: true, envelope: successEnvelope(acc, envCtx, { backlogRemaining: true, stopped: { reason: 'cost_cap' } }) };
  }

  const f = txnResult.failed;
  if (f?.stage === 'summarize') {
    // §4.7: 0 chunks committed this run → structured UPSTREAM_FAILURE (502,
    // via httpStatusFor). >=1 already committed → 200 partial — never lose
    // work already durably on disk to report a failure on a LATER chunk.
    if (acc.chunksDone === 0) {
      return {
        done: true,
        envelope: {
          schema_version: 1,
          ok: false,
          error: { code: 'UPSTREAM_FAILURE', stage: 'summarize', provider_class: f.providerClass, message: f.message },
        },
      };
    }
    return {
      done: true,
      envelope: successEnvelope(acc, envCtx, {
        backlogRemaining: true,
        stopped: { reason: f.providerClass === 'ratelimit' ? 'provider_ratelimit' : 'provider_failure' },
      }),
    };
  }
  if (f?.stage === 'phase2') {
    // Ledger carry #2 (Task 5 → 6): restore the pinned STATE_LOCK_CONTENTION
    // 503 envelope + its metric from the txn's additive `code` field; every
    // other phase-2 failure keeps today's plain-string error shape (→400).
    const isLockContention = f.code === 'EBUSY' || f.code === 'STATE_LOCK_CONTENTION';
    if (isLockContention) emitLockContentionMetric('checkpoint:summary');
    return {
      done: true,
      envelope: {
        schema_version: 1,
        ok: false,
        error: isLockContention
          ? { code: 'STATE_LOCK_CONTENTION', message: `checkpoint phase 2: state.md update contention: ${f.message}` }
          : f.message,
      },
    };
  }
  if (f?.stage === 'cursor_write') {
    return {
      done: true,
      envelope: {
        schema_version: 1,
        ok: false,
        error: { code: 'SERVER_INTERNAL', stage: 'cursor_write', message: f.message },
      },
    };
  }
  if (f?.stage === 'reindex') {
    // Pinned 502 + note semantics preserved: summary_id/summary_path ride
    // alongside `error` (not nested inside it) — this is what session-end.sh
    // and the drain's per-doc /api/reindex retry branch consume today.
    return {
      done: true,
      envelope: {
        schema_version: 1,
        ok: false,
        error: { code: 'UPSTREAM_FAILURE', stage: 'reindex', message: f.message },
        summary_id: f.summaryId,
        summary_path: f.summaryPath,
      },
    };
  }

  // Defensive: runChunkTransaction's own contract (its JSDoc) enumerates
  // every shape it can return; anything else is a wiring bug in this
  // orchestrator, not a runtime condition callers should have to handle.
  throw new Error(`checkpoint: unrecognized chunk-transaction result shape: ${JSON.stringify(txnResult)}`);
}

/** §4.5.2's abstention envelope — unchanged shape, byte-for-byte (§8: "unchanged"). */
function abstentionEnvelope(envCtx, { transcriptBytes, transcriptTurns }) {
  // MINOR 8 (Task-6 review): min_bytes/min_turns restored to the run-layer
  // diagnostic log — the primary "why did it abstain?" signal (the resolved
  // floors that actually fired), not just the resulting bytes/turns counts.
  safeLog(() => getLogger().info({
    request_id: currentRequestId(),
    component: 'checkpoint',
    project: envCtx.project,
    transcript_bytes: transcriptBytes,
    transcript_turns: transcriptTurns,
    min_bytes: envCtx.minBytes,
    min_turns: envCtx.minTurns,
  }, 'thin transcript — abstaining from summary'), 'log:checkpoint:thin-abstain');
  recordCaptureEvent({
    surface: envCtx.surface,
    project: envCtx.project,
    event: CAPTURE_EVENTS.CHECKPOINT,
    outcome: 'abstained',
  });
  return {
    schema_version: 1,
    ok: true,
    skipped: 'thin_transcript',
    transcript_bytes: transcriptBytes,
    transcript_turns: transcriptTurns,
    duration_ms: Date.now() - envCtx.t0,
  };
}

/** §4.6 CheckpointSuccess envelope — additive fields layered onto the pinned base shape. */
function successEnvelope(acc, envCtx, { backlogRemaining, thinTail = false, stopped = null }) {
  const env = {
    schema_version: 1,
    ok: true,
    summary_id: acc.lastSummaryId,
    summary_path: acc.lastSummaryPath,
    state_updated: acc.stateUpdated,
    state_path: acc.statePath,
    cost_usd: acc.costUsd,
    tokens_in: acc.tokensIn,
    tokens_out: acc.tokensOut,
    duration_ms: Date.now() - envCtx.t0,
    chunks_done: acc.chunksDone,
    backlog_remaining: backlogRemaining,
  };
  if (thinTail) env.thin_tail = true;
  if (stopped) env.stopped = stopped;
  // §4.6: deprecated alias — `truncated: true` whenever backlog remains, so
  // the pre-chunking consumer of this field survives unchanged in spirit: it
  // now honestly means "more backlog remains; oldest digested first; cursor
  // resumes there" instead of "content was dropped".
  if (backlogRemaining) env.truncated = true;
  return env;
}
