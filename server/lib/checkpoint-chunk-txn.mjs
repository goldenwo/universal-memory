// server/lib/checkpoint-chunk-txn.mjs — the per-chunk checkpoint transaction
// (spec §4.5/§4.7/§4.8, docs/plans/2026-08-15-checkpoint-chunked-
// summarization-spec.md; interface decisions from .superpowers/sdd/2026-08-15-
// checkpoint-chunked-summarization-plan/task-5-brief.md).
//
// THIS MODULE OWNS THE ARC'S CRASH-SAFETY INVARIANT (I5): the ordering of the
// steps below is not incidental — it IS the contract. Cursor advance (step 5)
// happens strictly AFTER the summary's durable rename (step 4) and strictly
// BEFORE reindex (step 7):
//   - crash between step 4 and step 5 → the chunk is re-digested next run
//     (the cursor never advanced past it) — a duplicate doc, never a loss.
//   - crash between step 5 and step 7 → a durable-but-unindexed doc, which is
//     today's existing UPSTREAM_FAILURE surface (the caller's own §4.7 502).
// Every returned shape mirrors exactly which side of that line the failure
// landed on — see the JSDoc on runChunkTransaction for the full envelope.
//
// This is a per-CHUNK transaction only: the caller (checkpoint.mjs, ported in
// Task 6) owns the whole-run lock, the lock heartbeat, cursor load/init, the
// chunk-assembly loop (chunk-builder.mjs), and the run-level result envelope
// (§4.6/§4.7 mapping to HTTP status). This module never acquires or releases
// any lock, and never throws — every code path below returns one of the
// documented shapes, so a caller can loop chunk-by-chunk without a top-level
// try/catch of its own.
//
// Porting note (temporary, deliberate duplication — Task 6 deletes the
// original checkpoint.mjs pipeline block and its markOrphanSummary once the
// orchestrator is re-pointed at this module): markOrphanSummary, the NOFOLLOW
// symlink-guard pattern, the two-phase write, the D3.2/D3.3 auto-supersede
// pass, and the blocking-reindex withRetry wiring are ported near-verbatim
// from server/lib/checkpoint.mjs:122-149 and :426-745. Deviations from that
// block are called out inline and summarized in the task-5 report.

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';
import { withRetry } from './retry.mjs';
import { summarize as defaultSummarize } from './summarize.mjs';
import { updateState as defaultUpdateState } from './update-state.mjs';
import { detectContradictionsInBatch as defaultDetectContradictions } from './contradiction-batch.mjs';
import { supersedePoint as defaultSupersedePoint, isAutoSupersedeEnabled as defaultIsAutoSupersedeEnabled } from './supersede.mjs';
import { recordCaptureEvent as defaultRecordCaptureEvent, CAPTURE_EVENTS } from './capture-events.mjs';
import { advanceCursor } from './checkpoint-cursor.mjs';
import { resolveFloor, DEFAULT_MIN_TRANSCRIPT_BYTES, DEFAULT_MIN_TRANSCRIPT_TURNS } from './checkpoint-config.mjs';
import { ProviderError } from './provider/errors.mjs';

// B.12-style hardening (checkpoint.mjs): refuse to follow symlinks at the
// open() syscall level. undefined on Windows → coerced to a no-op via `?? 0`
// (NTFS has a different threat model; the lstat-based guards below still
// apply cross-platform).
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// Spec §5.4 retry policy for blocking reindex (mirrors checkpoint.mjs's
// module-private constants — not exported there, so duplicated here; same
// house pattern as NOFOLLOW / MAX_TRANSCRIPT_BYTES-style constants already
// duplicated across the checkpoint-* modules).
const DEFAULT_RETRY_DELAYS_MS = [100, 200, 400];
const DEFAULT_RETRY_JITTER_MAX_MS = 50;

// §4.8: the same 3000-char cap update-state.mjs enforces on its own output.
// update-state.mjs's STATE_CAP_CHARS/truncateToCap are module-private (task-5
// brief constrains that file to ONLY the additive `ok: true` change), so the
// cap + truncation algorithm are ported byte-for-byte here for the degrade
// path below, which constructs mergedMd itself and therefore bypasses
// update-state.mjs's own capping. Keep in sync manually if the cap or
// algorithm there ever changes.
const STATE_CAP_CHARS = 3000;
function truncateStateToCap(md, cap) {
  const fmMatch = md.match(/^(---\n[\s\S]*?\n---\n)/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const body = md.slice(fm.length);
    const bodyCap = cap - fm.length - 5; // 5 = '\n...'.length + 1 for newline before it
    return `${fm}${body.slice(0, bodyCap)}\n...`;
  }
  return `${md.slice(0, cap - 5)}\n...`;
}

// §4.8 degrade marker — appended when the state-merge LLM call fails, returns
// a malformed shape, or times out. Distinct from update-state.mjs's own
// internal `<!-- llm-merge-failed, appended raw -->` marker (that one fires
// when update-state.mjs's OWN prompt-missing/LLM-throw fallback runs; this
// one fires when THIS module degrades around update-state.mjs entirely —
// timeout, or a resolved-but-unusable result).
const STATE_MERGE_UNAVAILABLE_MARKER = '<!-- state-merge-unavailable -->';

/**
 * Rewrite a .tmp summary file to set `status: orphan_summary` in its
 * frontmatter. Best-effort: failures here are logged but not propagated.
 *
 * Ported verbatim from checkpoint.mjs:122-149 (task-5 brief: "markOrphanSummary
 * semantics are COPIED here for now — Task 6 deletes the original"). The
 * stale "next-session-start orphan recovery" framing from the original's
 * comment is corrected per spec §4.5 step 4: no recovery mechanism exists or
 * ships; an orphaned .tmp simply means the chunk never committed, so its
 * content is re-digested next run — inert disk litter, not unfinished work.
 */
async function markOrphanSummary(tmpPath) {
  try {
    const content = await fs.readFile(tmpPath, 'utf8');
    let updated;
    if (/^status:\s*\S+$/m.test(content)) {
      updated = content.replace(/^status:\s*\S+$/m, 'status: orphan_summary');
    } else {
      updated = content.replace(/^---\n/, '---\nstatus: orphan_summary\n');
    }
    const fh = await fs.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
    try { await fh.writeFile(updated, 'utf8'); } finally { await fh.close(); }
  } catch (err) {
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      component: 'checkpoint-chunk-txn',
      path: tmpPath,
      err_message: err?.message ?? String(err),
    }, 'failed to mark orphan_summary'), 'log:checkpoint-chunk-txn:orphan-mark-failed');
  }
}

/**
 * Race `promise` against a `ms`-timeout. The loser is discarded (house
 * pattern — server/lib/bouncer.mjs's withTimeout): a late resolution/rejection
 * of a timed-out promise has nothing attached to it and can never mutate the
 * value this function already returned/threw. JS has no true cancellation, so
 * a timed-out summarize/state-merge/autosupersede call may still complete its
 * side effects in the background after this function moves on — the caller's
 * degrade paths are written to tolerate that (see §4.5 step 5b's documented
 * crash/timeout residual).
 */
function raceTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'TIMEOUT' }));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/** ProviderError.class ('PROVIDER_RATELIMIT'|'PROVIDER_CONFIG'|'PROVIDER_UPSTREAM') → §4.7 provider_class. Non-ProviderError (incl. our own TIMEOUT sentinel) → 'upstream'. */
function classifySummarizeError(err) {
  if (err instanceof ProviderError) {
    if (err.class === 'PROVIDER_RATELIMIT') return 'ratelimit';
    if (err.class === 'PROVIDER_CONFIG') return 'config';
    return 'upstream'; // PROVIDER_UPSTREAM
  }
  return 'upstream'; // timeout sentinel or any other unexpected throw
}

/**
 * §4.5 step 4's deterministic summary id: `session-<YYYY-MM-DD of
 * coversFrom>-<hash8>`, hash8 = first 8 hex chars of
 * sha256(project|startFile|startOffset|endFile|endOffset). Content-window
 * derived (start AND end coordinates), NOT randomUUID — a crash-redo of the
 * same window produces the SAME id/path, so reindexDoc replaces the same
 * point instead of minting a duplicate.
 */
function deterministicSummaryId(project, chunk) {
  const hash = createHash('sha256')
    .update(`${project}|${chunk.startFile}|${chunk.startOffset}|${chunk.endFile}|${chunk.endOffset}`)
    .digest('hex')
    .slice(0, 8);
  return `session-${chunk.coversFrom.slice(0, 10)}-${hash}`;
}

/**
 * §4.1's max-persist rule for `last_turn_iso`: the persisted watermark must
 * never move backward, even though a single chunk's own coversUntil can
 * regress relative to a PRIOR chunk's watermark under non-monotonic
 * client-supplied turn timestamps (Task 4's carried-forward note to Task 5).
 * `a` may be null/unparseable (fresh project, or a hand-edited cursor); `b`
 * is chunk.coversUntil, which chunk-builder guarantees is always a
 * well-formed ISO string.
 */
function maxIso(a, b) {
  const aMs = typeof a === 'string' ? Date.parse(a) : NaN;
  const bMs = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return bMs >= aMs ? b : a;
}

/** §5b's supersession digest block (spec §3.7 format) — ported verbatim from checkpoint.mjs:596-609. */
function buildSupersedeDigest(detections, lane, persona) {
  const laneStr = lane || '-';
  const personaStr = persona || '-';
  const bullets = detections.map((d) =>
    `- target \`${d.targetId}\` → superseded by \`${d.supersededBy}\` (confidence ${d.confidence})\n` +
    `  - reason: ${String(d.reasoning ?? '').replace(/\s+/g, ' ').trim()}\n` +
    `  - undo: \`memory_supersede {"action":"unsupersede","id":"${d.targetId}"}\``
  ).join('\n');
  return `\n\n## Auto-superseded (D3.2)\n\nPartition: lane=${laneStr} persona=${personaStr}\n\n${bullets}\n`;
}

/**
 * Run the §4.5 per-chunk transaction: cost-cap pre-check → #185 thin gate →
 * summarize → two-phase summary write (incl. §4.8 state-merge hardening) →
 * cursor advance → auto-supersede pass (5b) → blocking reindex → telemetry.
 *
 * Never throws: every path below returns exactly one of —
 *   `{ committed: { summaryId, summaryPath, costUsd, tokensIn, tokensOut, nextCursor } }`
 *   `{ stopped: { reason: 'cost_cap' } }`                          — step 1, nothing consumed
 *   `{ thin: true }`                                               — step 2, cursor untouched
 *   `{ failed: { stage: 'summarize', providerClass, message } }`   — step 3, nothing written
 *   `{ failed: { stage: 'phase2', message } }`                     — step 4, .tmp orphan-marked, cursor untouched
 *   `{ failed: { stage: 'cursor_write', message } }`                — step 5, doc durable, cursor lags
 *   `{ failed: { stage: 'reindex', message, summaryId, summaryPath } }` — step 7, doc durable, CURSOR ADVANCED
 *
 * @param {object} args
 * @param {string} args.vaultDir
 * @param {string} args.project
 * @param {{text:string, turnCount:number, startFile:string, startOffset:number,
 *   endFile:string, endOffset:number, boundary:'turn'|'split',
 *   coversFrom:string, coversUntil:string}} args.chunk - one chunk-builder.mjs output.
 * @param {{last_turn_iso?:string|null}|null} args.prevCursor - the cursor this chunk resumes from.
 * @param {object} args.config - parsed checkpoint.json.
 * @param {{summarizeTimeoutMs:number, autosupersedeTimeoutMs:number, stateMergeTimeoutMs:number}} args.chunkingCfg
 *   - resolveChunkingConfig() output (checkpoint-config.mjs).
 * @param {string|null} [args.lane]
 * @param {string|null} [args.persona]
 * @param {string} [args.surface]
 * @param {boolean} [args.skipStateMerge]
 * @param {object} [deps] - DI overrides; each defaults to the real implementation
 *   exactly as checkpoint.mjs's ctx does.
 * @returns {Promise<object>} one of the shapes documented above.
 */
export async function runChunkTransaction(args, deps = {}) {
  const {
    vaultDir,
    project,
    chunk,
    prevCursor,
    config,
    chunkingCfg,
    lane = null,
    persona = null,
    surface,
    skipStateMerge = false,
  } = args;

  const summarizeFn = deps.summarizeFn ?? defaultSummarize;
  const updateStateFn = deps.updateStateFn ?? defaultUpdateState;
  const reindexFn = deps.reindexFn ?? (async () => {});
  const detectContradictions = deps.detectContradictions ?? defaultDetectContradictions;
  const supersedePointFn = deps.supersedePoint ?? defaultSupersedePoint;
  const isAutoSupersedeEnabledFn = deps.isAutoSupersedeEnabled ?? defaultIsAutoSupersedeEnabled;
  const qdrantClient = deps.qdrantClient;
  const collection = deps.collection;
  const userId = deps.userId;
  const recordCaptureEventFn = deps.recordCaptureEvent ?? defaultRecordCaptureEvent;
  const clock = deps.clock ?? (() => new Date());
  const systemPrompt = deps.systemPrompt;
  const model = deps.model;
  // D3.3: independent judge/retrieval threshold overrides — same env vars as
  // checkpoint.mjs; undefined lets the detector apply its own eval-derived default.
  const autoJudgeThreshold = process.env.UM_AUTOSUPERSEDE_THRESHOLD
    ? Number(process.env.UM_AUTOSUPERSEDE_THRESHOLD)
    : undefined;
  const autoRetrievalThreshold = process.env.UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD
    ? Number(process.env.UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD)
    : undefined;

  // Single clock() call (append-turn.mjs convention) — reused for both the
  // per-day telemetry path and the frontmatter's valid_from so both reflect
  // the exact same instant.
  const now = clock();
  const today = now.toISOString().slice(0, 10);
  const costPath = path.join(vaultDir, '.telemetry', `${today}-${project}.count`);

  // ----- Step 1: cost-cap pre-check (per chunk, not per run) -----
  let daySpent = 0;
  try { daySpent = parseFloat(await fs.readFile(costPath, 'utf8')) || 0; } catch {}
  if (daySpent >= config.cost_cap_usd_per_day_per_project) {
    return { stopped: { reason: 'cost_cap' } };
  }

  // ----- Step 2: #185 thin-transcript gate, byte-for-byte, applied to the chunk -----
  const minTranscriptBytes = resolveFloor(
    'UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES', config.min_transcript_bytes, DEFAULT_MIN_TRANSCRIPT_BYTES);
  const minTranscriptTurns = resolveFloor(
    'UM_CHECKPOINT_MIN_TRANSCRIPT_TURNS', config.min_transcript_turns, DEFAULT_MIN_TRANSCRIPT_TURNS);
  const transcriptBytes = Buffer.byteLength(chunk.text.trim(), 'utf8');
  if (transcriptBytes < minTranscriptBytes && chunk.turnCount < minTranscriptTurns) {
    return { thin: true };
  }

  // ----- Step 3: summarize, under summarizeTimeoutMs -----
  let summary, costUsd, tokensIn, tokensOut;
  try {
    const result = await raceTimeout(
      summarizeFn(chunk.text, {
        backend: process.env.UM_SUMMARIZER,
        model: model ?? config.summary_model,
        systemPrompt,
      }),
      chunkingCfg.summarizeTimeoutMs,
      'summarize',
    );
    ({ summary, costUsd, tokensIn, tokensOut } = result);
  } catch (err) {
    recordCaptureEventFn({ surface, project, event: CAPTURE_EVENTS.CHECKPOINT, outcome: 'failed' });
    return {
      failed: {
        stage: 'summarize',
        providerClass: classifySummarizeError(err),
        message: err?.message ?? String(err),
      },
    };
  }

  // ----- Step 4: two-phase summary write (incl. §4.8 state-merge hardening) -----
  const summaryId = deterministicSummaryId(project, chunk);
  const summaryRelPath = `sessions/${project}/${summaryId}.md`;
  const absSummaryPath = path.join(vaultDir, summaryRelPath);
  const tmpSummaryPath = absSummaryPath + '.tmp';

  let summaryWithFm = null; // built inside the try; used by the catch's defensive re-stage path

  try {
    await fs.mkdir(path.dirname(absSummaryPath), { recursive: true });

    // Symlink guards on both .tmp and final paths (ported from checkpoint.mjs:446-454).
    // Unlike the original's early-return, a refusal here is a genuine
    // phase-2-stage failure and is normalized into the same failed/phase2
    // shape as every other failure in this block (a deliberate improvement —
    // see task-5 report).
    const tmpSymCheck = await fs.lstat(tmpSummaryPath).catch(() => null);
    if (tmpSymCheck && tmpSymCheck.isSymbolicLink()) {
      throw Object.assign(new Error('target is a symlink; refusing to write'), { code: 'SYMLINK_REFUSED' });
    }
    const summaryStatCheck = await fs.lstat(absSummaryPath).catch(() => null);
    if (summaryStatCheck && summaryStatCheck.isSymbolicLink()) {
      throw Object.assign(new Error('target is a symlink; refusing to write'), { code: 'SYMLINK_REFUSED' });
    }

    // Frontmatter — reindexDoc requires type/id/title. Additive covers_from/
    // covers_until (§4.5 step 4) beyond checkpoint.mjs:456-470's fields.
    const coversDate = chunk.coversFrom.slice(0, 10);
    const frontmatter = [
      '---',
      'type: session_summary',
      `id: ${summaryId}`,
      `title: Session summary ${coversDate} for ${project}`,
      `project: ${project}`,
      `valid_from: ${now.toISOString()}`,
      `covers_from: ${chunk.coversFrom}`,
      `covers_until: ${chunk.coversUntil}`,
      `tokens_in: ${tokensIn}`,
      `tokens_out: ${tokensOut}`,
      `cost_usd: ${costUsd.toFixed(6)}`,
      '---',
      '',
    ].join('\n');
    summaryWithFm = frontmatter + summary;

    // Phase 1: write .tmp (NOFOLLOW open — checkpoint.mjs:473-481).
    {
      const fh = await fs.open(tmpSummaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
      try { await fh.writeFile(summaryWithFm, 'utf8'); } finally { await fh.close(); }
    }

    // Phase 2: state.md merge (unless skipStateMerge), THEN atomic rename —
    // ordering rationale ported from checkpoint.mjs:484-490: state.md is the
    // contention-prone path, so a state-merge failure leaves the summary
    // .tmp in place for orphan-marking below, never advancing to the rename.
    if (!skipStateMerge) {
      const oldStatePath = path.join(vaultDir, 'state', project, 'state.md');
      // checkpoint.mjs's caller creates state/<project>/ while acquiring the
      // whole-run lockdir (path.dirname(lockdir), where lockdir sits inside
      // this same directory) BEFORE the pipeline runs; this per-chunk module
      // owns no locking (Task 6 does), so it must not assume the directory
      // already exists — a fresh project's first chunk has no state/ dir yet.
      await fs.mkdir(path.dirname(oldStatePath), { recursive: true });
      let oldStateMd = '';
      try { oldStateMd = await fs.readFile(oldStatePath, 'utf8'); } catch {}

      // §4.8 hardening: run under stateMergeTimeoutMs; degrade (never throw)
      // when the call times out OR resolves with `ok === false` or a
      // non-string mergedMd. A genuine REJECTION (not a timeout) from
      // updateStateFn is treated as the IO-class failure it almost always is
      // in practice (updateState.mjs itself never throws for an LLM-side
      // failure — it has its own internal fallback) and is re-thrown into
      // this try's own phase2 catch below, exactly like any other phase-2 IO
      // failure (state.md write/rename errors).
      let stateResult = null;
      let stateDegraded = false;
      try {
        stateResult = await raceTimeout(
          updateStateFn({ oldStateMd, newSummary: summary, projectId: project }, { summarizeFn }),
          chunkingCfg.stateMergeTimeoutMs,
          'state-merge',
        );
        if (stateResult?.ok === false || typeof stateResult?.mergedMd !== 'string') {
          stateDegraded = true;
        }
      } catch (raceErr) {
        if (raceErr?.code === 'TIMEOUT') {
          stateDegraded = true;
        } else {
          throw raceErr;
        }
      }

      let mergedMd;
      if (stateDegraded) {
        mergedMd = oldStateMd
          ? `${oldStateMd}\n\n${summary}\n\n${STATE_MERGE_UNAVAILABLE_MARKER}`
          : `${summary}\n\n${STATE_MERGE_UNAVAILABLE_MARKER}`;
        if (mergedMd.length > STATE_CAP_CHARS) {
          mergedMd = truncateStateToCap(mergedMd, STATE_CAP_CHARS);
        }
      } else {
        mergedMd = stateResult.mergedMd;
      }

      // Symlink guard on state.md target before rename (checkpoint.mjs:504-507).
      const stateSymCheck = await fs.lstat(oldStatePath).catch(() => null);
      if (stateSymCheck && stateSymCheck.isSymbolicLink()) {
        throw Object.assign(new Error('target is a symlink; refusing to write'), { code: 'SYMLINK_REFUSED' });
      }
      const stateTmpPath = oldStatePath + '.tmp';
      {
        const fh = await fs.open(stateTmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
        try { await fh.writeFile(mergedMd, 'utf8'); } finally { await fh.close(); }
      }
      await fs.rename(stateTmpPath, oldStatePath);
    }

    // Final rename — the summary becomes durably reachable at its canonical path.
    await fs.rename(tmpSummaryPath, absSummaryPath);
  } catch (phase2Err) {
    // Ported from checkpoint.mjs:524-551.
    const tmpStillThere = await fs.stat(tmpSummaryPath).catch(() => null);
    if (tmpStillThere) {
      await markOrphanSummary(tmpSummaryPath);
    } else if (summaryWithFm !== null) {
      // Defensive re-stage (checkpoint.mjs keeps this branch "dead but a
      // safety net for defensive future edits" — same here): the .tmp
      // vanished between phase-1 write and the phase-2 failure. Only
      // attempted when we actually have content to re-stage (a failure
      // BEFORE the frontmatter was built has nothing to write).
      try {
        const fh = await fs.open(tmpSummaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
        try { await fh.writeFile(summaryWithFm, 'utf8'); } finally { await fh.close(); }
        await markOrphanSummary(tmpSummaryPath);
      } catch (restageErr) {
        safeLog(() => getLogger().warn({
          request_id: currentRequestId(),
          component: 'checkpoint-chunk-txn',
          path: tmpSummaryPath,
          err_message: restageErr?.message ?? String(restageErr),
        }, 'phase-2 orphan re-stage failed'), 'log:checkpoint-chunk-txn:phase2-orphan-failed');
      }
    }
    return { failed: { stage: 'phase2', message: phase2Err?.message ?? String(phase2Err) } };
  }

  // ----- Step 5: cursor advance — strictly after the durable rename, strictly before reindex (I5) -----
  const nextCursorInput = {
    file: chunk.endFile,
    offset: chunk.endOffset,
    boundary: chunk.boundary,
    // §4.1 max-persist rule: the digested_through watermark must never regress.
    last_turn_iso: maxIso(prevCursor?.last_turn_iso ?? null, chunk.coversUntil),
    last_summary_id: summaryId,
  };
  let nextCursor;
  try {
    nextCursor = await advanceCursor({ vaultDir, project, cursor: nextCursorInput });
  } catch (cursorErr) {
    return {
      failed: {
        stage: 'cursor_write',
        message: `checkpoint cursor write failed (${cursorErr?.code ?? 'ERR'}) — check free space on the vault volume`,
      },
    };
  }

  // ----- Step 6 (spec 5b): auto-supersede contradiction pass — warn-not-throw, under autosupersedeTimeoutMs -----
  // The chunk is already durably committed and the cursor already advanced
  // above: nothing here can un-commit the chunk (spec §4.5 5b + I1 pin —
  // chunk-commit-with-skipped-5b-pass is a success, not an error).
  if (isAutoSupersedeEnabledFn()) {
    try {
      await raceTimeout((async () => {
        const detections = await detectContradictions(chunk.text, {
          userId, lane, persona, collection, client: qdrantClient,
          judgeThreshold: autoJudgeThreshold,
          retrievalThreshold: autoRetrievalThreshold,
        });
        if (detections.length > 0) {
          for (const d of detections) {
            await supersedePointFn({ client: qdrantClient, collection, id: d.targetId, supersededBy: d.supersededBy });
          }
          // Digest appended to the already-written summary file BEFORE
          // reindex, so reindexFn (which reads from disk) picks it up.
          await fs.appendFile(absSummaryPath, buildSupersedeDigest(detections, lane, persona), 'utf8');
        }
      })(), chunkingCfg.autosupersedeTimeoutMs, 'autosupersede');
    } catch (err) {
      safeLog(() => getLogger().warn({
        request_id: currentRequestId(),
        component: 'checkpoint-chunk-txn',
        err_message: err?.message ?? String(err),
      }, 'auto-supersede pass failed or timed out (non-fatal)'), 'log:checkpoint-chunk-txn:autosupersede-failed');
    }
  }

  // ----- Step 7: blocking reindex with retry (spec §5.4/§4.5 step 6) -----
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryJitterMaxMs = deps.retryJitterMaxMs ?? DEFAULT_RETRY_JITTER_MAX_MS;
  const callerOverridesDelays = deps.retryDelaysMs !== undefined || deps.retryJitterMaxMs !== undefined;

  let attemptCount = 0;
  let lastReindexErr;
  let reindexSucceeded = false;
  try {
    const retryOpts = callerOverridesDelays
      ? {
          maxRetries: retryDelaysMs.length,
          baseDelayMs: retryDelaysMs[0] ?? 0,
          jitterMaxMs: retryJitterMaxMs,
          op: 'reindex',
        }
      : { op: 'reindex' };
    await withRetry(async () => {
      attemptCount += 1;
      try {
        await reindexFn(summaryRelPath);
      } catch (err) {
        lastReindexErr = err;
        safeLog(() => getLogger().warn({
          request_id: currentRequestId(),
          component: 'checkpoint-chunk-txn',
          attempt: attemptCount,
          project,
          err_message: err?.message ?? String(err),
        }, 'reindex attempt failed'), 'log:checkpoint-chunk-txn:reindex-attempt-failed');
        throw err;
      }
    }, retryOpts);
    reindexSucceeded = true;
  } catch (wrappedErr) {
    void wrappedErr; // withRetry already wrapped/logged; the failure is surfaced below via lastReindexErr
  }

  if (!reindexSucceeded) {
    const totalRetries = callerOverridesDelays ? retryDelaysMs.length : 3;
    recordCaptureEventFn({ surface, project, event: CAPTURE_EVENTS.CHECKPOINT, outcome: 'error' });
    return {
      failed: {
        stage: 'reindex',
        message: `checkpoint reindex failed after ${totalRetries} retries: ${lastReindexErr?.message ?? String(lastReindexErr)}`,
        summaryId,
        summaryPath: summaryRelPath,
      },
    };
  }

  // ----- Step 8: per-chunk telemetry + stored counter -----
  try {
    await fs.mkdir(path.dirname(costPath), { recursive: true });
    const fh = await fs.open(costPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
    try { await fh.writeFile(String(daySpent + costUsd), 'utf8'); } finally { await fh.close(); }
  } catch {}

  recordCaptureEventFn({ surface, project, event: CAPTURE_EVENTS.CHECKPOINT, outcome: 'stored' });

  return {
    committed: {
      summaryId,
      summaryPath: summaryRelPath,
      costUsd,
      tokensIn,
      tokensOut,
      nextCursor,
    },
  };
}
