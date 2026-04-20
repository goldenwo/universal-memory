# universal-memory — Claude Code plugin

Cross-session, cross-device memory for Claude Code. Captures every session as
structured markdown, synthesizes it into searchable summaries and a per-project
`state.md`, and injects the most relevant context at the start of every new session.

## What this plugin does

Four hooks + one slash command + two CLIs:

| Component | When it runs | What it does |
|---|---|---|
| **SessionStart** (`session-start.sh`) | On every new session | Reads `state.md` and injects it as `additionalContext`; detects unprocessed raw captures and kicks off the catchup pipeline in the background; injects a memory routing rubric so "remember this" has predictable behavior: durable facts go to mem0 via `memory_capture`; project-scoped work goes to `state.md` automatically |
| **Stop** (`stop.sh`) | After every Claude turn | Appends an entry to the daily raw capture file — cheap, no LLM call, always runs |
| **SessionEnd** (`session-end.sh`) | When Claude Code exits cleanly | Runs the full synthesis pipeline: LLM summary → `state.md` update → reindex |
| **UserPromptSubmit** (`user-prompt-submit.sh`) | On every user message | On first user message per session, vector-searches memory (`POST /api/search` with the prompt text) and injects top 5 hits (~2k token budget) as additionalContext. Exits silently for 2nd+ prompts and when server is unreachable. |
| **`/um-checkpoint`** (slash command) | User-triggered | Forces `session-end.sh` to run immediately — use after a significant decision or before a long break |
| **`um-forget`** (CLI) | Manual | Deprecates a vault document by ID (sets `status: deprecated`) and reindexes |
| **`um-supersede`** (CLI) | Manual | Marks an old document superseded and registers the new one; reindexes both |

## Configuration

| Variable | Required? | Default | Description |
|---|---|---|---|
| `UM_ENDPOINT` | Yes (for any network ops) | — | Your memory server URL, e.g. `http://localhost:6335` |
| `UM_VAULT_DIR` | Yes | `$HOME/.um/vault` | Host path to the vault directory. Must match the server's `UM_VAULT_DIR`. |
| `UM_OPENAI_API_KEY` | Yes (for synthesis) | falls back to `$OPENAI_API_KEY` | API key used by the summarization and state-update LLM calls |
| `UM_COMPOSE_DIR` | Optional | — | Path to a directory with `docker-compose.yml`. If set, the plugin auto-runs `docker compose up -d` when the endpoint is unreachable |
| `UM_SUMMARY_ENABLED` | Optional | `true` | Set to `false` to skip the summarization pipeline entirely (no LLM calls, no state updates) |
| `UM_TEMPORAL_DECAY` | Optional | `false` | Pass-through to server; enables time-based decay ranking when searching. Set in the server's `.env`, not here |

If `UM_ENDPOINT` is unset, all hooks exit silently — safe default.

## Requirements

- **pyyaml**: the `um-forget` and `um-supersede` CLIs use Python 3 + `pyyaml` for frontmatter mutation. Install with `pip install pyyaml` (or `pip3 install pyyaml`).
- Bash 4+ on PATH. On macOS, the system `/bin/bash` is version 3 — install `bash` via Homebrew.
- Windows: Git Bash or WSL required (native PowerShell not yet supported).

## Install

### One-command setup

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
./install.sh
```

The wizard handles everything:
1. Collects your OpenAI API key, validates it against `/v1/models`, and writes `server/.env`
2. Copies (or symlinks) the plugin into `$HOME/.claude/plugins/universal-memory`
3. Appends `export UM_OPENAI_API_KEY=...` to your shell profile (`~/.bashrc` or `~/.zshrc`)
4. Pulls and starts the Docker stack
5. Polls the health endpoint until the server is ready

After the wizard completes, **restart Claude Code** — the plugin is already installed.

### Post-install check

```bash
bash server/install.sh --verify
```

Runs a battery of 9 checks (Docker, health endpoint, plugin presence, env vars, vault, pyyaml, hook smoke test, session-end dry-run, cleanup) and reports pass/fail with fix commands.

### Remote server

Deploy the server image (`ghcr.io/goldenwo/universal-memory-server`) and set `UM_ENDPOINT` in your env to point at it. You can then skip the Docker wizard but still run `install.sh` for the plugin-install and shell-profile steps.

## Verify it works

Open a new Claude Code session. After some work, run `/um-checkpoint`. In the next
session, ask: *"What do you already know about this project?"* — you should see the
synthesized state injected into context.

To check raw captures are being written:

```bash
ls "$UM_VAULT_DIR/captures/<project>/raw/"
```

## Troubleshooting

- **"server not reachable"**: check `curl $UM_ENDPOINT/health`. If the server is
  down and `UM_COMPOSE_DIR` is set, the plugin will try `docker compose up -d` automatically.
- **No summaries being generated**: verify `UM_OPENAI_API_KEY` is set and `UM_SUMMARY_ENABLED` is not `false`. Check `$UM_VAULT_DIR/.telemetry/session-end*.log` for errors.
- **Memories not showing in new sessions**: check `curl $UM_ENDPOINT/api/list`. If empty, the reindex step failed. Raw captures under `$UM_VAULT_DIR/captures/` are your durable backup — re-run `session-end.sh` manually to recover.
- **Lock not released after crash**: lockdirs older than 10 minutes are auto-cleared on the next run (stale-lock recovery). To clear manually: `rmdir "$UM_VAULT_DIR/state/<project>/state.md.lockdir"`.

## Version compatibility

- Claude Code v2.1.59+ required.
- Plugin version: 0.3.0-alpha. See [ROADMAP.md](../../../ROADMAP.md) for planned features.
