// server/lib/update-state.mjs — node port of hooks/lib/update-state.sh
//
// Merges an old state.md with a new session summary via LLM, producing an
// updated state.md. Mirrors the bash script's logic:
//   - Builds a user prompt containing old state + new summary
//   - Calls summarize() with the update-state system prompt
//   - Enforces 3000-char cap on output (per the prompt rule); truncates with '\n...' marker
//   - On LLM failure: falls back to appending the new summary verbatim to the old state
//     with an <!-- llm-merge-failed, appended raw --> marker, still returns ok (llmFailure: true)
//
// DI: pass ctx.summarizeFn to inject a mock for tests.
// Prompt resolution priority: ctx.promptDir > UM_PROMPT_DIR env > repo default.

import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';
import { fileURLToPath } from 'node:url';
import { summarize as defaultSummarize } from './summarize.mjs';

const STATE_CAP_CHARS = 3000;

/**
 * Re-stamp server-owned frontmatter on a merged state doc.
 *
 * The merge prompt asks the model to emit "the updated state.md (frontmatter + body)",
 * so WITHOUT this the document's `valid_from` is whatever date the model invented.
 * Observed in a live vault: 25 of 27 state docs carried 2023 dates (a plausible
 * training-era default) while their real mtimes were all 2026-07/08 — and one
 * re-merge produced a date three months in the FUTURE, because the model kept the
 * month-day it had invented earlier and moved the year to the current one. A
 * future-dated doc out-ranks everything in any recency comparison, which is worse
 * than an obviously-broken old one.
 *
 * The model owns the BODY; the server owns the metadata. This mirrors
 * checkpoint-chunk-txn.mjs, which already clock-stamps `valid_from` for session
 * summaries — state docs simply never got the same treatment.
 *
 * No frontmatter block => returns the text untouched. Fabricating frontmatter here
 * would be a different (and larger) behaviour change than fixing the timestamp.
 */
function stampServerOwnedFrontmatter(md, nowIso) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return md;
  const block = m[1];
  const stamped = /^valid_from:.*$/m.test(block)
    ? block.replace(/^valid_from:.*$/m, `valid_from: ${nowIso}`)
    : `${block}\nvalid_from: ${nowIso}`;
  return `---\n${stamped}\n---${md.slice(m[0].length)}`;
}
const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PROMPT_PATH = path.resolve(LIB_DIR, '../config/prompts/update-state.txt');

/**
 * Merge old state.md with a new session summary.
 *
 * @param {object} args
 * @param {string} args.oldStateMd   - Existing state document (may be empty)
 * @param {string} args.newSummary   - New session summary to merge in
 * @param {string} [args.projectId]  - Project identifier (for prompt context)
 * @param {object} [ctx]             - Options / DI overrides
 * @param {Function} [ctx.summarizeFn]  - Replacement for summarize() (test DI)
 * @param {string}   [ctx.promptDir]    - Prompt directory override
 * @param {number}   [ctx.temperature]  - LLM temperature override
 * @returns {Promise<{mergedMd: string, costUsd: number, tokensIn: number, tokensOut: number, schema_version: 1, llmFailure: boolean}>}
 */
export async function updateState(args, ctx = {}) {
  const { oldStateMd = '', newSummary, projectId = '' } = args;
  const summarizeFn = ctx.summarizeFn ?? defaultSummarize;

  // Load merge system prompt
  const promptDir = ctx.promptDir ?? process.env.UM_PROMPT_DIR;
  const promptPath = promptDir
    ? path.join(promptDir, 'update-state.txt')
    : DEFAULT_PROMPT_PATH;
  let systemPrompt;
  try {
    systemPrompt = await fs.readFile(promptPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // C.9 (§4.2.0): pino emit must never throw out of an update-state path.
      safeLog(() => getLogger().error({
        request_id: currentRequestId(),
        component: 'update-state',
        path: promptPath,
      }, 'update-state prompt missing'), 'log:update-state:prompt-missing');
      return {
        schema_version: 1,
        ok: false,
        error: 'update-state prompt file missing — check $UM_PROMPT_DIR or reinstall plugin',
      };
    }
    throw err;
  }

  // Build user prompt matching bash script's _UM_USER_PROMPT format
  const oldStateDisplay = oldStateMd.trim()
    ? oldStateMd
    : '(empty — this is the initial state for this project)';
  const userPrompt = [
    `Project: ${projectId}`,
    ``,
    `Old state:`,
    `---`,
    oldStateDisplay,
    `---`,
    ``,
    `New session summary:`,
    `---`,
    newSummary,
    `---`,
    ``,
    `Produce the updated state.md (frontmatter + body).`,
  ].join('\n');

  let mergedMd;
  let costUsd = 0, tokensIn = 0, tokensOut = 0;
  let llmFailure = false;

  try {
    const result = await summarizeFn(userPrompt, {
      backend: process.env.UM_SUMMARIZER,
      systemPrompt,
      temperature: ctx.temperature ?? 0.2,
    });
    mergedMd = result.summary;
    costUsd = result.costUsd ?? 0;
    tokensIn = result.tokensIn ?? 0;
    tokensOut = result.tokensOut ?? 0;
  } catch {
    // LLM-failure fallback: append new summary verbatim with marker
    llmFailure = true;
    mergedMd = oldStateMd
      ? `${oldStateMd}\n\n<!-- llm-merge-failed, appended raw -->\n\n${newSummary}`
      : newSummary;
  }

  // Enforce 3000-char cap on output (matches prompt rule: "Keep the total document under 3000 characters")
  if (mergedMd.length > STATE_CAP_CHARS) {
    mergedMd = truncateToCap(mergedMd, STATE_CAP_CHARS);
  }

  // Server owns the timestamp, not the model. Applied AFTER the cap so the value
  // that reaches disk is always the stamped one (truncateToCap preserves the
  // frontmatter block, so ordering is belt-and-braces rather than load-bearing).
  // Also applied on the llmFailure path, whose frontmatter is inherited from the
  // OLD state doc and would otherwise carry a stale valid_from forward.
  mergedMd = stampServerOwnedFrontmatter(mergedMd, (ctx.now?.() ?? new Date()).toISOString());

  // §4.8 hardening (checkpoint-chunk-txn.mjs): additive explicit ok:true on
  // the success return. Previously only the prompt-missing failure path set
  // `ok`, so a naive `if (!stateResult.ok)` check on the CALLER side
  // misfired on every successful merge. Additive — existing tests assert
  // fields individually and are unaffected.
  return { schema_version: 1, ok: true, mergedMd, costUsd, tokensIn, tokensOut, llmFailure };
}

/**
 * Truncate markdown to cap chars, preserving frontmatter block at the top.
 * Appends '\n...' marker at the cut point.
 */
function truncateToCap(md, cap) {
  const fmMatch = md.match(/^(---\n[\s\S]*?\n---\n)/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const body = md.slice(fm.length);
    const bodyCap = cap - fm.length - 5; // 5 = '\n...'.length + 1 for newline before it
    return `${fm}${body.slice(0, bodyCap)}\n...`;
  }
  return `${md.slice(0, cap - 5)}\n...`;
}
