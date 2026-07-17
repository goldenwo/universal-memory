# CC hook input fixtures

Pinned input contracts for the plugin's Stop / SessionEnd / SessionStart hook rewrite
(#159). Every hook test in this directory's siblings asserts against these files, so
they must track what Claude Code actually sends — not what a hook wishes it sent.

- **Capture date:** 2026-07-17
- **Claude Code version:** 2.1.193 (`claude --version` on the capture box, Windows 11)
- **Transcript-line schema observed at:** CC 2.1.161–2.1.193 session transcripts under
  `~/.claude/projects/<sanitized-cwd>/*.jsonl`

## The contract in one line

Claude Code sends hooks a **small JSON metadata object on stdin** — NOT the transcript.
The transcript is a JSONL file at the metadata's `transcript_path`. (The pre-#159
`stop.sh` did `TRANSCRIPT=$(cat)` and therefore never captured anything.)

## Files and provenance

| File | Provenance |
| --- | --- |
| `stop-stdin.json` | **Reconstructed** from the official hooks docs (code.claude.com/docs/en/hooks, Stop input example + field table, fetched 2026-07-17) cross-checked against the fields the dev-box v2 hook (`~/.claude/scripts/mem0-hook-stop.sh`) consumes live. No verbatim stdin capture existed on this box (`~/.um/hook.log` records outcomes only). |
| `session-end-stdin.json` | **Reconstructed** from the official hooks docs SessionEnd example (same fetch). Field set kept exactly as documented. |
| `transcript-sample.jsonl` | **Structurally verbatim, content scrubbed.** Each line mirrors a real line shape found in real transcripts on this box (main-session `*.jsonl` plus a `subagents/agent-*.jsonl` for the sidechain shape); key names, types, and nesting are preserved exactly; prose, IDs, paths, and usage numbers were replaced with innocuous equivalents. |

## stop-stdin.json fields

Common fields: `session_id`, `transcript_path` (absolute path to the session JSONL;
Windows-shaped on this box), `cwd`, `permission_mode`, `hook_event_name: "Stop"`.
Stop-specific: `stop_hook_active` (true when the hook fires as a result of a previous
stop-hook continuation — hooks must exit early on it to avoid loops),
`last_assistant_message`, and (CC >= 2.1.145, when the task registry is reachable)
`background_tasks` / `session_crons` arrays (empty here; see docs for element shape).

## session-end-stdin.json fields

Common fields as above (docs' SessionEnd example omits `permission_mode`) plus
`reason` — one of `"clear"`, `"resume"`, `"logout"`, `"prompt_input_exit"`,
`"bypass_permissions_disabled"`, `"other"`.

## transcript-sample.jsonl — line-by-line

| # | Shape | Capture-relevance |
| --- | --- | --- |
| 1 | `type:"queue-operation"` (enqueue) | skip — not user/assistant |
| 2 | `type:"user"`, `message.content` = **string** | keep |
| 3 | `type:"user"`, `isMeta:true`, content = blocks array `[{type:"text"}]` (skill injection) | skip — `isMeta` |
| 4 | `type:"user"`, string content starting `<system-reminder>` | skip — reminder content |
| 5 | `type:"assistant"`, content = `[{type:"thinking"}]` only | keep-but-empty (no text blocks) |
| 6 | `type:"assistant"`, content = `[text, tool_use]`, `stop_reason:"tool_use"` | keep (text block only) |
| 7 | `type:"user"`, content = `[{type:"tool_result"}]`, envelope has `toolUseResult` + `sourceToolAssistantUUID` | skip — no text blocks |
| 8 | `type:"assistant"`, content = `[text]` (normal answer) | keep |
| 9 | `type:"user"`, `isSidechain:true`, `agentId`, `parentUuid:null` (subagent-transcript shape) | skip — `isSidechain` |
| 10 | `type:"system"`, `subtype:"api_error"` | skip — not user/assistant |
| 11 | `type:"assistant"`, `model:"<synthetic>"`, `isApiErrorMessage:true` (client-synthesized API-error line) | structurally kept by naive type filters — tests should decide |
| 12 | `type:"user"`, content = blocks array `[{type:"text"}]` (non-meta) | keep |

Envelope fields on user/assistant lines (all observed live): `parentUuid`,
`isSidechain`, `promptId` (user lines), `type`, `message`, `uuid`, `timestamp`,
`permissionMode`/`promptSource` (user prompts), `requestId` (assistant lines),
`userType`, `entrypoint`, `cwd`, `sessionId`, `version`, `gitBranch`. Assistant
`message` carries the full API message (`id`, `model`, `content[]`, `stop_reason`,
`usage{...}`). Other top-level `type` values seen in real transcripts and NOT
sampled here: `attachment`, `last-prompt`, `pr-link`, `mode` — hooks must skip
unknown types rather than enumerate them. `type:"summary"` lines were not observed
in any transcript on this box at capture time.

## What the hooks consume (minimum contract)

From stdin: `transcript_path` (Stop + SessionEnd), `session_id`, `hook_event_name`,
`reason` (SessionEnd), `stop_hook_active` (Stop). From the transcript: `type`
(user/assistant only), `isSidechain`, `isMeta`, `message.role`,
`message.content` as string OR blocks array (text blocks only), skipping
`<system-reminder>`-prefixed text. This matches the working dev-box v2 parser.

## Scrubbing notes

All conversational content, UUIDs, message/request/tool-use IDs, usernames, and
project paths are fabricated placeholders; structure (keys, value types, nesting,
block ordering) is preserved from the real lines. Session IDs match
`^[A-Za-z0-9._-]+$`. No credentials, e-mail addresses, or personal content remain.
