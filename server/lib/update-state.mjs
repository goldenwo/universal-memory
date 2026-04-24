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
import { fileURLToPath } from 'node:url';
import { summarize as defaultSummarize } from './summarize.mjs';

const STATE_CAP_CHARS = 3000;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_PROMPT_PATH = path.join(REPO_ROOT, 'server/config/prompts/update-state.txt');

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
      return {
        schema_version: 1,
        ok: false,
        error: `update-state prompt missing at ${promptPath}; check $UM_PROMPT_DIR or reinstall plugin`,
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

  return { schema_version: 1, mergedMd, costUsd, tokensIn, tokensOut, llmFailure };
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
