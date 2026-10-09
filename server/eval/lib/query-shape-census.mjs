// server/eval/lib/query-shape-census.mjs — #203 (spec D9, §4.2.6; plan T5): the
// retrospective query-shape census. A library, not a command: `score` calls it
// after verifyAnchor, on the anchored transcript snapshot and counters export,
// so its selection rules, inputs and result are frozen with everything else.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record):
//
// • INPUTS: only an injected transcripts directory and counters-export file
//   (score passes <arc-dir>/transcripts/ and <arc-dir>/counters-export.json,
//   both bound by the anchor). Window, threshold, source mapping, prompt rules
//   and the tool-name suffix all come from the rule's `census` block.
//
// • ITEMS, as the production instruments count them:
//   (a) first prompts — the first user prompt of at least `min_prompt_chars`
//       chars of each MAIN session, as the UserPromptSubmit hook sends it
//       (cut at `prompt_max_chars` code points; trailing newlines dropped before
//       the length check; whitespace-trimmed), when that prompt is dated inside
//       the window. A shorter prompt is skipped and the next one counts.
//       Sidechain/subagent lines never fire the hook: a line with
//       isSidechain: true, or any line in a `subagents/` or `agent-*.jsonl`
//       file, gives no first prompt. Meta, compact-summary and tool-result
//       lines, and lines that open with one of `non_prompt_prefixes` (slash
//       and local-command markup), are not prompts. A prompt line copied into
//       a resumed session's file is the same prompt: lines are deduplicated by
//       uuid (the copy in the file named after its own sessionId wins).
//   (b) agent calls — every tool_use whose name ends in `tool_name_suffix`
//       (its `query` argument), subagent transcripts included, counted ONCE by
//       tool-use id wherever it appears, when dated inside the window.
//   Codex logs are not read (spec D9). Timestamps are the line's ISO
//   `timestamp`, compared as UTC days, both window ends inclusive.
//
// • SHAPES come from classifyQueryShape (server/lib/query-shape.mjs) — never a
//   reimplementation. P_dom = (s_first × V_plugin + s_agent × V_unknown) /
//   (V_plugin + V_unknown), V_* from the counters export over the same window,
//   excluded surfaces reported but never weighted; s_agent = 0 with no agent
//   call. The prevalence side of D10 is P_dom against the rule's threshold.
//
// • AGGREGATES ONLY: the result holds counts, shares and fixed labels — no
//   prompt, query, path, session or tool id. A line that does not parse (a file
//   copied mid-write) is skipped and counted. Every failure is a fixed code;
//   no parser message (which would quote its input) ever leaves this module.

import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { classifyQueryShape } from '../../lib/query-shape.mjs';

/** D10 action branches (spec D10). */
export const D10_BRANCHES = Object.freeze([
  'close-no-remedy', 'close-and-open-remedy-issue', 'close-and-open-parked-issue', 'close-with-bound', 'keep-open-void',
]);
export const PREVALENCE_SIDES = Object.freeze(['at-or-above-threshold', 'below-threshold']);

const fail = (code) => ({ ok: false, code });
const emptyShapes = () => ({ total: 0, none: 0, embedded: 0, dominant: 0 });

function walkJsonl(root, rel = '') {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkJsonl(root, r));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(r);
  }
  return out;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The first `n` code points of `s` (the hook's Python slice counts code points). */
function capCodePoints(s, n) {
  if (s.length <= n) return s;
  let out = '';
  let i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

/** The query the hook would send for this prompt text, or null when it sends none. */
function hookQuery(text, census) {
  const cut = capCodePoints(text, census.prompt_max_chars);
  const checked = cut.replace(/\n+$/, '');
  if ([...checked].length < census.min_prompt_chars) return null;
  return cut.trim();
}

/** The prompt text of a typed user line, or null when the line is not a prompt. */
function promptText(obj, census) {
  if (obj.type !== 'user') return null;
  const m = obj.message;
  if (!m || typeof m !== 'object' || m.role !== 'user') return null;
  if (obj.isMeta === true || obj.isCompactSummary === true || obj.isVisibleInTranscriptOnly === true) return null;
  if (obj.toolUseResult !== undefined) return null;
  let text;
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    if (m.content.some((b) => b && b.type === 'tool_result')) return null;
    text = m.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  } else {
    return null;
  }
  const lead = text.trimStart();
  if (census.non_prompt_prefixes.some((p) => lead.startsWith(p))) return null;
  return text;
}

/** Every tool_use block anywhere in a parsed line (progress lines nest them). */
function* toolUses(obj) {
  const stack = [obj];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object') continue;
    if (Array.isArray(o)) { for (const x of o) stack.push(x); continue; }
    if (o.type === 'tool_use' && typeof o.id === 'string' && typeof o.name === 'string') yield o;
    for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
  }
}

function readCounters(countersPath, census) {
  let rows;
  try {
    rows = JSON.parse(readFileSync(countersPath, 'utf8'));
  } catch {
    return null;
  }
  const valid = Array.isArray(rows) && rows.every((r) => r && typeof r === 'object'
    && typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day)
    && typeof r.surface === 'string' && r.surface.length > 0
    && Number.isInteger(r.n) && r.n >= 0);
  if (!valid) return null;
  const map = census.source_mapping;
  const volume = { plugin: 0, unknown: 0, excluded: 0, other: 0 };
  for (const r of rows) {
    if (r.day < census.census_from || r.day > census.census_until) continue;
    if (r.surface === map.first_prompt) volume.plugin += r.n;
    else if (r.surface === map.agent_memory_search) volume.unknown += r.n;
    else if (map.excluded.includes(r.surface)) volume.excluded += r.n;
    else volume.other += r.n;
  }
  return volume;
}

/**
 * Run the census.
 * @param {{ transcriptsDir: string, countersPath: string, rule: object }} args
 * @returns {Promise<{ ok: true, census: object } | { ok: false, code: string }>}
 */
export async function runCensus({ transcriptsDir, countersPath, rule }) {
  const census = rule.census;
  try {
    if (!statSync(transcriptsDir).isDirectory() || !statSync(countersPath).isFile()) return fail('census-input-missing');
  } catch {
    return fail('census-input-missing');
  }
  const volume = readCounters(countersPath, census);
  if (!volume) return fail('census-counters-malformed');

  const inWindow = (ms) => {
    const d = utcDay(ms);
    return d >= census.census_from && d <= census.census_until;
  };

  let files;
  try {
    files = walkJsonl(transcriptsDir).sort();
  } catch {
    return fail('census-input-missing');
  }
  const prompts = new Map(); // dedupe key -> candidate
  const calls = new Map(); // tool-use id -> { ms, query }
  let linesRead = 0;
  let malformed = 0;
  let anonymous = 0;
  for (const rel of files) {
    const parts = rel.split('/');
    const base = parts[parts.length - 1];
    const ownSession = base.slice(0, -'.jsonl'.length);
    const subagentFile = parts.includes('subagents') || base.startsWith('agent-');
    let lineNo = 0;
    try {
      const rl = createInterface({ input: createReadStream(join(transcriptsDir, ...parts)), crlfDelay: Infinity });
      for await (const line of rl) {
        lineNo++;
        if (line.trim() === '') continue;
        linesRead++;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        const ms = Date.parse(obj.timestamp);
        // A tool name ending in the suffix appears verbatim in the raw line
        // (JSON never escapes ASCII letters or `_`), so other lines skip the walk.
        if (line.includes(census.tool_name_suffix)) {
          for (const tu of toolUses(obj)) {
            if (!tu.name.endsWith(census.tool_name_suffix)) continue;
            const prev = calls.get(tu.id);
            if (!prev || (Number.isNaN(prev.ms) && !Number.isNaN(ms))) calls.set(tu.id, { ms, query: tu.input?.query });
          }
        }
        if (subagentFile || obj.isSidechain === true) continue;
        const text = promptText(obj, census);
        if (text === null) continue;
        const sessionId = typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : `file:${rel}`;
        const cand = { sessionId, ms, text, rel, lineNo, own: sessionId === ownSession };
        const key = typeof obj.uuid === 'string' && obj.uuid ? `uuid:${obj.uuid}` : `anon:${anonymous++}`;
        const prev = prompts.get(key);
        if (!prev || (!prev.own && cand.own)) prompts.set(key, cand);
      }
    } catch {
      return fail('census-input-missing');
    }
  }

  // (a) first prompts
  const bySession = new Map();
  for (const c of prompts.values()) {
    if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
    bySession.get(c.sessionId).push(c);
  }
  const firstPrompts = emptyShapes();
  let undated = 0;
  for (const cands of bySession.values()) {
    cands.sort((a, b) => {
      const ta = Number.isNaN(a.ms) ? Infinity : a.ms;
      const tb = Number.isNaN(b.ms) ? Infinity : b.ms;
      if (ta !== tb) return ta - tb;
      if (a.rel !== b.rel) return a.rel < b.rel ? -1 : 1;
      return a.lineNo - b.lineNo;
    });
    let first = null;
    let query = null;
    for (const c of cands) {
      query = hookQuery(c.text, census);
      if (query !== null) { first = c; break; }
    }
    if (!first) continue;
    if (Number.isNaN(first.ms)) { undated++; continue; }
    if (!inWindow(first.ms)) continue;
    const shape = classifyQueryShape(query);
    firstPrompts.total++;
    firstPrompts[shape]++;
  }

  // (b) agent memory_search calls
  const agentCalls = emptyShapes();
  for (const call of calls.values()) {
    if (Number.isNaN(call.ms)) { undated++; continue; }
    if (!inWindow(call.ms)) continue;
    const shape = classifyQueryShape(call.query);
    agentCalls.total++;
    agentCalls[shape]++;
  }

  if (firstPrompts.total === 0) return fail('census-no-first-prompts');
  const weight = volume.plugin + volume.unknown;
  if (weight === 0) return fail('census-no-volume');
  const sFirst = firstPrompts.dominant / firstPrompts.total;
  const sAgent = agentCalls.total ? agentCalls.dominant / agentCalls.total : 0;
  const pDom = (sFirst * volume.plugin + sAgent * volume.unknown) / weight;
  return {
    ok: true,
    census: {
      window: { from: census.census_from, until: census.census_until },
      files_read: files.length,
      lines_read: linesRead,
      malformed_lines: malformed,
      undated_items: undated,
      first_prompts: firstPrompts,
      agent_calls: agentCalls,
      volume,
      s_first: sFirst,
      s_agent: sAgent,
      p_dom: pDom,
      threshold: census.prevalence_threshold,
      prevalence: pDom >= census.prevalence_threshold ? 'at-or-above-threshold' : 'below-threshold',
    },
  };
}

/** The D10 action branch for a verdict and the census's prevalence side. */
export function d10Branch(verdict, census) {
  switch (verdict) {
    case 'NO-GAP':
    case 'REVERSE':
      return 'close-no-remedy';
    case 'GAP':
      return census.prevalence === 'at-or-above-threshold' ? 'close-and-open-remedy-issue' : 'close-and-open-parked-issue';
    case 'GAP (seed-carried)':
    case 'INCONCLUSIVE':
      return 'close-with-bound';
    case 'VOID':
      return 'keep-open-void';
    default:
      throw new Error('unknown verdict');
  }
}
