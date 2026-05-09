# Cross-surface default-project audit

**Phase:** A1 (Audits) — universality roadmap
**Date:** 2026-05-08
**Author:** maintainer (server side: a6c17e9)
**Tracker:** [#72](https://github.com/goldenwo/universal-memory/issues/72) Gap 5; [#70](https://github.com/goldenwo/universal-memory/issues/70); [#71](https://github.com/goldenwo/universal-memory/issues/71)

> Question: what `metadata.project` value does each non-Claude-Code surface
> actually pass to `memory_capture` / `memory_add` / `memory_append_turn`
> today, when the user issues a casual "remember this" / "save this fact"?

This audit answers that question by tracing each surface's project-resolution path
end-to-end (host → connector → server) and recording the server-side fallback
when project is absent.

---

## 1. Server-side defaults — single source of truth

The handlers live in [`server/mem0-mcp-http.mjs`](../../server/mem0-mcp-http.mjs)
and [`server/lib/append-turn.mjs`](../../server/lib/append-turn.mjs). For each
write tool, what happens when the caller omits `metadata.project` (or
top-level `project`) is **heterogeneous**:

| Tool | Code path | Behavior on missing project |
|---|---|---|
| `memory_capture` | mem0-mcp-http.mjs:846 | Soft-default to literal **`'default'`**. File lands at `authored/default/<id>.md`. |
| `memory_add` | mem0-mcp-http.mjs:765 | Stored via `umAdd()` with no project metadata. Searchable but not project-filterable. |
| `memory_append_turn` | append-turn.mjs:49 | **Hard fail** with `"invalid project slug: ..."` (project must match `^[a-zA-Z0-9._-]+$`). |
| `memory_state` | mem0-mcp-http.mjs:1530 | Hard fail (path arg required). |
| `memory_recent` | mem0-mcp-http.mjs:824–828 | Hard fail (`memory_recent`: project required since v0.4 alpha). |
| `memory_search` | mem0-mcp-http.mjs:2114 | Project optional — used only as a post-filter. Search succeeds without it but cannot scope. |

**Three distinct failure modes for the same caller error.** Two soft (one with
a magic string, one losing the metadata silently) and one hard. From a casual
user's POV this looks like "sometimes the bot saved my note, sometimes it
errored, sometimes it saved but I can't find it later."

---

## 2. Surface-by-surface

The reference is Claude Code (CC); every non-CC surface is graded against it.

### 2.1 Claude Code (CC) — REFERENCE

- **Project resolution chain** (`plugins/claude-code/universal-memory/hooks/lib/resolve-project.sh`):
  1. `--project <p>` arg
  2. `$UM_PROJECT` env var
  3. `.um/config UM_PROJECT=` entry
  4. `basename "$(git rev-parse --show-toplevel)"`
  5. exit 2 with helpful message
- **Per-session injection:** `session-start.sh` calls `project_name()`
  (which delegates to `resolve_project`) and emits the inferred slug into
  `additionalContext` so the model has it for the session.
- **Auto-capture path:** `um-capture` (`plugins/claude-code/.../bin/um-capture`)
  uses the same chain. CC users never type a project — git+env solve it.
- **Effect:** every CC capture lands under a meaningful, stable, per-repo
  project slug. Cross-surface composition works because retrieval-side scoping
  matches the inferred slug.

### 2.2 Claude.ai (web)

- **Connector:** HTTP MCP at `<tunnel>/mcp` (per `docs/connecting-claude-ai.md`).
- **Project signal from host:** **NONE.** Anthropic's cloud has no notion of
  "the user's current project"; the connector form has no field for it.
- **Rubric paste-in:** Custom Connector instructions tell the model
  `project: <current-project>` — but `<current-project>` is a placeholder. No
  resolver exists at the model layer.
- **Effect when user says "remember this":**
  - Model invokes `memory_capture` with whatever string it can guess from the
    conversation. If nothing obvious, it either omits project (→ server uses
    `'default'`) or hallucinates a name. Either way, retrieval from another
    surface won't find it under the user's mental project.
  - For `memory_append_turn` (richer context preservation), missing project
    is a **hard fail** — the user sees an error envelope, not a soft-default.

### 2.3 Claude Desktop (app)

- **Connector:** HTTP MCP from `claude_desktop_config.json` (per
  `docs/connecting-claude-ai.md` §3b).
- **Project signal from host:** **NONE.** The config block has no project
  field; Claude Desktop runs MCP without per-conversation cwd metadata.
- **Workaround per docs:** users with the Anthropic **Projects** feature
  paste the rubric into project-level system prompt, but `<current-project>`
  remains a placeholder there.
- **Effect:** identical to Claude.ai. The Projects feature gives the model
  more durable instructions (no per-chat re-paste), but doesn't supply a
  resolver.

### 2.4 ChatGPT Desktop (MCP connector)

- **Connector:** HTTP MCP at `<tunnel>/mcp` (per
  `docs/connecting-chatgpt-desktop.md`).
- **Project signal from host:** **NONE.** Same shape as Claude.ai —
  cloud-resident, no project hint reaches the connector.
- **Rubric paste-in:** ChatGPT Custom Instructions field. Same
  `<current-project>` placeholder.
- **Effect:** identical to Claude.ai surfaces.

### 2.5 ChatGPT Custom GPT (Actions API, REST)

- **Connector:** REST via `actions-trimmed.yaml`
  (`plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml`). Trimmed
  spec exposes 7 routes: search / state / add / delete / recent / append-turn /
  checkpoint. **`memory_capture` is NOT in the trimmed spec** — Custom GPT
  writes go through `memory_add` (mem0 fact-extraction).
- **Project signal from host:** **NONE.** Same cloud-resident shape.
- **Schema:** `MemoryMetadata.project` is documented as optional ("Owning
  project slug"). `additionalProperties: true` so the model can pass it but
  isn't required to.
- **System prompt:** `system-prompt.md` says
  `memory_state(project: <inferred>)` — `<inferred>` is a placeholder.
- **Effect distinct from MCP surfaces:** missing project on `memory_add` does
  **NOT** hit the `'default'` soft-default — that's a `memory_capture` codepath.
  Instead the fact lands in mem0 with no project metadata at all. Searchable by
  text but invisible to project-scoped state/recent calls.

### 2.6 Codex CLI (config-only plugin)

- **Connector:** MCP via `.mcp.json` (`plugins/codex/universal-memory/.mcp.json`)
  pointing at `http://localhost:6335/mcp`. Plugin is config-only — no hooks,
  no scripts (per `plugins/codex/universal-memory/NOTES.md`).
- **Project signal from host:** **NONE in v1.0.** Codex's MCP servers run
  without seeing the editor's cwd. Hooks (which do receive cwd via stdin JSON
  per `docs/codex-integration-notes.md` §5) would carry that signal — but the
  Codex plugin has no hooks pending three upstream blockers (no SessionEnd,
  no plugin-bundled hooks, no Windows hooks).
- **Rubric paste-in surface:** TBD per `NOTES.md` (suspected AGENTS.md, not
  yet confirmed on a live Codex install).
- **Effect:** identical to Claude.ai surfaces. Even when v0.5+ adds Codex
  hooks, the project signal will flow through hooks → `additionalContext`,
  not through MCP itself, so MCP-only callers stay at the same gap.

### 2.7 Discord OpenClaw bridge (cross-system, mem0-pi today)

- **Status:** today writes to `mem0-pi-mcp` on the Pi, not UM. Audit deferred
  to **A3** (codebase access required).
- **UM-side coupling:** none until Phase C (parallel deploy) or F (migration
  completion).
- **Effect:** out of scope for this audit; tracked separately.

---

## 3. Findings

### F1 — Project-default behavior is heterogeneous server-side

Three different responses to the same omission:
- `memory_capture` → soft-default to literal `'default'`
- `memory_add` → silently drops project metadata
- `memory_append_turn` / `memory_state` / `memory_recent` → hard fail

A casual user issuing "remember this" via different connector configurations
gets different observable behavior with no clear rule.

### F2 — Only Claude Code resolves project automatically

CC's `resolve-project.sh` chain (arg → env → `.um/config` → git basename) is
the only host-side resolver. All five non-CC surfaces (Claude.ai, Claude
Desktop, ChatGPT Desktop, ChatGPT Custom GPT, Codex CLI) push the resolution
problem onto the LLM via a paste-in rubric containing a `<current-project>`
placeholder.

### F3 — `<current-project>` and `<inferred>` are placeholders, not signals

The rubric (`docs/memory-routing-rubric.md`) and Custom GPT system prompt
literally use those strings. The model has to guess. There is no canonical
project value to substitute.

### F4 — `'default'`-bucketing is silent and cross-user-collision-prone

When `memory_capture` is invoked without project, captures land in
`authored/default/<id>.md`. There is no operator-visible signal that this
happened. On a shared/multi-user backend (Phase E2 zero-setup install or
Phase F single-system world) every user's "default" collisions land in the
same directory. There is no `UM_DEFAULT_PROJECT` env override.

### F5 — `memory_append_turn` is the worst UX for casual users

`memory_append_turn` is the conversational-context tool the rubric
specifically recommends for "track this conversation" cases (the high-signal
casual use case). On a missing-project call from a Claude.ai user it returns
an `INPUT_INVALID` error — the user-visible failure mode is "the bot tried
to save my context and got an error." Compare to `memory_capture`'s
soft-default `'default'`, which at least appears to succeed.

### F6 — ChatGPT Custom GPT `memory_add` skips the soft-default entirely

Because the Custom GPT Actions surface exposes `memory_add` (not
`memory_capture`), facts extracted from "remember this" prompts go through
mem0 fact-extraction and store *without project metadata at all* on omission.
This is a different failure shape from MCP surfaces — the fact is stored,
just unreachable via project-scoped retrieval.

---

## 4. Implications for downstream phases

| Phase | Implication |
|---|---|
| **B1** surface coverage parity matrix | Each surface gets a "project resolution" column; today only CC fills it. The matrix makes F1/F2 visible at a glance. |
| **B2** `/remember` skill | CC-only target initially. Reuses `resolve-project.sh` chain. Doesn't address non-CC surfaces — F2 stays open. |
| **C2** dual-backend bridge | Discord OpenClaw → UM cross-write must specify a project. If Discord has no project notion either, `UM_DEFAULT_PROJECT` env (F4) or a per-bridge override is needed before C2 can land. |
| **D1** cross-surface fact dedup | Dedup keys on (text, project, user). Heterogeneous project defaults (F1) mean the same fact captured from CC vs Claude.ai may land under different project slugs and therefore not dedup. F1 must be addressed before D1 can claim "cross-surface dedup" honestly. |
| **D2** lane / persona schema | Orthogonal to project — but the same "no signal from non-CC surfaces" gap applies to lane. Document the parity once D2 lands. |
| **E3** LLM context router | Directly addresses F2/F3. Server-side classifier on write-time content lets the user-facing surface skip the project-resolution problem entirely. After E3 lands, the rubric paste-in becomes redundant for non-CC surfaces. |

---

## 5. Recommendations (out of scope for PR #73 — for tracking)

1. **Document the heterogeneous-default behavior** in `docs/mcp-tools.md` so
   connector users have a predictable mental model. (Mechanical doc PR.)
2. **Add `UM_DEFAULT_PROJECT` env** so deployments can override the literal
   `'default'`. Especially load-bearing for Phase F (single-system world) and
   F4 (cross-user collision risk).
3. **Phase E3 priority confirmation** — this audit reinforces that the
   rubric-paste-in approach is structurally fragile (drift, paste-in friction,
   model-dependent obedience). E3 (server-side router) is the durable fix; it
   should sit in front of E1/E2 in the priority order if ranking by
   universality-axis advancement.
4. **Connector docs should warn `'default'`-bucketing is the silent fallback**
   so operators have a signal that captures may be landing somewhere they
   don't expect. (Mechanical doc PR; can land in B1.)
5. **Consider promoting `memory_append_turn` to soft-default `'default'`**
   like `memory_capture` does. Today's hard-fail is the worst UX of any tool
   in the matrix. Either the soft-default is right (then both should do it) or
   the hard-fail is right (then `memory_capture` should also fail). The
   current asymmetry is a bug pattern, not a design.

---

## 6. Provenance / verification

All findings traced from source files at commit a6c17e9:
- Server: [`server/mem0-mcp-http.mjs`](../../server/mem0-mcp-http.mjs),
  [`server/lib/append-turn.mjs`](../../server/lib/append-turn.mjs),
  [`server/openapi.mjs`](../../server/openapi.mjs)
- Reference: [`plugins/claude-code/universal-memory/hooks/lib/resolve-project.sh`](../../plugins/claude-code/universal-memory/hooks/lib/resolve-project.sh),
  [`plugins/claude-code/universal-memory/bin/um-capture`](../../plugins/claude-code/universal-memory/bin/um-capture)
- Connector docs: [`docs/connecting-claude-ai.md`](../connecting-claude-ai.md),
  [`docs/connecting-chatgpt-desktop.md`](../connecting-chatgpt-desktop.md),
  [`docs/codex-integration-notes.md`](../codex-integration-notes.md)
- Plugins:
  [`plugins/codex/universal-memory/.mcp.json`](../../plugins/codex/universal-memory/.mcp.json),
  [`plugins/codex/universal-memory/NOTES.md`](../../plugins/codex/universal-memory/NOTES.md),
  [`plugins/chatgpt-custom-gpt/universal-memory/system-prompt.md`](../../plugins/chatgpt-custom-gpt/universal-memory/system-prompt.md),
  [`plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml`](../../plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml)

A2 (mem0 version on Pi) and A3 (Discord OpenClaw codebase access) findings
will be appended once maintainer-action items complete; placeholder section
below.

---

## 7. A2 — mem0 version on Pi (PENDING — needs maintainer SSH)

> Pending. Run on `pi-openclaw`:
> ```bash
> docker exec mem0-pi-mcp pip show mem0ai | grep Version
> ```
> Expected: `Version: 2.4.6` (matches UM v1.0). If older, in-place migration
> requires a mem0 upgrade on the Pi first.

## 8. A3 — Discord OpenClaw integration (PENDING — needs codebase access)

> Pending. Open questions:
> - Is the OpenClaw codebase forkable / under maintainer control? Or third-party?
> - What MCP wire-protocol does the Discord integration expect from `mem0-pi-mcp`?
> - Is the MCP endpoint URL operator-controllable? (Required for C2 dual-backend bridge.)
> - Does Discord OpenClaw resolve project per-message, per-user, per-server, or not at all?
