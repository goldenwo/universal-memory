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

Foundations shipped alongside v0.1.0:

- Architecture doc ([docs/architecture.md](docs/architecture.md)) — source/synthesis/index role-based frame

## Planned

The arc from v0.5 through v1.0 is scoped as micro-releases so each version ships independent value, is reviewable in a single spec, and lets lessons from one inform the next. Design spec for the active release lives at `docs/plans/<date>-v0.X-design.md` (gitignored, local-only); this section is the committed public-facing pointer.

### v0.6 — ecosystem integrations (~3–4 weeks)
UM becomes the "union vault" across adjacent memory tools: OpenClaw plugin (UM usable in Discord-side openclaw deployment), Claude-mem bridge (one-way ingest of claude-mem's local SQLite export; bidirectional if demand appears), cross-device sync (resolves an open architectural decision: Syncthing vs git vs daemon), plus ride-along `/api/list` envelope unification with `/api/search`/`/api/recent` and a tool-count consolidation pass (`memory_delete` + `memory_forget` → `memory_delete(mode)`).

**Candidate items:** OpenClaw integration addon (ROADMAP §Capture path), Claude-mem bridge (ROADMAP §Capture path), cross-device markdown sync (ROADMAP §Capture path), `/api/list` envelope unification (v0.4 deferred), tool-count consolidation (v0.5 deferred).

### v0.7 — multi-provider + launch-ready (~3 weeks)
Provider neutrality: embeddings + summarizer + fact-extraction swappable via env flag between OpenAI / Anthropic / Google / Ollama (no mem0-YAML editing). Plus: self-bootstrap `curl | bash` installer (tarball + stdin-detection pattern), operational debt batch (Qdrant v1.13.x pin, image size reduction, history DB persistence), v0.4 review Minor findings M1–M10 cleanup, Windows CI matrix, and public-repo-prep checklist (ROADMAP's pre-public gate).

### v1.0
Stable API, externally usable, publicly announced. No new features — the combination of v0.5 + v0.6 + v0.7 reaches the bar defined in [Distribution / release](#distribution--release).

### post-v1.0
Working examples / demos bundle for adoption (OpenAI Agents SDK, LangChain-style integrations, provider-specific examples, npm client as reference implementation). Plus the power-user enrichment tier: vault web UI (#16), Kuzu graph memory + bi-temporal metadata, synthesis Layer 2 passes (workspace-dream skill, cross-project compile, ADR topic compile), Codex lifecycle hooks (#17 — upstream-gated regardless of timeline).

## Near-term — plug-and-play arc

Three ordered plans that collectively eliminate manual `docker compose` invocation for the end user. Each is independent and ships value on its own.

### 1. Install wizard (`server/install.sh`) — ✅ shipped in v0.1.1
**Why:** `cp .env.example .env && edit .env && docker compose up -d` is three steps and requires knowing what to edit. An interactive script prompts for the required values, writes `.env`, runs `docker compose up -d`, and polls `/health`. Single command, no editing.
**Status:** shipped in [v0.1.1](https://github.com/goldenwo/universal-memory/releases/tag/v0.1.1).

### 2. CI workflow + GHCR image publishing
**Why:** Two wins at once. (a) CI proves portability continuously: every PR spins up the stack on fresh Ubuntu and runs the smoke test — no more "works on my machine." (b) CI publishes the built image to `ghcr.io/goldenwo/universal-memory-server:<tag>`. Users pull the prebuilt image instead of building locally — first-run latency drops from ~2 min (npm install + build) to ~20 s (image pull).
**Scope:** small plan. `.github/workflows/ci.yml` with a smoke-test job and a publish job (on tag push). Requires setting `GHCR_TOKEN` secret.
**Depends on:** install wizard (CI smoke test can invoke it).

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

### `create-adr` skill + `/adr` slash command
**Why:** ADR workflow first-class support. Writes the new ADR file using the template, creates the git commit, posts the atomic fact to the memory server.
**Scope:** small plan. One skill + slash command + post-commit hook hook.
**Decisions needed:** invocation model — `/adr` slash command vs keyword detection vs end-of-session batch.

### OpenClaw integration addon
**Why:** For users who also run OpenClaw. `workspace-dream` skill for the Pi's hand-curated workspace markdown + autoCapture retrofit to write markdown before POSTing to the memory server.
**Scope:** medium plan. Requires coordinating with the `openclaw-mem0` plugin maintainer or forking.

### Claude-mem bridge
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

### Qdrant version alignment
Current: image pinned to `qdrant/qdrant:v1.11.3`, but `mem0ai`'s bundled client is `1.13.x` — benign warning in logs. Pin image to a matching `v1.13.x` tag and upgrade existing data directories.

### Image size
Current image is ~583 MB. Dominated by mem0ai's transitively-bundled LLM provider SDKs (`@azure` 58 MB, `cloudflare` 52 MB, `@google`, `@mistralai`, `@langchain`) that we don't use. Options: fork mem0ai to mark providers as optional, wait for upstream to move providers to peer deps, or build a custom minimal image.

### History DB persistence
Current: `/tmp/mem0-history.db` (ephemeral, reset on container restart). Users who want audit history of mem0 edits should be able to bind-mount a persistent location without editing config. Ship a commented volume mount example in `docker-compose.yml`.

## Open architectural decisions

| Topic | Blocking |
|---|---|
| ADR invocation model (`/adr` vs keyword vs end-of-session batch) | `create-adr` skill |
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
