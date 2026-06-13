# Connecting Claude.ai and Claude Desktop to universal-memory

> **⚠️ OAuth now required for Claude.ai (web/mobile) custom connectors.** As of
> the 2025-11-25 MCP auth spec, Claude.ai will not connect via a static bearer
> token — it requires MCP-spec OAuth, which UM now serves (v1.4, behind
> `UM_OAUTH_ENABLED`). **Start with [docs/oauth.md](oauth.md)** to enable and
> connect; the bearer-token paste steps below are retained for Claude Desktop's
> local JSON config and as historical reference, and are pending a full refresh
> after live vendor verification.

> **Draft docs — Claude.ai (web + desktop) UI labels may shift across app
> updates. Paths below are verified against Claude.ai and Claude Desktop as of
> 2026-04-23. If a label differs from what you see, look for the conceptually
> matching option.**

How to add your universal-memory server as an MCP connector inside Claude.ai (web) and Claude Desktop (app), so both surfaces can read/write the same vault that Claude Code uses.

Audience: a user who already has UM running locally (via `install.sh` + `docker compose up -d`) and wants Claude.ai and/or Claude Desktop to share the same memory store. Assumes basic familiarity with the UM tool surface — see [`docs/workflow.md`](workflow.md) and [`docs/mcp-tools.md`](mcp-tools.md) for the runtime reference.

**Status:** Addresses issue #4 (routing rubric delivery to Anthropic surfaces). UM's routing rubric is normally injected via Claude Code's `additionalContext` hook — Claude.ai and Claude Desktop MCP users don't get that injection, so this doc covers the paste-in alternative.

---

## 1. Prereqs

Before starting, you should have:

- UM server running locally. Confirm with (loopback — no auth header needed):
  ```bash
  curl -sf http://localhost:6335/mcp -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 200
  ```
  You should see a JSON response listing **4 default read tools** (`memory_search`, `memory_list`, `memory_state`, `memory_recent`). All 7 write tools appear only when `UM_MCP_WRITE_ENABLED=true` on the server — see [docs/mcp-tools.md](mcp-tools.md#tool-listing). From a tunnel URL, include `Authorization: Bearer $UM_AUTH_TOKEN`.
- A reachable URL for the MCP endpoint:
  - **Claude.ai (web)** runs in Anthropic's cloud and cannot reach your `localhost:6335`. You need a **publicly reachable HTTPS tunnel** — see [Tunnel options](#2-tunnel-options) below.
  - **Claude Desktop (app)** can reach `http://localhost:6335` directly via its MCP config file — no tunnel required for local-only use. If you want Claude Desktop to reach a UM server running on a different host, you still need a tunnel (or LAN/VPN reachability).
- A Claude plan that supports custom MCP connectors — typically Pro, Team, or Enterprise for Claude.ai (web); Claude Desktop MCP config via the JSON file works on all tiers that support Claude Desktop. See [Anthropic's documentation](https://docs.anthropic.com) for current plan-tier requirements.
- (Optional but recommended) `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env` if you want Claude to write memories, not just read. Read-only is safer for first connection.

---

## 2. Tunnel options

**Recommended entry:** run [`bin/um-tunnel`](../plugins/claude-code/universal-memory/bin/um-tunnel) for a one-command setup — it auto-detects your installed tunnel CLI, starts the tunnel, and prints the URL + rubric block ready to paste. See [`docs/um-tunnel.md`](um-tunnel.md) for details. The manual instructions below still work for anyone who prefers to run the tunnel CLI directly.

Three common choices for making `http://localhost:6335` publicly reachable at an HTTPS URL. This section mirrors the equivalent in [`docs/connecting-chatgpt-desktop.md`](connecting-chatgpt-desktop.md#2-tunnel-options) — refer there for the full pros/cons discussion and security commentary. Minimum commands below so this doc stands alone.

For full exposure-model context see the [Security section of `docs/mcp-tools.md`](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http) — **write mode exposes your entire vault to anyone who can hit the tunnel URL**, so prefer an auth-aware tunnel when writes are enabled.

### Tailscale Funnel (recommended for personal use)

Free for personal accounts, auth-aware via Tailscale identity.

```bash
tailscale funnel --bg 6335
# note the printed https://<device>.<tailnet>.ts.net URL
```

Funnel URLs are public. For tailnet-only reach (no public exposure) use `tailscale serve` instead — but Claude.ai cannot hit a tailnet-only URL, so Funnel (or another public option) is required for the web surface. Claude Desktop on a tailnet-joined device can use `serve`.

### Cloudflare Tunnel

Stable hostnames on your own domain (or a generated `trycloudflare.com` one), free tier covers personal use.

```bash
cloudflared tunnel --url http://localhost:6335
```

Pair with Cloudflare Access for SSO-style auth before enabling MCP writes.

### ngrok

Fastest to set up.

```bash
ngrok http 6335
```

Free tier URLs are ephemeral per-process. All traffic transits ngrok infrastructure — acceptable for testing, weaker for sustained use with writes enabled.

---

## 3. Connection walkthrough

Two subsections: one for Claude.ai (web), one for Claude Desktop (app). Pick whichever you're configuring — or both, using the same tunnel URL.

### 3a. Claude.ai (web)

Step-by-step UI clicks. The Claude.ai settings UI evolves, so screenshots will be captured during manual verification. Placeholders below mark where those go.

1. Open [claude.ai](https://claude.ai) and sign in. Click your profile icon (bottom left or top right depending on layout) → **Settings**.

   ![TBD: screenshot of Claude.ai Settings entry point](screenshots/claude-ai-1.png)

2. In Settings, navigate to **Connectors** (may be labeled **Integrations** or **Custom Connectors** — look for the MCP server setup section).

   ![TBD: screenshot of Claude.ai Settings Connectors panel](screenshots/claude-ai-2.png)

3. Click **Add connector** (or **Add custom connector** / **New MCP server** if that's what your version shows).

   ![TBD: screenshot of Claude.ai Add Connector dialog](screenshots/claude-ai-3.png)

4. Fill in the connector form:
   - **Name**: `universal-memory` (any label you want — what Claude will call it in the connector list)
   - **URL**: your tunnel URL + `/mcp` suffix, e.g. `https://<your-device>.<tailnet>.ts.net/mcp`
   - **Transport**: **HTTP** (may be labeled **Streamable HTTP** or **SSE** — UM speaks plain JSON-RPC HTTP at `POST /mcp`; pick whichever option matches that).
   - **Auth**: Bearer token — see [Bearer token configuration](#bearer-token-configuration) below. For loopback-only installs (Claude Desktop reaching `localhost:6335` directly with no tunnel), auth is not required.

   ![TBD: screenshot of the filled-in connector form](screenshots/claude-ai-4.png)

5. Click **Save** (or **Add** / **Connect** depending on your version). Claude.ai should perform the MCP handshake and list the discovered tools.

   ![TBD: screenshot showing the 4 default UM read tools discovered](screenshots/claude-ai-5.png)

6. Enable the connector in a new chat (it may be on by default, or you may need a per-chat or per-project toggle — look for a plugin/connector icon in the chat input bar).

### 3b. Claude Desktop (app)

Claude Desktop reads MCP server configuration from a JSON file on disk. No UI walkthrough — edit the file directly, then restart the app.

**Config file location:**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json` (likely — verify if not found)

Open the file (create it if missing) and add an entry under `mcpServers`. For a **local UM server** (no tunnel):

```json
{
  "mcpServers": {
    "universal-memory": {
      "url": "http://localhost:6335/mcp",
      "transport": "http"
    }
  }
}
```

For a **remote UM server** (tunnel URL):

```json
{
  "mcpServers": {
    "universal-memory": {
      "url": "https://<your-device>.<tailnet>.ts.net/mcp",
      "transport": "http"
    }
  }
}
```

The `"transport"` field value may need to be `"streamable-http"` or `"sse"` depending on your Claude Desktop version — try `"http"` first. If Claude Desktop only supports stdio-based MCP servers and not HTTP URLs in the config, an HTTP→stdio proxy is required.

Save the file, quit Claude Desktop completely (not just close the window — use **Quit** from the menu on macOS, or exit via the system tray on Windows), and relaunch. The `universal-memory` server should appear in the app's MCP connector list.

---

## 3c. Bearer token configuration

As of v0.6, all requests arriving over a tunnel (or any route where a forwarded-header is present) require a `Authorization: Bearer <token>` header. The token is generated during `install.sh` and stored at `~/.um/auth-token` on the UM host.

**Why auth is required through a tunnel:** when any of the ten forwarded-presence headers (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, `CF-Ray`, `True-Client-IP`, `X-Original-Forwarded-For`) is present on an incoming request, UM bypasses the loopback-noauth shortcut and requires a bearer token. This ensures a tunnel or reverse proxy in front of the loopback cannot be used to bypass auth.

To find your token:

```bash
cat ~/.um/auth-token
```

**Claude.ai (web) connector auth:** when filling in the connector form, select **Bearer Token** (or **API Key / Bearer Token** — whichever your Claude.ai version labels it) as the auth type and paste the token from `~/.um/auth-token`.

**Claude Desktop (app) config:** add a `headers` entry to the config block. Example:

```json
{
  "mcpServers": {
    "universal-memory": {
      "url": "https://<your-device>.<tailnet>.ts.net/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <paste token from ~/.um/auth-token>"
      }
    }
  }
}
```

For a local-only Claude Desktop install (no tunnel, `http://localhost:6335/mcp`), the `headers` block is not required — loopback requests with no forwarded-headers skip auth automatically.

---

## 4. Routing rubric paste-in

UM's routing rubric is injected automatically in Claude Code sessions via a SessionStart hook. Claude.ai and Claude Desktop don't run that hook, so the rubric has to live somewhere Claude reads at the start of every conversation.

**For Claude.ai (web):** Claude.ai supports per-connector custom instructions. Open **Settings → Connectors → universal-memory** and look for a **Custom instructions** field (may be labeled **Instructions** or **Connector prompt**). Paste the rubric block below. This scopes the rubric to conversations where the UM connector is enabled, which is the cleanest placement.

**For Claude Desktop (app):** Claude Desktop's config file does not currently have a per-connector instructions field. Two placements work:

1. **Preferred — Projects system prompt.** If you use Claude's **Projects** feature, add the rubric block to the project's system prompt / knowledge. This scopes it to the project where you actually use UM.
2. **Fallback — User-level custom instructions.** Set via **Settings → Profile → Custom instructions** (may be labeled **How Claude should respond**). This applies to every conversation, which is noisier but works when you don't use Projects.

Paste the following block verbatim. This is the same rubric Claude Code hooks inject at session start.

<!-- Do not edit inline — mirror of docs/memory-routing-rubric.md. If the canonical file changes, re-paste this whole block. -->

```markdown
<!-- CANONICAL-RUBRIC-START -->
## Memory routing (universal-memory)

Tool note: the bullets below reference `memory_capture`. If that tool is not registered in this session but `memory_add` is (generic mem0), call `memory_add` instead — the routing guidance applies to either.

When the user says "remember", "note that", or similar:
- Project-scoped active work (current focus, in-flight tasks, open questions, decisions made today): no immediate action needed — the session-end pipeline will capture it in state.md and the session summary automatically.
- Durable facts the user will want later ("I prefer X", "my address is Y", "the API rotates quarterly"): call `memory_capture` with `type: fact` and `project: global` (cross-project) or `project: <current-project>` (project-scoped).
- Architecture decisions worth auditing later: call `memory_capture` with `type: adr` and `project: <current>`.
- Anything the user will likely search for by keyword later: call `memory_capture` (any appropriate type).
- **Conversational context worth preserving across surfaces** (e.g. "track this conversation", a significant exchange you'll revisit from Claude Code later, the current turn on its own): call `memory_append_turn` with `role` (user/assistant/system) + `content` + `project`. Unlike `memory_capture` (which writes a stable authored doc with structured frontmatter), `memory_append_turn` appends a raw turn that the NEXT session-end summary will consume. Use both when appropriate — a durable decision gets `memory_capture`; the context around the decision gets `memory_append_turn`.

When uncertain, prefer a capture call over trusting session-end — durable docs are easier to search than buried state.md entries.
<!-- CANONICAL-RUBRIC-END -->
```

This block is the canonical rubric — the source lives at [`docs/memory-routing-rubric.md`](memory-routing-rubric.md). If the repo version is updated, re-paste this block.

---

## 4a. Project metadata defaults

UM v1.1's server-side soft-default routes write tool calls with an omitted `metadata.project` field (`undefined` / `null` / `""`) to `UM_DEFAULT_PROJECT` (defaults to the literal slug `default`). This applies to `memory_capture`, `memory_add`, `memory_append_turn`, `memory_checkpoint`, and the REST `/api/add` endpoint.

**Why this matters for connector users:** Claude Code injects a project signal automatically via SessionStart hook; Claude.ai and Claude Desktop don't. The routing rubric above asks the model to pass an explicit `project:`, but if the model omits it the write silently lands in the fallback slug rather than failing loud — there is no warning surfaced to the connector. Reads (`memory_state` / `memory_search` / `memory_recent` / `memory_list`) still require an explicit project — the soft-default is write-only by design.

To control where omitted-project writes land, set `UM_DEFAULT_PROJECT=<slug>` in `server/.env` and restart the server. To make writes fail loud instead of soft-defaulting, the model-facing fix is the routing rubric (which already asks for an explicit `project:`); the server-side fix is to send the project field on every write you care about filtering later.

For full rationale, see [`docs/audits/2026-05-08-cross-surface-defaults.md`](audits/2026-05-08-cross-surface-defaults.md) §F1 + §F5 + §F6.

---

## 5. Verification walkthrough

Quick sanity checks that the connector works end-to-end. Run these in a fresh Claude.ai or Claude Desktop conversation with the UM connector enabled.

1. **Tool discovery.** Ask:
   > "What tools do you have available from universal-memory?"

   Expected (v0.5 default): Claude lists **4 default read tools** — `memory_search`, `memory_list`, `memory_state`, `memory_recent`. These are the reads visible to any MCP client. All 7 write tools (`memory_add`, `memory_delete`, `memory_capture`, `memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`) appear only when the server runs with `UM_MCP_WRITE_ENABLED=true`. If you see **fewer than 4**, the connector isn't wired correctly — re-check the URL and transport.

2. **Read test — state.md.** Ask:
   > "Call `memory_state` with project `test` and tell me what you got."

   Expected: returns `{ "ok": true, "project": "test", "state": null, "valid_from": null }` if no state.md exists for `test`, or the full state body if one does. This exercises the read path.

3. **Write test — capture a fact.** (Requires `UM_MCP_WRITE_ENABLED=true` in `server/.env`.) Ask:
   > "Use `memory_capture` to write a doc with content 'Claude.ai connection verified' and metadata `{ type: 'fact', id: 'claude-ai-smoke-<today>', title: 'Claude.ai smoke', project: 'test' }`."

   Expected: returns `{ "ok": true, "path": "authored/test/claude-ai-smoke-<today>.md", ... "indexed": true }`.

4. **Disk verification.** On the UM host:
   ```bash
   ls "$UM_VAULT_DIR/authored/test/"
   cat "$UM_VAULT_DIR/authored/test/claude-ai-smoke-<today>.md"
   ```
   Expected: the file exists with the frontmatter + body from step 3.

If all four pass, Claude.ai / Claude Desktop is reading and writing the same vault Claude Code uses.

---

## 6. What works vs what doesn't

### Works
- **Reads at full parity with Claude Code**: `memory_state`, `memory_search`, `memory_recent`, `memory_list` — all return the same data Claude Code sees.
- **Writes when `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`**: `memory_capture`, `memory_forget`, `memory_supersede` persist to the same vault. Captures written from Claude.ai or Claude Desktop appear in your Claude Code sessions at next session start.
- **Rubric routing.** The rubric pasted into the connector's custom instructions (Claude.ai) or the Project / user-level instructions (Claude Desktop) steers Claude to call `memory_capture` on explicit "remember" requests — same behavior as Claude Code's hook-injected rubric.

### Doesn't work automatically (but now bridgeable with v0.5 tools)
- **No automatic session-end hook.** Claude.ai / Claude Desktop have no equivalent of Claude Code's Stop / SessionEnd hooks, so the raw-capture pipeline does not run automatically. Use `memory_append_turn` (v0.5) to append turns during a session, and `memory_checkpoint` (v0.5 real implementation) to trigger synthesis and `state.md` refresh at session end.
- **Rubric drift risk.** Connector custom instructions (Claude.ai) and Project prompts (Claude Desktop) are static. If the canonical rubric in [`docs/memory-routing-rubric.md`](memory-routing-rubric.md) changes, you need to re-paste. No auto-sync.

---

## Troubleshooting

- **Tools don't appear after adding connector.** For Claude.ai, check the tunnel URL resolves from outside your network (test from a phone on cellular). Confirm the `/mcp` path suffix is present. For Claude Desktop, verify the JSON config is valid (no trailing commas) and that you fully quit and relaunched the app.
- **Tools appear but writes fail.** Check `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env`, then `docker compose restart memory-server`. Writes return `{ ok: false, error: "MCP writes disabled" }` when the gate is off.
- **Claude refuses to call the tools.** Instructions may be conflicting. Confirm the rubric is in the right place (per-connector for Claude.ai; Project / user-level for Claude Desktop) and no other instructions override it.
- **More diagnostic surface.** See [`docs/workflow.md`](workflow.md) "Common diagnostic questions" for UM-side health checks.
