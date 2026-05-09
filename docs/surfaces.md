# Surface coverage parity matrix

> **Mission anchor (per [#72](https://github.com/goldenwo/universal-memory/issues/72)):**
> Persistent + quality + automatic memory storage and recall, **across any vendor / device / platform, for any user doing anything.**
>
> This doc is the canonical answer to "where is universal-memory first-class today, and where is it second-class?" Updated as a release artifact — every release that changes a surface's tier or setup story must update the relevant row here.

The matrix below is the implementation arm of [#72 Gap 6](https://github.com/goldenwo/universal-memory/issues/72) (surface coverage parity). It is intended to be read by:

- **Operators** picking which client to wire up first (start at the `first-class` row).
- **Maintainers** scoping which surface to upgrade next (look at "blocks axes" column for the highest-leverage promotions).
- **PR reviewers** asking "does this PR advance surface coverage?" (a row that moves up the tier ladder is the answer).

## Reading guide

**Capture path** — when the user says *"remember this"* (or equivalent), what happens?

- `auto` — captured without explicit user/tool action; pipeline runs on session lifecycle events
- `partial-auto` — captured after explicit invocation but no per-fact wiring (e.g. `memory_append_turn` per turn)
- `manual` — user must explicitly invoke a tool (`memory_capture`, `memory_add`, `um capture`, paste-in rubric)
- `none` — no capture path; surface is read-only

**Recall path** — when the user (or LLM) needs prior context, what happens?

- `auto` — pulled into the model's context at session start without explicit ask (e.g. `state.md` injection via SessionStart hook)
- `partial-auto` — surface's connector layer makes recall tools available; LLM decides when to call (most MCP surfaces)
- `manual` — user must explicitly invoke (`um state`, `um search`)
- `none` — no recall path

**Setup steps** — minimum operator actions from "I want this to work" to a working surface. Lower number → closer to axis-4 (zero-setup) goal.

**Project / lane signal** — does the surface know what project the user is currently working on? The reference (CC) infers from `git rev-parse --show-toplevel | basename`; non-CC surfaces have no host-side signal and rely on the LLM to guess from conversation context (cf. `metadata.project` cross-surface defaults audit, [#73](https://github.com/goldenwo/universal-memory/pull/73)).

**Blocks axes** — which of [#72](https://github.com/goldenwo/universal-memory/issues/72)'s 6 axes does this surface's current tier prevent us from closing? (An axis is "blocked" when promoting this surface would unblock it.) Axes 1, 2 are server-side concerns and not affected by surface-tier — they're omitted from the column.

## At-a-glance matrix

| Surface | Capture | Recall | Setup steps | Project / lane signal | Blocks axes |
|---|---|---|---|---|---|
| **Claude Code (CC)** | `auto` (Stop hook → `captures/<project>/raw/<date>.md` → SessionEnd hook → LLM-synthesized state.md) | `auto` (SessionStart hook injects `state.md` + routing rubric into `additionalContext`) | 1 (`bash install.sh`) | `auto` (git basename → `$UM_PROJECT` → `.um/config` → `--project` flag, see [`hooks/lib/resolve-project.sh`](../plugins/claude-code/universal-memory/hooks/lib/resolve-project.sh)) | reference — none |
| **Claude.ai (web)** | `manual` (rubric paste-in → user types "remember"; LLM calls `memory_capture` / `memory_append_turn`) | `partial-auto` (4 read tools available via MCP; LLM decides when to call) | 4 (UM up; tunnel; connector form; rubric paste) | `none` (rubric placeholder `<current-project>`; LLM guesses) | 3 (mobile reach via web), 4 (4-step setup), 5 (no signal), 6 (this surface's tier IS axis 6) |
| **Claude Desktop** | `manual` (rubric in Projects system-prompt → user types "remember") | `partial-auto` (MCP read tools) | 3 (UM up; edit `claude_desktop_config.json`; restart app) | `none` | 4, 5, 6 |
| **ChatGPT Desktop** (MCP connector) | `manual` (rubric in Custom Instructions → user types "remember") | `partial-auto` (MCP read tools) | 4 (UM up; tunnel; connector form; Custom Instructions paste) | `none` | 4, 5, 6 |
| **ChatGPT Custom GPT** (REST Actions) | `manual` (system prompt → user types "remember"; GPT calls `POST /api/add`) | `partial-auto` (5 REST endpoints in [`actions-trimmed.yaml`](../plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml); GPT decides when to call) | 5 (UM up; tunnel; new GPT; import `actions-trimmed.yaml`; system prompt paste) | `none` (and `memory_add` doesn't even soft-default to `'default'` — fact lands in mem0 with no project metadata at all; cf. F6 in [#73](https://github.com/goldenwo/universal-memory/pull/73) audit) | 4, 5, 6 |
| **Codex CLI** | `manual` (rubric paste surface TBD per [`NOTES.md`](../plugins/codex/universal-memory/NOTES.md); LLM calls `memory_capture`) | `partial-auto` (MCP read tools per `.mcp.json`) | 2-3 (UM up; `install.sh` auto-detects + drops plugin OR manual `config.toml`) | `none` (and 3 upstream blockers prevent hooks-based signal: no SessionEnd, no plugin-bundled hooks, no Windows hooks; see [`docs/codex-integration-notes.md`](codex-integration-notes.md)) | 4, 5, 6 |
| **Discord OpenClaw** (bridge) | TBD (gated on [#71](https://github.com/goldenwo/universal-memory/issues/71) A3 audit; today writes to `mem0-pi-mcp`, not UM) | TBD | TBD | TBD | 4, 5, 6 (until Phase C2 dual-backend bridge lands) |
| **`um` standalone CLI** | `manual` (`um capture --project <p> --type <t> --text "..."` or stdin) | `manual` (`um state`, `um search`, `um recent`) | 1 (`bash install-cli.sh`) | `auto` (same `resolve-project.sh` chain as CC) | 4 partial — single-line install but power-user shape; 6 (CLI is its own tier) |

**Tier ladder (for promotions):**

```
none → manual → partial-auto → auto
```

A PR that moves a surface up one rung (manual → partial-auto, etc.) advances axis 6.

## Per-surface notes

### Claude Code (CC) — REFERENCE

Full hooks-driven pipeline. Four hooks (`SessionStart`, `Stop`, `SessionEnd`, `UserPromptSubmit`) wire UM into the session lifecycle without per-turn user intervention:

- `Stop` appends each assistant turn to `captures/<project>/raw/<UTC-date>.md`
- `SessionEnd` runs the LLM summarizer over raw captures + writes / updates `state/<project>/state.md`
- `SessionStart` reads `state.md` + injects routing rubric into `additionalContext`
- `UserPromptSubmit` (when present) can pre-augment prompts with retrieval results

Project resolution chain at [`plugins/claude-code/universal-memory/hooks/lib/resolve-project.sh`](../plugins/claude-code/universal-memory/hooks/lib/resolve-project.sh) — arg → `$UM_PROJECT` env → `.um/config` → `git rev-parse --show-toplevel | basename` → exit 2. Every CC capture lands under a stable per-repo project slug.

### Claude.ai (web)

HTTP MCP connector (cf. [`docs/connecting-claude-ai.md`](connecting-claude-ai.md)). Anthropic's cloud cannot reach `localhost:6335` directly, so a public tunnel is required. The 4 default read tools appear at connector handshake; 7 write tools appear only when the server is started with `UM_MCP_WRITE_ENABLED=true`.

The "remember" flow is brittle: per-connector custom instructions (or per-Project prompt) hold the routing rubric, which uses `<current-project>` as a placeholder. The LLM has to infer project from conversation context, which is inconsistent. There is no host-side project resolver — Claude.ai runs in cloud and has no notion of "the user's current project".

### Claude Desktop

Same MCP wire-protocol as Claude.ai but reachable from `localhost` directly when UM runs on the same machine — no tunnel required for local-only setups. The MCP config lives in `claude_desktop_config.json`. Setup is 1 step shorter than Claude.ai because the tunnel is optional.

For routing rubric placement, the Anthropic Projects feature (when used) gives a more durable home than per-chat custom instructions; otherwise user-level Custom Instructions apply rubric to every conversation (noisier).

### ChatGPT Desktop

Same shape as Claude.ai web (cloud-resident → tunnel required → manual rubric in Custom Instructions). Routing-rubric paste-in goes into ChatGPT's Custom Instructions. The 4 default read tools and (with writes enabled) 7 write tools appear at handshake.

### ChatGPT Custom GPT (REST)

The only surface that uses REST Actions instead of MCP. Wired via [`plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml`](../plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml) — 7 endpoints (search / state / add / delete / recent / append-turn / checkpoint). The 7-endpoint subset is deliberate: the Custom GPT Actions UI is constrained to a smaller spec than full MCP. Note: `memory_capture` is NOT in the trimmed spec — Custom GPT writes go through `memory_add` (mem0 fact-extraction) instead, which means a missing-project call lands a fact in mem0 with no project metadata at all (vs. the soft-default `'default'` that `memory_capture` applies). Cf. F6 in the [cross-surface defaults audit (#73)](https://github.com/goldenwo/universal-memory/pull/73).

### Codex CLI

Config-only plugin per [`plugins/codex/universal-memory/.mcp.json`](../plugins/codex/universal-memory/.mcp.json). Three upstream blockers prevent a hooks-based capture pipeline matching CC:

1. Codex `v0.121` has no `SessionEnd` event — the synthesize-summary pipeline has no trigger.
2. Codex's plugin manifest has no `hooks` field — operators would have to hand-edit `~/.codex/hooks.json`, defeating one-click install.
3. Hooks disabled on Windows in Codex `v0.121` — regression vs CC platform coverage.

Until any two of those clear upstream, Codex is parked at MCP-connector-only. Cf. [`docs/codex-integration-notes.md`](codex-integration-notes.md).

### Discord OpenClaw (bridge)

Cross-system bridge to the user's Discord OpenClaw instance. Today writes through to `mem0-pi-mcp` (the Pi-hosted mem0 instance), not UM. Audit [#71](https://github.com/goldenwo/universal-memory/issues/71) is gated on three open questions surfaced in the [#73](https://github.com/goldenwo/universal-memory/pull/73) PR body (codebase access, MCP wire-protocol, operator-controllable endpoint, project-resolution semantics). Promotion to first-class UM surface is the Phase C2 dual-backend bridge → Phase F migration completion arc.

### `um` standalone CLI

Single-line install via [`installer/install-cli.sh`](../installer/install-cli.sh). Provides:

- `um capture` — fs-direct write to `captures/<project>/raw/<date>.md` (same path the CC `Stop` hook writes to)
- `um state` — read state.md
- `um search` — semantic search via the server
- `um recent` — recent authored docs

Reuses CC's `resolve-project.sh` chain so project resolution is consistent across CC and CLI. Useful for cron / scripting / one-off queries outside any Claude session.

This is the lowest-setup surface today (1 step) but doesn't satisfy axis 4 fully — the CLI is power-user-shaped (you have to type commands explicitly with flags) and operates on top of a running UM server.

## Cross-cutting findings

### No surface today serves axis 3 (mobile-friendly capture and recall)

Every surface in the matrix above is desktop / terminal / web-via-desktop. There is no native iOS / Android client, and the mobile web Anthropic / OpenAI clients don't expose a native MCP-connector configuration step. Closing axis 3 requires either (a) a vault web UI at `<um-server>/app` (Phase E1), (b) a hosted UM service that mobile clients can connect to without operator setup, or (c) a native client.

### Only Claude Code serves axis 5 (auto context routing)

Five of seven surfaces (Claude.ai, Claude Desktop, ChatGPT Desktop, ChatGPT Custom GPT, Codex CLI) have **no host-side project signal**. The routing rubric uses `<current-project>` as a placeholder text — the LLM is expected to infer project from conversation context, which is inconsistent. Discord OpenClaw's project-resolution semantics are pending audit ([#71](https://github.com/goldenwo/universal-memory/issues/71)). The `um` CLI inherits CC's chain, but only CC's hook-driven session-lifecycle integration auto-resolves project per-session.

Closing axis 5 requires either (a) a server-side LLM context router (Phase E3 — classifier on write-time content), (b) an explicit `lane` / `persona` schema field surfaces can pass (Phase D2), or (c) a host-side resolver per surface (per-vendor work, expensive).

### Axis 4 (zero-setup) is gated by every surface having a multi-step setup story

Even the lowest-setup surface (`um` CLI, 1 step) operates on top of a running UM server, which itself requires `bash install.sh` plus Docker plus `.env` plus an API key. The matrix's "Setup steps" column is the gradient — closing axis 4 means halving the modal column value over the next year. Phase E2 (zero-setup SQLite mode) targets this directly.

### Axis 6 (the matrix itself) becomes auditable with this doc

Until this doc landed, "UM works with any MCP client" was a claim without a corresponding receipt. The matrix now makes the claim auditable — every release can grep for tier-changes, every PR can answer "did this advance surface coverage?".

## Living-doc commitment

This document is updated as a release artifact under the universality roadmap (`docs/plans/2026-05-08-universality-roadmap.md`, gitignored). The maintainer commits to:

1. **At each release tag**, audit the matrix for stale rows (e.g., a surface tier promoted, setup steps reduced) and update.
2. **In any PR description that changes a surface's capture / recall / setup story**, link to the relevant row here and note the tier-shift in the PR body.
3. **When a new surface is added** (new connector, new vendor, new bridge), prepend a row to the matrix in the same PR that adds the integration.

Stale rows are themselves a vision-axis-6 regression — the matrix being out-of-date is functionally equivalent to UM not knowing where it stands.
