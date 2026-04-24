// server/lib/checkpoint.mjs — session-end checkpoint orchestration
//
// Pipeline order:
//   1. Validate project slug
//   2. Acquire lockdir (atomic mkdir; stale-detect on EEXIST)
//   3. Cost-cap check (per-day, per-project telemetry file)
//   4. Read raw captures
//   5. Summarize transcript
//   6. Write session summary file
//   7. Reindex
//   8. Merge into state.md (unless skip_state_merge)
//   9. Atomic state write (.tmp + rename)
//  10. Update telemetry
//  11. Release lockdir (finally)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { summarize as defaultSummarize } from './summarize.mjs';
import { updateState as defaultUpdateState } from './update-state.mjs';

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(LIB_DIR, '../config/checkpoint.json');
const DEFAULT_SUMMARIZE_PROMPT_PATH = path.resolve(LIB_DIR, '../config/prompts/summarize.txt');

const VALID_SLUG = /^[a-zA-Z0-9._-]+$/;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024; // 1 MB — DoS guard

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
    };
  }

  // Config + DI
  const config = ctx.config ?? JSON.parse(await fs.readFile(DEFAULT_CONFIG_PATH, 'utf8'));
  const vaultDir = ctx.vaultDir ?? process.env.UM_VAULT_DIR;
  const summarizeFn = ctx.summarizeFn ?? defaultSummarize;
  const updateStateFn = ctx.updateStateFn ?? defaultUpdateState;
  const reindexFn = ctx.reindexFn ?? (async () => {});

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
        console.error('[checkpoint] summarize prompt missing at', promptPath);
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

  // Acquire lockdir (atomic via EEXIST)
  const lockdir = path.join(vaultDir, 'state', project, 'state.md.lockdir');
  await fs.mkdir(path.dirname(lockdir), { recursive: true });
  try {
    await fs.mkdir(lockdir);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Check for stale lockdir
    const stat = await fs.stat(lockdir).catch(() => null);
    if (stat && (Date.now() - stat.mtimeMs) > config.lockdir_stale_timeout_ms) {
      await fs.rmdir(lockdir).catch(() => {});
      await fs.mkdir(lockdir);
    } else {
      return { schema_version: 1, ok: false, error: 'checkpoint_in_progress' };
    }
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
    // Lock each raw file's sibling .lock before reading to ensure consistency
    // with concurrent writers (stop.sh + append-turn.mjs) that hold the same
    // <date>.md.lock path via proper-lockfile / perl flock.
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
      const lockPath = rawFilePath + '.lock';
      // Ensure the .lock file exists (proper-lockfile requires the file to exist)
      await fs.writeFile(lockPath, '', { flag: 'a' });
      let release;
      try {
        release = await lockfile.lock(lockPath);
        const chunk = await fs.readFile(rawFilePath, 'utf8') + '\n\n';
        if (Buffer.byteLength(transcript + chunk, 'utf8') > MAX_TRANSCRIPT_BYTES) {
          transcriptTruncated = true;
          break;
        }
        transcript += chunk;
      } finally {
        if (release) await release().catch(() => {});
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

    // Write session summary file
    const summaryId = `session-${today}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const summaryPath = `sessions/${project}/${summaryId}.md`;
    const absSummaryPath = path.join(vaultDir, summaryPath);
    await fs.mkdir(path.dirname(absSummaryPath), { recursive: true });
    // Fix 3: symlink guard on summary write
    const summaryStatCheck = await fs.lstat(absSummaryPath).catch(() => null);
    if (summaryStatCheck && summaryStatCheck.isSymbolicLink()) {
      return { schema_version: 1, ok: false, error: 'target is a symlink; refusing to write' };
    }
    await fs.writeFile(absSummaryPath, summary);

    // Reindex (non-fatal — orphan summary is recoverable; state.md must still update)
    let reindexFailed = false;
    let reindexError;
    try {
      await reindexFn(summaryPath);
    } catch (err) {
      reindexFailed = true;
      reindexError = err?.message ?? String(err);
      console.warn(`[checkpoint] reindex failed for project=${project}: ${err?.message ?? String(err)}`);
    }

    // Optionally merge into state.md
    let stateUpdated = false;
    let statePath = null;
    if (!skip_state_merge) {
      const oldStatePath = path.join(vaultDir, 'state', project, 'state.md');
      let oldStateMd = '';
      try { oldStateMd = await fs.readFile(oldStatePath, 'utf8'); } catch {}
      const stateResult = await updateStateFn(
        { oldStateMd, newSummary: summary, projectId: project },
        { summarizeFn },
      );
      // Atomic write: .tmp + rename
      // Fix 3: symlink guard on state.md target before rename
      const stateSymCheck = await fs.lstat(oldStatePath).catch(() => null);
      if (stateSymCheck && stateSymCheck.isSymbolicLink()) {
        return { schema_version: 1, ok: false, error: 'target is a symlink; refusing to write' };
      }
      const tmpPath = oldStatePath + '.tmp';
      await fs.writeFile(tmpPath, stateResult.mergedMd);
      await fs.rename(tmpPath, oldStatePath);
      stateUpdated = true;
      statePath = `state/${project}/state.md`;
    }

    // Update per-day telemetry
    try {
      await fs.mkdir(path.dirname(costPath), { recursive: true });
      await fs.writeFile(costPath, String(daySpent + costUsd));
    } catch {}

    const result = {
      schema_version: 1,
      ok: true,
      summary_id: summaryId,
      summary_path: summaryPath,
      state_updated: stateUpdated,
      state_path: statePath,
      cost_usd: costUsd,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      duration_ms: Date.now() - t0,
    };
    if (transcriptTruncated) result.truncated = true;
    if (reindexFailed) {
      result.reindex_failed = true;
      result.reindex_error = reindexError;
    }
    return result;
  } finally {
    await fs.rmdir(lockdir).catch(() => {});
  }
}
