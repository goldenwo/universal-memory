// server/lib/update-state.mjs — node port of hooks/lib/update-state.sh
//
// Merges an old state.md with a new session summary via LLM, producing an
// updated state.md. Mirrors the bash script's logic:
//   - Builds a user prompt containing old state + new summary
//   - Calls summarize() with the update-state system prompt
//   - Tells the model the date for this merge (effectiveAsOf(args.asOf, ctx.now()) — #326 D4)
//   - Stamps valid_from, then shapes the output with state-cap.mjs (#326 D2/D5/D8: scaffold the
//     six required sections, age In-flight stamps, bound the lists, fit to the 3000 cap) and
//     logs state.cap_trimmed / state.shaped when the shaping did anything
//   - On LLM failure: falls back to appending the new summary verbatim to the old state
//     under an <!-- llm-merge-failed, appended raw --> marker and a `## Unmerged session
//     summary` heading (everything after that heading is foreign to the trimmer),
//     still returns ok (llmFailure: true)
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
import {
  effectiveAsOf,
  shapeState,
  MARKER_LLM_MERGE_FAILED,
  UNMERGED_SUMMARY_HEADING,
} from './state-cap.mjs';

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
 * @param {string|Date} [args.asOf]  - The session date for this merge (the chunk's coversUntil);
 *                                     clamped by effectiveAsOf to [now - 14 d, now]
 * @param {object} [ctx]             - Options / DI overrides
 * @param {Function} [ctx.summarizeFn]  - Replacement for summarize() (test DI)
 * @param {Function} [ctx.now]          - Clock returning a Date (test DI; the txn passes its own)
 * @param {string}   [ctx.promptDir]    - Prompt directory override
 * @param {number}   [ctx.temperature]  - LLM temperature override
 * @returns {Promise<{mergedMd: string, costUsd: number, tokensIn: number, tokensOut: number, schema_version: 1, llmFailure: boolean, shaping: {added: string[], aged: number, aged_future: number, bounded: object[], trims: object[]}}>}
 */
export async function updateState(args, ctx = {}) {
  const { oldStateMd = '', newSummary, projectId = '', asOf: asOfArg } = args;
  const summarizeFn = ctx.summarizeFn ?? defaultSummarize;
  // One clock, one supplied date: the date line the model sees and the shaping below read the
  // same values (spec 4.2.3). The txn passes ctx.now so its own clamp is the identity here.
  const now = ctx.now?.() ?? new Date();
  const asOf = effectiveAsOf(asOfArg, now);

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
    `Date for this merge (UTC): ${asOf.slice(0, 10)}`,
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
    // LLM-failure fallback: append the new summary verbatim under the marker and the
    // unmerged heading (spec 4.2.3) — the trimmer treats everything after that heading as
    // foreign, and D8 scaffolds the six required sections ahead of it.
    llmFailure = true;
    mergedMd = oldStateMd
      ? `${oldStateMd}\n\n${MARKER_LLM_MERGE_FAILED}\n\n${UNMERGED_SUMMARY_HEADING}\n\n${newSummary}`
      : `${MARKER_LLM_MERGE_FAILED}\n\n${UNMERGED_SUMMARY_HEADING}\n\n${newSummary}`;
  }

  // Server owns the timestamp, not the model. Stamped BEFORE the shaping so the cap
  // sizes the document that reaches disk (#326 §1 item 8: a stamp applied after the cap
  // could push a capped doc over it). Also applied on the llmFailure path, whose
  // frontmatter is inherited from the OLD state doc and would otherwise carry a stale
  // valid_from forward.
  mergedMd = stampServerOwnedFrontmatter(mergedMd, now.toISOString());

  // #326: scaffold → age → bound → fit (spec 4.2.1), then say what changed (D6).
  const charsBefore = mergedMd.length;
  const shaped = shapeState(mergedMd, { asOf, now });
  mergedMd = shaped.md;
  logShaping({ component: 'update-state', project: projectId, charsBefore, charsAfter: mergedMd.length, report: shaped.report });

  // §4.8 hardening (checkpoint-chunk-txn.mjs): additive explicit ok:true on
  // the success return. Previously only the prompt-missing failure path set
  // `ok`, so a naive `if (!stateResult.ok)` check on the CALLER side
  // misfired on every successful merge. Additive — existing tests assert
  // fields individually and are unaffected.
  // #326: the shaping report rides along (additive) so a caller such as the keyed eval can
  // record what the server did without scraping the log lines.
  return { schema_version: 1, ok: true, mergedMd, costUsd, tokensIn, tokensOut, llmFailure, shaping: shaped.report };
}

/**
 * #326 D6 — the two structured log lines both producers emit, only when the respective
 * report is non-empty: `state.cap_trimmed` (warn) with the per-section trim list (canonical
 * names, `(preamble)`, one aggregated `(foreign)` — no session text), and `state.shaped`
 * (info) with what scaffolding, ageing and bounding did. Shared with checkpoint-chunk-txn.mjs,
 * which passes its own `component`.
 */
export function logShaping({ component, project, charsBefore, charsAfter, report }) {
  const base = { request_id: currentRequestId(), component, project };
  if (report.trims.length > 0) {
    safeLog(() => getLogger().warn({
      ...base, chars_before: charsBefore, chars_after: charsAfter, sections: report.trims,
    }, 'state.cap_trimmed'), `log:${component}:cap-trimmed`);
  }
  if (report.added.length > 0 || report.aged > 0 || report.aged_future > 0 || report.bounded.length > 0) {
    safeLog(() => getLogger().info({
      ...base, added: report.added, aged: report.aged, aged_future: report.aged_future, bounded: report.bounded,
    }, 'state.shaped'), `log:${component}:shaped`);
  }
}
