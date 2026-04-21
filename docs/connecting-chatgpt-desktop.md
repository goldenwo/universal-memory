# Connecting ChatGPT Desktop to universal-memory

How to add your universal-memory server as an MCP connector inside ChatGPT Desktop, so ChatGPT can read/write the same vault that Claude Code uses.

Audience: a user who already has UM running locally (via `install.sh` + `docker compose up -d`) and wants ChatGPT Desktop to share the same memory store. Assumes basic familiarity with the UM tool surface — see [`docs/workflow.md`](workflow.md) and [`docs/mcp-tools.md`](mcp-tools.md) for the runtime reference.

---

## 1. Prereqs

Before starting, you should have:

- UM server running locally. Confirm with:
  ```bash
  curl -sf http://localhost:6335/mcp -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 200
  ```
  You should see a JSON response listing the 10 tools.
- A **publicly reachable URL** for the MCP endpoint. ChatGPT Desktop runs in OpenAI's cloud and cannot reach your `localhost:6335` directly — even though it's a desktop app, the MCP connector calls originate from OpenAI's backend. You need a tunnel. See [Tunnel options](#2-tunnel-options) below.
- ChatGPT Desktop with a plan that supports custom MCP connectors. `<TBD: confirm exact plan tier required during verification — Plus / Pro / Business>`.
- (Optional but recommended) `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env` if you want ChatGPT to write memories, not just read. Read-only is safer for first connection.

---

## 2. Tunnel options

**Recommended entry:** run [`bin/um-tunnel`](../plugins/claude-code/universal-memory/bin/um-tunnel) for a one-command setup — it auto-detects your installed tunnel CLI, starts the tunnel, and prints the URL + rubric block ready to paste. See [`docs/um-tunnel.md`](um-tunnel.md) for details. The manual instructions below still work for anyone who prefers to run the tunnel CLI directly.

Three common choices. All three expose `http://localhost:6335` at a public HTTPS URL. For full exposure-model context see the [Security section of `docs/mcp-tools.md`](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http) — **write mode exposes your entire vault to anyone who can hit the tunnel URL**, so prefer an auth-aware tunnel when writes are enabled.

### Tailscale Funnel (recommended for personal use)

Free for personal accounts, auth-aware via Tailscale identity, stable hostname tied to your tailnet.

```bash
tailscale funnel --bg 6335
# note the printed https://<device>.<tailnet>.ts.net URL
```

**Pros:** Identity-bound (only your tailnet or the public internet if you choose), no separate account for tunnel service, free.
**Cons:** Requires Tailscale client on the host. Funnel exposes the port publicly by default — use `tailscale serve` for tailnet-only if ChatGPT Desktop doesn't need external reach.
**Security note:** Funnel URLs are public. If you enable MCP writes, pair with localhost-bind + reverse proxy, or restrict via Tailscale ACLs if using `serve` instead of `funnel`. Cross-reference [mcp-tools.md security](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http).

### Cloudflare Tunnel

Stable hostnames on your own domain (or a generated `trycloudflare.com` one), free tier covers personal use.

```bash
cloudflared tunnel --url http://localhost:6335
```

**Pros:** Stable named tunnels when bound to a Cloudflare-managed domain; can front with Cloudflare Access for SSO-style auth; generous free tier.
**Cons:** Setup is more involved if you want a stable custom hostname (requires a domain in Cloudflare DNS). `trycloudflare.com` URLs are ephemeral per-process.
**Security note:** Without Cloudflare Access in front, the tunnel URL is public. Enable Access policies before turning on MCP writes.

### ngrok

Fastest to set up, widely known.

```bash
ngrok http 6335
```

**Pros:** Easiest — one command, works instantly.
**Cons:** Free tier URLs are ephemeral (rotate per process) and traffic transits ngrok infrastructure. Paid tier for stable subdomains.
**Security note:** ngrok sees all traffic. If you enable MCP writes, this means ngrok has a network path to your vault contents. Acceptable for testing, weaker for sustained use. See [mcp-tools.md security](mcp-tools.md#security--mcp-write-tools-expose-the-vault-over-http).

---

## 3. ChatGPT Desktop MCP connector walkthrough

Step-by-step UI clicks. The ChatGPT Desktop UI evolves, so screenshots will be captured during manual verification. Placeholders below mark where those go.

1. Open ChatGPT Desktop. Click your profile icon (top right) → **Settings**.

   ![TBD: screenshot of ChatGPT Desktop Settings entry point](screenshots/chatgpt-desktop-settings-entry.png)

2. In Settings, navigate to **`<TBD: exact menu name during verification — likely "Connectors" or "Integrations">`**.

   ![TBD: screenshot of ChatGPT Desktop Settings → Connectors panel](screenshots/chatgpt-desktop-connectors-panel.png)

3. Click **`<TBD: exact button label — "Add connector" / "New MCP server" / similar>`**.

   ![TBD: screenshot of ChatGPT Desktop Settings → Connectors → Add](screenshots/chatgpt-desktop-connector-add.png)

4. Fill in the connector form:
   - **Name**: `universal-memory` (any label you want — what ChatGPT will call it)
   - **URL**: your tunnel URL + `/mcp` suffix, e.g. `https://<your-device>.<tailnet>.ts.net/mcp`
   - **Transport**: `<TBD: confirm option name — "HTTP" or "Streamable HTTP" or "SSE">`. UM speaks plain JSON-RPC HTTP at `POST /mcp`; pick whichever option matches that.
   - **Auth**: none (UM has no auth layer of its own; auth lives in the tunnel). If the UI requires selecting an auth type, pick `<TBD: "None" / "No auth" equivalent>`.

   ![TBD: screenshot of the filled-in connector form](screenshots/chatgpt-desktop-connector-form.png)

5. Click **`<TBD: "Save" / "Add" / "Connect">`**. ChatGPT Desktop should perform the MCP handshake and list the available tools.

   ![TBD: screenshot showing the 10 UM tools discovered](screenshots/chatgpt-desktop-tools-discovered.png)

6. Enable the connector in a new chat (`<TBD: confirm whether it's on by default or needs a per-chat toggle>`).

---

## 4. Routing rubric paste-in

ChatGPT Desktop does not read repo files, so the routing rubric needs to live in your ChatGPT **Custom Instructions**. This is the same rubric Claude Code hooks inject at session start — pasting it here gives ChatGPT the same routing guidance.

Navigate to **ChatGPT → Settings → Personalization → Custom Instructions**, then paste the following block into the field labeled **"What would you like ChatGPT to know about you"**:

<!-- Do not edit inline — mirror of docs/memory-routing-rubric.md. If the canonical file changes, re-paste this whole block. -->

```markdown
## Memory routing (universal-memory)

Tool note: the bullets below reference `memory_capture`. If that tool is not registered in this session but `memory_add` is (generic mem0), call `memory_add` instead — the routing guidance applies to either.

When the user says "remember", "note that", or similar:
- Project-scoped active work (current focus, in-flight tasks, open questions, decisions made today): no immediate action needed — the session-end pipeline will capture it in state.md and the session summary automatically.
- Durable facts the user will want later ("I prefer X", "my address is Y", "the API rotates quarterly"): call `memory_capture` with `type: fact` and `project: global` (cross-project) or `project: <current-project>` (project-scoped).
- Architecture decisions worth auditing later: call `memory_capture` with `type: adr` and `project: <current>`.
- Anything the user will likely search for by keyword later: call `memory_capture` (any appropriate type).

When uncertain, prefer a capture call over trusting session-end — durable docs are easier to search than buried state.md entries.
```

This block is the canonical rubric — the source lives at [`docs/memory-routing-rubric.md`](memory-routing-rubric.md). If the repo version is updated, re-paste this block.

---

## 5. Verification walkthrough

Quick sanity checks that the connector works end-to-end. Run these in a fresh ChatGPT Desktop chat with the UM connector enabled.

1. **Tool discovery.** Ask:
   > "What tools do you have available from universal-memory?"

   Expected: ChatGPT lists the 10 UM tools (`memory_search`, `memory_add`, `memory_list`, `memory_delete`, `memory_state`, `memory_recent`, `memory_capture`, `memory_checkpoint`, `memory_forget`, `memory_supersede`). If it lists fewer or the wrong ones, the connector isn't wired correctly — re-check the URL and transport.

2. **Read test — state.md.** Ask:
   > "Call `memory_state` with project `test` and tell me what you got."

   Expected: returns `{ "ok": true, "project": "test", "state": null, "valid_from": null }` if no state.md exists for `test`, or the full state body if one does. This exercises the read path.

3. **Write test — capture a fact.** (Requires `UM_MCP_WRITE_ENABLED=true` in `server/.env`.) Ask:
   > "Use `memory_capture` to write a doc with content 'ChatGPT Desktop connection verified' and metadata `{ type: 'fact', id: 'chatgpt-desktop-smoke-<today>', title: 'ChatGPT Desktop smoke', project: 'test' }`."

   Expected: returns `{ "ok": true, "path": "authored/test/chatgpt-desktop-smoke-<today>.md", ... "indexed": true }`.

4. **Disk verification.** On the UM host:
   ```bash
   ls "$UM_VAULT_DIR/authored/test/"
   cat "$UM_VAULT_DIR/authored/test/chatgpt-desktop-smoke-<today>.md"
   ```
   Expected: the file exists with the frontmatter + body from step 3.

If all four pass, ChatGPT Desktop is reading and writing the same vault Claude Code uses.

---

## 6. What works vs what doesn't

### Works
- All 10 MCP tools listed at [`docs/mcp-tools.md`](mcp-tools.md) — reads unconditionally, writes when `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw`.
- Captures written from ChatGPT Desktop appear in your Claude Code sessions at next session start (indexed by mem0, readable via `memory_search` / `memory_state` / `memory_recent`).
- The rubric pasted into Custom Instructions steers ChatGPT to call `memory_capture` on explicit "remember" requests, same as Claude Code hook-injected rubric does.

### Doesn't work (yet)
- **No session-end hook.** ChatGPT Desktop has no equivalent of Claude Code's Stop / SessionEnd hooks, so the raw-capture → session-summary → state.md pipeline does not run from ChatGPT sessions. Only Claude Code sessions produce state.md updates.
- **No state.md regen from ChatGPT sessions** until v0.4 server-side checkpoint lands — tracked in [issue #5](https://github.com/goldenwo/universal-memory/issues/5). Workaround: run `/um-checkpoint` in Claude Code (or `hooks/session-end.sh` directly) to refresh state after a significant ChatGPT session.
- **No raw turn capture** until v0.4's `memory_append_turn` MCP tool — tracked in [issue #6](https://github.com/goldenwo/universal-memory/issues/6). ChatGPT conversations stay ephemeral on the UM side; only explicit `memory_capture` calls persist.
- **Rubric drift risk.** Custom Instructions are static — if the canonical rubric in [`docs/memory-routing-rubric.md`](memory-routing-rubric.md) changes, you need to re-paste. No auto-sync.

---

## After v0.4 upgrade

If you previously connected a ChatGPT Custom GPT to UM, the deployed GPT is pinned to an old `actions-trimmed.yaml`. After upgrading UM to v0.4:

1. Open the Custom GPT editor on ChatGPT.
2. Under "Actions," click "Import from file" and re-upload the new `plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml` (includes the new `/api/recent/{project}` endpoint + compact-shape response schema).
3. Save.

Existing chats will continue to use the previous action definitions until the GPT is updated.

---

## Troubleshooting

- **Tools don't appear after adding connector.** Check the tunnel URL resolves from outside your network (test from a phone on cellular). Confirm the `/mcp` path suffix is present.
- **Tools appear but writes fail.** Check `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env`, then `docker compose restart memory-server`. Writes return `{ ok: false, error: "MCP writes disabled" }` when the gate is off.
- **ChatGPT refuses to call the tools.** Custom Instructions may be conflicting. Confirm the rubric is pasted in the "know about you" field and no other instructions override it.
- **More diagnostic surface.** See [`docs/workflow.md`](workflow.md) "Common diagnostic questions" for UM-side health checks.
