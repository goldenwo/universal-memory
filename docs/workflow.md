# Universal-memory — workflow reference

> **Version:** This document describes **v0.5.0-alpha**. Three equal-peer surfaces: MCP (every Claude surface + Codex + Custom GPT), REST (OpenAPI 3.1 — Custom GPT Actions, Responses API, HTTP clients), and the standalone `um` CLI (7 subcommands). Progressive disclosure on reads: responses default to compact snippets; full bodies via `?full=1` / `full: true`.

Source-of-truth description of what universal-memory does on this machine today. Written against **v0.5.0-alpha** (supersedes v0.4.0-alpha, which was tagged 2026-04-21). Update this file when the behavior changes.

Audience: the maintainer (you). Useful when answering "where did X go?", "why didn't Y fire?", "what tool should Claude call for Z?" — or when a fresh session needs to catch up on the runtime picture.

---

## TL;DR

Universal-memory is a **session-continuity layer** for Claude surfaces. It captures what happens during your Claude Code sessions, synthesizes a per-project snapshot of "where you left off" (`state.md`), and indexes the synthesized summaries for semantic recall. The goal is that you never lose context between sessions — next time you open Claude, it already knows what you were doing.

Two tiers:
- **Tier 1 — source markdown** in `$VAULT/`: raw captures, session summaries, state.md, authored docs. Human-readable, never lost.
- **Tier 2 — vector index (mem0 + Qdrant)** at `localhost:6335`: vector recall over tier 1's indexable content (session summaries + authored docs). `state.md` is *never* indexed — it's read directly.

Three pillars:
1. **Summaries** — every session's raw captures get LLM-synthesized into a `session_summary` document at session end.
2. **state.md** — one file per project, LLM-merged running snapshot. 3000-char cap.
3. **Versioning** — `um-forget` (soft-delete via frontmatter `status: deprecated`) and `um-supersede` (versioned replace). Searches default to `status=current`.

---

## Three surfaces, one vault

Every v0.4 feature is addressable through three equal-peer surfaces reading/writing the same vault:

- **MCP** — `http://localhost:6335/mcp` — every Claude surface (Code, Desktop, Claude.ai), Codex, and bridges into Claude Desktop's Custom GPT. Default `tools/list` exposes 4 reads; 7 writes gated behind `UM_MCP_WRITE_ENABLED=true` (and the vault mount must be `rw` for the writes to actually succeed).
- **REST** — OpenAPI 3.1 at `GET /openapi.yaml`; used by ChatGPT Custom GPT Actions (`?gpt=1` trimmed variant), the OpenAI Responses API, and any HTTP client. New in v0.4: `GET /api/recent/{project}` for mtime-sorted session summaries.
- **CLI (`um`)** — 7 subcommands: `um search`, `um state`, `um recent`, `um list`, `um capture`, `um tail`, `um --version`. Install standalone via `installer/install-cli.sh`; configure via `UM_ENDPOINT` + optional `~/.um/config` (KEY=value, parsed by `hooks/lib/config.sh`; env > file precedence).

All three default to compact-shape reads (`{id, title, score, snippet}`, ~200 bytes per hit). Ask for full bodies explicitly with `?full=1` (REST), `full: true` (MCP), or `--full` (CLI where supported).

---

## Where things live on this machine

Resolved paths as of v0.4.0-alpha:

| Thing | Path |
|---|---|
| Repo | `E:/Projects/universal-memory/` |
| Vault (default) | `$HOME/.um/vault/` — i.e. `C:/Users/wogol/.um/vault/` |
| Plugin installed | `C:/Users/wogol/.claude/plugins/universal-memory/` |
| Server docker stack | `E:/Projects/universal-memory/server/docker-compose.yml` |
| Server container image | `ghcr.io/goldenwo/universal-memory-server:0.4.0-alpha` |
| MCP endpoint | `http://localhost:6335/mcp` (bound to `127.0.0.1` only) |
| Qdrant data | `E:/Projects/universal-memory/server/data/qdrant/` |
| Cost log | `$VAULT/.telemetry/cost-log.csv` |
| Session-end log | `$VAULT/.telemetry/session-end*.log` |

**Environment** (should be set in the shell that launches Claude Code):

```bash
UM_VAULT_DIR="$HOME/.um/vault"
UM_OPENAI_API_KEY="sk-..."
UM_ENDPOINT="http://localhost:6335"
```

`install.sh` writes these into `~/.bashrc` (or your shell equivalent) between marker lines.

---

## The four storage destinations

Content flows into exactly one of these — they don't compete, they layer.

```
$VAULT/
├── captures/<project>/raw/YYYY-MM-DD.md    (1) raw captures — append-only
├── sessions/<project>/<summary-id>.md       (2) session summaries
├── state/<project>/state.md                 (3) state of play — one per project
└── authored/<project>/<id>.md               (4) authored documents
```

| # | Destination | Writer | Indexed in mem0? | Lifetime |
|---|-------------|--------|------------------|----------|
| 1 | `captures/.../raw/<date>.md` | Stop hook (every turn) | No — synthesized into summaries then consumed | Append-only day-file; persists indefinitely but only the *recent* files feed synthesis |
| 2 | `sessions/.../<id>.md` | SessionEnd hook / catchup / `/um-checkpoint` | **Yes** via `/api/reindex` | Permanent — becomes the searchable record of what happened |
| 3 | `state/<project>/state.md` | Same writers as #2 (LLM-merge) | **No** — direct file read only | Overwritten every refresh; current snapshot only |
| 4 | `authored/<project>/<id>.md` | `memory_capture` MCP tool / user writes directly | **Yes** via `/api/reindex` | Permanent unless `memory_forget` / `memory_supersede` changes status |

### Why state.md is NOT in mem0

Deliberate. State.md is the LLM's distillation of "current project state" — you want *deterministic* access (the current version, every time), not *semantic* (top-k similar chunks). Also prevents a stale state.md chunk from polluting unrelated queries. The invariant is enforced by `POST /api/reindex` — passing `type: state` returns an error.

---

## Per-turn flow (Stop hook)

Every time Claude finishes a response:

```
Claude finishes response
    ↓
hooks/stop.sh fires (registered in plugin's hooks.json)
    ↓
Append entry to $VAULT/captures/<project>/raw/YYYY-MM-DD.md
Format: timestamp header + role + content
    ↓
exit 0 (fast — no LLM call, no HTTP request)
```

The Stop hook's job is to be **bulletproof and fast**. No LLM, no network, just an atomic append. If the vault is unwritable, it fails silently.

`<project>` is detected by `project_name()` in `hooks/lib/vault.sh` — typically derived from the CC workspace path.

---

## Per-session flow

### At session start (SessionStart hook)

```
Claude Code session starts (startup | clear | compact)
    ↓
hooks/session-start.sh fires
    ↓
1. auto-start.sh — ensure server stack is up (no-op if already running)
    ↓
2. Check UM_ENDPOINT — if unset, emit rubric-only context and exit 0
    ↓
3. Detect orphans — raw captures whose mtime > newest session summary valid_from
   └─ If orphans exist:
      Fork session-end.sh in the background with UM_CATCHUP_RAW_SINCE/UNTIL
      (disowned — runs while you start typing)
    ↓
4. GET /api/state/<project> (3s timeout, fail-soft)
    ↓
5. Apply staleness rules (from valid_from frontmatter):
   ≤ 7 days   → inject verbatim
   7-30 days  → inject with "last active YYYY-MM-DD, may be outdated" prefix
   > 30 days  → skip state body, still inject rubric
   missing    → skip state body, still inject rubric
    ↓
6. Emit JSON:
   { "additionalContext": "<state.md body>\n\n<routing rubric>" }
    ↓
Claude sees the injection as part of its first-turn context.
```

**Token budget:** ~1–2k tokens total (state.md is capped at 3000 chars, rubric is ~1100 chars).

**Invariants:** Exits `0` on any failure — never blocks session start. Auto-start hangs or network flakes become silent no-ops, not errors.

### Mid-session — first user message (UserPromptSubmit hook)

On the **first** prompt of a session only (guarded by a count file at `$VAULT/.telemetry/session-<id>.count`):

```
User sends first message
    ↓
hooks/user-prompt-submit.sh fires
    ↓
POST /api/search with the prompt text as query
    ↓
Top 5 hits returned (status=current filter, ~2k token budget)
    ↓
Emit { "additionalContext": "<hits>" } — injected before Claude responds
    ↓
2nd+ prompts: hook exits silently (count > 1)
```

**Rationale:** Gives Claude a semantic jump-start for the session's topic without re-searching on every turn. Avoids budget explosion.

### At session end (SessionEnd hook)

When Claude Code exits cleanly:

```
hooks/session-end.sh fires
    ↓
Acquire lockdir at $VAULT/state/<project>/state.md.lockdir
(stale-lock recovery after 10 min)
    ↓
1. Read recent raw captures (since last summary's valid_from, or UM_CATCHUP_RAW_SINCE/UNTIL for catchup)
    ↓
2. Summarize via OpenAI (hooks/lib/summarize.sh)
   Budget-gated: daily cost cap per project in $VAULT/.telemetry/<date>-<project>.count
   If cap hit, skip with warning
    ↓
3. Write session summary to $VAULT/sessions/<project>/<id>.md
   with frontmatter: { type: session_summary, valid_from: <now>, project, id, title, status: current }
    ↓
4. POST /api/reindex {path: "sessions/<project>/<id>.md"}
   → server reads file, upserts into mem0 with full frontmatter
    ↓
5. Merge-and-update state.md (hooks/lib/update-state.sh)
   Prompt: old state.md + new summary → new state.md (LLM-merged, preserves human edits)
   Size-capped at 3000 chars
    ↓
6. Atomic write $VAULT/state/<project>/state.md via .tmp + rename
    ↓
7. Release lockdir
    ↓
Telemetry logged: cost, token counts, state_updated mtime delta, session-end log
```

**Catchup mode (UM_DETACH=1 from session-start):** same pipeline, but forked and disowned. Reads UM_CATCHUP_RAW_SINCE/UNTIL instead of computing them from last-summary lookback.

### `/um-checkpoint` — manual trigger

Slash command file at `commands/um-checkpoint.md`. When you type `/um-checkpoint` in Claude Code, it instructs Claude to execute `hooks/session-end.sh` directly — same pipeline as a natural session-end, on demand. Useful when you've just made a significant decision and want state.md refreshed before continuing.

---

## Cross-session flow

You start Claude Code. `session-start.sh` runs:

1. **State.md read** — via `GET /api/state/<project>`, injected synchronously
2. **Orphan catchup** — if any raw captures exist that aren't yet in a summary, fork `session-end.sh` in the background to generate a summary + refresh state.md

By the time you write your first message, state.md is injected (possibly with the "may be outdated" prefix if the catchup hasn't finished yet). The catchup's output becomes available to your NEXT session.

**What this achieves:** even if your previous session crashed mid-summary (laptop closed, Ctrl-C, process-killed), the orphan detection picks up the loose raw captures on next start and fills the gap.

---

## Versioning — um-forget / um-supersede

Two CLIs in `plugins/claude-code/universal-memory/bin/`:

### `um-forget <id>`

Soft-delete. Mutates frontmatter: `status: deprecated`, `invalidated_at: <now>`. Reindexes — mem0 picks up the new status. Default search filter (`status=current`) hides deprecated docs.

Not destructive: the `.md` file stays on disk. Flip `status` back to reinstate.

### `um-supersede <old_id> <new_doc_file>`

Versioned replace.
- Old doc: `status: superseded`
- New doc: `supersedes: [<old_id>]`, inherits id/project from metadata
- Both reindexed

`um-supersede` has guards against self-supersede and target-exists collisions (fixed in v0.2.0-alpha as C1 in the pre-dogfood pass).

### Search filter behavior

`POST /api/search` (and `GET /api/search`) defaults to `status=current`. Pass `include_superseded=true` to get all docs regardless of status.

---

## Multi-surface flow

### Claude Code (fully working)

- Hooks fire automatically (4 of them)
- state.md injection + rubric via `additionalContext`
- MCP tools optional — server reachable via `http://localhost:6335/mcp` if registered in `~/.claude.json`
- If UM MCP is *not* registered but another mem0 MCP is (e.g. `mem0-pi`), Claude uses that for explicit `remember` requests. The rubric has a `memory_add` fallback clause for this setup (shipped via PR #9).

### Standalone CLI (`um`)

- **No plugin required** — installs via `installer/install-cli.sh` against any reachable UM server. The full-server wizard (`installer/install.sh`) also drops `um` into `$PATH`, so if you've run that you already have it.
- **Surfaces:** `um search`, `um state`, `um recent`, `um list`, `um capture`, `um tail` (plus `um --version` / `--help`). `um forget` and `um supersede` delegate to the pre-existing `bin/um-forget` / `bin/um-supersede` binaries.
- **Config:** `UM_ENDPOINT` env var (URL of the UM server), optional `~/.um/config` (KEY=value lines; parsed by `hooks/lib/config.sh`). Precedence is env > repo-local `./.um/config` > user-global `~/.um/config`.
- **What it DOES:** ad-hoc querying, shell scripting, cron jobs, power-user `jq` pipelines over `--json` output.
- **What it DOESN'T do:** no `SessionStart` / `Stop` / `SessionEnd` hooks — purely ad-hoc query/capture. If you want the session-continuity pipeline, run Claude Code with the CC plugin, or invoke `hooks/session-end.sh` manually.
- **Reference:** see [docs/um-cli.md](um-cli.md) for per-subcommand flags and JSON output contracts.

### Codex CLI (MCP only)

- **MCP-only surface.** Install the config-only plugin at `plugins/codex/universal-memory/` and Codex points at the UM server's `/mcp` endpoint.
- **Recall works:** `memory_search`, `memory_state`, `memory_recent`, `memory_list` are available by default.
- **Writes work when gated open:** flip `UM_MCP_WRITE_ENABLED=true` server-side and the 7 write tools appear.
- **No hook-driven capture pipeline:** Codex has three upstream gaps (no SessionEnd hook, plugins can't bundle hooks, Windows unsupported). Those are tracked in [docs/codex-integration-notes.md](codex-integration-notes.md) and deferred to v0.5+. Consequence: Codex conversations don't flow into raw captures → session summaries → state.md. Call `memory_capture` explicitly from the conversation if you want a write.

### ChatGPT Desktop / Custom GPT Actions

- **ChatGPT Desktop (MCP connector):** exposes the UM server as a remote MCP connector via a tunnel (`um-tunnel` handles the plumbing). Same read/write gating as Claude.ai — see the connection guide at [docs/connecting-chatgpt-desktop.md](connecting-chatgpt-desktop.md).
- **Custom GPT Actions (REST):** hits the OpenAPI spec at `/openapi.yaml?gpt=1` (trimmed variant — omits MCP routes + any tools the GPT builder can't render). Scaffold lives at `plugins/chatgpt-custom-gpt/universal-memory/`. Same vault, just different protocol.
- **Neither has hooks.** Same caveat as Claude.ai: the conversation itself isn't in raw captures, so state.md only reflects CC work unless you explicitly call `memory_capture`.

### Claude.ai / Claude Desktop (read-capable, limited write)

- **No hooks** — Claude.ai has no local filesystem access. No automatic state.md injection, no Stop hook captures, no SessionEnd pipeline.
- **MCP reads work** — configure the UM server as an HTTP MCP connector at a publicly reachable URL (ngrok / Tailscale Funnel / Cloudflare Tunnel / `um-tunnel`). Then `memory_state`, `memory_search`, `memory_recent`, `memory_list` all work.
- **MCP writes work when enabled** — `memory_capture`, `memory_forget`, `memory_supersede` require `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` on the server.
- **But:** Claude.ai conversations don't feed the state.md pipeline. You can ask "what's my state on project X" and it works (reads state.md). You can say "remember Y" and it creates an authored doc. But Claude.ai's conversation itself doesn't append to raw captures, so next day's state.md won't reflect Claude.ai work — only CC work.

These Claude.ai / Desktop / remote-surface gaps are tracked:
- **[#5](https://github.com/goldenwo/universal-memory/issues/5)** — server-side `memory_checkpoint` so remote surfaces can trigger state refresh (still deferred to v0.5+)
- **[#6](https://github.com/goldenwo/universal-memory/issues/6)** — `memory_append_turn` MCP tool so remote-surface conversations feed captures (still deferred to v0.5+)

---

## MCP tool surface

11 tools at `POST http://localhost:6335/mcp`. The default `tools/list` response exposes the **4 read tools** below; the **7 write tools** only appear when `UM_MCP_WRITE_ENABLED=true` (implemented by `getVisibleTools()` in `server/mem0-mcp-http.mjs`). `memory_checkpoint` now has a real server-side implementation (v0.5); the v0.4 stub has been dropped.

### Read tools (visible by default in `tools/list`)

| Tool | What it does |
|---|---|
| `memory_search(query, limit?, include_superseded?, filters?, full?)` | Vector search with optional status + metadata filters. Returns compact `{id, title, score, snippet}` by default; pass `full: true` for full bodies. |
| `memory_list(limit?, full?)` | List all stored memories. Returns compact `{id, title, snippet}` by default; pass `full: true` for full bodies. |
| `memory_state(project)` | Direct file read of `state/<project>/state.md` (never from mem0). |
| `memory_recent(project, limit?, full?)` | Recent authored docs for a project by **filesystem mtime desc** (wraps `doRecent`; parity with new REST `/api/recent/{project}`). Compact shape by default; `full: true` for full bodies. **Breaking in v0.4:** `project` is now required (was optional). |

### Write tools (gated — require `UM_MCP_WRITE_ENABLED=true` to appear in `tools/list`; writes also require `UM_MOUNT_MODE=rw`)

| Tool | What it does |
|---|---|
| `memory_add(text, metadata?)` | Add to mem0 via extraction pipeline (generic mem0 behavior). **Note:** in v0.4 `memory_add` is classified as a write and hidden by default; flip `UM_MCP_WRITE_ENABLED` to surface it. |
| `memory_delete(memoryId)` | Delete by mem0 UUID. |
| `memory_capture(content, metadata)` | Write authored doc to vault + reindex. |
| `memory_checkpoint(project?, since?, until?, skip_state_merge?)` | Trigger full session-end pipeline (summary → state merge → reindex). Real implementation in v0.5; drops v0.4 stub. |
| `memory_forget(id)` | Mutate frontmatter to `status: deprecated` + reindex. |
| `memory_supersede(old_id, new_doc)` | Versioned replace — old `status: superseded`, new `supersedes: [old_id]`. |
| `memory_append_turn(project, content, role, timestamp?, conversation_id?)` | Append a conversation turn to the raw-capture pipeline. Enables non-CC surfaces to feed captures. |

The canonical write-tool set is exported as `WRITE_TOOL_NAMES` in `server/mem0-mcp-http.mjs` (imported by tests so the visible/gated split doesn't drift).

**Security note:** with writes enabled and the default Docker port binding, the server accepts unauthenticated writes from any host that can reach port 6335. Defaults bind to `127.0.0.1:6335` (localhost only) for that reason. Opening to LAN/WAN needs `um-tunnel` or a reverse proxy with its own auth layer. See [docs/mcp-tools.md:391+](mcp-tools.md#L391) Security section.

---

## Environment variable reference

### Server-side (in `server/.env`)

| Var | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | Mem0's extraction + embedding |
| `MEM0_USER_ID` | *(required)* | Namespace scope (server rejects blank at startup) |
| `MEM0_MCP_PORT` | `6335` | Container port (compose binds to `127.0.0.1` by default) |
| `UM_VAULT_DIR` | *(required — no default)* | Host vault path mounted into container |
| `UM_MOUNT_MODE` | `ro` | `ro` or `rw` (flip when enabling MCP writes) |
| `UM_MCP_WRITE_ENABLED` | `false` | Gate on memory_capture/forget/supersede |
| `UM_TEMPORAL_DECAY` | `false` | Opt-in decay weighting |
| `UM_DECAY_HALF_LIFE_DAYS` | `30` | Only used when decay enabled |

Optional mem0 tuning: `MEM0_EMBEDDER_MODEL`, `MEM0_LLM_MODEL`, `QDRANT_HOST/PORT/COLLECTION`, `MEM0_HISTORY_DB_PATH`.

### Client-side (in shell env where Claude Code runs)

| Var | Default | Purpose |
|---|---|---|
| `UM_ENDPOINT` | *(unset → hooks no-op)* | URL of the UM server for hook HTTP calls |
| `UM_VAULT_DIR` | `$HOME/.um/vault` | Host vault path hooks write to |
| `UM_OPENAI_API_KEY` | *(required for summarize)* | Hooks use this for session-end summarization |
| `UM_SUMMARY_ENABLED` | `true` | Set `false` to disable session-end LLM entirely |
| `UM_SUMMARIZER` | auto-detect | `openai` \| `claude-agent-sdk` \| `ollama`. See [docs/summarizer-choice.md](summarizer-choice.md). |
| `UM_TEMPORAL_DECAY` | `false` | Honored by search ranking |
| `UM_SKIP_KEY_VALIDATION` | *(unset)* | `1` to skip install.sh's live OpenAI probe |
| `UM_DETACH` | *(unset)* | Internal — set by session-start when forking catchup |
| `UM_CATCHUP_RAW_SINCE/UNTIL` | *(unset)* | Internal — catchup mode boundaries |
| `UM_PROJECT` | *(auto-detected)* | Override project name detection |
| `UM_PROMPT_DIR` | *(set by installer)* | Directory containing `summarize.txt` + `update-state.txt` prompts; default is plugin-local `hooks/lib/prompts/`. |
| `UM_SUMMARIZER_FALLBACK` | `openai` | Backend to fall back to when the primary `UM_SUMMARIZER` is unavailable (e.g. `claude-agent-sdk` server-side). |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL. Only used when `UM_SUMMARIZER=ollama`. |
| `UM_SUMMARIZE_MODEL` | `gpt-4o-mini` (openai) / `llama3` (ollama) | Model ID passed to the summarizer backend. |

---

## Common diagnostic questions

### Where did my capture go?

```
ls $UM_VAULT_DIR/captures/<project>/raw/$(date +%Y-%m-%d).md
```

If missing, the Stop hook didn't fire. Check:
- Plugin installed? `ls $HOME/.claude/plugins/universal-memory/hooks/stop.sh`
- hooks.json registered? `cat $HOME/.claude/plugins/universal-memory/hooks/hooks.json | jq .hooks.Stop`
- Did you restart CC after plugin install?

### Why didn't state.md update?

In order of likelihood:
1. **SessionEnd didn't fire** — Claude Code was force-killed or terminal closed before clean exit. Solution: next session's SessionStart will catchup.
2. **Lockdir stuck** — check `$VAULT/state/<project>/state.md.lockdir`. Auto-clears after 10 min.
3. **Cost cap hit** — check `$VAULT/.telemetry/$(date +%Y-%m-%d)-<project>.count`. Daily cap in hooks/lib/summarize.sh.
4. **OpenAI key invalid** — check `$VAULT/.telemetry/session-end*.log` for 401s.
5. **Server unreachable** — hooks use `UM_ENDPOINT`. Test with `curl -sf $UM_ENDPOINT/health` (no health endpoint? try `/api/search` with an empty query).

### What's my total cost?

```
tail $VAULT/.telemetry/cost-log.csv
# columns: timestamp,project,model,prompt_tokens,completion_tokens,cost_usd
```

### Server status

```bash
cd E:/Projects/universal-memory/server
docker compose ps
docker logs universal-memory-memory-server-1 --tail 50
```

### Re-run the full diagnostic sweep

```bash
bash E:/Projects/universal-memory/server/install.sh --verify
```

9 checks: stack running, plugin registered, env vars set, vault writable, pyyaml present, stop.sh fires, session-end dry-runs cleanly, cleanup tidies, server health.

---

## Known gaps (deferred to v0.5+)

| Issue | Scope | Effort |
|---|---|---|
| [#5](https://github.com/goldenwo/universal-memory/issues/5) | Server-side `memory_checkpoint` body — let remote surfaces trigger state refresh | Medium |
| [#6](https://github.com/goldenwo/universal-memory/issues/6) | `memory_append_turn` MCP — let Claude.ai / Codex / ChatGPT conversations feed captures | Medium-high |
| [#16](https://github.com/goldenwo/universal-memory/issues/16) | Vault web UI (deferred from v0.4 — revisit when multi-user/shared-host direction clarifies) | High |
| Codex lifecycle | Three upstream Codex gaps blocking hook-driven capture (see [docs/codex-integration-notes.md](codex-integration-notes.md)) | Blocked upstream |

### Test-infra hygiene (tracked unmilestoned)

| Issue | Scope | Effort |
|---|---|---|
| [#7](https://github.com/goldenwo/universal-memory/issues/7) | Wire `continuity.sh` into CI workflow | ~30 min |
| [#8](https://github.com/goldenwo/universal-memory/issues/8) | Decay-on integration smoke (math is unit-tested; env plumbing is not) | ~1–2 hrs |

### v0.2.0-alpha → v0.2.1 transition

- `v0.2.0-alpha` (2026-04-19): session-continuity pipeline + 10-tool MCP surface + plug-and-play install. Tested (61/61 preflight, 150+ unit assertions, CI green).
- `v0.2.1` (pending merge of Phase A): pluggable summarizer (`UM_SUMMARIZER`), canonical rubric at `docs/memory-routing-rubric.md`, recursive-hook guard for `claude-agent-sdk` backend. No breaking changes.
- Validation strategy: passive use during UM work rather than an explicit dogfood phase. If issues surface → patch as `v0.2.2`.

---

## Version state (snapshot — 2026-04-22)

- **Tag:** `v0.5.0-alpha` — cross-env first-class release; GHCR image `ghcr.io/goldenwo/universal-memory-server:0.5.0-alpha` (amd64 + arm64).
- **What's new in 0.5.0-alpha:**
  - **`memory_append_turn`** — new MCP tool + `POST /api/append-turn` REST endpoint. Non-CC surfaces (Claude.ai, ChatGPT Desktop, Codex) can now append conversation turns directly to the raw-capture pipeline. Args: `project`, `content`, `role` (required); `timestamp`, `conversation_id` (optional). Flock-protected file writes; log-injection guard on project value.
  - **`memory_checkpoint` real body** — drops the v0.4 stub; triggers the full session-end pipeline (summary → state merge → reindex) from any MCP surface via `POST /api/checkpoint`. Parity: `memory_checkpoint` MCP tool + `POST /api/checkpoint` REST. If `UM_SUMMARIZER=claude-agent-sdk` is set server-side, it falls back to `openai`/`ollama` with a warning (Docker cannot spawn a host-side CC process).
  - **Modular install** — `install.sh` is now the unified entry point; composable component flags (`--server`, `--plugin-cc`, `--plugin-codex`, `--cli`, `--all`). Interactive wizard auto-triggered when run with no flags in a TTY.
  - **Interactive wizard** — first-time users get a numeric-menu walkthrough. `--yes` still skips interactive prompts; `--dry-run` prints without executing.
  - **Shared prompt templates** — summarize + update-state prompts extracted to `server/config/prompts/` and written to the vault at install time. `hooks/lib/summarize.sh` + `update-state.sh` read from `$UM_PROMPT_DIR` (falls back to plugin-local `hooks/lib/prompts/` if unset).
  - **`UM_PROMPT_DIR` env var** — written to the managed block in `~/.bashrc`/`~/.zshrc` by the installer for plugin-cc installs. Eliminates prompt drift between the CC plugin and server paths.
  - **I4 fix (claude-agent-sdk summarize)** — `summarize.sh` now prepends `_UM_SYSTEM_PROMPT` before piping the transcript when using the `claude-agent-sdk` backend. Fixes a silent quality regression where the system prompt was omitted.
  - **`stop.sh` flock-protected** — raw-capture appends use Perl `Fcntl::flock` via a sibling lockfile; no turn corruption under concurrent writes.
  - **BACKENDS registry** — `summarize.mjs` exposes a `BACKENDS` map for v0.7 provider-neutrality groundwork (Anthropic/Google/Ollama swap). Backend fallback for `claude-agent-sdk` at server side.
  - **Rubric-drift-gate test** — `server/test/rubric-drift.test.mjs` asserts that rubric blocks in all 5 mirrors match the canonical `docs/memory-routing-rubric.md`.
- **Explicitly deferred to v0.6+:** OpenClaw plugin, Claude-mem bridge, cross-device sync, Kuzu graph memory, Vault UI (issue [#16](https://github.com/goldenwo/universal-memory/issues/16)), working-examples bundle, provider neutrality (Anthropic/Google/Ollama swap).
- **Previous release:** `v0.4.0-alpha` (below).

## Version state (snapshot — 2026-04-21)

- **Tag:** `v0.4.0-alpha` — HYBRID-REBALANCE release (Phases 0, B.1, B.3, A, D, E of the v0.4 plan); GHCR image `ghcr.io/goldenwo/universal-memory-server:0.4.0-alpha` (amd64 + arm64). Install method is `git clone + bash installer/install-cli.sh` (CLI-only) or `installer/install.sh` (full server). No release-asset curl|bash URL — see `installer/install-cli.md` for why.
- **What's new in 0.4.0-alpha (across phases 0/B/A/D/E):**
  - **Progressive disclosure on reads (Phase B.1)** — `/api/search`, `/api/list`, `/api/recent/{project}`, MCP `memory_search` / `memory_list` / `memory_recent` return `{id, title, score, snippet}` by default. `?full=1` / `full: true` opts into full bodies. 41.9% single-hop context reduction measured against v0.3 baseline.
  - **New `/api/recent/{project}` REST endpoint** — filesystem mtime-sorted authored docs (parity with the corrected `memory_recent` MCP tool, which now wraps `doRecent` instead of reusing `doSearch`).
  - **Schema hygiene (Phase B.3)** — default `tools/list` exposes 4 reads (`memory_search`, `memory_list`, `memory_state`, `memory_recent`); 7 writes (`memory_add`, `memory_append_turn`, `memory_capture`, `memory_checkpoint`, `memory_delete`, `memory_forget`, `memory_supersede`) only appear when `UM_MCP_WRITE_ENABLED=true`. Summarizer prompt compressed 35.5%.
  - **`um` CLI (Phase A)** — 7 subcommands: `search`, `state`, `recent`, `list`, `capture`, `tail`, `--version`. Dispatcher at `plugins/claude-code/universal-memory/bin/um` + KEY=value config loader at `hooks/lib/config.sh`. One subcommand (`um validate`) was dropped per the Phase 0.5b vault-as-git signal check.
  - **Standalone CLI installer (Phase D)** — `installer/install-cli.sh` with shared `installer/lib/marker-block.sh` helper; CI matrix covers Ubuntu + macOS. Full-server wizard at `installer/install.sh` still also installs `um`.
  - **Docs capstone (Phase E)** — README + plugin READMEs + workflow.md + CHANGELOG + MIGRATION.md updated. "Three surfaces, one vault" framing landed.
- **Explicitly deferred to v0.5+:** `memory_append_turn` (issue [#6](https://github.com/goldenwo/universal-memory/issues/6)), server-side `memory_checkpoint` body (issue [#5](https://github.com/goldenwo/universal-memory/issues/5)), vault web UI (issue [#16](https://github.com/goldenwo/universal-memory/issues/16)), Codex lifecycle hooks (3 upstream gaps unresolved), response envelope unification (`/api/list` raw-array → `{results:[...]}`), ETag caching on reads, self-bootstrap `curl | bash` installer.
- **Previous release:** `v0.3.0-alpha` (below).
- **Tests passing:** 103/103 server + 93/93 server/install + 33/33 install-cli + 14/14 um-dispatcher + 150+ additional bash assertions across 8 um-* test files. 2 pre-existing Windows-symlink skips unrelated to v0.4.

## Minor deviations from the v0.4 plan

- **B.2 (write-tool consolidation) DROPPED** per Phase 0 gate — schema hygiene math showed <2K aggregate savings.
- **A.9 (`um validate`) DROPPED** per Phase 0.5b — vault-as-git signal ABSENT.
- **`/api/list` envelope stays raw-array** (inconsistent with `/api/search` / `/api/recent` envelopes). Locked for v0.4 per B.1.4b backward-compat; revisit v0.5.
- **No pre-v0.4 migration logic** — no external users yet.

---

## Version state (snapshot — 2026-04-20)

- **Tag:** `v0.3.0-alpha` — cross-platform release (Phases A–F of the v0.3 plan); GHCR image `ghcr.io/goldenwo/universal-memory-server:0.3.0-alpha` (amd64 + arm64)
- **What's new in 0.3.0-alpha (across Phases A–F):**
  - **Codex CLI plugin** at `plugins/codex/universal-memory/` — config-only plugin that points Codex at UM's MCP server. Recall-only in v0.3; automatic session capture + summarization is still CC-only (three upstream Codex gaps tracked in [docs/codex-integration-notes.md](codex-integration-notes.md))
  - **ChatGPT Desktop + Claude.ai + Claude Desktop connection guides** at `docs/connecting-chatgpt-desktop.md` + `docs/connecting-claude-ai.md` — MCP connector setup with tunnel options, rubric paste-in, works/doesn't-work matrices (closes #4)
  - **ChatGPT Custom GPT scaffold** at `plugins/chatgpt-custom-gpt/universal-memory/` — system prompt + trimmed OpenAPI spec + setup guide
  - **OpenAPI 3.1 spec** at `GET /openapi.yaml` and `/openapi.yaml?gpt=1` (trimmed) — generated programmatically from `server/openapi.mjs`, validated against `@apidevtools/swagger-parser`
  - **`um-tunnel` CLI** at `plugins/claude-code/universal-memory/bin/um-tunnel` — one-command remote MCP exposure (auto-detects cloudflared/tailscale/ngrok; prints URL + rubric + context-aware security warning)
  - **OpenAI Assistants API example** at `examples/openai-assistants/` — Node + Python, smoke-tested, documents Assistants deprecation + Responses API migration path
  - **Pluggable summarizer via `UM_SUMMARIZER`** (from Phase A / v0.2.1): `openai` (default) | `claude-agent-sdk` (zero-cost for CC users, auto-detected by install.sh) | `ollama` (stub for v0.4)
  - **Adoption conveniences (from Phase B / v0.2.2):** `/um-preview` slash command, first-session welcome banner, `install.sh --yes` flag, `curl | bash` bootstrap
- **Explicitly deferred to v0.4:** vault web UI (`D.5.2–D.5.4`), Codex lifecycle hooks (no SessionEnd, plugins can't bundle hooks, Windows unsupported upstream), OpenAI Agents SDK example (Responses API variant is the likelier shape), `@universal-memory/client` npm package, `memory_append_turn` (issue #6), server-side `memory_checkpoint` (issue #5)
- **Previous release:** `v0.2.2` — Phase B: adoption-friction reduction
- **Tests passing:** 140+ unit assertions across 8 hook test files; install.test.sh 82/82 (adds T13 Codex-present, T19 Codex-absent); openapi.test.mjs 5/5; um-tunnel.test.sh 17/17; summarize.test.sh 42/42; full server suite 58/58. Preflight A.5 claude-agent-sdk live dispatch verified (1023-byte summary) against Docker stack (v0.2.2).

## Minor deviations from the plan

Tracked deliberately:
- **Task 23** (2-week dogfood) substituted with A+B preflight — objective validation only; subjective usability gated to alpha→GA transition
- **`memory_checkpoint`** shipped as documented stub (tracked in #5)
- **Decay-on smoke** placeholder rather than integration test (tracked in #8)
- **CI continuity wiring** deferred (tracked in #7)

Nothing else deviates from the plan's "Done when" checklist.

---

## Revision log

- **2026-04-22** — v0.5.0-alpha landed: cross-env first-class capture. `memory_append_turn` + real `memory_checkpoint` body allow Claude.ai / ChatGPT Desktop / Codex to append turns and trigger state refresh without Claude Code hooks. Modular installer with interactive wizard. `UM_PROMPT_DIR` env var eliminates prompt drift. I4 (claude-agent-sdk system prompt) fixed. flock-protected stop.sh. BACKENDS registry groundwork for v0.7 provider-neutrality.
- **2026-04-21** — v0.4.0-alpha landed: HYBRID-REBALANCE. Progressive disclosure on reads (41.9% context reduction), `um` CLI (7 subcommands, standalone installer), `/api/recent/{project}` REST endpoint, schema-hygiene listTools filter, docs capstone. Phase 0 + B.1 + B.3 + A + D + E of the v0.4 plan. Three surfaces, one vault.
- **2026-04-20** — v0.3.0-alpha landed: Codex MCP plugin + ChatGPT Desktop/Claude.ai/Custom GPT docs + OpenAPI 3.1 surface + um-tunnel + OpenAI Assistants example. First release with four agent surfaces. Phase D.5 vault UI + Phase E Codex hooks + Phase F Agents SDK all deferred to v0.4.
- **2026-04-20** — v0.2.2 Phase B landed: /um-preview CLI + slash command, first-session welcome banner, install.sh --yes flag, curl | bash bootstrap. Adoption-friction reduction; no runtime behavior changes.
- **2026-04-20** — v0.2.1 Phase A landed: pluggable summarizer (UM_SUMMARIZER), canonical rubric, recursive-hook guard. No breaking changes.
- **2026-04-19** — First version. v0.2.0-alpha tagged + GHCR published.
