# Connecting ChatGPT to universal-memory

> **OAuth connector guide (OAuth-era).** ChatGPT's custom connectors are
> **OAuth-only** — they will not connect via a static bearer token. UM now serves
> MCP-spec OAuth 2.1 (v1.4, behind `UM_OAUTH_ENABLED`, default off), so the connect
> flow below is the OAuth handshake, **live-verified 2026-06-13** against ChatGPT
> over a Tailscale Funnel. The OAuth-server setup (enable, env vars, public URL,
> revocation, troubleshooting) lives in **[docs/oauth.md](oauth.md)** — this doc
> points there for that and covers ChatGPT's connect steps + the rubric step that
> makes recall actually fire.

> **Labels may shift across app versions.** The ChatGPT connector / developer-mode
> UI evolves. Click paths below are written against ChatGPT as of 2026-06-13; if a
> label differs from what you see, look for the conceptually matching option.

How to add your universal-memory server as an MCP connector inside ChatGPT, so ChatGPT can read/write the same vault that Claude Code uses.

Audience: a user who already has UM running locally (via `install.sh`) and wants ChatGPT to share the same memory store. Assumes basic familiarity with the UM tool surface — see [`docs/workflow.md`](workflow.md) and [`docs/mcp-tools.md`](mcp-tools.md) for the runtime reference.

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
- **OAuth enabled** (required for the ChatGPT connector): `UM_OAUTH_ENABLED=true` and `UM_PUBLIC_BASE_URL=<your public origin>` in `server/.env`. See **[docs/oauth.md §2](oauth.md#2-enabling-it)** for what `UM_PUBLIC_BASE_URL` is and how to find your tunnel's value — don't re-derive it here.
- **A public HTTPS URL** for the MCP endpoint. ChatGPT runs in OpenAI's cloud and cannot reach your `localhost:6335` directly — even the desktop app's connector calls originate from OpenAI's backend. You need a publicly reachable HTTPS tunnel (Tailscale Funnel, Cloudflare Tunnel, ngrok) or a VPS domain. Run [`bin/um-tunnel`](../plugins/claude-code/universal-memory/bin/um-tunnel) for one-command setup, or see [`docs/um-tunnel.md`](um-tunnel.md). The connector URL you paste is this origin **plus `/mcp`** (e.g. `https://<your-host>.ts.net/mcp`).
- **ChatGPT with a plan that supports custom MCP connectors** — typically Plus, Pro, or Team. See [OpenAI's documentation](https://help.openai.com) for current plan-tier requirements and where the connector / developer-mode dialog lives in your version.
- (Optional but recommended) **`UM_MCP_WRITE_ENABLED=true` + `UM_MOUNT_MODE=rw`** in `server/.env` if you want ChatGPT to *capture* memories, not just recall. Read-only is safer for a first connection.

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
> If anything ever hit this server URL *before* OAuth was enabled (e.g. an earlier
> failed connect), the vendor caches the discovery failure and later POSTs to the
> wrong endpoint (`/register` instead of `/oauth/register`), surfacing as a
> **"couldn't register with the sign-in service"**-style error. **Fix: remove the
> connector and add it again** — that forces fresh discovery and it connects.

---

## 2. Tunnel options

**Recommended entry:** run [`bin/um-tunnel`](../plugins/claude-code/universal-memory/bin/um-tunnel) for a one-command setup — it auto-detects your installed tunnel CLI, starts the tunnel, and prints the public URL + the `/mcp` connector URL + the routing rubric block ready to paste. See [`docs/um-tunnel.md`](um-tunnel.md) for details. The manual commands below still work if you prefer to drive the tunnel CLI directly.

Three common choices for exposing `http://localhost:6335` at a public HTTPS URL. For full exposure-model context see the [Security section of `docs/mcp-tools.md`](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http) — **write mode exposes your entire vault to anyone who can hit the tunnel URL**, so keep OAuth enabled and prefer an auth-aware tunnel when writes are on.

### Tailscale Funnel (recommended for personal use)

Free for personal accounts, auth-aware via Tailscale identity, stable hostname tied to your tailnet.

```bash
tailscale funnel --bg 6335
# note the printed https://<your-host>.ts.net URL
```

**Pros:** Identity-bound, no separate account for a tunnel service, free.
**Cons:** Requires the Tailscale client on the host. Funnel exposes the port publicly — and ChatGPT (cloud-side) needs public reach, so `funnel`, not tailnet-only `serve`.

### Cloudflare Tunnel

Stable hostnames on your own domain (or a generated `trycloudflare.com` one), free tier covers personal use.

```bash
cloudflared tunnel --url http://localhost:6335
```

**Pros:** Stable named tunnels when bound to a Cloudflare-managed domain; can front with Cloudflare Access for SSO-style auth; generous free tier.
**Cons:** Stable custom hostnames need a domain in Cloudflare DNS. `trycloudflare.com` URLs are ephemeral per-process.

### ngrok

Fastest to set up, widely known.

```bash
ngrok http 6335
```

**Pros:** Easiest — one command, works instantly.
**Cons:** Free tier URLs are ephemeral (rotate per process) and traffic transits ngrok infrastructure. Paid tier for stable subdomains.

---

## 3. ChatGPT MCP connector walkthrough (OAuth via CIMD)

ChatGPT connects with **no manual client setup**. It uses **CIMD** (Client ID Metadata Document — it presents its client-id *as an HTTPS URL* pointing at a metadata document), and UM advertises CIMD support in its discovery document, so ChatGPT resolves itself automatically. There is no client id or secret for you to create.

1. Open ChatGPT's **connector / developer-mode dialog** (Settings → Connectors, or the developer-mode "Add MCP server" entry, depending on your version).
2. Add your public origin **+ `/mcp`** as the server URL, e.g. `https://<your-host>.ts.net/mcp` (the same value `um-tunnel` prints as the MCP connector URL). The dialog reads `client_id_metadata_document_supported` from discovery and proceeds via CIMD — no client id / secret fields to fill.
3. ChatGPT opens UM's **consent page** ("Authorize ChatGPT") in a browser tab. The page shows ChatGPT's actual redirect host (e.g. `chatgpt.com`) so you can confirm what you're approving.
4. Paste your **operator token** into the field and click **Allow**. (If social login is configured, you can click **"Continue with GitHub"** instead — see [docs/oauth.md §3](oauth.md#3-sign-in-with-github-social-login).) This is the server's `UM_AUTH_TOKEN`, mirrored on the UM host at `~/.um/auth-token`:
   ```bash
   cat ~/.um/auth-token
   ```
   The tab closes and ChatGPT is connected. (For the full DCR-vs-CIMD detail, the consent cookie, and the security model, see [docs/oauth.md §5](oauth.md#5-connecting-chatgpt-cimd).)

> **Hit a "couldn't register with the sign-in service"-style error?** That's the
> stale-discovery-cache gotcha from §1 — **remove the connector and add it again** to
> force fresh discovery. And if discovery 404s entirely, you're on the pre-OAuth GHCR
> image — rebuild from local source (§1, finding 1).

> **Watching the server logs during connect?** A `GET /.well-known/openid-configuration → 401`
> is **harmless** — ChatGPT probes for OIDC first, gets the 401, and falls back to the
> RFC 8414 `/.well-known/oauth-authorization-server` document, which is what UM serves.
> The connect still completes. An `oauth_host_mismatch` warning, by contrast, means
> your tunnel host doesn't match `UM_PUBLIC_BASE_URL` and is worth fixing — see
> [docs/oauth.md §8](oauth.md#8-verifying--troubleshooting).

---

## 4. Routing rubric — required so recall actually fires

**This step is not optional for ChatGPT.** Unlike Claude, **ChatGPT does NOT proactively call the memory tools** — when you ask a memory-shaped question it will tend to **hallucinate an answer from its own context instead of searching UM**, unless you do one of:

- **(a)** explicitly tell it to, every time — e.g. *"use the universal-memory connector to look this up"*; or
- **(b) — recommended:** paste UM's **routing rubric** into ChatGPT's **Custom Instructions** once, so recall "just works" without you prompting it each turn.

Claude Code gets this rubric injected automatically via a hook; Claude.ai picks it up from per-connector instructions; **ChatGPT has no per-connector instructions field, so it must go in your account-level Custom Instructions.** This is the same `## Memory routing` block that `um-tunnel` prints on startup.

Navigate to **ChatGPT → Settings → Personalization → Custom Instructions**, then paste the following block into the field labeled **"What would you like ChatGPT to know about you"**:

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

This block is the canonical rubric — the source lives at [`docs/memory-routing-rubric.md`](memory-routing-rubric.md). If the repo version is updated, re-paste this block. Even with the rubric in place, ChatGPT can occasionally still answer from context — if a reply looks like a guess, nudge it with *"check universal-memory."*

---

## 4a. Project metadata defaults

UM v1.1's server-side soft-default routes write tool calls with an omitted `metadata.project` field (`undefined` / `null` / `""`) to `UM_DEFAULT_PROJECT` (defaults to the literal slug `default`). This applies to `memory_capture`, `memory_add`, `memory_append_turn`, `memory_checkpoint`, and the REST `/api/add` endpoint — the last being the one ChatGPT Custom GPT Actions use.

**Why this matters for connector users:** Claude Code injects a project signal automatically via SessionStart hook; ChatGPT doesn't. The routing rubric above asks the model to pass an explicit `project:`, but if the model omits it the write silently lands in the fallback slug rather than failing loud — there is no warning surfaced to the connector. Reads (`memory_state` / `memory_search` / `memory_recent` / `memory_list`) still require an explicit project — the soft-default is write-only by design.

To control where omitted-project writes land, set `UM_DEFAULT_PROJECT=<slug>` in `server/.env` and restart the server. To make writes fail loud instead of soft-defaulting, the model-facing fix is the routing rubric (which already asks for an explicit `project:`); the server-side fix is to send the project field on every write you care about filtering later.

For full rationale, see [`docs/audits/2026-05-08-cross-surface-defaults.md`](audits/2026-05-08-cross-surface-defaults.md) §F1 + §F5 + §F6.

---

## 5. Verification walkthrough

Quick sanity checks that the connector works end-to-end. Run these in a fresh ChatGPT chat with the UM connector enabled. (If ChatGPT answers without calling a tool, that's the proactiveness gap from §4 — tell it to "use the universal-memory connector" and confirm the rubric is in your Custom Instructions.)

1. **Tool discovery.** Ask:
   > "What tools do you have available from universal-memory?"

   Expected: ChatGPT lists **4 default read tools** — `memory_search`, `memory_list`, `memory_state`, `memory_recent`. These are the reads visible to any MCP client. All 7 write tools (`memory_add`, `memory_delete`, `memory_capture`, `memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`) appear only when the server runs with `UM_MCP_WRITE_ENABLED=true`. If you see **fewer than 4**, the connector isn't wired correctly — re-check the URL and (for the stale-cache case) remove + re-add the connector.

2. **Read test — state.md.** Ask:
   > "Call `memory_state` with project `test` and tell me what you got."

   Expected: returns `{ "ok": true, "project": "test", "state": null, "valid_from": null }` if no state.md exists for `test`, or the full state body if one does. This exercises the read path.

3. **Write test — capture a fact.** (Requires `UM_MCP_WRITE_ENABLED=true` in `server/.env`.) Ask:
   > "Use `memory_capture` to write a doc with content 'ChatGPT connection verified' and metadata `{ type: 'fact', id: 'chatgpt-smoke-<today>', title: 'ChatGPT smoke', project: 'test' }`."

   Expected: returns `{ "ok": true, "path": "authored/test/chatgpt-smoke-<today>.md", ... "indexed": true }`.

4. **Disk verification.** On the UM host:
   ```bash
   ls "$UM_VAULT_DIR/authored/test/"
   cat "$UM_VAULT_DIR/authored/test/chatgpt-smoke-<today>.md"
   ```
   Expected: the file exists with the frontmatter + body from step 3.

If all four pass, ChatGPT is reading and writing the same vault Claude Code uses.

---

## 6. What works vs what doesn't

### Works
- **OAuth connector via CIMD with zero manual client setup** (§3) — ChatGPT resolves its own client-id document; you only paste the URL and approve on UM's consent page.
- All 11 MCP tools listed at [`docs/mcp-tools.md`](mcp-tools.md) — 4 reads (`memory_search`, `memory_list`, `memory_state`, `memory_recent`) visible by default; 7 writes gated behind `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` (and filtered out of `tools/list` when unset).
- Read responses use compact shape by default (`{id, title, score, snippet}`, ~200 bytes per hit). Pass `full: true` for full document bodies.
- Captures written from ChatGPT appear in your Claude Code sessions at next session start (indexed by mem0, readable via `memory_search` / `memory_state` / `memory_recent`).
- **Rubric-steered recall** once the block is in Custom Instructions (§4) — without it, ChatGPT won't reliably call the tools on its own.

### Doesn't work automatically
- **ChatGPT is not proactive about the memory tools.** It will answer from context unless told to search or unless the routing rubric is in Custom Instructions (§4). This is the single biggest difference from Claude in day-to-day use — set the rubric and you mostly won't notice it.
- **No automatic session-end hook.** ChatGPT has no equivalent of Claude Code's Stop / SessionEnd hooks, so the raw-capture → session-summary → state.md pipeline does not run automatically. Use `memory_append_turn` to append turns during a session, and `memory_checkpoint` to trigger synthesis at the end.
- **Rubric drift risk.** Custom Instructions are static — if the canonical rubric in [`docs/memory-routing-rubric.md`](memory-routing-rubric.md) changes, you need to re-paste. No auto-sync.

---

## After v0.4 upgrade (legacy Custom GPT Actions)

This section applies only to the **older ChatGPT Custom GPT Actions** integration (REST `/api/*` via an OpenAPI action), not the OAuth MCP connector above. If you previously connected a Custom GPT to UM, the deployed GPT is pinned to an old `actions-trimmed.yaml`. After upgrading UM to v0.4 or later:

1. Open the Custom GPT editor on ChatGPT.
2. Under "Actions," click "Import from file" and re-upload the new `plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml` (includes the `/api/recent/{project}` endpoint + compact-shape response schema).
3. Save.

Existing chats will continue to use the previous action definitions until the GPT is updated.

---

## Troubleshooting

- **ChatGPT answers without searching / hallucinates instead of recalling.** The proactiveness gap (§4): paste the routing rubric into **Custom Instructions**, or tell ChatGPT explicitly to "use the universal-memory connector." This is expected ChatGPT behavior, not a connection fault.
- **"Couldn't register with the sign-in service"-style error.** Stale discovery cache from a pre-OAuth probe of this URL — **remove the connector and add it again** to force fresh discovery (§1 / §3).
- **Discovery 404s / OAuth routes missing.** You're running the pre-OAuth GHCR `:latest` image. Rebuild from local source: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` from `server/` (§1). Verify with the discovery curl in [docs/oauth.md §2](oauth.md#2-enabling-it).
- **Consent page rejects the token (`bad_token`).** You pasted the wrong secret. The operator token is `UM_AUTH_TOKEN`, mirrored at `~/.um/auth-token` on the UM host — `cat ~/.um/auth-token`. Rotating it changes only *future* consent; existing grants keep working.
- **`oauth_host_mismatch` in the logs / ChatGPT can't complete discovery.** Your tunnel/proxy host doesn't match `UM_PUBLIC_BASE_URL`. Make them identical (origin only, no path, no trailing slash). See [docs/oauth.md §8](oauth.md#8-verifying--troubleshooting).
- **`GET /.well-known/openid-configuration → 401` in the logs.** Harmless — ChatGPT probes OIDC, gets 401, and falls back to RFC 8414 discovery, which UM serves. Connect completes.
- **Tools appear but writes fail.** Check `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env`, then restart the server. Writes return `{ ok: false, error: "MCP writes disabled" }` when the gate is off.
- **OAuth-server diagnostics (metrics + logs).** For the `um_oauth_*` counters and the `error_class` log breadcrumbs that pinpoint where a failed connect died, see [docs/oauth.md §8](oauth.md#8-verifying--troubleshooting).
- **More diagnostic surface.** See [`docs/workflow.md`](workflow.md) "Common diagnostic questions" for UM-side health checks.
