---
name: create-adr
description: Author an Architectural Decision Record (ADR) in the current repo. /adr [<title>] writes docs/decisions/NNNN-<slug>.md, commits, and registers with the universal-memory server. /adr sync NNNN re-registers an existing ADR.
---

# /adr — Architectural Decision Record skill

You (the LLM running this skill) are responsible for parsing the user's `ARGUMENTS:` line and dispatching to a bash helper that does the file writing, git commit, and HTTP POST. **Do not write the ADR file yourself, do not run git yourself, do not curl yourself** — call the helper for everything.

## Step 1 — parse the ARGUMENTS line

The `ARGUMENTS:` line contains the user's input after `/adr`. Examples:

| ARGUMENTS                         | What the user typed         |
|-----------------------------------|------------------------------|
| `Adopt mem0 OSS for vector store` | `/adr Adopt mem0 OSS for vector store` |
| `"Quoted title with spaces"`      | `/adr "Quoted title with spaces"`      |
| `sync 0042`                       | `/adr sync 0042`             |
| `--help`                          | `/adr --help`                |
| `-- --literal flag-like title`    | `/adr -- --literal flag-like title` |
| (empty)                           | `/adr`                       |

Apply these rules **in this exact order**:

1. **`--help` or `-h`** appears anywhere in args, OR args is empty → invoke `create-adr.sh help`.
2. **First non-flag token is the literal `sync`** AND second token matches `^[0-9]{4,}$` → invoke `create-adr.sh sync <NNNN>`. (Do NOT treat `/adr 2026 my notes` as sync — only the literal token `sync` triggers sync mode.)
3. **POSIX `--` end-of-flags terminator:** anything after `--` is treated as title content with no flag interpretation. `/adr -- --literal title` → title is `--literal title`.
4. **Recognized flags** (extract before assembling title): `--commit`, `--no-path`. Anything else starting with `--` (other than `--help` handled above and `--` terminator) → reply with `unknown flag: <flag> (recognized: --commit, --no-path, --help)` and STOP — do NOT invoke the helper.
5. **Remaining tokens form the title.** Whitespace-join them. Strip surrounding shell-quote characters if the args came pre-quoted.

## Step 2 — invoke the helper via Bash tool

The helper lives at `~/.claude/skills/create-adr/create-adr.sh`. Use the Bash tool with the structured CLI form:

- **Help:** `bash ~/.claude/skills/create-adr/create-adr.sh help`
- **Create:** `bash ~/.claude/skills/create-adr/create-adr.sh create --title "<title>" [--commit] [--no-path]`
- **Sync:** `bash ~/.claude/skills/create-adr/create-adr.sh sync <NNNN>`

Pass the title as a single quoted argument. Pass `--commit` and `--no-path` only if the user supplied them. Use the user's current working directory as cwd — the helper resolves the git toplevel itself.

## Step 3 — surface the helper's output verbatim

The helper prints either a 3-line success block or an error message to stdout/stderr. Whatever the helper prints, surface it to the user as your assistant message body — **do not add commentary, summaries, "Done!" lines, or restated context**. The helper output IS the user-facing message.

If the helper exits 0, the operation succeeded (possibly with a WARNING line on the third line — still exit 0, that's the warn-only contract for transient failures). If the helper exits non-zero, include the error message verbatim and stop.

## Notes for special cases

- **User typed only `/adr`** (no args, no flags) → invoke help. The user is asking what the command does.
- **Title contains shell metacharacters** (backticks, dollar signs, etc.) → still pass as a single quoted argument; the helper's bash sanitization handles it.
- **`/adr sync` with no NNNN** → reply `usage: /adr sync NNNN (e.g. /adr sync 0042)` and STOP.
- **The user is running this skill from inside the universal-memory repo itself** → just invoke the helper as normal. The helper detects self-application and skips the commit + POST automatically; the success output's third line will say `Skipped registration (universal-memory self-host)`. The user does not need any special handling from you.
