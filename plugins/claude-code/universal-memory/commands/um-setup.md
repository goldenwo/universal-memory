---
description: First-run setup — point the plugin at your universal-memory server, verify it, save config
---

Run the plugin's first-run setup: verify a universal-memory server (health check + an authed write probe) and, on success, write `~/.um/endpoint` and `~/.um/auth-token` (mode 600) so every hook resolves it.

Steps:

1. Ask the user for their UM server URL (default `http://localhost:6335` for a local Docker install; a remote server looks like `http://your-host:6337`).
2. Ask whether the server needs an auth token. Loopback installs usually don't; anything reached through a tunnel/proxy does. If a token is needed and the user prefers not to paste it in chat, tell them to run the script themselves in a terminal — it has a hidden token prompt:
   `bash "${CLAUDE_PLUGIN_ROOT}/hooks/um-setup.sh"`
3. Otherwise execute via the Bash tool (token flag only when one was given):
   `bash "${CLAUDE_PLUGIN_ROOT}/hooks/um-setup.sh" --endpoint <url> [--token <token>]`
4. Relay the result. On failure the script prints one actionable message per cause and writes nothing — the important distinctions:
   - `unreachable` — wrong URL, server down, or tunnel/firewall in between.
   - `writes are DISABLED (HTTP 403)` — the server needs `UM_MCP_WRITE_ENABLED=true` (and `UM_MOUNT_MODE=rw`) in its `.env`, then a restart.
   - `server is too old (404 on the write probe)` — the server predates the `/api` capture routes; it must be upgraded to v1.7.0 or newer.
   - `rejected the token (401)` — token mismatch with the server's `UM_AUTH_TOKEN`.

On success, hooks work immediately in the next session — no restart of Claude Code required for capture; the state-of-play banner appears at the next SessionStart.
