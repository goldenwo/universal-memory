# Walkthrough: solo developer on macOS

A fresh-eyes walkthrough of installing universal-memory and proving session continuity works. Targeted at a solo developer on macOS with no prior context. **Roughly 10–15 minutes if everything goes right.**

This walkthrough is intentionally hand-holdy and verifiable at every step. If a check fails, the [Troubleshooting](#troubleshooting) section below lists the most common causes.

> **Status:** This document is the v1.0 plan's W2.1 deliverable — the walkthrough doc that the W2.2 fresh-eyes runner will execute. Paper cuts surfaced during the W2.2 run land as small follow-up PRs against this doc.

---

## What you'll have at the end

- A locally-running memory server (Docker Compose: Qdrant + the UM HTTP server on `localhost:6335`)
- The `universal-memory` plugin installed and active in Claude Code
- A vault directory with at least one captured session and a generated `state.md`
- Verified that a second Claude Code session opens with `state.md` content already in context — no manual paste-in

---

## Prerequisites

| Item | Version / detail |
|---|---|
| macOS | 13 (Ventura) or newer |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 4.30+ (any recent version is fine; just confirm it's running before Step 2) |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | Latest CLI; verify with `claude --version` |
| OpenAI API key | A real `sk-…` key with access to `gpt-4o-mini` and `text-embedding-3-small`. **Stays on your machine** — written to `server/.env`, never sent anywhere except OpenAI |
| Disk | ~700 MB for the Docker images + a few hundred KB for your vault |
| Time | 10–15 minutes |

You do **not** need: a Pi, a remote host, a tunnel, OpenClaw, or any other component. Pure local install.

---

## Step 1: Confirm Docker Desktop is running

```bash
docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Start Docker Desktop first"
```

If that prints `Start Docker Desktop first`, open Docker Desktop from Applications, wait until the whale icon stops animating, then re-run the check.

---

## Step 2: Install the memory server

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
bash install.sh
```

The wizard will prompt for:

- **`MEM0_USER_ID`** — any string. This is your namespace. `me` works fine for a single-user install.
- **`OPENAI_API_KEY`** — paste your `sk-…` key.
- **`UM_VAULT_DIR`** — where your vault lives on the host. The default `~/.um/vault` is fine.

The vault is mounted **read-only** by default (server reads, hooks write directly from your shell). To enable MCP write tools later, set `UM_MOUNT_MODE=rw` in your environment before re-running the wizard — `UM_MOUNT_MODE` is an advanced env override, not a wizard prompt.

When the wizard finishes, it runs `docker compose up -d` and polls `/health`. Expected last line:

```
[install] Server is healthy: {"ok":true,"memories":0}
```

If you see anything else, jump to [Troubleshooting § Step 2](#step-2-issues).

### Verify

```bash
curl -s http://localhost:6335/health
# Expected: {"ok":true,"memories":0}
```

`memories: 0` is right — you haven't captured anything yet.

```bash
docker compose ps
# Expected: two services (memory-server, qdrant), both "running"
```

---

## Step 3: (Optional) Install the `um` CLI

Useful for shell scripting and quick recall from the command line, but not required for the rest of this walkthrough. Skip if you only care about the Claude Code path.

```bash
cd ..   # back to repo root
bash installer/install-cli.sh
```

This installs `um` into your PATH. Verify:

```bash
um --version
um state me   # if you set MEM0_USER_ID=me; substitute your value
```

The `um state` call should return an empty/missing-state response — same reason as `memories: 0`. You haven't generated a state yet.

---

## Step 4: Install the Claude Code plugin

In your home dir or any Claude-Code project, edit `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "universal-memory": {
      "source": {
        "source": "github",
        "repo": "goldenwo/universal-memory"
      }
    }
  }
}
```

Reload Claude Code (close + reopen the CLI, or the IDE if you're using the IDE integration). Then enable the `universal-memory` plugin from the plugin list (`/plugin` slash command in Claude Code, then choose `enable`).

### Set environment variables

The plugin's hooks read these from your shell environment. Add to your `~/.zshenv` (or `~/.bashrc` if you use bash):

```bash
export UM_ENDPOINT=http://localhost:6335
export UM_VAULT_DIR=$HOME/.um/vault          # match what install.sh set
export UM_OPENAI_API_KEY=sk-...               # paste your key (or skip if OPENAI_API_KEY is already global)
```

The install wizard also generated `~/.um/auth-token` and wrote a marker-block trailer to your shell rc that auto-exports `UM_AUTH_TOKEN`. Confirm:

```bash
cat ~/.um/auth-token | head -c 8 ; echo "..."   # should print 8 hex chars + ...
```

Source the rc or open a new terminal so the exports take effect.

### Verify

In a fresh terminal:

```bash
echo "$UM_ENDPOINT $UM_VAULT_DIR ${UM_AUTH_TOKEN:0:8}..."
# Expected: http://localhost:6335 /Users/you/.um/vault <8-hex-chars>...
```

All three must be set or the hooks will silently no-op.

---

## Step 5: First Claude Code session — capture something

Open Claude Code in any project directory (a real one with code is fine; an empty test dir works too):

```bash
cd ~/my-test-project    # or wherever
claude
```

Have a substantive conversation. **Two minutes of real work** is enough — ask Claude to explain a file, refactor something small, debate a design choice. The Stop hook captures every assistant message.

When you're done, `/exit` or close the session normally.

### Verify capture happened

```bash
ls -la ~/.um/vault/captures/<your-project-name>/raw/
# Expected: a 2026-MM-DD.md file (one daily file, append-only Markdown)
```

The exact subdirectory name depends on the project's `package.json`, git remote, or directory name (in that order of preference). If you don't see a project-named subdir, look for `unknown/` — that's the fallback.

```bash
wc -l ~/.um/vault/captures/<your-project-name>/raw/*.md
# Expected: at least a few lines — one section per assistant message, Markdown-formatted
```

---

## Step 6: End the first session — observe summary + `state.md`

The SessionEnd hook (or `/exit`) triggers session-end processing: synthesize a summary, refresh `state.md`, index the captured turns. Wait ~10–30 seconds after closing the session for the LLM call to complete.

### Verify

```bash
ls -la ~/.um/vault/state/<your-project-name>/state.md
# Expected: file exists, ~1-3 KB
```

```bash
cat ~/.um/vault/state/<your-project-name>/state.md
```

Expected shape (per [docs/state-of-play.md](../state-of-play.md)):

```markdown
---
project: <your-project-name>
generated_at: 2026-05-07T...
session_count: 1
---

# Current focus
<one-line headline of what the session was about>

# In-flight work
<bulleted list of unfinished items>

# Recent decisions
<bulleted list with rationale>

# Next actions
<bulleted next steps>
```

If `state.md` doesn't exist after waiting 30s, see [Troubleshooting § Step 6](#step-6-issues).

You can also confirm captures landed in the index:

```bash
curl -s -H "Authorization: Bearer $UM_AUTH_TOKEN" http://localhost:6335/health
# Expected: {"ok":true,"memories":<N>} where N > 0
```

---

## Step 7: Second Claude Code session — observe continuity

Open Claude Code **in the same project directory** as Step 5:

```bash
cd ~/my-test-project
claude
```

The SessionStart hook reads `state.md` and injects it as context before your first message. **Look for a banner or system-context line at the top of the session** — it varies by Claude Code version, but the content of `state.md` will be silently in context.

### Verify

Without giving Claude any context yet, ask:

```
What did we work on last session?
```

Claude should be able to summarize accurately based on the injected `state.md`. If Claude says "I don't know" or asks you to provide context, the hook didn't fire — see [Troubleshooting § Step 7](#step-7-issues).

---

## Step 8: Force a mid-session checkpoint

During an active session, run:

```
/um-checkpoint
```

This immediately re-synthesizes `state.md` from accumulated raw captures since the last summary. Useful after a significant decision you want captured before the session ends.

### Verify

```bash
stat -f '%m %N' ~/.um/vault/state/<your-project-name>/state.md
# (BSD stat — macOS default. Compare to Step 6's mtime; should be more recent.)
```

---

## Step 9: (Optional) Cross-surface — Claude.ai web

If you want to verify cross-surface access, follow [docs/connecting-claude-ai.md](../connecting-claude-ai.md) to wire your local `localhost:6335` server to Claude.ai's MCP connector via a tunnel. Once connected:

```
memory_state("<your-project-name>")
# Should return your state.md content from the same vault Claude Code wrote to
```

This step is **deferred** if you're only on Claude Code today — local-only is the simpler shape.

---

## Step 10: Inspect your vault

A guided tour of what's in your vault, so you know what to look at later:

```bash
tree -L 3 ~/.um/vault/
```

Expected layout:

```
~/.um/vault/
├── captures/
│   └── <your-project-name>/
│       └── raw/
│           └── 2026-05-07.md            # daily raw-capture files (append-only Markdown)
├── sessions/
│   └── <your-project-name>/
│       └── *.md                         # per-session LLM-synthesized summaries
├── state/
│   └── <your-project-name>/
│       └── state.md                     # current synthesized state-of-play
└── docs/                                # authored documents (ADRs etc.) — empty for now
```

Add `~/.um/vault/` to your watched directories or `.gitignore` so it doesn't get pulled into project git history accidentally. The vault is private; you control its lifecycle.

---

## Troubleshooting

### Step 2 issues

**`docker compose up` fails with `port is already allocated`**
Something else is on port `6335` (or `6333` for Qdrant). Find it: `lsof -i :6335`. Either stop the conflicting process or override the port via `MEM0_MCP_PORT` in `server/.env` and `UM_ENDPOINT` in your shell.

**`/health` returns `503` or never responds**
Look at the server log: `docker compose logs memory-server | tail -50`. Most common: missing `OPENAI_API_KEY`, missing `MEM0_USER_ID`, or Qdrant not yet ready (give it another 10s on slow hardware).

**Wizard exits with `MEM0_USER_ID is required`**
You hit Enter on the prompt without typing anything. Re-run `bash install.sh` and provide a value.

### Step 6 issues

**`state.md` not generated after 30s**
- Confirm the SessionEnd hook fired: `tail -50 ~/.um/vault/raw/<project>/.session-end.log` (path varies; search for `*.log` files in the vault).
- Confirm your `OPENAI_API_KEY` is reachable: `curl -s -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models | head`. If that fails, your key is wrong or rate-limited.
- The OpenAI live-continuity test sometimes returns empty output for transient reasons (variability in real LLM output). Run a second short session and end it; the second pass usually generates `state.md`.

**`state.md` exists but is empty / has placeholder text**
The synthesizer returned malformed output. This is a known intermittent flake (tracked in [issue #47](https://github.com/goldenwo/universal-memory/issues/47)). Run another session and the next synthesis pass should succeed.

### Step 7 issues

**Claude doesn't seem to know about the prior session**
- Confirm `UM_VAULT_DIR` is set in the new session's environment: `echo $UM_VAULT_DIR`. If empty, the SessionStart hook silently no-ops.
- Confirm the project directory is detected the same way both sessions: the hook uses `package.json` → git remote → directory name in that order. If you ran the first session in `~/foo` and the second in `~/foo-renamed`, they'll be different projects.
- Check the SessionStart hook output: there's usually a short banner mentioning UM. If it's missing, plugin isn't enabled — re-enable in `/plugin`.

### General

**Hooks all silently no-op**
The hooks check `[ -n "$UM_ENDPOINT" ]` and exit 0 if empty. Confirm all three exports are present in the shell where Claude Code runs:

```bash
echo "$UM_ENDPOINT" "$UM_VAULT_DIR" "$UM_AUTH_TOKEN"
```

Any of those empty = hooks no-op. Source your rc file or open a fresh terminal.

---

## Next steps

- **[docs/architecture.md](../architecture.md)** — the source / synthesis / index frame and how the pieces fit together.
- **[docs/mcp-tools.md](../mcp-tools.md)** — the 11 MCP tools (4 read, 7 write) for programmatic access.
- **[docs/um-cli.md](../um-cli.md)** — the 7-subcommand `um` CLI reference.
- **[docs/connecting-claude-ai.md](../connecting-claude-ai.md)** / **[docs/connecting-chatgpt-desktop.md](../connecting-chatgpt-desktop.md)** — wiring up the cross-surface flows.
- **[CHANGELOG.md](../../CHANGELOG.md)** — what's shipped, what's in flight.
- **[CONTRIBUTING.md](../../CONTRIBUTING.md)** — if a paper cut you hit during this walkthrough is fixable, this is how to send it.

---

## Feedback for the W2.2 runner

If you ran this walkthrough cold and hit anything that wasn't covered here, please open a GitHub issue (or, if you have repo access, a PR against this file). The most useful kinds of feedback:

- A step's "Verify" check passed but the next step failed — means the verify check is too lax
- A step needed a sub-step that wasn't documented — means the doc assumes too much
- Time estimate was wrong by >2x — means something needs streamlining
- An error message you saw that this doc didn't reference — means [Troubleshooting](#troubleshooting) needs a new entry

Walkthrough quality is the v1.0 ship signal — every paper cut here is a real one.
