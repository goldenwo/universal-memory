# universal-memory — Claude Code plugin

Cross-session, cross-device memory for Claude Code. Session hooks capture
every conversation to a universal-memory server — local Docker or remote
self-hosted — which synthesizes a per-project `state.md` and injects it at the
start of every new session.

Since v1.7.0 the hooks are **API-always thin HTTP clients** (spec #159): every
capture goes through the server's `/api/append-turn` + `/api/checkpoint`,
loopback or remote alike. No client-side vault, no client LLM key.

Install, upgrade and troubleshooting: the repository
[README](../../../README.md).

## Minimum server version

**Requires a universal-memory server ≥ v1.7.0** (the release shipping the
`/api` capture contract the hooks are pinned against). The setup probe and
hooks distinguish an old server (HTTP 404 → "upgrade it") from a current
server with writes disabled (HTTP 403 → "flip `UM_MCP_WRITE_ENABLED`").

## Install

Marketplace (no checkout):

```bash
claude plugin marketplace add goldenwo/universal-memory
claude plugin install universal-memory@universal-memory
```

Or from a repo checkout: `bash installer/install.sh --plugin-cc`
(add `--remote <url>` for a remote server).

Codex CLI installs this same plugin from the same marketplace:
`codex plugin marketplace add goldenwo/universal-memory`, then
`codex plugin add universal-memory@universal-memory` (or
`bash installer/install.sh --plugin-codex`). Approve the hooks when `codex` lists
them: at first install and, on Codex 0.164 and later, after each update. See
[Codex hook approval](#codex-hook-approval).

Antigravity's CLI loads this same folder too, through `.antigravity-plugin/plugin.json` and
the `hooks.json` at the plugin root: `bash installer/install.sh --plugin-antigravity` from a
repo checkout. See [Antigravity](#antigravity).

## First run: `/um-setup`

A fresh install ships hooks but no config. Run **`/um-setup`** once (or
`bash hooks/um-setup.sh` in a terminal for a hidden token prompt). It prompts
for the server URL + token, verifies the server with a health check **and an
authed write probe**, and only on success writes `~/.um/endpoint` +
`~/.um/auth-token` (600). Failures print one actionable message per cause and
write nothing.

## What runs

| Component | When | What it does |
|---|---|---|
| **SessionStart** (`session-start.sh`) | New session | Injects the project's server-side `state.md` + memory-routing rubric; shows a visible ⚠ banner when captures are OFF (server unreachable / writes disabled) |
| **UserPromptSubmit** (`user-prompt-submit.sh`) | First prompt per session | Vector-search injection of top memory hits |
| **Stop** (`stop.sh`) | After every turn | Parses the session transcript (delta cursor) and POSTs new messages to `/api/append-turn` — no LLM, fail-open |
| **SessionEnd** (`session-end.sh`) | Clean exit | POST `/api/checkpoint` in **accepted mode** — the server answers 202 at once and runs summary + `state.md` update afterwards with its own key. The hook logs `accepted`, which means taken, **not** digested |
| **`/um-checkpoint`** | On demand | Forces a checkpoint now |
| **`/um-setup`** | First run | Setup flow above |

Every fire logs to `~/.um/hook.log` (`posted http=<code> … project=<slug>` /
`accepted project=<slug>` / `skip=<reason>` / `error=<reason>`) — capture problems are never silent,
and since #294 the resolved project slug rides every success line. `accepted` is `session-end`'s
accepted-mode line: the server took the job, and whether synthesis then succeeded is reported by
`bin/um-alert.sh`'s `CHECKPOINT-FAILURE` section rather than here.

Checkpoint synthesis is chunked server-side (bounded input per call, regardless of backlog size), so
a single `SessionEnd` fire (or `/um-checkpoint`) may leave `backlog_remaining: true` on a project
with a large undigested backlog — the next fire simply resumes from a durable cursor and continues.
For catching up many calls or many projects at once, see the operator tool `bin/um-drain.sh`
(progressive drain: loops the same POST, with a cost estimate and confirm gate, until every project
reports `backlog_remaining: false`).

## Configuration

Endpoint resolution (first match wins):

| Tier | Source | Notes |
|---|---|---|
| 1 | `UM_SERVER_URL` env | Canonical; shadows the file tier |
| 2 | `UM_ENDPOINT` env | Deprecated alias |
| 3 | `~/.um/endpoint` file | Written by `/um-setup` / `install.sh --remote` |
| 4 | `http://localhost:6335` | Loopback default |

Token: `${UM_TOKEN_FILE:-~/.um/auth-token}` — absent/empty ⇒ no auth header
(valid for loopback). Optional: `UM_COMPOSE_DIR` lets `auto-start.sh` bring a
**local** server up on demand (never fires for remote endpoints).

Server-side, captures require `UM_MCP_WRITE_ENABLED=true` +
`UM_MOUNT_MODE=rw` in `server/.env`, then `docker compose up -d` from `server/`.

## Requirements

- Bash + curl on PATH; a working Python (`py`/`python3`/`python`) for
  transcript parsing. Windows: Git for Windows (its Git Bash runs the hooks), or run the client
  inside WSL.
- Claude Code v2.1.59+.

### Codex on Windows

Codex runs these hooks through `hooks/run-hook.cmd` on Windows (`commandWindows` in
`hooks/hooks.json`), which locates Git Bash itself: launched from PowerShell or cmd, the first
`bash` on PATH is usually `C:\Windows\System32\bash.exe`, the WSL launcher, which cannot run these
scripts. The launcher adds a few tens of milliseconds to Codex's one-second SessionEnd budget and
passes the hook payload through untouched. If Git lives somewhere the launcher cannot find (a
portable or scoop install), set `UM_GIT_BASH` to the absolute path of its `bin\bash.exe` (not
`C:\Windows\System32\bash.exe`, which is WSL's and is refused); when set, it is the only place the
launcher looks. A launcher that finds no Git Bash logs `skip=no-git-bash` to `~/.um/hook.log` and
lets the session continue. A Codex home whose path contains `^`, `$`, a backtick or a curly quote
is not supported: the hooks fail to start (move it with `CODEX_HOME`).

### Codex hook approval

Codex runs only hooks you have approved. Interactive `codex` lists new or changed hooks at
startup: choose **Trust all and continue** (if other hooks are waiting too, the review option
approves them one at a time). Until you do, Codex runs none of them. `codex exec` never asks, so if
you only use `codex exec`, open `codex` once to approve.

What makes Codex ask again depends on its version:

- **Before 0.164.0**: a change to a hook's own definition in `hooks/hooks.json` (event, matcher,
  command, timeout). `hooks/hooks-json.test.sh` pins those, so an update normally asks nothing. The
  one update that did was the one that introduced `run-hook.cmd`, which changed the Windows command
  of all four hooks.
- **0.164.0 and later**: that, or a change to any file in the installed plugin. Every
  universal-memory update changes at least the version number, so Codex asks again after each
  update, on every platform.

### Antigravity

Antigravity reads the `hooks.json` at the plugin root, not `hooks/hooks.json` (which Claude Code
and Codex read and Antigravity ignores). Tested on the Antigravity CLI, agy 1.5.3, on Windows;
macOS, Linux, and the Antigravity app and IDE are untested.

| Antigravity event | Script | What it does |
|---|---|---|
| **SessionStart** | `agy-session-start.sh` | Fires at the first prompt of a conversation and carries that prompt. Runs `session-start.sh`, then `user-prompt-submit.sh`, and returns both results as one injected message |
| **Stop** | `agy-stop.sh` | Fires after every turn. Runs `stop.sh`, which reads Antigravity's transcript as a third format beside Claude Code's and Codex's |

The two `agy-` scripts only translate Antigravity's hook input and output (`lib/agy.sh`); the
capture and recall logic is the one the other hosts run. What differs:

- **The server's address must be saved in `~/.um/endpoint`**, which `bash installer/install.sh
  --remote <url>` writes. `/um-setup` does not exist on Antigravity, and a server installed on
  the same machine does not write the file: without it the hooks capture turns to
  `http://localhost:6335` but inject nothing.
- **No session-end event.** The end-of-session summary and the `state.md` update come from the
  server's idle sweep, hourly, for sessions idle six hours or more. Turns are captured at once.
- **`SessionStart` is not fired again when a conversation is resumed**, so a resumed conversation
  gets no fresh state injection; its turns are still captured.
- **Windows.** Antigravity runs a hook through `cmd`, from the installed plugin's folder, so the
  command is `hooks\run-hook.cmd <script>` and needs Git for Windows, as under Codex. A double
  quote anywhere in a hook command breaks it there.
- **Failures are silent in the session.** Antigravity logs a failed hook to
  `~/.gemini/antigravity-cli/cli.log` (search for `jsonhook__universal-memory`). The hooks log
  their own line per run to `~/.um/hook.log`: `agy-session-start ok sid=<conversation>` and
  `agy-stop ok sid=<conversation>`, next to the usual lines of the scripts they run.
- **Antigravity keeps a copy.** `agy plugin install` copies this folder to
  `~/.gemini/config/plugins/universal-memory`, so run the installer again after an update.
  `agy plugin uninstall universal-memory` removes it.
- **Slash commands.** Antigravity does not load this plugin's `commands/`, so `/um-setup`,
  `/um-checkpoint` and `/um-preview` do not exist there. The skills load as
  `/universal-memory:create-adr` and `/universal-memory:create-remember`.

## The `um` CLI

The standalone `um` CLI (`search`, `state`, `recent`, `list`, `capture`,
`tail`) talks to the same server from shell scripts and cron. See
[`installer/install-cli.md`](../../../installer/install-cli.md) and
[`docs/um-cli.md`](../../../docs/um-cli.md).

## Verify it works

Open a session, do some work, run `/um-checkpoint`. Next session, the
state-of-play is injected before your first message. Capture health:
`tail ~/.um/hook.log`.
