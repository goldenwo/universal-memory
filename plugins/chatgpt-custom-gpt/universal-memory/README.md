# ChatGPT Custom GPT — universal-memory

A "Custom GPT" recipe that lets ChatGPT (web / native apps) read and write your universal-memory vault via the server's REST surface. Unlike the Claude.ai / Claude Desktop and ChatGPT Desktop connectors (which speak MCP), this path uses ChatGPT's **Custom GPT Actions** feature: a user-authored OpenAPI spec that the GPT model can call over plain HTTPS.

Audience: a user who already has UM running locally + tunneled (see the [Claude Code plugin README](../../claude-code/universal-memory/README.md) for install / env setup) and wants a ChatGPT surface with memory access — especially on platforms where MCP connectors aren't available (mobile ChatGPT, free/Plus tiers without MCP entitlement).

---

## What you get

- A Custom GPT named (your choice — e.g. "Memory GPT") with 4 actions wired to your UM server:
  - `memory_search` — semantic search across the vault
  - `memory_state` — load the `state.md` snapshot for a project
  - `memory_add` — fact extraction + store (equivalent to mem0's `add` pass)
  - `memory_delete` — remove by metadata.id or mem0 UUID
- An **Instructions** block that teaches the GPT when to call each action (the canonical memory-routing rubric).

## What it does NOT give you

Custom GPT Actions only cover the REST surface. MCP-only tools — raw turn capture, full `memory_capture` with arbitrary frontmatter, `memory_supersede`, `memory_forget`, `memory_checkpoint` — are **not** exposed via Actions. For those, use Claude Code (native plugin) or Claude.ai / ChatGPT Desktop MCP connector (see `docs/connecting-claude-ai.md`, `docs/connecting-chatgpt-desktop.md`).

See the [Limitations](#5-limitations) section below for the full can / can't-do list.

---

## 1. Prereqs

Before starting, you should have:

- UM server running + reachable at a tunnel URL (Tailscale Funnel, Cloudflare Tunnel, or ngrok).
  See [`docs/connecting-chatgpt-desktop.md#2-tunnel-options`](../../../docs/connecting-chatgpt-desktop.md#2-tunnel-options) for tunnel walkthroughs — the same tunnel works for Custom GPT Actions. Confirm the tunnel resolves:
  ```bash
  curl -sf https://<your-tunnel-host>/health
  # expected: {"ok":true,"memories":<count>}
  ```
- A ChatGPT account on a plan that can create Custom GPTs. `<TBD: confirm current plan tier during D3 — likely Plus / Pro / Team / Enterprise as of 2026>`.
- (Optional, for write tests) `UM_MCP_WRITE_ENABLED=true` in `server/.env`. `memory_add` itself does not require MCP writes to be enabled — it uses the HTTP `/api/add` path, which is gated only by the server being reachable. But if you also want to experiment with vault writes later, turn it on now.

Security note: the same tunnel-exposure caveats from [`docs/connecting-chatgpt-desktop.md`](../../../docs/connecting-chatgpt-desktop.md) apply here. Anyone who can reach the tunnel URL can hit these endpoints, so prefer an auth-aware tunnel (Tailscale Funnel or Cloudflare Access) over raw ngrok when your vault contains anything sensitive.

### Compact-shape default (new in v0.4)

As of v0.4, `memory_search` responses ship in a **compact shape** by default: each hit returns `{id, title, score, snippet}` with a ~200-byte snippet rather than the full document body. This is a deliberate token-budget reduction for model-driven recall — most searches only need enough surface area to decide which hit matters, and the GPT can then request the full body on demand. If your GPT's workflow needs full bodies (e.g. "summarize all hits"), pass `full=true` as an action parameter. If you customize the pasted-in system prompt (Instructions block), keep in mind the default is snippets, not full bodies.

---

## 2. Create the Custom GPT

1. Visit the Custom GPT editor at `<TBD: confirm exact URL during D3 — likely https://chatgpt.com/gpts/editor or chat.openai.com/gpts/editor>` and click **`<TBD: exact button label — "Create a GPT" or similar>`**.

   ![TBD: screenshot of Create-a-GPT entry point](screenshots/custom-gpt-create.png)

2. In the **Configure** tab, give the GPT a name (e.g. "Memory GPT") and a short description (e.g. "Access to my universal-memory vault").

3. Paste the content of [`system-prompt.md`](system-prompt.md) into the **Instructions** field. This is the routing rubric mirrored from [`docs/memory-routing-rubric.md`](../../../docs/memory-routing-rubric.md). If the canonical rubric ever changes, re-paste this whole block.

   ![TBD: screenshot of Instructions field populated](screenshots/custom-gpt-instructions.png)

---

## 3. Add the Actions

You have **two options** for importing the action schema. The URL form keeps the spec auto-fresh; the paste-in form is fully offline.

### Option A — Import from URL (recommended)

In the **Actions** section of Configure, click **`<TBD: "Create new action" / "Add Action" or similar>`**, then choose **"Import from URL"** and enter:

```
https://<your-tunnel-host>/openapi.yaml?gpt=1
```

The `?gpt=1` query flag makes the server emit the trimmed Custom-GPT-ready subset (4 routes, renamed operationIds, 5xx responses stripped) instead of the full spec. If you forget the flag and import the full spec, ChatGPT may fail to accept it — it contains routes (`/mcp`, `/api/reindex`) and response codes the validator rejects.

**Why prefer this path:** the spec re-generates on every request, so if a future UM release changes the schema, your Custom GPT picks it up on next re-import. No manual re-sync.

### Option B — Paste `actions-trimmed.yaml`

If your tunnel is offline during setup, or you prefer a fully-pinned spec, paste the full contents of [`actions-trimmed.yaml`](actions-trimmed.yaml) into the schema textbox.

This file is generated from the same helper as the URL-form response, so the two are byte-identical at publish time. They can drift later if the server is upgraded and this file isn't re-generated; regenerate with:

```bash
node -e "import('./server/openapi.mjs').then(m => console.log(m.generateCustomGPTActionsSpec()))" \
  > plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml
```

### Either option — set the Authentication

Set Authentication to **None** (UM has no auth layer of its own; auth lives in the tunnel). `<TBD: confirm the exact UI label during D3 — "None", "No authentication", or equivalent>`.

Then confirm the **server URL** shown by the Actions editor matches your tunnel host. The spec ships with `http://localhost:6335` baked into `servers[0].url` — the Custom GPT editor normally lets you override this at import time. If it doesn't, edit the `servers:` block in the pasted YAML (Option B) before saving.

![TBD: screenshot of Actions configuration with server URL override](screenshots/custom-gpt-actions.png)

---

## 4. Save + verify

Click **`<TBD: "Save" or "Update">`** and (for a personal-only GPT) choose the **`<TBD: "Only me"-equivalent visibility>`** option.

Then start a new chat with the GPT and run these checks:

1. **Tool discovery.** Ask:
   > "What tools do you have available?"

   Expected: the GPT lists `memory_search`, `memory_state`, `memory_add`, `memory_delete`. If it lists nothing or wrong names, the spec didn't import — re-check the URL / paste and confirm the Actions tab shows a green checkmark.

2. **Read test — state.md.** Ask:
   > "Call `memory_state` for project `test` and show me the result."

   Expected: the GPT calls the action and returns `{ "ok": true, "project": "test", "state": null, "valid_from": null }` if no state file exists for `test`, or the full body if one does.

3. **Read test — search.** Ask:
   > "Use `memory_search` with query 'universal-memory' and limit 3."

   Expected: some result list (possibly empty if the vault is empty).

4. **Write test — add.** Ask:
   > "Use `memory_add` to store the text: 'ChatGPT Custom GPT smoke test on <today>'."

   Expected: ChatGPT calls the action and returns a `results` array with at least one extracted fact.

If all four pass, the Custom GPT is wired correctly.

---

## 5. Limitations

### Works
- **Search.** Semantic recall across every indexed document in the vault, with optional `project` / `type` filters.
- **State load.** Direct read of `state.md` for any project — returns null gracefully when no state exists.
- **Fact extraction + store.** `memory_add` runs mem0's LLM extractor on whatever text you send, producing atomic facts in the vector store.
- **Delete.** Remove by metadata.id (wipes every entry with that id) or mem0 UUID (single entry).

### Doesn't work
- **Raw session capture.** ChatGPT web has no session-end hook — there's no equivalent of Claude Code's Stop / SessionEnd pipeline. Whatever the GPT doesn't explicitly capture via `memory_add` is ephemeral on UM's side. The `memory_append_turn` MCP tool is planned for v0.5+ ([issue #6](https://github.com/goldenwo/universal-memory/issues/6)) to close this.
- **Rich structured capture.** `memory_add` goes through mem0's fact-extractor; you don't get to specify the full frontmatter (type, id, title, project) the way `memory_capture` does over MCP. For ADRs, canonical docs, or anything that needs a stable filename + versioning, use Claude Code (the native plugin exposes `memory_capture` directly) or a Claude.ai / ChatGPT Desktop MCP connector instead.
- **Supersede / forget / checkpoint.** These are MCP-only write tools (`memory_supersede`, `memory_forget`, `memory_checkpoint`). Not exposed to Custom GPT Actions.
- **State regeneration.** A Custom GPT session does not refresh `state.md` — only Claude Code's `session-end.sh` / `/um-checkpoint` does. If you want ChatGPT-session context in the next Claude Code session, wait for a future release (tracked alongside `memory_append_turn`) or checkpoint manually.
- **Rubric drift.** The Instructions block is a static paste. If the canonical rubric in [`docs/memory-routing-rubric.md`](../../../docs/memory-routing-rubric.md) changes, re-paste `system-prompt.md` into the GPT's Instructions field.

### Out-of-scope failure modes to expect
- **Spec too large for the Actions import.** The Custom GPT Actions size limit `<TBD: verify current limit during D3 — the plan mentioned a 700-byte figure which is almost certainly a typo; ~100KB is the historically-documented cap but re-confirm before citing>`. The trimmed spec is ~10KB, so it's well under any plausible cap, but double-check if you hit "schema too large" errors.
- **CORS.** UM sends `Access-Control-Allow-Origin: *` — Custom GPT Actions don't require CORS (the calls originate from OpenAI's backend, not a browser), so this shouldn't matter. If you see CORS errors, something else is misconfigured.

---

## Troubleshooting

- **"This action isn't available"** when the GPT tries to call a tool. Most commonly caused by the full `/openapi.yaml` being imported instead of `/openapi.yaml?gpt=1` — the full spec contains routes the Actions validator silently disables. Re-import with the flag or paste `actions-trimmed.yaml`.
- **Tools don't appear.** Tunnel URL unreachable from OpenAI's backend. Test from a device on cellular: `curl -sf https://<tunnel>/openapi.yaml?gpt=1 | head -c 200`. If that fails, fix the tunnel before revisiting the GPT editor.
- **`memory_add` returns an error.** Check that the UM server has `OPENAI_API_KEY` set and the mem0 LLM model is reachable — the fact-extraction pass needs an OpenAI call.
- **Writes land but disappear.** Confirm the vault path is the same one Claude Code reads. `memory_add` stores to mem0's vector index; it does **not** create a markdown file in the vault (that's what `memory_capture` does over MCP). If you want a persisted markdown record, use Claude Code or an MCP connector.
