# um-tunnel — one-command tunnel onboarding

`um-tunnel` is a small bash CLI that removes the networking friction from connecting ChatGPT Desktop, Claude.ai, Claude Desktop, or a Custom GPT to a locally running universal-memory server. Run it once and it prints the URL + routing rubric block you need to paste into your MCP client.

> TL;DR: `cd <repo>` → `plugins/claude-code/universal-memory/bin/um-tunnel` → copy the MCP connector URL and the rubric block → paste into ChatGPT / Claude.ai settings.

---

## When to use

- You have UM running locally (`install.sh` + `docker compose up -d`) and want a remote MCP client (ChatGPT Desktop, Claude.ai, Custom GPT) to hit it.
- You don't want to memorize the tunnel CLI flags, find the routing rubric, and paste it together by hand on every new machine.
- You want an opinionated default that still defers to whatever tunnel CLI you already have installed.

**Do not use it** if you only run Claude Code locally and don't need a remote client — UM's Claude Code plugin reaches `localhost:6335` directly and doesn't need a tunnel.

---

## How it works

1. **Tunnel CLI detection.** `um-tunnel` checks your `PATH` in priority order:
   1. `cloudflared`
   2. `tailscale`
   3. `ngrok`

   The first one it finds is used. Set `UM_TUNNEL_CLI=<binary>` to force a specific one. If none of the three (and no env override) resolves, `um-tunnel` exits with install hints instead of guessing.

2. **Tunnel start.** It launches the CLI forwarding to `http://localhost:${UM_PORT:-6335}` and merges the CLI's stdout + stderr into a log file (`${UM_TUNNEL_LOG:-/tmp/um-tunnel-output.log}`).

3. **URL extraction.** It polls the log (every 0.5s, up to 10s) for a public HTTPS URL matching the expected pattern (`trycloudflare.com`, `ts.net`, or `ngrok-*.app`/`ngrok-*.io`). If it can't find one, it prints an error and the log path so you can debug. Trailing slashes are stripped (Tailscale Funnel prints its URL with one) so the `/mcp` join below never doubles the slash.

4. **Panel print-out.** It prints:
   - The base public URL
   - The MCP connector URL (`$URL/mcp`) — paste this into ChatGPT Desktop / Claude.ai "Add connector"
   - The OpenAPI spec URL (`$URL/openapi.yaml`) — for Custom GPT Actions
   - The routing rubric body (resolved from `docs/memory-routing-rubric.md`) — paste this into the MCP client's custom instructions
   - A contextual security note based on the **running server's** write-mode, detected in precedence order: (1) a live `tools/list` probe against `localhost:$UM_PORT/mcp` (a write tool in the response means writes are ON), (2) `server/.env` (path overridable via `UM_SERVER_ENV_FILE`), (3) this shell's `UM_MCP_WRITE_ENABLED` as a last resort. The probe means the banner reflects what the container actually serves, not a possibly-stale shell variable; the chosen source is logged to stderr as `[um-tunnel] Write-mode: <true|false> (source: <tier>)`.

5. **Block until Ctrl+C.** The tunnel subprocess stays alive. When you Ctrl+C, `um-tunnel` cleanly kills the tunnel via its SIGINT/SIGTERM/EXIT trap.

---

## Tunnel CLI comparison

| CLI | Cost | Account required | Auth story | Recommended for |
|-----|------|-------------------|------------|-----------------|
| **cloudflared** | Free | No (for ephemeral `trycloudflare.com` URLs) | Pair with Cloudflare Access for SSO/basic-auth | First-time users, single-machine demos |
| **tailscale** | Free (personal) | Yes (Tailscale account) | Identity-bound via tailnet; per-device ACLs | Anyone already on Tailscale |
| **ngrok** | Free tier available | Yes (ngrok account) | Basic-auth via `--basic-auth=user:pass`; paid tier for stable hosts | Quick demos where you already have ngrok |

All three tunnels expose `http://localhost:6335` at a public HTTPS URL. None of them adds auth by default — UM itself has no auth layer. See the security model below.

---

## Forwarded-header default-deny (v0.6 — why tunnels force auth)

As of v0.6, UM uses a **forwarded-header presence check** as a proxy-safety signal (per spec §4.2). When any of the following headers is present on an incoming request, the server bypasses its loopback-noauth shortcut and requires a valid `Authorization: Bearer <token>` header:

| Header | Purpose |
|---|---|
| `X-Forwarded-For` | Standard de-facto client IP from reverse proxy |
| `X-Forwarded-Proto` | Original protocol (http/https) from proxy |
| `X-Forwarded-Host` | Original Host header from proxy |
| `X-Forwarded-Port` | Original port from proxy |
| `X-Real-IP` | Single-client-IP variant used by nginx |
| `Forwarded` | RFC 7239 standardized forwarding header |
| `CF-Connecting-IP` | Cloudflare client IP (Cloudflare Tunnel / CDN) |
| `CF-Ray` | Cloudflare Ray ID — confirms Cloudflare proxying |
| `True-Client-IP` | Akamai / Cloudflare real-IP alternative |
| `X-Original-Forwarded-For` | Forwarded-For after internal re-forwarding |

**Rationale:** all major tunnel CLIs (`cloudflared`, `ngrok`, `tailscale funnel`) inject at least one of these headers when they forward a request. Presence of any forwarded-header indicates the request passed through a proxy, meaning it originated from outside the host — even if the outer TCP connection arrives on `127.0.0.1`. Without this check, a tunnel-fronted loopback could bypass auth silently.

**Effect on `um-tunnel` users:** the token from `~/.um/auth-token` (written by `install.sh`) must be included in every tunnel-fronted request. The UM connector docs and CLI wrapper handle this automatically when `UM_AUTH_TOKEN` is exported. Direct `curl` calls to a tunnel URL must include the header:

```bash
curl -H "Authorization: Bearer $UM_AUTH_TOKEN" https://<tunnel-host>/mcp ...
```

Loopback requests with **no** forwarded-headers (e.g. direct `curl http://localhost:6335/...` from the same host) continue to skip auth.

---

## Security model (blunt)

- **Tunneling makes `localhost:6335` world-reachable at the printed URL.** Anyone who guesses or intercepts the URL can hit your MCP server.
- **Bearer auth is required for all tunnel-fronted requests (v0.6+).** The token lives at `~/.um/auth-token`; see the forwarded-header section above for why.
- **MCP write tools remain gated on `UM_MCP_WRITE_ENABLED`.** The tunnel does **not** bypass that gate. With `UM_MCP_WRITE_ENABLED=false` (the default), remote callers get `{ ok: false, error: "MCP writes disabled" }` when they try to persist anything.
- **`UM_MCP_WRITE_ENABLED=true` + public tunnel with no auth = world-writable vault.** Don't do this without fronting the tunnel with auth.
- **For any non-trivial use, front the tunnel with auth:**
  - Cloudflare Access (works natively with `cloudflared`)
  - Tailscale ACL (use `tailscale serve` instead of `funnel` when you only need tailnet-internal reach; ACLs restrict per-device)
  - ngrok basic-auth (`ngrok http 6335 --basic-auth=user:pass`) or ngrok OAuth
- **`um-tunnel` prints a prominent warning whenever the running server has writes enabled** (live-detected via `tools/list`, falling back to `server/.env`, then the shell env). Heed it.

Cross-reference: [`docs/mcp-tools.md` §Security](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http) has the full exposure model, including the recommended localhost-bind (`MEM0_MCP_PORT=127.0.0.1:6335`) for single-machine use.

---

## Usage

```bash
# Auto-detect an installed tunnel CLI (default port 6335):
bin/um-tunnel

# Force a specific CLI:
UM_TUNNEL_CLI=cloudflared bin/um-tunnel
UM_TUNNEL_CLI=tailscale   bin/um-tunnel
UM_TUNNEL_CLI=ngrok       bin/um-tunnel

# Non-default UM port (e.g. if you moved the server to 6336):
UM_PORT=6336 bin/um-tunnel

# Custom log path (default: /tmp/um-tunnel-output.log):
UM_TUNNEL_LOG=/path/to/tunnel.log bin/um-tunnel
```

Invoke from the repo checkout (`plugins/claude-code/universal-memory/bin/um-tunnel`) or from wherever the plugin is installed. The script auto-locates the routing rubric in both layouts.

---

## Troubleshooting

- **"could not extract public URL ... within 10s"** — the tunnel CLI started but didn't print the expected URL shape fast enough. Inspect `$UM_TUNNEL_LOG` (default `/tmp/um-tunnel-output.log`). Common causes: cloudflared still booting on a slow network; ngrok free-tier rate limit; tailscale funnel not enabled on your tailnet (run `tailscale funnel status` to confirm).
- **Tunnel dies immediately** — check the log for the CLI's error message. Tailscale: "funnel is not enabled in this tailnet" means you need to enable the feature in the admin console. ngrok: "ERR_NGROK_108" usually means you need to authenticate with `ngrok config add-authtoken ...`.
- **Ctrl+C doesn't fully stop the tunnel** — the EXIT trap should handle this, but if the tunnel CLI forked a background process of its own, you may need `pkill cloudflared` / `pkill tailscaled` / `pkill ngrok`.
- **Wrong CLI picked** — set `UM_TUNNEL_CLI=<binary>` to override auto-detection.
- **Rubric block missing from output** — the script looks in two places: `docs/memory-routing-rubric.md` (repo checkout, 4 parents up from `bin/`) and `../rubric.md` (installed-plugin layout). If neither resolves, it prints a fallback message pointing at the repo file. Running from the repo checkout is always safe.

### Windows / Git Bash caveats

`um-tunnel` is bash; it runs under Git Bash on Windows, but there are known rough edges:

- **`kill $PID` / signal handling.** Git Bash's implementation of `trap cleanup EXIT` works in the common case but may not reliably kill grandchild processes spawned by `cloudflared` or `ngrok` (Windows signal propagation is weaker than POSIX). If the tunnel process survives Ctrl+C, kill it manually via Task Manager or `taskkill /F /IM cloudflared.exe`.
- **Stderr buffering.** Some Windows builds of `cloudflared` and `ngrok` buffer stderr differently than their Linux counterparts. If URL extraction times out consistently on Windows but works on macOS/Linux with the same CLI version, it's usually a stderr-flush issue — try upgrading the CLI or switch to a different tunnel.
- **`tailscale funnel`** requires the Tailscale Windows client and funnel to be enabled for your tailnet — same preconditions as on macOS/Linux, not a `um-tunnel` limitation.

These limitations are documented rather than worked around in the CLI; fixing them in bash would cost more than the value they add. If you hit them, the manual `cloudflared` / `ngrok` / `tailscale` commands from [`docs/connecting-chatgpt-desktop.md`](connecting-chatgpt-desktop.md#2-tunnel-options) still work — `um-tunnel` is a convenience wrapper, not a dependency.

---

## See also

- [`docs/connecting-chatgpt-desktop.md`](connecting-chatgpt-desktop.md) — full walkthrough for ChatGPT Desktop.
- [`docs/connecting-claude-ai.md`](connecting-claude-ai.md) — walkthrough for Claude.ai and Claude Desktop.
- [`docs/mcp-tools.md` §Security](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http) — full exposure model.
- [`docs/memory-routing-rubric.md`](memory-routing-rubric.md) — canonical rubric source (what `um-tunnel` prints).
