# Walkthrough: solo developer on Windows (WSL2)

A fresh-eyes walkthrough of installing universal-memory and proving session continuity works. Targeted at a solo developer on Windows 10/11 with WSL2. **Roughly 15–20 minutes if everything goes right** — slightly longer than macOS/Linux because of the WSL2 bridge.

This walkthrough is intentionally hand-holdy and verifiable at every step. If a check fails, the [Troubleshooting](#troubleshooting) section below lists the most common causes.

> **Status:** Mirror of [`linux-solo-dev.md`](linux-solo-dev.md) authored 2026-05-08. **Verification level:** macOS-equivalent paths confirmed; Linux mirror derived from macOS but unverified; **this Windows mirror further derived from Linux and unverified on Windows hardware**. WSL2-primary path is favored over native PowerShell because it minimizes platform-specific divergence. Native-PowerShell users should treat this doc as a starting point and expect paper cuts at the WSL/Windows boundary; please open issues for any friction. The W2.2 runner pass on Windows is the canonical signal for shipping this version stable.

> **Why WSL2 and not native PowerShell?** Universal-memory's installer + plugin install scripts + `um` CLI are all bash. Running them under WSL2 is the supported path. A native-PowerShell runtime is theoretically possible but every script would need a rewrite — that's a v1.1+ effort. For Windows on v1.0: install Docker Desktop + WSL2, then run everything from inside the WSL2 shell.

---

## What you'll have at the end

- A locally-running memory server (Docker Compose: Qdrant + the UM HTTP server on `localhost:6335` — bound on the WSL2 side, accessible from Windows)
- The `universal-memory` plugin installed and active in Claude Code
- A vault directory inside WSL2 with at least one captured session and a generated `state.md`
- Verified that a second Claude Code session opens with `state.md` content already in context

---

## Prerequisites

| Item | Version / detail |
|---|---|
| Windows | 10 (build 19041+) with WSL2 enabled OR 11 (any version) |
| WSL2 distro | Ubuntu 22.04 (recommended) or Debian 12. Install via `wsl --install -d Ubuntu` from elevated PowerShell, then reboot. |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 4.30+ for Windows, configured with **WSL2 backend enabled** (Settings → General → "Use the WSL 2 based engine"). Settings → Resources → WSL Integration → enable for your distro. |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | Latest CLI. **Install inside WSL2**, not on Windows side, so it has access to the WSL2 filesystem. Verify with `claude --version` inside WSL2. |
| OpenAI API key | A real `sk-…` key with access to `gpt-4o-mini` and `text-embedding-3-small`. **Stays on your machine** — written to `server/.env`, never sent anywhere except OpenAI |
| Disk | ~700 MB for the Docker images + a few hundred KB for your vault |
| Time | 15–20 minutes |

You do **not** need: a Pi, a remote host, a tunnel, OpenClaw, or any other component. Pure local install.

> **Open all the commands below inside a WSL2 shell** (e.g. `wsl` from PowerShell, or open Ubuntu from the Start menu). The walkthrough is identical to the Linux walkthrough from this point forward, with one boundary note at Step 4 about Claude Code accessing the WSL2 filesystem.

---

## Step 1: Confirm Docker is reachable from WSL2

From inside WSL2 (Ubuntu shell, not Windows PowerShell):

```bash
docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Start Docker Desktop on Windows + enable WSL2 integration"
```

If that prints `Start Docker Desktop on Windows`:
- Open **Docker Desktop** on the Windows side (Start menu).
- Wait until the whale icon stops animating.
- In Docker Desktop **Settings → Resources → WSL Integration**, ensure your distro (e.g. Ubuntu) is toggled on. Click "Apply & Restart" if you changed anything.
- In WSL2, re-run the check.

---

## Step 2: Install the memory server

Inside WSL2:

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
bash install.sh
```

The wizard will prompt for:

- **`MEM0_USER_ID`** — any string. This is your namespace. `me` works fine for a single-user install.
- **`OPENAI_API_KEY`** — paste your `sk-…` key.
- **`UM_VAULT_DIR`** — where your vault lives on the host. The default `~/.um/vault` is fine. Note this is inside WSL2 (`/home/you/.um/vault`), NOT under `/mnt/c/Users/...`. Putting the vault on the WSL2 native filesystem is significantly faster than under `/mnt/c/`.

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

The server is bound on `localhost:6335` from inside WSL2. Docker Desktop's WSL2 integration also exposes this to the Windows host via `localhost:6335` — useful if you want to test from a Windows-native browser, but Claude Code (running inside WSL2) just uses `localhost`.

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
um state                         # auto-resolves to git repo name or $UM_PROJECT
# Or pass an explicit project name:
um state my-project-name
```

`um state` takes a **project name** (not your user / namespace ID). With no argument it resolves from `$UM_PROJECT` or the git repo name. The call should return an empty/missing-state response — same reason as `memories: 0`. You haven't generated a state yet.

---

## Step 4: Install the Claude Code plugin

> **Important:** install Claude Code **inside WSL2**, not on the Windows side. The plugin's hooks are bash and need access to the WSL2 filesystem (where your vault lives).

Two supported paths — pick one:

**Path A (recommended for first-time setup): bash installer.** From the repo root, inside WSL2:

```bash
bash installer/install-plugin-cc.sh
```

This registers the plugin AND writes a managed shell-rc marker block (`UM_SERVER_URL`, `UM_LIB_DIR`, `UM_CLI_DIR`, PATH guard, `UM_AUTH_TOKEN` loader). After running it, source your shell rc or open a new terminal so the exports take effect.

**Path B (Claude Code marketplace flow): manual JSON edit.** If you prefer to wire the plugin via Claude Code's marketplace UI without the bash installer:

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

Edit `~/.claude/settings.json` (inside WSL2; this is `/home/you/.claude/settings.json`, NOT `C:\Users\you\.claude\settings.json`), reload Claude Code, then enable the plugin from `/plugin`. **Path B does NOT write the shell-rc marker block** — you'll need to manually export the env vars below for hooks to function.

### Set environment variables

The plugin's hooks read these from your shell environment. Add to `~/.bashrc` (bash, default in Ubuntu) or `~/.zshrc` (zsh, if you've switched):

```bash
export UM_ENDPOINT=http://localhost:6335     # consumed by hooks (session-start, user-prompt-submit)
export UM_VAULT_DIR=$HOME/.um/vault           # match what install.sh set (= /home/you/.um/vault inside WSL2)
export UM_OPENAI_API_KEY=sk-...               # paste your key (or skip if OPENAI_API_KEY is already global)
```

> **Note on `UM_ENDPOINT` vs `UM_SERVER_URL`:** the plugin's bash hooks (`session-start.sh`, `user-prompt-submit.sh`) read `UM_ENDPOINT`. The `um` CLI and managed marker block use `UM_SERVER_URL`. Both name the same concept; consolidation to a single canonical name is deferred to v1.1. For v1.0 keep both stable — manual `UM_ENDPOINT` export is required even if the marker block already set `UM_SERVER_URL`.

The install wizard also generated `~/.um/auth-token` and wrote a marker-block trailer to your shell rc that auto-exports `UM_AUTH_TOKEN`. Confirm:

```bash
cat ~/.um/auth-token | head -c 8 ; echo "..."   # should print 8 hex chars + ...
```

Source the rc or open a new terminal so the exports take effect: `source ~/.bashrc`.

### Verify

In a fresh WSL2 terminal:

```bash
echo "$UM_ENDPOINT $UM_VAULT_DIR ${UM_AUTH_TOKEN:0:8}..."
# Expected: http://localhost:6335 /home/you/.um/vault <8-hex-chars>...
```

All three must be set or the hooks will silently no-op.

---

## Step 5: First Claude Code session — capture something

Open Claude Code in any project directory inside WSL2 (a real one with code is fine; an empty test dir works too):

```bash
cd ~/my-test-project    # or wherever — keep it inside WSL2 for performance
claude
```

> **Filesystem hint:** project dirs under `/home/you/...` (WSL2 native) are dramatically faster than dirs under `/mnt/c/Users/...` (Windows-side, accessed via 9P protocol). For day-to-day work, keep your projects inside WSL2.

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

Open Claude Code **in the same project directory** as Step 5 (still inside WSL2):

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
stat -c '%Y %n' ~/.um/vault/state/<your-project-name>/state.md
# (GNU stat — same as Linux. Compare to Step 6's mtime; should be more recent.)
```

---

## Step 9: (Optional) Cross-surface — Claude.ai web

If you want to verify cross-surface access, follow [docs/connecting-claude-ai.md](../connecting-claude-ai.md) to wire your local `localhost:6335` server (visible to both WSL2 and Windows) to Claude.ai's MCP connector via a tunnel. Once connected:

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
# Install tree if missing (Ubuntu): sudo apt install tree
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

If you want to browse the vault from Windows: in File Explorer, navigate to `\\wsl$\Ubuntu\home\you\.um\vault\` (substitute your distro name and username). The vault is private; you control its lifecycle.

---

## Troubleshooting

### Step 2 issues

**`docker info` says "Cannot connect to the Docker daemon" inside WSL2**
Docker Desktop isn't running, or WSL2 integration isn't enabled. In Docker Desktop GUI: Settings → Resources → WSL Integration → toggle on for your distro → Apply & Restart.

**`docker compose up` fails with `port is already allocated`**
Something else is on port `6335` (or `6333` for Qdrant). Find it from inside WSL2: `ss -ltn 'sport = :6335'`. Or from PowerShell on Windows: `Get-NetTCPConnection -LocalPort 6335`. Either stop the conflicting process or override the port via `MEM0_MCP_PORT` in `server/.env` and `UM_ENDPOINT` in your shell.

**`docker compose pull` fails with `unauthorized` or `denied: requested access to the resource is denied`**
You cloned the repo before the public-flip and the GHCR image isn't pullable yet. Set `UM_BUILD_LOCAL=1` and re-run install.sh — this builds the server image from source instead of pulling from GHCR:
```bash
UM_BUILD_LOCAL=1 bash install.sh
```
Once the public-flip lands, the GHCR image is pullable and you can switch back by unsetting `UM_BUILD_LOCAL`.

**`/health` returns `503` or never responds**
Look at the server log: `docker compose logs memory-server | tail -50`. Most common: missing `OPENAI_API_KEY`, missing `MEM0_USER_ID`, or Qdrant not yet ready (give it another 10s on slow hardware — WSL2 IO is slower than native Linux).

**Wizard exits with `MEM0_USER_ID is required`**
You hit Enter on the prompt without typing anything. Re-run `bash install.sh` and provide a value.

### Step 6 issues

**`state.md` not generated after 30s**
- Confirm the SessionEnd hook fired: look in `~/.um/vault/` for any `*.log` files.
- Confirm your `OPENAI_API_KEY` is reachable: `curl -s -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models | head`. If that fails, your key is wrong, rate-limited, or your WSL2 instance can't reach the internet (try `curl https://api.openai.com` to verify general connectivity).
- The OpenAI live-continuity test sometimes returns empty output for transient reasons (variability in real LLM output). Run a second short session and end it; the second pass usually generates `state.md`.

**`state.md` exists but is empty / has placeholder text**
The synthesizer returned malformed output. This is a known intermittent flake (tracked in [issue #47](https://github.com/goldenwo/universal-memory/issues/47)). Run another session and the next synthesis pass should succeed.

### Step 7 issues

**Claude doesn't seem to know about the prior session**
- Confirm `UM_VAULT_DIR` is set in the new session's environment: `echo $UM_VAULT_DIR`. If empty, the SessionStart hook silently no-ops.
- Confirm the project directory is detected the same way both sessions: the hook uses `package.json` → git remote → directory name in that order. If you ran the first session in `~/foo` and the second in `~/foo-renamed`, they'll be different projects.
- Confirm Claude Code is running INSIDE WSL2, not on the Windows host. A Windows-side Claude Code can't reach the WSL2 vault filesystem.

### General

**Hooks all silently no-op**
The hooks check `[ -n "$UM_ENDPOINT" ]` and exit 0 if empty. Confirm all three exports are present in the WSL2 shell where Claude Code runs:

```bash
echo "$UM_ENDPOINT" "$UM_VAULT_DIR" "$UM_AUTH_TOKEN"
```

Any of those empty = hooks no-op. Source your rc file or open a fresh WSL2 terminal.

**Slow filesystem performance**
If you cloned the repo or put your vault under `/mnt/c/...`, IO will be 10-100× slower than under `/home/you/...`. Move both to WSL2-native paths.

---

## WSL2-specific notes

- **Filesystem placement:** keep `universal-memory` repo, vault, and project dirs inside WSL2 (`/home/you/...`). Avoid `/mnt/c/Users/...` for these — the 9P protocol bridge is slow.
- **Port forwarding:** Docker Desktop with WSL2 backend automatically exposes container ports to Windows `localhost`. No extra setup needed.
- **Docker Desktop required:** rootless Docker inside WSL2 without Docker Desktop is theoretically possible but unsupported by this walkthrough. Stick with Docker Desktop + WSL2 integration.
- **Two filesystems:** Windows can read WSL2 files via `\\wsl$\<distro>\...` UNC paths; WSL2 can read Windows files via `/mnt/c/...`. Avoid crossing the boundary in performance-sensitive paths.
- **Claude Code on Windows host vs WSL2:** install Claude Code inside WSL2. The Windows-host Claude Code installation can't reach the WSL2 vault filesystem.

---

## Native-PowerShell users (NOT recommended for v1.0)

If you absolutely cannot use WSL2, the bash-based installer + plugin install + `um` CLI all need rewrites. This is **out of scope for v1.0**. Tracking is a v1.1+ workstream — please open an issue if you want to advocate for it. Current state: WSL2 is the supported Windows path.

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

If you ran this walkthrough cold on Windows and hit anything that wasn't covered here, please open a GitHub issue (or, if you have repo access, a PR against this file). The most useful kinds of feedback for the Windows path:

- A WSL2 integration friction point — e.g. a permission, networking, or filesystem boundary issue
- A Docker Desktop setting that needed adjustment beyond what this doc says
- A step's "Verify" check passed but the next step failed — means the verify check is too lax
- A step needed a sub-step that wasn't documented — means the doc assumes too much
- Time estimate was wrong by >2x — means something needs streamlining

This Windows mirror is **derived without Windows-hardware testing**. Every paper cut a real Windows runner finds is high-value — please report.
