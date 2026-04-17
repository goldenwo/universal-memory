# Quickstart

**Status:** 🚧 Scaffold. Full walkthroughs pending plugin and server implementation.

## Three install paths

### Path 1 — Cloud mode (fastest, no self-hosted infra)

For users who want to try the system with minimal setup.

1. Sign up at [mem0.ai](https://mem0.ai) and grab an API key.
2. Install the Claude Code plugin.
3. Configure plugin with `mode: "cloud"` and paste the API key.

Elapsed: ~60 seconds. You now have cross-session memory.

### Path 2 — Self-hosted server

For privacy, control, and zero per-request costs.

1. Pick a host (laptop, Pi, VPS — anywhere Docker runs).
2. `git clone` this repo, `cd server`.
3. `cp .env.example .env` and set `OPENAI_API_KEY` + `MEM0_USER_ID`.
4. `docker-compose up -d`.
5. Install the Claude Code plugin (same as Path 1 but with `mode: "self-hosted"` and `endpoint: "http://your-host:6335"`).

Elapsed: ~5 minutes.

### Path 3 — Self-hosted + cross-device

Add sync of markdown source files across your machines.

1. Complete Path 2.
2. Pick a sync mechanism: Syncthing (recommended), or nightly `git push` to a bare repo on the same host.
3. Configure each additional device with the same endpoint.

The memory server sees all your devices as one. Queries from any device return context captured on any other.

## Verify it works

After install, open a Claude Code session:

```
"What do you already know about this project?"
```

On a fresh project with no prior memory, the response should be empty or near-empty. Captures accumulate as you work. On subsequent sessions, the SessionStart hook injects relevant prior facts automatically.

## Troubleshooting

- **Server unreachable:** check `curl http://your-host:6335/health` returns JSON. If not, inspect `docker-compose logs`.
- **Hook not firing:** confirm Claude Code picked up the plugin — look for `universal-memory` in the active plugins list at session start.
- **No memories retrieved:** verify your `userId` matches across plugin config and server `.env`.
