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

- **Status:** Discord OpenClaw uses mem0 via in-process JS import
  (`@mem0/openclaw-mem0@1.0.6` extension), not over the wire. The
  `mem0-pi-mcp` HTTP service is a *separate* exposure for external MCP
  clients. See **§8** for the full Q1–Q4 findings.
- **UM-side coupling:** none today. C2 (dual-backend bridge) re-scoping
  required per §8.5 — the "intercept at network" assumption doesn't hold.
  Phase F (migration completion) needs synthetic project assignment for
  Pi data (single `userId='golden'` flat bucket, no project dimension).
- **Effect:** the audit's project-default question doesn't apply directly
  — OpenClaw's surface has no project parameter at all (§8 Q4). Every
  capture lands project-less. From the casual user's POV, "remember this"
  via Discord stores under a single flat namespace; project-scoped
  retrieval does not work for Pi-side data without a synthetic-project
  layer.

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
| **C2** dual-backend bridge | A3 reveals the OpenClaw → mem0 path is **in-process JS import**, not wire-protocol — no network boundary to intercept. Bridge strategies are now (a) plugin shim replacing `@mem0/openclaw-mem0`, (b) qdrant-compatible HTTP shim under the extension, or (c) defer to Phase F one-shot migration. All assume `UM_DEFAULT_PROJECT` (F4) since OpenClaw passes no project metadata at all (A3 §8 Q4). |
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
6. **Re-scope Phase C2 design.** Original "intercept at network" assumption
   doesn't fit (§8 Q2). Three viable bridge strategies are listed in §8.5
   — pick one (or pick (c) defer-to-F) before C2 enters implementation.
   Recommended pre-C2 deliverable: a short ADR comparing the three options
   on coupling, upstream-churn risk, and migration timing.
7. **Document `mem0-pi-mcp` ≠ Discord OpenClaw integration path.** Older
   plans and connector docs may conflate these two paths. A short note in
   `docs/connecting-claude-ai.md` (or a new `docs/architecture/pi-mem0.md`)
   explaining the two-callers, two-paths model would prevent the same
   premise inversion (§8 Q2) recurring in future planning rounds.

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

A2 + A3 sources (Pi-side, inspected 2026-05-09 via SSH; not in this repo):
- `~/.config/systemd/user/mem0-mcp.service`,
  `~/.config/systemd/user/openclaw-gateway.service`
- `~/.openclaw/scripts/mem0-mcp-http.mjs`
- `~/.openclaw/extensions/openclaw-mem0/package.json`

A2 and A3 findings landed 2026-05-09 via maintainer-authorized SSH inspection
of the Pi systemd services and openclaw extension package metadata.

---

## 7. A2 — mem0 version on Pi

**Headline:** Pi runs **`mem0ai@2.4.5`** (Node.js, npm). One patch behind
UM v1.0's `mem0ai@2.4.6`. Phase C1 (in-place migration) is unblocked at
low risk.

### 7.1 Premise correction

The original probe assumed `docker exec mem0-pi-mcp pip show mem0ai` would
return a version. **Both halves of that assumption were wrong:**

1. **mem0 is not containerized on the Pi.** Only `qdrant`
   (`y0mg/qdrant-raspberry-pi:latest`, port 6333) runs in Docker. mem0
   itself runs as a `systemd --user` service:
   `~/.config/systemd/user/mem0-mcp.service` →
   `/usr/bin/node /home/openclaw/.openclaw/scripts/mem0-mcp-http.mjs`.
2. **mem0 is not Python.** The Pi uses the Node.js `mem0ai` npm package,
   not the Python `mem0ai` PyPI package. The script imports
   `Memory` directly from
   `~/.openclaw/extensions/openclaw-mem0/node_modules/mem0ai/dist/oss/index.mjs`.

### 7.2 Version

The hosting extension is **`@mem0/openclaw-mem0@1.0.6`** (Apache-2.0,
upstream `mem0ai/mem0` repo, `openclaw` directory). Its `package.json`
pins `mem0ai: 2.4.5`. UM v1.0 ships with `mem0ai@2.4.6` (cf.
[`server/patches/mem0ai+2.4.6.patch`](../../server/patches/mem0ai+2.4.6.patch)).
Patch skew: **`2.4.5 → 2.4.6`**, one minor patch.

### 7.3 Pi server identity + endpoint shape

The HTTP server announces itself in MCP `initialize`:

```json
{ "serverInfo": { "name": "mem0-pi", "version": "2.0.0" }, ... }
```

Port: `MEM0_MCP_PORT` env (default `6335`). Listens on two transports:

- **MCP** — JSON-RPC over `POST /mcp` + SSE on `GET /mcp/sse`
- **REST** — `POST /api/search`, `POST /api/add`, `GET /api/list`,
  `DELETE /api/:id`

Tool surface (4 tools): `memory_search`, `memory_add`, `memory_list`,
`memory_delete`. Hardcoded `userId: USER_ID` from `MEM0_USER_ID` env
(default `'golden'`). **No project parameter on any tool** (carried into
A3 §8 Q4 below).

### 7.4 Phase C1 implication

In-place migration mental model holds: same vector store (qdrant on the
Pi), same provider choices (OpenAI for embedding + LLM, qdrant for vector
store), just bump the npm dep. UM's W6.2 patch
(`server/patches/mem0ai+2.4.6.patch`) targets the npm package on a UM
config that exercises it; whether it needs to apply on Pi-side mem0
depends on which patched code path the Pi's 4-tool MCP touches. Decide
patch applicability when scheduling C1 implementation.

---

## 8. A3 — Discord OpenClaw integration

**Headline (premise inversion):** Discord OpenClaw does **NOT** consume
`mem0-pi-mcp` over the wire. The `openclaw-gateway` systemd service loads
mem0 via **in-process JS import** (`@mem0/openclaw-mem0@1.0.6` extension).
The `mem0-pi-mcp` HTTP server is a separate exposure for *external* MCP
clients (e.g., user's Claude Code reaching the Pi over Tailscale serve),
distinct from how Discord OpenClaw itself talks to mem0.

### 8.1 Q1 — codebase forkable / under maintainer control?

**Answer: third-party.** Confirmed by maintainer 2026-05-09.

- Gateway: `openclaw@2026.4.21` installed at
  `~/.local/lib/node_modules/openclaw/dist/index.js` (npm-published,
  third-party).
- Mem0 plugin: `@mem0/openclaw-mem0@1.0.6` (Apache-2.0, upstream
  `mem0ai/mem0/openclaw` directory). Forkable in the open-source sense
  (license permits) but not maintainer-controlled.

### 8.2 Q2 — MCP wire-protocol the Discord integration expects from `mem0-pi-mcp`

**Answer: question's premise is inverted.** Discord OpenClaw does **NOT**
go over the wire to `mem0-pi-mcp`. Two distinct paths exist on the Pi:

| Caller | Path | Wire? |
|---|---|---|
| Discord OpenClaw (`openclaw-gateway` systemd unit) | `import { Memory } from 'mem0ai'` (in-process, JS) via the `@mem0/openclaw-mem0` extension | **No.** |
| External MCP clients (e.g., user's Claude Code, exposed via Tailscale serve) | HTTP `POST /mcp` (JSON-RPC) or `GET /mcp/sse` (SSE) on port 6335; OR REST at `POST /api/add` etc. | Yes — JSON-RPC MCP or simple REST. |

**Implication:** the Phase C2 design assumption ("intercept Discord
OpenClaw → `mem0-pi-mcp` at the network boundary") doesn't hold. There
is no such network boundary.

### 8.3 Q3 — is the MCP endpoint URL operator-controllable?

**Answer: split:**

- **For external exposure (`mem0-mcp.service`):** **yes.** Port via
  `MEM0_MCP_PORT` env (default `6335`); user namespace via `MEM0_USER_ID`
  env (default `'golden'`); both read from
  `~/.openclaw/.env` per the systemd unit's `EnvironmentFile=`.
- **For Discord OpenClaw's internal use of mem0:** **N/A** — in-process
  JS import; the "endpoint" is a node_modules path, not a URL. Operator
  controls qdrant connection (host/port hardcoded `localhost:6333` in
  `mem0-mcp-http.mjs` — but that's the HTTP-side wiring; the extension
  may differ — not inspected, scope-limited).

### 8.4 Q4 — does Discord OpenClaw resolve project per-message / per-user / per-server / not at all?

**Answer: not at all.** The 4-tool MCP/REST surface
(`memory_search`, `memory_add`, `memory_list`, `memory_delete`) has **no
project field** on any tool input schema. `memory_add` takes only `text`;
`memory_search` takes only `query` + optional `limit`. The server hardcodes
`userId` from env (`MEM0_USER_ID`, default `'golden'`) and passes that —
no project metadata at any layer. Every capture from any caller (Discord,
external MCP, REST) lands in a single flat `userId='golden'` namespace.

### 8.5 Implications

1. **Phase C2 (dual-backend bridge) must be re-scoped.** The
   "intercept-at-network" design doesn't fit. Three viable strategies
   surface:
   - **(a) Plugin shim** — fork or replace `@mem0/openclaw-mem0` with a
     UM-aware version that dual-writes (mem0 in-process + UM via HTTP).
     Tightly coupled to the OpenClaw plugin ABI; brittle to upstream
     churn.
   - **(b) Vector-store shim** — point the openclaw-mem0 extension's
     `vectorStore.config.host` at a UM-fronting qdrant-compatible HTTP
     proxy. Decouples from OpenClaw plugin churn; UM serves as a qdrant
     proxy. Implementation cost is the proxy itself.
   - **(c) Defer to Phase F migration** — accept that OpenClaw + mem0
     stay coupled until Phase F retires the Pi mem0 entirely. Lowest
     immediate complexity; biggest delay on cross-surface unification.
2. **Phase F (migration) needs synthetic project assignment.** All Pi
   data lives in a single `userId='golden'` bucket with no project
   dimension. Migration to UM must either (i) bucket all Pi captures into
   a synthetic project (e.g., `mem0-pi-legacy` or `discord-openclaw`), or
   (ii) run E3-style content-based project inference on each migrated
   record.
3. **Phase D1 (cross-surface dedup) inherits a project-skew.** Pi captures
   are project-less; UM-side captures are (heterogeneously) project-tagged
   per F1. Dedup either treats Pi captures as a synthetic project or
   relaxes the project key for Pi-derived facts only.

### 8.6 Provenance for §7+§8

All findings traced 2026-05-09 from public-facing files via SSH-inspected
read of:

- systemd unit definitions: `~/.config/systemd/user/mem0-mcp.service`,
  `~/.config/systemd/user/openclaw-gateway.service`
- mem0 HTTP server source:
  `~/.openclaw/scripts/mem0-mcp-http.mjs` (the script itself —
  imports, port wiring, tool definitions, mem0 SDK invocation)
- extension package metadata:
  `~/.openclaw/extensions/openclaw-mem0/package.json` (pinned mem0ai
  version, openclaw plugin manifest, build metadata)

Internal source code paths (`index.ts`, providers, gateway internals) were
not inspected — outside the maintainer's authorization scope. Assertions
about openclaw-gateway's in-process loading model rest on the systemd
unit's `WorkingDirectory=` pointing inside the extension dir + the
extension's `dist/index.js` being the systemd-mounted entrypoint of the
gateway's plugin loader. If a future investigation reveals the gateway
also makes HTTP calls to `mem0-pi-mcp`, §8 Q2 should be amended; until
then the in-process model is the working assumption based on the
public-facing evidence.
