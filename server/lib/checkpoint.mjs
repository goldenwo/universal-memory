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
import { summarize as defaultSummarize } from './summarize.mjs';
import { updateState as defaultUpdateState } from './update-state.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'server/config/checkpoint.json');

const VALID_SLUG = /^[a-zA-Z0-9._-]+$/;

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
    since = null,             // v0.5: accepted but reads all captures
    until = null,             // v0.5: accepted but reads all captures
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

    // Read raw captures (v0.5: read all; since/until accepted for future use)
    const rawDir = path.join(vaultDir, 'captures', project, 'raw');
    const rawFiles = await fs.readdir(rawDir).catch(() => []);
    let transcript = '';
    for (const f of rawFiles.filter(f => f.endsWith('.md')).sort()) {
      transcript += await fs.readFile(path.join(rawDir, f), 'utf8') + '\n\n';
    }

    // Summarize
    const { summary, costUsd, tokensIn, tokensOut } = await summarizeFn(transcript, {
      backend: process.env.UM_SUMMARIZER,
      model: ctx.model ?? config.summary_model,
    });

    // Write session summary file
    const summaryId = `session-${today}-${Math.random().toString(36).slice(2, 8)}`;
    const summaryPath = `sessions/${project}/${summaryId}.md`;
    const absSummaryPath = path.join(vaultDir, summaryPath);
    await fs.mkdir(path.dirname(absSummaryPath), { recursive: true });
    await fs.writeFile(absSummaryPath, summary);

    // Reindex
    await reindexFn({ path: summaryPath, project });

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

    return {
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
  } finally {
    await fs.rmdir(lockdir).catch(() => {});
  }
}
