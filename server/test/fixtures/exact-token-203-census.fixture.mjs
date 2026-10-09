// server/test/fixtures/exact-token-203-census.fixture.mjs — #203 PR 2 (spec D9,
// §4.2.6; plan T5). A SYNTHETIC transcript snapshot and counters export for the
// query-shape census. Every string is invented for the test; no real transcript
// was read to write it (plan P5/P12/P13 were resolved from Claude Code's
// documented JSONL shape, not from local files).
//
// Shape modelled (one JSON object per line):
//   { type: 'user'|'assistant'|..., sessionId, uuid, timestamp (ISO, UTC),
//     isSidechain, isMeta?, isCompactSummary?, message: { role, content } }
//   - a typed prompt is a `user` line whose content is a string, or an array of
//     text blocks; a tool result is a `user` line carrying `tool_result` blocks;
//   - a tool call is a `tool_use` block { type, id, name, input } inside an
//     `assistant` line's content array;
//   - subagent transcripts live at <session>/subagents/agent-*.jsonl with
//     isSidechain: true on every line; older versions inline sidechain lines in
//     the main file with isSidechain: true.
//
// Expected census over the tracked rule's window (2026-09-10 .. 2026-10-08):
//   first prompts (one per MAIN session, first prompt of >= 5 chars, dated in
//   the window): a1 dominant, a5 embedded, a6 none, a8 none (its first prompt
//   is under 5 chars, the next counts; a later command changes nothing),
//   b1 dominant, c1 dominant (a resumed copy of a1's first prompt is
//   deduplicated by uuid)  -> 6: 3 / 1 / 2.
//   Excluded and counted (sessions_command_first = 2): a2 (its first
//   submitted line is a slash command), a9 (a skipped short prompt, then a
//   command). Dropped: a3 (first prompt before the window), a4 (after it),
//   a7 (undated).
//   agent memory_search calls (each tool-use id once, subagents included):
//   A1 dominant, S1 dominant, D1 dominant (present in two files), N1 none,
//   E1 embedded -> 5: 3 / 1 / 1; OUT (before the window) and a non-memory
//   tool call are dropped.
//   counters in the window: claude-code-plugin 15, unknown 5 (mem0-compat
//   excluded; rows outside the window dropped).
//   s_first = 3/6 = 0.5, s_agent = 3/5 = 0.6,
//   P_dom = (0.5 * 15 + 0.6 * 5) / 20 = 0.525.

/** A substring of prompt and result text the census must never echo (P3). */
export const CENSUS_MARKER = 'PROMPT-TEXT-MARKER';
const MARK = CENSUS_MARKER;

const user = (sessionId, uuid, timestamp, content, extra = {}) => ({
  type: 'user', sessionId, uuid, timestamp, isSidechain: false, userType: 'external',
  message: { role: 'user', content }, ...extra,
});
const assistantToolUse = (sessionId, uuid, timestamp, id, name, input, extra = {}) => ({
  type: 'assistant', sessionId, uuid, timestamp, isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text: 'Searching.' }, { type: 'tool_use', id, name, input }] },
  ...extra,
});
const toolResult = (sessionId, uuid, timestamp, toolUseId) => user(sessionId, uuid, timestamp,
  [{ type: 'tool_result', tool_use_id: toolUseId, content: `results ${MARK}` }]);

/** Relative path (POSIX) -> array of lines (objects are JSON-encoded; strings written raw). */
export const CENSUS_FILES = Object.freeze({
  'C--proj-alpha/sess-a1.jsonl': [
    { type: 'summary', summary: `older summary ${MARK}`, leafUuid: 'x' },
    user('sess-a1', 'a1-u1', '2026-09-12T08:00:00.000Z', `UM_FAKE_FLAG ${MARK}`),
    assistantToolUse('sess-a1', 'a1-a1', '2026-09-12T08:00:05.000Z', 'toolu_A1', 'mcp__um__memory_search', { query: '#4321' }),
    toolResult('sess-a1', 'a1-u2', '2026-09-12T08:00:06.000Z', 'toolu_A1'),
    user('sess-a1', 'a1-u3', '2026-09-12T08:05:00.000Z', 'how did we handle the widget pipeline restart'),
  ],
  'C--proj-alpha/sess-a1/subagents/agent-x1.jsonl': [
    user('sess-a1', 'x1-u1', '2026-09-20T10:00:00.000Z', `look up the widget notes ${MARK}`, { isSidechain: true, agentId: 'x1' }),
    assistantToolUse('sess-a1', 'x1-a1', '2026-09-20T10:00:03.000Z', 'toolu_S1', 'mcp__plugin_um__memory_search', { query: 'v9.8.7 widget' }, { isSidechain: true, agentId: 'x1' }),
  ],
  'C--proj-alpha/sess-a2.jsonl': [
    // First submitted line is a slash command: the whole session is excluded.
    user('sess-a2', 'a2-u0', '2026-09-15T09:00:00.000Z', '<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
    user('sess-a2', 'a2-u1', '2026-09-15T09:00:01.000Z', 'Caveat: generated while running local commands', { isMeta: true }),
    user('sess-a2', 'a2-u3', '2026-09-15T09:02:00.000Z', 'UM_AFTER_COMMAND_FLAG'),
  ],
  'C--proj-alpha/sess-a8.jsonl': [
    user('sess-a8', 'a8-u1', '2026-09-16T09:00:01.000Z', 'Caveat: generated while running local commands', { isMeta: true }),
    user('sess-a8', 'a8-u2', '2026-09-16T09:01:00.000Z', 'hi'),
    user('sess-a8', 'a8-u3', '2026-09-16T09:02:00.000Z', [{ type: 'text', text: `how did we fix the reindex warnings ${MARK.toLowerCase()}` }]),
    user('sess-a8', 'a8-u4', '2026-09-16T09:03:00.000Z', '<command-name>/compact</command-name>'),
  ],
  'C--proj-alpha/sess-a9.jsonl': [
    // A skipped short prompt, then a local command: excluded like a2.
    user('sess-a9', 'a9-u1', '2026-09-17T09:01:00.000Z', 'ok'),
    user('sess-a9', 'a9-u2', '2026-09-17T09:02:00.000Z', '<bash-input>ls</bash-input>'),
    user('sess-a9', 'a9-u3', '2026-09-17T09:03:00.000Z', '#4242'),
  ],
  'C--proj-alpha/sess-a3.jsonl': [
    user('sess-a3', 'a3-u1', '2026-09-05T09:00:00.000Z', 'lib/widget.mjs'),
    user('sess-a3', 'a3-u2', '2026-09-12T09:00:00.000Z', 'FAKE_FLAG_TWO'),
  ],
  'C--proj-alpha/sess-a4.jsonl': [
    user('sess-a4', 'a4-u1', '2026-10-09T01:00:00.000Z', 'FAKE_FLAG_THREE'),
  ],
  'C--proj-alpha/sess-a5.jsonl': [
    user('sess-a5', 'a5-u1', '2026-09-25T12:00:00.000Z', 'why does the reindex fail after FAKE_FLAG_ONE flips on in production'),
    assistantToolUse('sess-a5', 'a5-s1', '2026-09-25T12:00:10.000Z', 'toolu_D1', 'mcp__um__memory_search', { query: 'server/lib/stats.mjs freshness' }, { isSidechain: true }),
    assistantToolUse('sess-a5', 'a5-a2', '2026-09-25T12:00:20.000Z', 'toolu_R1', 'Read', { file_path: '/tmp/x.mjs' }),
  ],
  'C--proj-alpha/sess-a5/subagents/agent-y1.jsonl': [
    assistantToolUse('sess-a5', 'a5-s1', '2026-09-25T12:00:10.000Z', 'toolu_D1', 'mcp__um__memory_search', { query: 'server/lib/stats.mjs freshness' }, { isSidechain: true, agentId: 'y1' }),
    // A partial last line (the snapshot was copied while a session was live).
    `{"type":"assistant","sessionId":"sess-a5","uuid":"partial-line","message":{"content":[{"type":"text","text":"${MARK} cut off`,
  ],
  'C--proj-alpha/sess-a6.jsonl': [
    assistantToolUse('sess-a6', 'a6-a0', '2026-09-01T00:00:00.000Z', 'toolu_OUT', 'mcp__um__memory_search', { query: 'FAKE_FLAG_OUT' }),
    user('sess-a6', 'a6-u1', '2026-10-08T23:59:59.000Z', 'temporal decay feature flag'),
  ],
  'C--proj-alpha/sess-a7.jsonl': [
    { type: 'user', sessionId: 'sess-a7', uuid: 'a7-u1', isSidechain: false, message: { role: 'user', content: 'UM_UNDATED_FLAG' } },
  ],
  'C--proj-beta/sess-b1.jsonl': [
    user('sess-b1', 'b1-u0', '2026-10-01T07:00:00.000Z', 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
    toolResult('sess-b1', 'b1-u1', '2026-10-01T07:00:01.000Z', 'toolu_prev'),
    user('sess-b1', 'b1-u2', '2026-10-01T07:01:00.000Z', '--dry-run'),
    assistantToolUse('sess-b1', 'b1-a1', '2026-10-01T07:01:05.000Z', 'toolu_N1', 'mcp__um__memory_search', { query: 'how we fixed the reindex warnings' }),
    assistantToolUse('sess-b1', 'b1-a2', '2026-10-01T07:01:06.000Z', 'toolu_E1', 'mcp__4f1d__memory_search', { query: 'why does the reindex fail after UM_FAKE_FLAG flips on in production' }),
  ],
  'C--proj-beta/sess-c1.jsonl': [
    // A resumed session's file: it opens with a copy of sess-a1's first prompt
    // (same uuid, same sessionId) and continues under its own sessionId.
    user('sess-a1', 'a1-u1', '2026-09-12T08:00:00.000Z', `UM_FAKE_FLAG ${MARK}`),
    user('sess-c1', 'c1-u1', '2026-09-30T08:00:00.000Z', 'lib/widget.mjs'),
  ],
  'C--proj-beta/notes.txt': ['not a transcript'],
});

/** Counters export rows ({day, surface, n}); some outside the window, one excluded surface. */
export const CENSUS_COUNTERS = Object.freeze([
  { day: '2026-09-09', surface: 'claude-code-plugin', n: 100 },
  { day: '2026-09-10', surface: 'claude-code-plugin', n: 10 },
  { day: '2026-09-12', surface: 'unknown', n: 3 },
  { day: '2026-09-15', surface: 'mem0-compat', n: 4 },
  { day: '2026-10-01', surface: 'unknown', n: 2 },
  { day: '2026-10-08', surface: 'claude-code-plugin', n: 5 },
  { day: '2026-10-09', surface: 'unknown', n: 50 },
]);

export const CENSUS_EXPECTED = Object.freeze({
  first_prompts: { total: 6, none: 2, embedded: 1, dominant: 3 },
  agent_calls: { total: 5, none: 1, embedded: 1, dominant: 3 },
  volume: { plugin: 15, unknown: 5 },
  s_first: 0.5,
  s_agent: 0.6,
  p_dom: 0.525,
  malformed_lines: 1,
  sessions_command_first: 2,
});

/**
 * Write the snapshot under `dir/transcripts/` and the export at
 * `dir/counters-export.json`; returns both paths. LF line endings.
 */
export async function materializeCensusFixture(dir, { files = CENSUS_FILES, counters = CENSUS_COUNTERS } = {}) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const transcriptsDir = join(dir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  for (const [rel, lines] of Object.entries(files)) {
    const p = join(transcriptsDir, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  const countersPath = join(dir, 'counters-export.json');
  writeFileSync(countersPath, JSON.stringify(counters));
  return { transcriptsDir, countersPath };
}
