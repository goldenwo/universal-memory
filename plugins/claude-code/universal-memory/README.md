# universal-memory — Claude Code plugin

Cross-session, cross-device memory for Claude Code, backed by a self-hostable mem0 server.

## What this plugin does

- **SessionStart:** injects your relevant prior-session memories into the context of the new session.
- **Stop:** after each turn, writes an append-only markdown capture of the exchange, then asynchronously POSTs to the memory server for indexing.
- **Auto-start:** if the server isn't running and you've pointed the plugin at a compose dir, runs `docker compose up -d` for you on session start. Fails silently if not configured.

## Deployment scenarios

The plugin talks to *any* universal-memory server over HTTP. Pick the scenario that fits you:

| Scenario | What you set up | Auto-start? |
|---|---|---|
| **Local Docker** — server runs on your dev machine | Clone repo, `server/install.sh`. Set `UM_ENDPOINT=http://localhost:6335` and `UM_COMPOSE_DIR=/path/to/server`. | ✅ plugin runs `docker compose up -d` when endpoint is down |
| **Remote self-hosted** — server runs on a Pi, VPS, or k8s cluster | Deploy the server image (`ghcr.io/goldenwo/universal-memory-server`) on that host. Point `UM_ENDPOINT` at its URL (e.g. via Tailscale). Leave `UM_COMPOSE_DIR` unset. | ❌ remote host starts the server itself; plugin just points at it |
| **Cloud Qdrant as index** | Configure your UM server (local or remote) to use a managed Qdrant URL in its `.env`. Plugin unchanged. | Depends on where the UM server runs |
| **Cloud mem0.ai direct** (no UM server) | **Not supported in v0.1.** Would require the plugin to speak mem0.ai's API shape. Tracked on the roadmap. | — |

OpenClaw users: the plugin has zero OpenClaw dependencies and runs identically whether OpenClaw is installed or not.

Windows users: hooks are bash scripts and require Git Bash or WSL. Native PowerShell hooks are on the roadmap.

## Install

Two steps.

### 1. Run a universal-memory server somewhere

Easiest (local Docker): use the included server at `server/` in the [universal-memory repo](https://github.com/goldenwo/universal-memory):

```bash
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
./install.sh      # prompts for OpenAI key, writes .env, runs docker compose up -d
```

For remote / custom hosting, pull the prebuilt image and wire your own compose or orchestrator:

```bash
docker pull ghcr.io/goldenwo/universal-memory-server:latest
# then run it wherever — any host reachable from your dev machine works
```

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
| `UM_COMPOSE_DIR` | optional | Path to a directory containing a `docker-compose.yml` for the UM server on *this* machine. If set, the plugin auto-runs `docker compose up -d` there when the endpoint is unreachable. Leave unset for remote-server scenarios — the plugin won't try to start a remote host it can't reach. |
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
