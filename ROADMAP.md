# Roadmap

Status and open work for **universal-memory**. Items are loosely prioritized; actual ordering shifts with real-world needs. Each item is a candidate for its own plan + execution cycle.

## Shipped

| Version | What | Evidence |
|---|---|---|
| [v0.1.0](https://github.com/goldenwo/universal-memory/releases/tag/v0.1.0) | Memory server — Docker Compose + lifted mem0 HTTP server, vector-only, smoke-tested | Commit `58ad82d` on `main` |
| v0.1.1 | Install wizard (`server/install.sh`) — interactive prompts, writes `.env`, runs compose, polls `/health` | Tag `v0.1.1` |
| v0.1.3 | Claude Code plugin (manifest + hooks registration + auto-start probe) | Commit on main, tagged v0.1.3 |
| [v0.2.0-alpha](https://github.com/goldenwo/universal-memory/releases/tag/v0.2.0-alpha) | Session-continuity layer — Stop hook raw capture, LLM-synthesized session summaries, per-project `state.md`, memory versioning (forget/supersede), 10-tool MCP surface (Path B's three pillars land: summaries + state-of-play + versioning) | Commit `1877ba6` on `main`, tagged v0.2.0-alpha |
| [v0.2.1](https://github.com/goldenwo/universal-memory/releases/tag/v0.2.1) | Pluggable summarizer (`UM_SUMMARIZER=openai\|claude-agent-sdk\|ollama`), canonical routing rubric at `docs/memory-routing-rubric.md`, recursive-hook guard for CC hooks — Phase A of the v0.3 plan | Commit `c79f6b3` on `main`, tagged v0.2.1 |
| [v0.2.2](https://github.com/goldenwo/universal-memory/releases/tag/v0.2.2) | Adoption quickwins — `/um-preview` slash command + `bin/um-preview` CLI, first-session welcome banner, `install.sh --yes` non-interactive flag, `curl \| bash` bootstrap installer — Phase B of the v0.3 plan | Commit `5b053b8` on `main`, tagged v0.2.2 |
| [v0.3.0-alpha](https://github.com/goldenwo/universal-memory/releases/tag/v0.3.0-alpha) | Cross-platform release — Codex CLI plugin (MCP recall), ChatGPT Desktop + Claude.ai + Claude Desktop connection guides, ChatGPT Custom GPT scaffold, OpenAPI 3.1 at `GET /openapi.yaml` (+ `?gpt=1` trimmed), `um-tunnel` CLI, OpenAI Assistants API example. Phases C–G of the v0.3 plan | Commit `bae2b5f` on `main`, tagged v0.3.0-alpha |
| [v0.4.0-alpha](https://github.com/goldenwo/universal-memory/releases/tag/v0.4.0-alpha) | HYBRID-REBALANCE release — progressive disclosure on reads (compact `{id, title, score, snippet}` default; `?full=1` / `full: true` opt-in; 41.9% single-hop context reduction), new `um` CLI (7 subcommands + standalone `installer/install-cli.sh`), new `/api/recent/{project}` REST endpoint, MCP `memory_recent` rewired to filesystem mtime, schema-hygiene `tools/list` filter (4 reads visible by default; 6 writes gated on `UM_MCP_WRITE_ENABLED=true`), new `CHANGELOG.md` + `MIGRATION.md`. Phases 0, B.1, B.3, A, D, E of the v0.4 plan; 3 rounds of dual-Opus design review. | Commit `b59fb19` on `main`, tagged v0.4.0-alpha |
| [v0.5.0-alpha](https://github.com/goldenwo/universal-memory/releases/tag/v0.5.0-alpha) | Cross-env first-class release — `memory_append_turn` (raw-capture writes from any MCP client) + `memory_checkpoint` server-side body (non-CC surfaces can trigger session-summary + state.md refresh) + modular installer with wizard mode + NONINTERACTIVE env overrides (`UM_VAULT_DIR`, `UM_MOUNT_MODE`, `UM_MCP_WRITE_ENABLED`, `UM_CONTAINER_USER` validation) + docker-compose `UM_CONTAINER_USER` override for UID-matched rw-mount installs + I4 summarizer-prompt fix. 101 product commits + 13 CI-unblock commits + 1 post-review hardening commit; 13-round paired-Opus review cycle + 2 post-review Opus passes. Closes #5, #6. | Commit `5141887` on `main`, tagged v0.5.0-alpha |
| v0.6.0-alpha | Bearer auth + ops foundations + claude-mem bridge — bearer auth on `/api/*` + `/mcp` (loopback + 10-header forwarded-deny), pino structured logging with request_id, `/metrics` Prometheus (loopback-only default), per-IP token-bucket rate limiter, cross-process lockdir (Perl flock + proper-lockfile retired), O_NOFOLLOW on all vault writes, typeof-string timestamp guards, mem0/qdrant retry+jitter, request-body cap, `um-bridge-claude-mem` CLI (Node + better-sqlite3 plugin-local) with `<external-summary>` untrusted-content boundary + REJECT-on-literal-marker + path-traversal/UNC/symlink-bypass guards, BRIDGES.md registry + `source:` discriminator, schedule templates (systemd/launchd/cron), container entrypoint guard refusing root+rw+writes (#28), `_dump_on_fail` test harness (#21), `_um_curl_wrap` friendly-error CLI translator, `docs/process/review-playbook.md`. ~80 commits; per-task two-stage review during execution + paired-Opus R1 (1 Critical + 4 Important closed) + R2/R3 zero-finding convergence. Closes #20, #21, #28, #29, #30. | Tagged v0.6.0-alpha |
| v0.7.0-alpha | Provider neutrality release (alpha) — four providers swappable via env (openai, anthropic, google, ollama) with per-surface dispatch (`UM_EMBEDDING_PROVIDER`, `UM_SUMMARIZER_PROVIDER`, `UM_FACTS_PROVIDER`); embedding-stamp guard prevents cross-provider vector contamination + `um reindex` CLI for safe migrations (swap + archive paths, ~941 lines); mocked-SDK boot smoke covering all four providers; provider-neutral wizard prompts via `wizard-lib.sh`; D-series provider dispatch (DE-series for embed, DS-series for summarizer, DF-series for facts); FIN1 manual matrix validation. Multi-round paired-Opus review during plan + execution. | Tagged v0.7.0-alpha |
| v0.8.0-alpha | v0.7 follow-ups + cleanup queue close-out — `umAdd()` orchestrator (PR #36) replaces all 6 `mem0.add()` call sites so production embed/facts metrics emit; Qdrant server bumped 1.11.3 → 1.13.0; vault-frontmatter audit (PR #38, closes #37); v0.6 cleanup queue (PRs #39–#44) covering T17 stale-symlink test, CLI exec bit, shellcheck `--severity=style` restore, Windows T15 launcher fix, codex CI wire-up, ROADMAP refresh; reindex CLI orchestrator + DE12 e2e fill (PR #45); split `reindex.mjs` into `swap.mjs` + `archive.mjs` (PR #46); CHANGELOG + ROADMAP final alignment (PR #48). | Tagged v0.8.0-alpha |
| [v1.0.0](https://github.com/goldenwo/universal-memory/releases/tag/v1.0.0) | Stabilize + publish milestone — **no new features** vs v0.8; the work made the existing surface externally consumable. Server image 598 MB → 288 MB (W6.2), W6.4 hardening (CORS Authorization preflight, HMAC token compare, `UM_AUTH_TOKEN` logger redaction), macOS / Linux / Windows external-user walkthroughs (W2), CONTRIBUTING + SECURITY + ADR-0005 (Option A `/adr` invocation model), marketplace listing prep (W5), pull-by-default Docker compose + install-wizard image-mode (W1.2/W1.4), distribution + release ceremony. 18 PRs (#48–#65). | Commit `9dd70fc` on `main`, tagged v1.0.0 |
| [v1.1.0](https://github.com/goldenwo/universal-memory/releases/tag/v1.1.0) | Universality-arc milestone — advances [#72](https://github.com/goldenwo/universal-memory/issues/72) vision axes on the v1.0 stabilized surface: **B1** surface-coverage parity matrix (`docs/surfaces.md`, axis 6), **D1** cross-surface fact dedup default-ON at eval-derived τ=0.84 (axis 1), **F1** project soft-default unification (`UM_DEFAULT_PROJECT`, axis 4 partial), **B2** `/remember` casual-save skill (axis 4), **D2** lane/persona schema substrate (axis 5). Plus W1.1 `/adr` skill, W1.5 `UM_SERVER_URL` consolidation, W6.2 image-size reduction, the Phase-A pre-migration audits, and connector-doc + `/adr`-route hygiene. Migration notes: `MIGRATION.md` §"v1.0 → v1.1" (dedup default-ON, project soft-default, lane/persona read-filter). 14 PRs (#73–#86). | Commit `aa415b7` on `main`, tagged v1.1.0 |
| [v1.2.0](https://github.com/goldenwo/universal-memory/releases/tag/v1.2.0) | Auto-supersession default-ON — the **D3.3 flip**, the single operator-visible behavior change in the D3 lane-scoped auto-supersession arc (D3.1 substrate + D3.2 contradiction-detector both shipped inert under v1.1). Advances [#72](https://github.com/goldenwo/universal-memory/issues/72) **Gap 2** (axis 5). A 56-pair labelled contradiction eval pinned the judge-confidence threshold τ=0.80 (`UM_AUTOSUPERSEDE_THRESHOLD`) and decoupled the candidate-retrieval cosine to τ=0.45 (`UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD`); then `UM_AUTOSUPERSEDE_ENABLED` flipped to default-ON (opt-out, mirrors D1's `UM_DEDUP_ENABLED`). **Still inert in production until lanes are populated** (R1-B1 eligibility gate) — the Gap-5 lane-classifier that activates it is the next phase. Migration notes: `MIGRATION.md` §"v1.1 → v1.2" (no operator action required). PRs #92–#93 (+ #94 follow-ups, #95 summarizer `max_tokens`). | Tagged v1.2.0 |

Foundations shipped alongside v0.1.0:

- Architecture doc ([docs/architecture.md](docs/architecture.md)) — source/synthesis/index role-based frame

## Planned

Releases are scoped as micro-releases so each version ships independent value, is reviewable in a single spec, and lets lessons from one inform the next. The active release's paired spec + plan live at `docs/plans/<date>-<phase>-{spec,plan}.md` (gitignored, local-only per CLAUDE.md C3); this section is the committed public-facing pointer, and [North-star tracking](#north-star-tracking-72) is the authoritative lens for universality-axis work.

### v0.8 — ✅ shipped 2026-05-07

v0.8 closed the v0.7-alpha orchestrator-wiring gap (production embed/facts metrics emit correctly), shipped the `um reindex` CLI dispatcher, filled the DE12 e2e tests, and cleared the v0.6 follow-up backlog. Tagged `v0.8.0-alpha` at commit `ffad020`. See [Shipped](#shipped) table for the per-PR breakdown and CHANGELOG.md for full notes.

### v1.0 — ✅ shipped 2026-05-08

v1.0 was the stabilization + public-release milestone: stable API, externally usable, publicly announced, **no new features** (the v0.5+v0.6+v0.7+v0.8 combination reaching the [Distribution / release](#distribution--release) bar). Executed against a 7-workstream plan (W1 distribution/build, W2 external-user walkthrough, W3 ADR invocation model → ADR-0005 Option A, W4 public-repo readiness, W5 marketplace listing prep, W6 stability hardening, W7 release ceremony). Tagged `v1.0.0` at commit `9dd70fc`; 18 PRs (#48–#65). See [Shipped](#shipped) for the summary and CHANGELOG.md `## [1.0.0]` for full notes. The W2.2 fresh-eyes external runner is the one workstream item that remained human-gated past the tag (does not block the release; tracked with the public-flip gating, not here).

### v1.1 — ✅ shipped 2026-05-16

v1.1 became the **universality-arc milestone**, broader than this doc's original "capture path completeness" framing. It is the first release series to systematically advance the [#72](https://github.com/goldenwo/universal-memory/issues/72) vision-gap axes (see [North-star tracking](#north-star-tracking-72) below): B1 surface-coverage matrix (axis 6), D1 cross-surface dedup (axis 1), F1 project soft-default (axis 4 partial), B2 `/remember` skill (axis 4), D2 lane/persona schema substrate (axis 5). The original v1.1 bucket items also landed inside it — `create-adr`/`/adr` (W1.1), W6.2 image-size — and the claude-mem bridge shipped earlier in v0.6. Tagged `v1.1.0` at commit `aa415b7`; 14 PRs (#73–#86). See [Shipped](#shipped) and CHANGELOG.md `## [1.1.0]`.

### v1.2 — ✅ shipped 2026-06-03

v1.2 turns **auto-supersession ON by default** — the D3.3 flip, the single operator-visible behavior change in the **D3 lane-scoped auto-supersession** arc ([#72](https://github.com/goldenwo/universal-memory/issues/72) Gap 2, axis 5). D3.1 (supersession substrate — `supersedePoint`/`unsupersedePoint`, reserved fields, `only_superseded` listing, `unsupersede` undo) and D3.2 (session-end contradiction-detector behind `UM_AUTOSUPERSEDE_ENABLED`) both shipped **inert** under v1.1. v1.2 adds a 56-pair labelled contradiction eval that pinned the judge-confidence threshold (τ=0.80) and decoupled the candidate-retrieval cosine (τ=0.45), then flipped `UM_AUTOSUPERSEDE_ENABLED` to opt-out (default-ON, mirroring D1's `UM_DEDUP_ENABLED`). The R1-B1 eligibility gate keeps it **inert in production until lanes are populated** — the Gap-5 lane-classifier (next phase) is what moves it from shipped-mechanism to live behavior. Tagged `v1.2.0`; PRs #92–#93 (+ #94 follow-ups, #95). See [Shipped](#shipped), CHANGELOG.md `## [1.2.0]`, and MIGRATION.md §"v1.1 → v1.2".

### North-star tracking (#72)

Issue [#72](https://github.com/goldenwo/universal-memory/issues/72) is the canonical anchor for the universal claim — *"persistent + quality + automatic memory across all vendors / devices / users."* It enumerates **6 vision gaps**; this table is the authoritative gap → release mapping and supersedes the older free-text "post-v1.0" buckets for anything universality-related:

| #72 gap | What | Status | Release |
|---|---|---|---|
| Gap 1 — Cross-surface fact dedup | Same fact from N surfaces → 1 record, not N | ✅ shipped | v1.1 (D1, τ=0.84 default-ON; PRs #75–#77) |
| Gap 6 — Surface coverage parity matrix | Living `docs/surfaces.md` matrix | ✅ shipped | v1.1 (B1; PR #74) |
| Gap 5 — Auto context routing (substrate) | `lane`/`persona` orthogonal partition schema | ✅ shipped | v1.1 (D2 schema substrate; PR #84) |
| Gap 2 — Auto-supersession on contradiction | Session-end contradiction-detector marks old fact `superseded` (lane-scoped, reversible status flip) | ✅ shipped | v1.2 (D3 arc; substrate #88 + detector #91 + eval/flip #92–#93). Inert in prod until lanes populate — see Gap 5 classifier below. |
| **Gap 5 — Auto context routing (classifier)** | LLM lane-classifier populating the D2 schema so the shipped D3 auto-supersession actually acts in production | **next** | next release |
| Gap 3 — Mobile-friendly capture/recall | PWA at `<server>/app`, native client, or hosted thin client | unscheduled | TBD — biggest open "any device" gap |
| Gap 4 — Zero-setup / hosted entry path | <60s onboarding: hosted free-tier, SQLite single-user mode, or vendor-managed connector | unscheduled | TBD — biggest open "any user" gap |

Gap-linked side-trackers: [#70](https://github.com/goldenwo/universal-memory/issues/70) casual-user retrieval UX (Gap 4 + partial Gap 5), [#71](https://github.com/goldenwo/universal-memory/issues/71) mem0-pi → UM single-backend migration (closes when Gaps 4+5 partially solved), [#69](https://github.com/goldenwo/universal-memory/issues/69) doctype expansion (orthogonal — structured-layer quality, not universality).

### post-v1.0 release buckets

Cohesive themes; **final version allocation set when each release approaches** — numbers below v1.2 are provisional. The #72 table above is authoritative wherever it overlaps these buckets.

- **✅ shipped v1.2 — D3 lane-scoped auto-supersession (#72 Gap 2):** session-end contradiction-detector LLM call against top-K similar facts; high-confidence flips the old fact to `superseded` (reversible status flip with `supersededBy`/`supersededAt`, never deleted), lane-scoped so cross-context facts don't false-contradict. Built on the D2 substrate (uuidv5 seed, dedup `partitionArm`, lane/persona absence semantics) and D1's similarity-search path; batched at session-end via the summarization stop-hook (Approach A) rather than per-write. Shipped behind the R1-B1 eligibility gate — inert in production until lanes populate.
- **next release — Gap-5 lane-classifier (#72 Gap 5 classifier):** the headline next feature. An LLM auto-classifier that populates `lane`/`persona` on writes so the shipped D3 mechanism actually acts in production (today ~all facts are unpartitioned, so D3 auto-supersession is inert). Shares D3's detector/provider dispatch path; flag-gated rollout mirroring the D1/D2/D3 arcs.
- **Layer 3 foundation — Kuzu graph memory + bi-temporal metadata:** embedded graph DB for `supersedes`/`depends_on`/`contradicts` multi-hop + `valid_from`/`invalidated_at` fact temporality. Cohesive architectural step, ship together. Was this doc's old "v1.2"; now sequenced **after D3** — bi-temporal metadata is the natural Gap-2 follow-on (durable supersession history), not a precursor.
- **Layer 2 synthesis:** workspace-dream skill (cron markdown consolidation), cross-project compile pass (`wiki/by-topic/*.md`), ADR topic compile (cross-repo decision timeline).
- **Universality completion (Gaps 3 + 4) — unscheduled, no version assigned:** mobile-friendly path (PWA / native / hosted thin client) and zero-setup/hosted entry path. These are the **largest remaining universality gaps** and currently have no owner or release; flagged here so the cumulative-drift risk #72 warns about stays visible.
- **v1.x ongoing:** examples bundle (OpenAI Agents SDK / Responses API, LangChain, npm client reference), OpenClaw integration addon, cross-device markdown sync (after sync-mechanism decision), Codex lifecycle hooks (gated on upstream — issue [#17](https://github.com/goldenwo/universal-memory/issues/17)).
- **v2.0 — Reshape:** multi-tenant + cloud-vs-self-hosted decision (substantial public-API change requiring deprecation cycle). Likely the home for Gap 4's hosted-service path if that direction is chosen.

Power-user side-trackers: [#16](https://github.com/goldenwo/universal-memory/issues/16) (vault web UI, deferred post-v0.4 — partial Gap 3/4) and [#17](https://github.com/goldenwo/universal-memory/issues/17) (Codex lifecycle hooks, upstream-gated — Gap 6 surface parity).

## Near-term — plug-and-play arc

Three ordered plans that collectively eliminate manual `docker compose` invocation for the end user. Each is independent and ships value on its own.

### 1. Install wizard (`server/install.sh`) — ✅ shipped in v0.1.1
**Why:** `cp .env.example .env && edit .env && docker compose up -d` is three steps and requires knowing what to edit. An interactive script prompts for the required values, writes `.env`, runs `docker compose up -d`, and polls `/health`. Single command, no editing.
**Status:** shipped in [v0.1.1](https://github.com/goldenwo/universal-memory/releases/tag/v0.1.1).

### 2. CI workflow + GHCR image publishing — ✅ shipped
**Why:** Two wins at once. (a) CI proves portability continuously: every PR spins up the stack on fresh Ubuntu and runs the smoke test — no more "works on my machine." (b) CI publishes the built image to `ghcr.io/goldenwo/universal-memory-server:<tag>`. Users pull the prebuilt image instead of building locally — first-run latency drops from ~2 min (npm install + build) to ~20 s (image pull).
**Status:** CI smoke workflow shipped in the v0.1.x arc; GHCR image publishing completed in v1.0 (W1 — `release.yml` builds + pushes multi-arch images on tag, exercised by every release tag through `v1.1.0`). Pull-by-default compose (W1.2/W1.4) makes the published image the default install path.

### 3. Claude Code plugin manifest + auto-start hook — ✅ shipped in v0.1.3
**Why:** The final step to zero-touch. Plugin's SessionStart hook probes the endpoint; if unreachable, runs `docker compose up -d` using a user-configured compose dir. After initial plugin install, user never thinks about Docker again — sessions just work.
**Status:** shipped in v0.1.3. Plugin manifest at `plugins/claude-code/universal-memory/.claude-plugin/plugin.json`, hook registration at `hooks/hooks.json`, auto-start probe at `hooks/auto-start.sh`. v0.1 intentionally scopes to the user's existing `server/` dir via `UM_COMPOSE_DIR` rather than bundling compose inside the plugin — bundling is a v0.2 candidate once demand surfaces.

**Trust caveat:** auto-starting containers from a plugin hook is not invisible magic. The plugin logs clearly on first use via `[um-autostart]` lines and only acts when `UM_COMPOSE_DIR` explicitly points at a compose file the user controls.

## Layer 3 enrichment (index upgrades)

### Kuzu graph memory
**Why:** Multi-hop queries over ADR relationships (`supersedes`, `depends_on`, `contradicts`). Vector search can't answer "what depends on the choice to use PostgreSQL?"
**Rationale for Kuzu over Neo4j/Memgraph/AGE:** Kuzu is embedded (no server process) — fits a Pi's 8 GB budget where Neo4j would not. Production-supported in mem0 OSS since Sep 2025.
**Scope:** medium plan. Install `kuzu` optional dep in server image + update mem0 config + define graph schema for ADR-specific edges + extraction pipeline to populate edges from ADR frontmatter.
**Blocked on:** validating mem0 OSS's Kuzu integration works in our setup (documented as production-supported; haven't tested it ourselves).

### Bi-temporal metadata on index facts
**Why:** Borrowed from Zep's temporal knowledge graph pattern. Each fact gets `valid_from` / `invalidated_at` so superseded information doesn't surface at recall time. Essential for ADR workflows where decisions get overturned.
**Scope:** small-medium plan. Metadata schema + ingestion pipeline update + recall-path awareness.
**Order:** after Kuzu (edges are the natural place for temporal metadata).

## Synthesis passes (Layer 2 — LLM-compiled markdown)

### Workspace-dream skill
**Why:** Claude Code's autoDream consolidates per-project auto-memory on the local machine. The equivalent pass doesn't exist for the Pi vault or workspace markdown. A skill that consolidates any configured markdown tree on a cron.
**Scope:** medium plan. Generic "consolidate markdown directory" skill + configuration + systemd timer (or cron).

### Cross-project compile pass
**Why:** The Karpathy-LLM-wiki payoff. A weekly/monthly pass that reads per-project ADRs, per-project auto-memory, and standalone vault notes; produces `wiki/by-topic/*.md` pages aggregating knowledge across projects.
**Scope:** medium-large plan. Compile logic + topic-discovery heuristics + scheduling.

### ADR topic compile
**Why:** Specific flavor of the above. Reads every repo's `docs/decisions/*.md`, produces a timeline + topic index. Answers "how have I decided about X across all my projects?"
**Scope:** small plan (once the cross-project compile exists — this becomes a specialization of it).

## Capture path (Layer 1 — source writes)

### `create-adr` skill + `/adr` slash command — ✅ shipped in v1.1 (W1.1)
**Why:** ADR workflow first-class support. Writes the new ADR file using the template, creates the git commit, posts the atomic fact to the memory server.
**Status:** invocation model decided in **ADR-0005** (Option A — `/adr` slash command, over keyword detection / end-of-session batch). Shipped as the W1.1 `/adr` skill in the v1.1 arc (`plugins/claude-code/universal-memory/skills/create-adr/`); the v1.1 PR #82 fix corrected its POST route to `/api/add`. Second instance of the pattern (`/remember`, B2) followed in v1.1.

### OpenClaw integration addon
**Why:** For users who also run OpenClaw. `workspace-dream` skill for the Pi's hand-curated workspace markdown + autoCapture retrofit to write markdown before POSTing to the memory server.
**Scope:** medium plan. Requires coordinating with the `openclaw-mem0` plugin maintainer or forking.

### Claude-mem bridge — ✅ shipped in v0.6
**Status:** the `um-bridge-claude-mem` CLI shipped in v0.6.0-alpha (one-way claude-mem → UM, as the open question below recommended), with the `<external-summary>` untrusted-content boundary, REJECT-on-literal-marker guard, path-traversal/UNC/symlink-bypass guards, and the `BRIDGES.md` registry + `source:` discriminator. Bidirectional ingestion remains the open question — revisit only if daily use surfaces a need.

**Why:** [Claude-mem](https://github.com/thedotmack/claude-mem) is the leading memory plugin for Claude Code — it does per-session LLM-compressed capture into local SQLite+Chroma, with SSH sync between a user's own machines. Users will reasonably ask: *"how is this different, and can I use both?"*

**The honest difference.** Claude-mem optimizes for one tool (Claude Code) across one user's machines. universal-memory optimizes for **one memory served to every surface** — Claude Code, Claude.ai web (via local MCP), Claude Desktop, Discord OpenClaw, any MCP- or HTTP-speaking agent — from a single cloud-hosted server. Claude-mem's capture breadth inside Claude Code is deeper (5 lifecycle hooks vs our 2); our cross-surface reach is wider and our markdown-first design means the vector store is a replaceable cache rather than the source of truth.

**The bridge.** A small tool that reads Claude-mem's local SQLite export and appends its compressed summaries into the universal-memory markdown tree. Claude-mem becomes a contributor (tactical per-CC-session capture), universal-memory becomes the long-term vault (cross-surface access, cross-project synthesis, ADRs). Users get both without maintaining two sources of truth.

**Scope:** small plan. One CLI tool + a scheduled pull (cron / systemd timer) + docs explaining when to use which. No changes to Claude-mem itself — we read its on-disk format read-only.

**Open question:** whether the bridge flows one direction (claude-mem → UM) or bidirectional (UM summaries ingested back into claude-mem's search). Start one-way; revisit if daily use surfaces a need.

### Cross-device markdown sync
**Why:** Windows per-project auto-memory currently can't be read from Pi (and vice versa). Mem0 is the only cross-device surface today.
**Decisions needed:** sync mechanism — Syncthing vs nightly `git push` vs a sync daemon.
**Scope:** small-medium plan. Depends on chosen mechanism.

## Operational debt (lower priority, known)

### Qdrant version alignment — ✅ resolved in v0.8 G2
~~Current: image pinned to `qdrant/qdrant:v1.11.3`, but `mem0ai`'s bundled client is `1.13.x` — benign warning in logs.~~ Closed in PR #36: server image bumped to `v1.13.0` to match `@qdrant/js-client-rest@1.13.0` (now a direct dep, not transitive).

### Image size — ✅ resolved in v1.0 (W6.2) + v1.1
~~Current image is ~583 MB. Dominated by mem0ai's transitively-bundled LLM provider SDKs (`@azure` 58 MB, `cloudflare` 52 MB, `@google`, `@mistralai`, `@langchain`) that we don't use.~~ Closed via W6.2: v1.0 brought the server image **598 MB → 288 MB** (patch-package + surgical `rm` of unused transitive provider SDKs); v1.1 carried the W6.2 follow-up that was deferred from v1.0. No fork of mem0ai was needed.

### History DB persistence
Current: `/tmp/mem0-history.db` (ephemeral, reset on container restart). Users who want audit history of mem0 edits should be able to bind-mount a persistent location without editing config. Ship a commented volume mount example in `docker-compose.yml`.

## Open architectural decisions

| Topic | Blocking |
|---|---|
| Cross-device markdown sync mechanism (Syncthing / git / daemon) | Cross-device sync work |
| Raw capture co-location with Claude Code's per-project `memory/` dir | Stop-hook retrofit usability — deferred until autoDream behavior on custom subdirs is tested |
| Two deployment modes (cloud via mem0.ai vs self-hosted) | User-facing install flow |

## Distribution / release

### Public repo
Currently private. Going public when the shape is stable, the ADR invocation model is decided, and there's at least one external-user walkthrough (solo developer on macOS, no OpenClaw, no Pi) that demonstrably works.

### Plugin marketplace listing
After Claude Code plugin manifest is in and CI is green, register with the Claude Code plugin marketplace conventions.

## How this doc is maintained

- When a new area becomes the next focus, the item moves into the "near-term" list.
- When work ships, the item moves to "Shipped" with evidence (commit SHA + tag).
- Items can split or merge as we learn more. Don't worship the structure — use it.
