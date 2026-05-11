---
name: create-remember
description: Save a casual fact to universal-memory. /remember <text> POSTs the fact to the running UM server; no file written, no git repo required. /remember --help shows usage.
---

# /remember — casual fact capture skill

You (the LLM running this skill) are responsible for parsing the user's
`ARGUMENTS:` line and dispatching to a bash helper that does the
sanitization, payload assembly, and HTTP POST. **Do not assemble the
JSON payload yourself, do not curl the server yourself** — call the
helper for everything.

## Step 1 — parse the ARGUMENTS line

The `ARGUMENTS:` line contains the user's input after `/remember`.
Examples:

| ARGUMENTS                            | What the user typed                          |
|--------------------------------------|----------------------------------------------|
| `Bought milk on Tuesday`             | `/remember Bought milk on Tuesday`           |
| `"Quoted multi-word fact"`           | `/remember "Quoted multi-word fact"`         |
| `--help`                             | `/remember --help`                           |
| `-- --literal flag-like text`        | `/remember -- --literal flag-like text`      |
| (empty)                              | `/remember`                                  |

Apply these rules **in this exact order**:

1. **`--help` or `-h`** appears anywhere in args, OR args is empty →
   invoke `create-remember.sh help`. (The bare `/remember` form falls
   here; users without an explicit text are asking what the command
   does.)
2. **POSIX `--` end-of-flags terminator:** anything after `--` is
   treated as text content with no flag interpretation. `/remember --
   --literal text` → text is `--literal text`.
3. **Unknown flags** (`--foo` other than `--help`/`-h`) anywhere in
   args → reply with `unknown flag: <flag> (recognized: --help)` and
   STOP — do NOT invoke the helper.
4. **Remaining tokens form the text.** Whitespace-join them. Strip
   surrounding shell-quote characters if the args came pre-quoted.

## Step 2 — invoke the helper via Bash tool

The helper lives at `~/.claude/skills/create-remember/create-remember.sh`.
Use the Bash tool with the structured CLI form:

- **Help:** `bash ~/.claude/skills/create-remember/create-remember.sh help`
- **Remember:** `bash ~/.claude/skills/create-remember/create-remember.sh remember --text "<text>"`

Pass the joined text as a single quoted argument to `--text`. Never
forward a bare `--` separator to the helper; the LLM is the
end-of-flags parser, not the helper.

## Step 3 — surface the helper's output verbatim

The helper prints either a 2-line success block, a single WARNING
line (warn-only path on transient/auth failure), OR an error message
on hard fail (stderr). Whatever the helper prints, surface it to the
user as your assistant message body — **do not add commentary,
summaries, "Done!" lines, or restated context**. The helper output IS
the user-facing message.

Exit-code conventions (same as `/adr`):
- 0 → success (line-1 + line-2) OR warn-only (single WARNING line)
- 64 → usage error (unknown flag, missing `--text`, oversized text)
- 65 → input validation failed (empty after sanitization, bidi reject,
  HTTP 400/422 from server)
- 70 → internal error (e.g. python3 not installed and no
  `UM_CODEPOINT_TOOL` override)

## Notes for special cases

- **User typed only `/remember`** (no args, no flags) → invoke help.
  The user is asking what the command does.
- **Text contains shell metacharacters** (backticks, dollar signs,
  pipe, etc.) → still pass as a single quoted argument; the helper's
  bash sanitization + `_json_escape` handles it. Never expand or
  evaluate the text.
- **Long text** → if the LLM sees the user pasted a giant blob (e.g.
  > 1KB), still forward it as-is; the helper will hard-fail with exit
  64 at the 4096-codepoint limit, and the user gets a clear "split
  into multiple /remember calls" message.
- **Server unreachable / 401 / 429 / 5xx** → helper emits warn-only
  (exit 0, single WARNING line). The WARNING line includes the
  sanitized text preview so the operator can re-run verbatim after
  fixing the issue.
