# universal-memory — Claude Code plugin

Cross-session, cross-device memory for Claude Code. Session hooks capture
every conversation to a universal-memory server — local Docker or remote
self-hosted — which synthesizes a per-project `state.md` and injects it at the
start of every new session.

Since v1.7.0 the hooks are **API-always thin HTTP clients** (spec #159): every
capture goes through the server's `/api/append-turn` + `/api/checkpoint`,
loopback or remote alike. No client-side vault, no client LLM key.

Full guide (install shapes, config resolution, operator flags,
troubleshooting): [`docs/claude-code-plugin.md`](../../../docs/claude-code-plugin.md).

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
| **SessionEnd** (`session-end.sh`) | Clean exit | Detached POST `/api/checkpoint`; the server runs summary + `state.md` update with its own key |
| **`/um-checkpoint`** | On demand | Forces a checkpoint now |
| **`/um-setup`** | First run | Setup flow above |

Every fire logs to `~/.um/hook.log` (`posted http=<code>` / `skip=<reason>` /
`error=<reason>`) — capture problems are never silent.

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
`UM_MOUNT_MODE=rw` — see the operator section of
[`docs/claude-code-plugin.md`](../../../docs/claude-code-plugin.md#operator-side--server-flags-for-capture).

## Requirements

- Bash + curl on PATH; a working Python (`py`/`python3`/`python`) for
  transcript parsing. Windows: Git Bash (ships with Git for Windows) or WSL.
- Claude Code v2.1.59+.

## The `um` CLI

The standalone `um` CLI (`search`, `state`, `recent`, `list`, `capture`,
`tail`) talks to the same server from shell scripts and cron. See
[`installer/install-cli.md`](../../../installer/install-cli.md) and
[`docs/um-cli.md`](../../../docs/um-cli.md).

## Verify it works

Open a session, do some work, run `/um-checkpoint`. Next session, the
state-of-play is injected before your first message. Capture health:
`tail ~/.um/hook.log`.
