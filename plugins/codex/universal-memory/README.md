# universal-memory — Codex CLI plugin

Config-only plugin — recall via MCP tools only. For full session capture (raw turns → LLM-synthesized summary → `state.md`), use the Claude Code plugin at [`plugins/claude-code/universal-memory/`](../../claude-code/universal-memory/). Hooks-based capture in Codex is **deferred to v0.5+** (still blocked on Codex upstream; see [`docs/codex-integration-notes.md`](../../../docs/codex-integration-notes.md) for the 3 upstream gaps).

Audience: a user who already has universal-memory running locally (via `server/install.sh` + `docker compose up -d`) and wants OpenAI's Codex CLI to share the same memory store. Assumes basic familiarity with UM's tool surface — see [`docs/workflow.md`](../../../docs/workflow.md) and [`docs/mcp-tools.md`](../../../docs/mcp-tools.md) for the runtime reference.

---

## 1. What this plugin does (and doesn't)

This plugin wires Codex CLI to a locally running UM server via MCP. The plugin itself is two small config files — no scripts, no hooks, no daemons. See [`NOTES.md`](NOTES.md) for the schema TBDs that the v0.3 alpha carries.

### Works
- All 11 MCP tools listed at [`docs/mcp-tools.md`](../../../docs/mcp-tools.md) (4 reads visible by default; 7 writes opt-in via `UM_MCP_WRITE_ENABLED=true` + `UM_MOUNT_MODE=rw`). As of v0.5, the MCP server's default `listTools` response exposes only the 4 read tools (`memory_search`, `memory_list`, `memory_state`, `memory_recent`); the 7 write tools (`memory_add`, `memory_capture`, `memory_delete`, `memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`) appear only when both gates are set on the server.
- Memories captured from Codex sessions (via explicit `memory_capture` calls) show up in your Claude Code sessions at next session start, indexed by mem0, readable via `memory_search` / `memory_state` / `memory_recent`.
- The rubric pasted into Codex's custom-instructions equivalent (see §4) steers Codex to call `memory_capture` on explicit "remember" requests — same behavior as Claude Code's hook-injected rubric or ChatGPT Desktop's pasted rubric.

### Doesn't work (yet — tracked for v0.5+)
- **No automatic raw-capture pipeline.** Codex v0.121 does not emit a `SessionEnd` event, and its plugin manifest has no `hooks` field to bundle lifecycle scripts. Codex sessions do not append to `captures/<project>/raw/<date>.md`.
- **No automatic `state.md` regen from Codex sessions.** Without `SessionEnd`, the synthesis pipeline (raw → LLM summary → state merge → reindex) does not run from Codex. Only Claude Code sessions refresh `state.md` today.
- **No hook-based context injection on session start.** Codex has a `SessionStart` hook, but plugins can't bundle hook scripts in v0.121 — users would need to hand-edit `~/.codex/hooks.json`. Deferred pending plugin-bundled hook support.
- **Windows hook support is disabled upstream** in Codex v0.121 — one of the three blockers for a hook-driven port.

**Workaround for important conversations:** manually call `memory_capture` with `type: session_summary` at the end of a notable Codex session. There is no automatic synthesis — you write what you want preserved.

**Power-user alternative:** for scripting / cron / one-off queries outside a Codex session, install the standalone `um` CLI (see [`installer/install-cli.md`](../../../installer/install-cli.md)). It queries the same UM server without going through MCP — useful when you don't have a Codex session open.

---

## 2. Prereqs

Before starting, you should have:

- UM server running locally. Confirm with:
  ```bash
  curl -sf http://localhost:6335/mcp -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 200
  ```
  You should see a JSON response listing **4 default read tools** (`memory_search`, `memory_list`, `memory_state`, `memory_recent`). All 7 write tools appear only when the server runs with `UM_MCP_WRITE_ENABLED=true`.
- Codex CLI installed. `<TBD: confirm minimum version >= 0.121.0 during verification — earlier versions predate plugin support>`.
- (Optional but recommended) `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env` if you want Codex to write memories, not just read. Read-only is safer for first connection.
- For a **remote** UM server (Codex on a different host from UM), you need a tunnel. See [`docs/um-tunnel.md`](../../../docs/um-tunnel.md).

---

## 3. Installation

Two paths — pick whichever is easier.

### 3a. Automatic (recommended)

Run UM's install wizard — it auto-detects Codex and drops the plugin files in the right place:

```bash
cd universal-memory/server
./install.sh           # or ./install.sh --yes for defaults
```

If `~/.codex/` exists on your machine, the installer prints:

```
[install] Codex CLI detected — installing Codex plugin to ~/.codex/plugins/universal-memory/
```

Skip to §4 after the wizard exits clean.

### 3b. Manual

If you installed UM via curl-pipe-bash, are running the server remotely, or skipped `install.sh`, drop the files yourself:

```bash
# From the universal-memory repo root
mkdir -p ~/.codex/plugins/universal-memory/.codex-plugin
cp plugins/codex/universal-memory/.codex-plugin/plugin.json \
   ~/.codex/plugins/universal-memory/.codex-plugin/plugin.json
cp plugins/codex/universal-memory/.mcp.json \
   ~/.codex/plugins/universal-memory/.mcp.json
```

Alternately, register the plugin via the local marketplace file (works from any repo checkout without copying):

```bash
mkdir -p ~/.agents/plugins
cat > ~/.agents/plugins/marketplace.json <<'EOF'
{
  "plugins": [
    {
      "name": "universal-memory",
      "source": {
        "path": "./path/to/universal-memory/plugins/codex/universal-memory"
      }
    }
  ]
}
EOF
```

Adjust the `source.path` to match your checkout. `<TBD: confirm exact marketplace.json schema field names during verification — E1 notes "source.path with a `./`-prefixed relative path" but the surrounding envelope shape is inferred from the `$plugin-creator` skill output>`.

### 3c. Alternate — no plugin, direct `config.toml` registration

If the plugin discovery path doesn't work on your Codex version, register UM as an MCP server directly:

```toml
# ~/.codex/config.toml
[mcp_servers.universal-memory]
url = "http://localhost:6335/mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

This skips the plugin layer entirely — Codex will launch the MCP connection at session start without needing the plugin manifest. For a remote UM, swap in your tunnel URL.

---

## 4. Routing rubric paste-in

Codex needs UM's memory-routing rubric to decide when to call `memory_capture` vs letting session-end catch state. Unlike Claude Code (where `session-start.sh` injects the rubric automatically), Codex in v0.3 and v0.4 has no hook-based injection, so the rubric must live in Codex's equivalent of custom instructions.

Paste the block below into `<TBD: confirm exact surface during verification — likely AGENTS.md at your workspace root, or the "custom instructions" / "system prompt" field in Codex's equivalent settings panel>`. See also [`docs/memory-routing-rubric.md`](../../../docs/memory-routing-rubric.md) for the canonical source.

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

This block is the canonical rubric — the source lives at [`docs/memory-routing-rubric.md`](../../../docs/memory-routing-rubric.md). If the repo version is updated, re-paste this block.

**Caveat for Codex specifically:** the rubric references "the session-end pipeline will capture it". In Codex, there *is no session-end pipeline in v0.3 or v0.4* — so the guidance "no immediate action needed" effectively means the note is lost unless the user manually captures it. For important project work in Codex, err toward calling `memory_capture` regardless.

---

## 5. Verification

Quick sanity checks that the connector works end-to-end. Run these in a fresh Codex session.

1. **Tool discovery.** Ask:
   > "What tools do you have available from universal-memory?"

   Expected (v0.5 default): Codex lists **4 default read tools** — `memory_search`, `memory_list`, `memory_state`, `memory_recent`. These are the reads visible to any MCP client. All 7 write tools (`memory_add`, `memory_delete`, `memory_capture`, `memory_checkpoint`, `memory_forget`, `memory_supersede`, `memory_append_turn`) appear only when the server runs with `UM_MCP_WRITE_ENABLED=true`. If you see **fewer than 4** or the wrong ones, the MCP server didn't register — re-check `~/.codex/config.toml` or the plugin `.mcp.json`, and confirm UM is reachable.

   You can also run `codex mcp list` directly at the shell to confirm `universal-memory` shows up.

2. **Read test — state.md.** Ask:
   > "Call `memory_state` with project `test` and tell me what you got."

   Expected: returns `{ "ok": true, "project": "test", "state": null, "valid_from": null }` if no state.md exists for `test`, or the full state body if one does. This exercises the read path.

3. **Write test — capture a fact.** (Requires `UM_MCP_WRITE_ENABLED=true` in `server/.env`.) Ask:
   > "Use `memory_capture` to write a doc with content 'Codex CLI connection verified' and metadata `{ type: 'fact', id: 'codex-smoke-<today>', title: 'Codex CLI smoke', project: 'test' }`."

   Expected: returns `{ "ok": true, "path": "authored/test/codex-smoke-<today>.md", ... "indexed": true }`.

4. **Disk verification.** On the UM host:
   ```bash
   ls "$UM_VAULT_DIR/authored/test/"
   cat "$UM_VAULT_DIR/authored/test/codex-smoke-<today>.md"
   ```
   Expected: the file exists with the frontmatter + body from step 3.

If all four pass, Codex is reading and writing the same vault that Claude Code uses.

---

## 6. Troubleshooting

- **Tool list empty or wrong.** Confirm the MCP server registered: `codex mcp list` should show `universal-memory`. If absent, the plugin `.mcp.json` wasn't picked up — try the `config.toml` fallback in §3c.
- **Tools appear but writes fail.** Check `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` in `server/.env`, then `docker compose restart memory-server`. Writes return `{ ok: false, error: "MCP writes disabled" }` when the gate is off.
- **`state.md` never updates from Codex sessions.** Expected — no session-end pipeline in Codex v0.3. Run `/um-checkpoint` in Claude Code (or `hooks/session-end.sh` directly) on the UM host to refresh state after a significant Codex session.
- **Rubric drift.** The paste-in is static. If [`docs/memory-routing-rubric.md`](../../../docs/memory-routing-rubric.md) changes upstream, re-paste the whole block from §4.
- **More diagnostic surface.** See [`docs/workflow.md`](../../../docs/workflow.md) "Common diagnostic questions" for UM-side health checks.

---

## 7. Status and roadmap

- **Version:** 0.6.0-alpha (tracks v0.6 of universal-memory overall; Codex plugin remains config-only).
- **Scope:** MCP connector only — no lifecycle hooks.
- **Upstream gaps blocking full parity** (tracked in [`docs/codex-integration-notes.md`](../../../docs/codex-integration-notes.md)):
  1. Codex v0.121 has no `SessionEnd` event.
  2. Plugin manifest has no `hooks` field — can't bundle lifecycle scripts.
  3. Codex hooks disabled on Windows.
- **Path forward:** once any two of the above change upstream, this plugin gains the four hook scripts UM's Claude Code plugin already has, and Codex gets feature parity. No restructure required — same directory, additive.
