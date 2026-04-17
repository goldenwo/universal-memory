# universal-memory — Claude Code plugin

Cross-session, cross-device memory for Claude Code, backed by a self-hostable mem0 server.

## What this plugin does

- **SessionStart:** injects your relevant prior-session memories into the context of the new session.
- **Stop:** after each turn, writes an append-only markdown capture of the exchange, then asynchronously POSTs to the memory server for indexing.
- **Auto-start:** if the server isn't running and you've pointed the plugin at a compose dir, runs `docker compose up -d` for you on session start. Fails silently if not configured.

## Install

Two steps.

### 1. Run a universal-memory server somewhere

Easiest: use the included server at `server/` in the [universal-memory repo](https://github.com/goldenwo/universal-memory):

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
./install.sh      # prompts for OpenAI key, writes .env, runs docker compose up -d
```

Or pull the prebuilt image from GHCR and wire your own compose.

### 2. Install this plugin

Add the marketplace (once per machine):

```bash
# .claude/settings.json — under "extraKnownMarketplaces":
{
  "universal-memory": {
    "source": { "source": "github", "repo": "goldenwo/universal-memory" }
  }
}
```

Then enable the plugin in settings (it should appear in your plugin list). Reload Claude Code.

## Configuration

Set these env vars (machine-global, or per-project via a `.envrc`/direnv, etc.):

| Variable | Required? | Description |
|---|---|---|
| `UM_ENDPOINT` | required for the plugin to do anything | Your memory server URL. E.g. `http://localhost:6335` or `https://your-pi.taile....ts.net:6335`. |
| `UM_COMPOSE_DIR` | optional | Path to the directory containing your `docker-compose.yml`. If set, the plugin auto-runs `docker compose up -d` there when the endpoint is unreachable. Leave unset to opt out of auto-start. |
| `UM_CAPTURE_DIR` | optional | Where raw session captures get written. Defaults to `$HOME/.um/captures/<project>/raw/`. |

If `UM_ENDPOINT` is unset, the plugin hooks exit silently and do nothing — safe default.

## Testing the install

Open a new Claude Code session in any project. Ask: *"What do you already know about this project?"*

- On a fresh project with no prior memory: response is empty or minimal.
- On a project with prior memory: response includes what the SessionStart hook injected.

If auto-start is configured and the server was down, the session pauses briefly (< ~10s typical) while `docker compose up -d` brings it up, then proceeds normally. Watch Claude Code's hook output pane for `[um-autostart]` lines.

## Troubleshooting

- **"server not reachable" in the hook log:** your `UM_ENDPOINT` is wrong, the server isn't up, or `UM_COMPOSE_DIR` isn't pointing at a real compose directory. Start the server manually with `docker compose up -d` from your server dir and retry.
- **Hook seems slow to run:** auto-start polls `/health` for up to 60s after running compose. Normal for cold-start. On warm stack, probe is 2s.
- **Memories not showing up in new sessions:** verify `curl $UM_ENDPOINT/api/list` returns data. If empty, the Stop hook isn't successfully POSTing, OR mem0's extraction is filtering all inputs. Check `$HOME/.um/captures/<project>/raw/` — if that has data, the markdown-first write is working and only the indexing side is affected.

## Version compatibility

- Claude Code v2.1.59+ required (for the plugin system + autoDream compatibility).
- Requires `docker` + `docker compose` on PATH if auto-start is enabled.
