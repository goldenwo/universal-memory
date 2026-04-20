# Universal-memory — workflow reference

> **Version:** This document describes **v0.2.1**. Historical references to v0.2.0-alpha throughout describe behavior unchanged in v0.2.1 unless noted.

Source-of-truth description of what universal-memory does on this machine today. Written against **v0.2.1** (supersedes v0.2.0-alpha, which was tagged 2026-04-19). Update this file when the behavior changes.

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

## Where things live on this machine

Resolved paths as of v0.2.1:

| Thing | Path |
|---|---|
| Repo | `E:/Projects/universal-memory/` |
| Vault (default) | `$HOME/.um/vault/` — i.e. `C:/Users/wogol/.um/vault/` |
| Plugin installed | `C:/Users/wogol/.claude/plugins/universal-memory/` |
| Server docker stack | `E:/Projects/universal-memory/server/docker-compose.yml` |
| Server container image | `ghcr.io/goldenwo/universal-memory-server:0.2.1` |
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
- If UM MCP is *not* registered but another mem0 MCP is (e.g. `mem0-pi`), Claude uses that for explicit `remember` requests. The v0.2.x rubric says "call memory_capture" — but PR [#9](https://github.com/goldenwo/universal-memory/pull/9) adds a `memory_add` fallback clause for this setup.

### Claude.ai / Claude Desktop (read-capable, limited write)

- **No hooks** — Claude.ai has no local filesystem access. No automatic state.md injection, no Stop hook captures, no SessionEnd pipeline.
- **MCP reads work** — configure the UM server as an HTTP MCP connector at a publicly reachable URL (ngrok / Tailscale Funnel / Cloudflare Tunnel). Then `memory_state`, `memory_search`, `memory_recent`, `memory_list` all work.
- **MCP writes work when enabled** — `memory_capture`, `memory_forget`, `memory_supersede` require `UM_MCP_WRITE_ENABLED=true` and `UM_MOUNT_MODE=rw` on the server.
- **But:** Claude.ai conversations don't feed the state.md pipeline. You can ask "what's my state on project X" and it works (reads state.md). You can say "remember Y" and it creates an authored doc. But Claude.ai's conversation itself doesn't append to raw captures, so next day's state.md won't reflect Claude.ai work — only CC work.

These gaps are tracked:
- **[#4](https://github.com/goldenwo/universal-memory/issues/4)** — deliver routing rubric to Claude.ai via a connection guide
- **[#5](https://github.com/goldenwo/universal-memory/issues/5)** — server-side `memory_checkpoint` so Claude.ai can trigger state refresh
- **[#6](https://github.com/goldenwo/universal-memory/issues/6)** — `memory_append_turn` MCP tool so Claude.ai conversations feed captures

---

## MCP tool surface

10 tools at `POST http://localhost:6335/mcp`. 9 work in v0.2.x; 1 is a documented stub.

### Mem0-index tools (always available — bypass write gate)

| Tool | What it does |
|---|---|
| `memory_search(query, limit?, include_superseded?, filters?)` | Vector search with optional status + metadata filters |
| `memory_add(text, metadata?)` | Add to mem0 via extraction pipeline (generic mem0 behavior) |
| `memory_list()` | List all stored memories |
| `memory_delete(memoryId)` | Delete by mem0 UUID |
| `memory_state(project)` | Direct file read of `state/<project>/state.md` |
| `memory_recent(project?, limit?)` | Recent session summaries by valid_from desc |

### Vault write tools (require `UM_MCP_WRITE_ENABLED=true` + `UM_MOUNT_MODE=rw`)

| Tool | What it does |
|---|---|
| `memory_capture(content, metadata)` | Write authored doc to vault + reindex |
| `memory_checkpoint(project?)` | **Stub (v0.3).** Returns actionable error pointing at `/um-checkpoint` or direct `hooks/session-end.sh` invocation |
| `memory_forget(id)` | Mutate frontmatter to `status: deprecated` + reindex |
| `memory_supersede(old_id, new_doc)` | Versioned replace — old `status: superseded`, new `supersedes: [old_id]` |

**Security note:** with writes enabled and the default Docker port binding, the server accepts unauthenticated writes from any host that can reach port 6335. v0.2.x defaults to `127.0.0.1:6335` (localhost only) for that reason. Opening to LAN/WAN needs a reverse proxy or overlay network. See [docs/mcp-tools.md:391+](mcp-tools.md#L391) Security section.

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

## Known gaps (tracked, deferred to v0.3)

| Issue | Scope | Effort |
|---|---|---|
| [#4](https://github.com/goldenwo/universal-memory/issues/4) | Claude.ai / Desktop connection guide with copy-paste rubric | Low |
| [#5](https://github.com/goldenwo/universal-memory/issues/5) | Server-side `memory_checkpoint` — let remote surfaces trigger state refresh | Medium |
| [#6](https://github.com/goldenwo/universal-memory/issues/6) | `memory_append_turn` MCP — let Claude.ai conversations feed captures | Medium-high |

### Test-infra hygiene (not blocking — tracked unmilestoned)

| Issue | Scope | Effort |
|---|---|---|
| [#7](https://github.com/goldenwo/universal-memory/issues/7) | Wire `continuity.sh` into CI workflow | ~30 min |
| [#8](https://github.com/goldenwo/universal-memory/issues/8) | Decay-on integration smoke (math is unit-tested; env plumbing is not) | ~1–2 hrs |

### Pending in flight

| PR | What |
|---|---|
| [#9](https://github.com/goldenwo/universal-memory/pull/9) | Rubric fallback to `memory_add` when `memory_capture` isn't registered |

### v0.2.0-alpha → v0.2.1 transition

- `v0.2.0-alpha` (2026-04-19): session-continuity pipeline + 10-tool MCP surface + plug-and-play install. Tested (61/61 preflight, 150+ unit assertions, CI green).
- `v0.2.1` (pending merge of Phase A): pluggable summarizer (`UM_SUMMARIZER`), canonical rubric at `docs/memory-routing-rubric.md`, recursive-hook guard for `claude-agent-sdk` backend. No breaking changes.
- Validation strategy: passive use during UM work rather than an explicit dogfood phase. If issues surface → patch as `v0.2.2`.

---

## Version state (snapshot — 2026-04-20)

- **Tag:** `v0.2.1` — pending merge of Phase A PR; GHCR image will publish as `ghcr.io/goldenwo/universal-memory-server:0.2.1` (amd64 + arm64)
- **What's new in 0.2.1 (Phase A of the v0.3 plan):**
  - `UM_SUMMARIZER` env var — choose backend: `openai` (default when no claude CLI), `claude-agent-sdk` (zero-cost for CC users, auto-detected by install.sh), `ollama` (stub for v0.4)
  - Routing rubric extracted to canonical `docs/memory-routing-rubric.md` — referenced by hooks and (future) cross-platform integrations
  - Recursive-hook guard (`UM_IN_SUMMARIZER_SUBPROCESS=1` sentinel) in all 4 CC hooks — required for `claude-agent-sdk` to prevent infinite loop
  - `docs/summarizer-choice.md` — comparison matrix
- **Previous release:** `v0.2.0-alpha` — session continuity pipeline, MCP surface (10 tools), plug-and-play install
- **Tests passing:** 140+ unit assertions across 7 hook test files; install.test.sh 63/63 (includes T18 re-install backfill regression); summarize.test.sh 42/42. Full preflight (A+B) run pending Docker availability at merge time.

## Minor deviations from the plan

Tracked deliberately:
- **Task 23** (2-week dogfood) substituted with A+B preflight — objective validation only; subjective usability gated to alpha→GA transition
- **`memory_checkpoint`** shipped as documented stub (tracked in #5)
- **Decay-on smoke** placeholder rather than integration test (tracked in #8)
- **CI continuity wiring** deferred (tracked in #7)

Nothing else deviates from the plan's "Done when" checklist.

---

## Revision log

- **2026-04-20** — v0.2.1 Phase A landed: pluggable summarizer (UM_SUMMARIZER), canonical rubric, recursive-hook guard. No breaking changes.
- **2026-04-19** — First version. v0.2.0-alpha tagged + GHCR published.
