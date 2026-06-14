# Connecting Claude.ai and Claude Desktop to universal-memory

> **OAuth connector guide (OAuth-era).** Claude.ai's custom connectors are
> **OAuth-only** — as of the 2025-11-25 MCP auth spec they will not connect via a
> static bearer token. UM now serves MCP-spec OAuth 2.1 (v1.4, behind
> `UM_OAUTH_ENABLED`, default off), so the connect flow below is the OAuth
> handshake, **live-verified 2026-06-13** against Claude.ai web + mobile over a
> Tailscale Funnel. The OAuth-server setup (enable, env vars, public URL,
> revocation, troubleshooting) lives in **[docs/oauth.md](oauth.md)** — this doc
> points there for that and covers the per-vendor connect steps + rubric.

> **Labels may shift across app versions.** The Claude.ai (web/mobile) and Claude
> Desktop UI evolves. Click paths below are written against the apps as of
> 2026-06-13; if a label differs from what you see, look for the conceptually
> matching option.

How to add your universal-memory server as an MCP connector inside Claude.ai (web + mobile) and Claude Desktop, so every surface can read/write the same vault that Claude Code uses.

Audience: a user who already has UM running locally (via `install.sh`) and wants Claude.ai and/or Claude Desktop to share the same memory store. Assumes basic familiarity with the UM tool surface — see [`docs/workflow.md`](workflow.md) and [`docs/mcp-tools.md`](mcp-tools.md) for the runtime reference.

**Status:** Addresses issue #4 (routing rubric delivery to Anthropic surfaces). UM's routing rubric is normally injected via Claude Code's `additionalContext` hook — Claude.ai and Claude Desktop MCP users don't get that injection, so §4 covers the paste-in alternative. Claude.ai connects over a **public HTTPS tunnel via OAuth** (§3a); Claude Desktop can *also* reach a purely-local server over loopback without OAuth (§3b).

---

## 1. Prereqs

Before starting, you should have:

- **UM running** locally (`install.sh`). Confirm the MCP endpoint answers on loopback (no auth header needed):
  ```bash
  curl -sf http://localhost:6335/mcp -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 200
  ```
  You should see a JSON response listing **4 default read tools** (`memory_search`, `memory_list`, `memory_state`, `memory_recent`). All 7 write tools appear only when `UM_MCP_WRITE_ENABLED=true` on the server — see [docs/mcp-tools.md](mcp-tools.md#tool-listing).
- **OAuth enabled** (required for the Claude.ai connector): `UM_OAUTH_ENABLED=true` and `UM_PUBLIC_BASE_URL=<your public origin>` in `server/.env`. See **[docs/oauth.md §2](oauth.md#2-enabling-it)** for what `UM_PUBLIC_BASE_URL` is and how to find your tunnel's value — don't re-derive it here. (Claude Desktop reaching a local server over loopback does **not** need OAuth — see §3b.)
- **A public HTTPS URL** for the MCP endpoint. Claude.ai (web + mobile) runs in Anthropic's cloud and cannot reach your `localhost:6335` — you need a publicly reachable HTTPS tunnel (Tailscale Funnel, Cloudflare Tunnel, ngrok) or a VPS domain. Run [`bin/um-tunnel`](../plugins/claude-code/universal-memory/bin/um-tunnel) for one-command setup, or see [`docs/um-tunnel.md`](um-tunnel.md). The connector URL you paste is this origin **plus `/mcp`** (e.g. `https://<your-host>.ts.net/mcp`).
- **A Claude plan that supports custom MCP connectors** — typically Pro, Team, or Enterprise for Claude.ai; Claude Desktop's local JSON config works on tiers that support Claude Desktop. See [Anthropic's documentation](https://docs.anthropic.com) for current plan-tier requirements.
- (Optional but recommended) **`UM_MCP_WRITE_ENABLED=true` + `UM_MOUNT_MODE=rw`** in `server/.env` if you want Claude to *capture* memories, not just recall. Read-only is safer for a first connection.

> **Two findings that bite most first-time setups — read these before you connect.**
>
> **1. Build from local source until v1.4.0 is released.** The OAuth code is merged
> but unreleased, so a plain `docker compose up -d` pulls the pre-OAuth GHCR
> `:latest` image and **every OAuth route 404s**. From `server/`, build the image
> from local source instead:
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
> ```
> **Symptom of the wrong (pre-OAuth) image:** `GET /.well-known/oauth-authorization-server`
> returns **404** instead of the discovery JSON. Confirm you're on the right image
> with the discovery curl in [docs/oauth.md §2](oauth.md#2-enabling-it) — a healthy
> server returns JSON with `issuer`, `authorization_endpoint`, and
> `client_id_metadata_document_supported: true`.
>
> **2. If you probed this URL before OAuth existed, remove + re-add the connector.**
> If you (or Claude) ever hit this server URL *before* OAuth was enabled (e.g. an
> earlier failed connect), the vendor caches the discovery failure and later POSTs
> to the wrong endpoint (`/register` instead of `/oauth/register`), surfacing as
> **"Couldn't register with universal-memory's sign-in service."** **Fix: remove the
> connector and add it again** — that forces fresh discovery and it connects.
> (Observed exactly this with Claude on 2026-06-13; the re-add cleared it.)

---

## 2. Tunnel options

**Recommended entry:** run [`bin/um-tunnel`](../plugins/claude-code/universal-memory/bin/um-tunnel) for a one-command setup — it auto-detects your installed tunnel CLI, starts the tunnel, and prints the public URL + the `/mcp` connector URL + the routing rubric block ready to paste. See [`docs/um-tunnel.md`](um-tunnel.md) for details. The manual commands below still work if you prefer to drive the tunnel CLI directly.

Three common choices for exposing `http://localhost:6335` at a public HTTPS URL. This mirrors the equivalent in [`docs/connecting-chatgpt-desktop.md`](connecting-chatgpt-desktop.md#2-tunnel-options) — refer there for the full pros/cons and security commentary. Minimum commands below so this doc stands alone.

For full exposure-model context see the [Security section of `docs/mcp-tools.md`](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http) — **write mode exposes your entire vault to anyone who can hit the tunnel URL**, so keep OAuth enabled and prefer an auth-aware tunnel when writes are on.

### Tailscale Funnel (recommended for personal use)

Free for personal accounts, auth-aware via Tailscale identity, stable hostname tied to your tailnet.

```bash
tailscale funnel --bg 6335
# note the printed https://<your-host>.ts.net URL
```

Funnel URLs are public. For tailnet-only reach (no public exposure) use `tailscale serve` instead — but Claude.ai cannot hit a tailnet-only URL, so Funnel (or another public option) is required for the web/mobile surface.

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

Two subsections: §3a for **Claude.ai (web + mobile) over OAuth** — the main flow; §3b for **Claude Desktop's local JSON config**, a separate loopback path that doesn't use the OAuth connector. Pick whichever you're configuring — or both.

### 3a. Claude.ai (web + mobile) — OAuth connector

Claude registers itself automatically via Dynamic Client Registration (DCR) — there is **no manual client id or secret** to create. The whole handshake is: paste the URL, leave the OAuth fields blank, then approve on UM's own consent page.

1. In Claude.ai → **Settings → Connectors → Add custom connector**.
2. Fill in the form:
   - **Name**: `universal-memory` (any label you like — what Claude calls it in the connector list).
   - **URL**: your public origin **+ `/mcp`**, e.g. `https://<your-host>.ts.net/mcp` (the same value `um-tunnel` prints as the MCP connector URL).
3. Expand **Advanced settings** and **leave OAuth Client ID and Client Secret BLANK.** UM self-registers via DCR as a **public client** (no secret). Click **Add**.
4. Claude registers a client behind the scenes, then opens UM's **consent page** ("Authorize Claude") in a browser tab. The page shows the requesting client name and the redirect host so you can confirm what you're approving.
5. Paste your **operator token** into the field and click **Allow**. (If social login is configured, you can click **"Continue with GitHub"** instead — see [docs/oauth.md §3](oauth.md#3-sign-in-with-github-social-login).) This is the server's `UM_AUTH_TOKEN`, mirrored on the UM host at `~/.um/auth-token`:
   ```bash
   cat ~/.um/auth-token
   ```
   The tab closes and Claude is connected. (A short-lived `/oauth`-scoped consent cookie keeps the browser trusted for ~15 minutes, so connecting a second vendor in the same sitting skips the paste — you still click **Allow** every time; it never auto-approves. See [docs/oauth.md §4](oauth.md#4-connecting-claudeai-one-click-dcr).)
6. **Mobile is covered automatically.** The connector is account-level: one connect on the web shares it across Claude **web, Desktop, and mobile** — the single `https://claude.ai/api/mcp/auth_callback` redirect covers all surfaces, with **zero extra mobile setup** (verified live 2026-06-13). This is the Gap-3 "memory on mobile" story: connect once, recall/capture from your phone.

Once connected, Claude invokes the UM tools when you ask memory-shaped questions ("what was I working on?", "remember that I prefer X"). For that recall/capture routing to fire reliably, paste the routing rubric into the connector's custom instructions — see §4.

> **Hit "Couldn't register with universal-memory's sign-in service"?** That's the
> stale-discovery-cache gotcha from §1 — **remove the connector and add it again** to
> force fresh discovery. And if discovery 404s entirely, you're on the pre-OAuth GHCR
> image — rebuild from local source (§1, finding 1).

> **Watching the server logs during connect?** A `GET /.well-known/openid-configuration → 401`
> is **harmless** — Claude probes for OIDC first, gets the 401, and falls back to the
> RFC 8414 `/.well-known/oauth-authorization-server` document, which is what UM serves.
> The connect still completes. An `oauth_host_mismatch` warning, on the other hand,
> means your tunnel host doesn't match `UM_PUBLIC_BASE_URL` and is worth fixing — see
> [docs/oauth.md §8](oauth.md#8-verifying--troubleshooting).

Claude Code (the CLI) is also a supported OAuth client (it uses a loopback redirect), but for purely local use it doesn't need OAuth at all — it reaches `localhost:6335` directly. See [docs/oauth.md §7](oauth.md#7-the-legacy-bearer-token-is-unaffected).

### 3b. Claude Desktop (app) — local-only loopback path

This is **separate from the OAuth connector above** and does not use OAuth. Claude Desktop reads MCP server configuration from a JSON file on disk and can talk to a UM server running **on the same machine** over loopback — no tunnel, no OAuth. (If instead you want Claude Desktop to share the *account-level* connector you set up in §3a, it's already covered there; this section is the standalone local setup.)

**Config file location:**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json` (likely — verify if not found)

Open the file (create it if missing) and add an entry under `mcpServers` pointing at the **local loopback** endpoint:

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

Because the request arrives on `127.0.0.1` with no forwarded-headers, UM serves it **without an auth header** — no bearer token, no OAuth. (The `"transport"` value may need to be `"streamable-http"` or `"sse"` depending on your Claude Desktop version — try `"http"` first. If Claude Desktop only supports stdio MCP servers and not HTTP URLs, an HTTP→stdio proxy is required.)

Save the file, **fully quit** Claude Desktop (not just close the window — use **Quit** on macOS or exit via the system tray on Windows), and relaunch. The `universal-memory` server should appear in the app's MCP connector list.

> **Reaching a *remote* UM server from Claude Desktop?** Don't paste a static bearer
> token over a tunnel — the OAuth-era path is the account-level connector in §3a,
> which Claude Desktop inherits automatically once you've connected on the web. The
> loopback JSON config in this section is only for a UM server on the *same machine*.

---

## 4. Routing rubric paste-in

UM's routing rubric is injected automatically in Claude Code sessions via a SessionStart hook. Claude.ai and Claude Desktop don't run that hook, so the rubric has to live somewhere Claude reads at the start of every conversation — otherwise Claude may answer from its own context instead of calling the memory tools.

**For Claude.ai (web + mobile):** Claude.ai supports per-connector custom instructions. Open **Settings → Connectors → universal-memory** and look for a **Custom instructions** field (may be labeled **Instructions** or **Connector prompt**). Paste the rubric block below. This scopes the rubric to conversations where the UM connector is enabled — the cleanest placement, and it follows the account-level connector to mobile.

**For Claude Desktop (local JSON path, §3b):** Claude Desktop's config file has no per-connector instructions field. Two placements work:

1. **Preferred — Projects system prompt.** If you use Claude's **Projects** feature, add the rubric block to the project's system prompt / knowledge. This scopes it to the project where you actually use UM.
2. **Fallback — User-level custom instructions.** Set via **Settings → Profile → Custom instructions** (may be labeled **How Claude should respond**). Applies to every conversation — noisier, but works when you don't use Projects.

Paste the following block verbatim. This is the same rubric Claude Code hooks inject at session start, and the same block `um-tunnel` prints on startup.

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

   Expected: Claude lists **4 default read tools** — `memory_search`, `memory_list`, `memory_state`, `memory_recent`. These are the reads visible to any MCP client. All 7 write tools (`memory_add`, `memory_delete`, `memory_capture`, `memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`) appear only when the server runs with `UM_MCP_WRITE_ENABLED=true`. If you see **fewer than 4**, the connector isn't wired correctly — re-check the URL and (for the stale-cache case) remove + re-add the connector.

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
- **OAuth connector across web, Desktop, and mobile from one connect** (§3a) — the account-level grant follows you to every Claude surface, mobile included, with no per-device setup.
- **Reads at full parity with Claude Code**: `memory_state`, `memory_search`, `memory_recent`, `memory_list` — all return the same data Claude Code sees.
- **Writes when `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`**: `memory_capture`, `memory_forget`, `memory_supersede` persist to the same vault. Captures written from Claude.ai or Claude Desktop appear in your Claude Code sessions at next session start.
- **Rubric routing.** The rubric pasted into the connector's custom instructions (Claude.ai) or the Project / user-level instructions (Claude Desktop) steers Claude to call `memory_capture` on explicit "remember" requests — same behavior as Claude Code's hook-injected rubric.

### Doesn't work automatically (but bridgeable with the connector tools)
- **No automatic session-end hook.** Claude.ai / Claude Desktop have no equivalent of Claude Code's Stop / SessionEnd hooks, so the raw-capture pipeline does not run automatically. Use `memory_append_turn` to append turns during a session, and `memory_checkpoint` to trigger synthesis and `state.md` refresh at session end.
- **Rubric drift risk.** Connector custom instructions (Claude.ai) and Project prompts (Claude Desktop) are static. If the canonical rubric in [`docs/memory-routing-rubric.md`](memory-routing-rubric.md) changes, you need to re-paste. No auto-sync.

---

## Troubleshooting

- **"Couldn't register with universal-memory's sign-in service."** Stale discovery cache from a pre-OAuth probe of this URL — **remove the connector and add it again** to force fresh discovery (§1 / §3a).
- **Discovery 404s / OAuth routes missing.** You're running the pre-OAuth GHCR `:latest` image. Rebuild from local source: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` from `server/` (§1). Verify with the discovery curl in [docs/oauth.md §2](oauth.md#2-enabling-it).
- **Consent page rejects the token (`bad_token`).** You pasted the wrong secret. The operator token is `UM_AUTH_TOKEN`, mirrored at `~/.um/auth-token` on the UM host — `cat ~/.um/auth-token`. Rotating it changes only *future* consent; existing grants keep working.
- **`oauth_host_mismatch` in the logs / vendor can't complete discovery.** Your tunnel/proxy host doesn't match `UM_PUBLIC_BASE_URL`. Make them identical (origin only, no path, no trailing slash). See [docs/oauth.md §8](oauth.md#8-verifying--troubleshooting).
- **`GET /.well-known/openid-configuration → 401` in the logs.** Harmless — the vendor probes OIDC, gets 401, and falls back to RFC 8414 discovery, which UM serves. Connect completes.
- **Tools appear but writes fail.** Check `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env`, then restart the server. Writes return `{ ok: false, error: "MCP writes disabled" }` when the gate is off.
- **Claude refuses to call the tools.** Confirm the rubric is in the right place (per-connector for Claude.ai; Project / user-level for Claude Desktop) and no other instructions override it.
- **OAuth-server diagnostics (metrics + logs).** For the `um_oauth_*` counters and the `error_class` log breadcrumbs that tell you exactly where a failed connect died, see [docs/oauth.md §8](oauth.md#8-verifying--troubleshooting).
- **More diagnostic surface.** See [`docs/workflow.md`](workflow.md) "Common diagnostic questions" for UM-side health checks.
