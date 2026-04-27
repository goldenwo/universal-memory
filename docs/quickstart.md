# Quickstart

Get cross-session memory working in Claude Code in about 5 minutes.

## Step 1: Start the memory server

Clone the repo and run the install wizard (sets up your `.env`, starts the Docker stack):

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
bash install.sh
```

The wizard prompts for your OpenAI API key, a user ID, and your vault directory. It writes `server/.env` and runs `docker compose up -d`.

Verify it started:

```bash
curl http://localhost:6335/health
# {"ok":true,"memories":0}
```

## Step 2: Register the plugin in Claude Code

Add the marketplace to your `.claude/settings.json` (create it if it doesn't exist):

```json
{
  "extraKnownMarketplaces": {
    "universal-memory": {
      "source": { "source": "github", "repo": "goldenwo/universal-memory" }
    }
  }
}
```

Enable the `universal-memory` plugin from the plugin list. Reload Claude Code.

Set env vars in your shell profile (`~/.bashrc`, `~/.zshenv`, etc.):

```bash
export UM_ENDPOINT=http://localhost:6335
export UM_VAULT_DIR=$HOME/.um/vault        # match what the wizard set
export UM_OPENAI_API_KEY=sk-...            # or OPENAI_API_KEY if already set globally
```

**v0.6+ — bearer auth:** the install wizard generates `UM_AUTH_TOKEN` and writes it to `~/.um/auth-token`. The installer also adds a marker-block trailer to your shell rc that auto-exports it:

```bash
# Added by install.sh (universal-memory)
[ -r "$HOME/.um/auth-token" ] && export UM_AUTH_TOKEN="$(cat "$HOME/.um/auth-token")"
```

After install, **`source ~/.bashrc` (or restart your shell)** so the bridge CLIs and curl examples pick up `$UM_AUTH_TOKEN`. Loopback requests (`127.0.0.1` / `::1`) skip auth by default; set `UM_ALLOW_LOOPBACK_NOAUTH=false` to require the token even from localhost.

## Step 3: First session

Open any project in Claude Code. Do some work. The Stop hook appends a raw capture after each message. At the end of the session, the SessionEnd hook synthesizes a summary.

## Step 4: Second session — state injected

Open a new session in the same project. The SessionStart hook reads `state.md` (if it exists) and injects it as context. Ask Claude: *"What do you already know about this project?"*

The first synthesis runs during the first SessionEnd or the next SessionStart catchup. Give it a session or two to accumulate enough content.

## Step 5: On-demand refresh with /um-checkpoint

At any point mid-session, run `/um-checkpoint` to force a state update immediately — useful after a significant decision or before handing off to another session.

## Optional: MCP write tools for Claude.ai

If you also use Claude.ai or Claude Desktop and want those surfaces to write to your vault, enable write tools:

```env
# server/.env
UM_MCP_WRITE_ENABLED=true
UM_MOUNT_MODE=rw
```

Then restart the server: `docker compose restart memory-server`.

**Read the security note in `docs/mcp-tools.md` first** — enabling writes opens the vault over HTTP. Bind to localhost or use a VPN/reverse proxy before enabling on a shared network.

## Troubleshooting

- **Server unreachable**: `curl http://localhost:6335/health` — if it fails, `docker compose logs memory-server`.
- **No state injected**: check `ls "$UM_VAULT_DIR/state/<project>/"`. If empty, no synthesis has run yet. Try `/um-checkpoint`.
- **Summaries not generating**: check `UM_OPENAI_API_KEY` is set. Look in `$UM_VAULT_DIR/.telemetry/` for logs.
- **Plugin not loading**: confirm `universal-memory` appears in your active plugins list at session start. Check `.claude/settings.json` marketplace entry.
