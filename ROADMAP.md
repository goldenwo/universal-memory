# Roadmap

Status and open work for **universal-memory**. Items are loosely prioritized; actual ordering shifts with real-world needs. Each item is a candidate for its own plan + execution cycle.

## Shipped

| Version | What | Evidence |
|---|---|---|
| [v0.1.0](https://github.com/goldenwo/universal-memory/releases/tag/v0.1.0) | Memory server — Docker Compose + lifted mem0 HTTP server, vector-only, smoke-tested | Commit `58ad82d` on `main` |

Foundations also shipped alongside v0.1.0:

- Architecture doc ([docs/architecture.md](docs/architecture.md)) — source/synthesis/index role-based frame
- Four ADRs documenting the architectural decisions to date
- Implementation plan + review loop discipline ([docs/plans/2026-04-16-memory-server-v0.1.md](docs/plans/2026-04-16-memory-server-v0.1.md))

## Near-term — next 1–3 items to plan

### CI workflow (GitHub Actions)
**Why:** Turns the "portability" claim from a statement into a continuously-verified fact. Fresh Ubuntu runner + `docker compose up` + smoke test on every PR. Catches regressions in the Dockerfile, deps, or `mem0ai` updates before they reach users.
**Scope:** small plan. One `.github/workflows/smoke.yml` + secrets setup.

### Claude Code plugin manifest
**Why:** Hooks are already lifted into [plugins/claude-code/universal-memory/hooks/](plugins/claude-code/universal-memory/hooks/) — we need the `plugin.json` manifest + `.claude-plugin/` metadata so the plugin is installable via the Claude Code marketplace pattern.
**Scope:** small plan. One manifest + README install instructions.

### Install wizard
**Why:** `cp .env.example .env && vim .env` is friction. An interactive `server/install.sh` that prompts for `OPENAI_API_KEY`, `MEM0_USER_ID`, port, etc., writes `.env`, then `docker compose up -d` gets a user to working in seconds.
**Scope:** small plan. Shell or Python script, plus a Windows PowerShell equivalent.

## Layer 3 enrichment (index upgrades)

### Kuzu graph memory ([ADR-0004](docs/decisions/0004-kuzu-for-graph-memory.md))
**Why:** Multi-hop queries over ADR relationships (`supersedes`, `depends_on`, `contradicts`). Vector search can't answer "what depends on the choice to use PostgreSQL?"
**Scope:** medium plan. Install `kuzu` optional dep in server image + update mem0 config + define graph schema for ADR-specific edges + extraction pipeline to populate edges from ADR frontmatter.
**Blocked on:** validating mem0 OSS's Kuzu integration works in our setup (documented as production-supported since Sep 2025; haven't tested it ourselves).

### Bi-temporal metadata on index facts
**Why:** Borrowed from Zep ([ADR-0001](docs/decisions/0001-adopt-source-synthesis-index-frame.md)). Each fact gets `valid_from` / `invalidated_at` so superseded information doesn't surface at recall time. Essential for ADR workflows where decisions get overturned.
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
**Decisions needed:** ADR-0005 (invocation model — `/adr` slash vs keyword detect vs end-of-session batch).

### OpenClaw integration addon
**Why:** For users who also run OpenClaw. `workspace-dream` skill for the Pi's hand-curated workspace markdown + autoCapture retrofit to write markdown before POSTing to the memory server.
**Scope:** medium plan. Requires coordinating with the `openclaw-mem0` plugin maintainer or forking.

### Cross-device markdown sync
**Why:** Windows per-project auto-memory currently can't be read from Pi (and vice versa). Mem0 is the only cross-device surface today.
**Decisions needed:** ADR-0006 (Syncthing vs nightly `git push` vs a sync daemon).
**Scope:** small-medium plan. Depends on chosen mechanism.

## Operational debt (lower priority, known)

### Qdrant version alignment
Current: image pinned to `qdrant/qdrant:v1.11.3`, but `mem0ai`'s bundled client is `1.13.x` — benign warning in logs. Pin image to a matching `v1.13.x` tag and upgrade existing data directories.

### Image size
Current image is ~583 MB. Dominated by mem0ai's transitively-bundled LLM provider SDKs (`@azure` 58 MB, `cloudflare` 52 MB, `@google`, `@mistralai`, `@langchain`) that we don't use. Options: fork mem0ai to mark providers as optional, wait for upstream to move providers to peer deps, or build a custom minimal image.

### History DB persistence
Current: `/tmp/mem0-history.db` (ephemeral, reset on container restart). Users who want audit history of mem0 edits should be able to bind-mount a persistent location without editing config. Ship a commented volume mount example in `docker-compose.yml`.

## Open architectural decisions (ADRs yet to write)

| ADR | Topic | Blocking |
|---|---|---|
| 0005 | ADR invocation model (`/adr` vs keyword vs end-of-session batch) | `create-adr` skill |
| 0006 | Cross-device markdown sync mechanism (Syncthing / git / daemon) | Cross-device sync work |
| 0007 | Raw capture co-location with Claude Code's per-project `memory/` dir | Stop-hook retrofit usability — deferred until autoDream behavior on custom subdirs is tested |
| 0008 | Two deployment modes (cloud via mem0.ai vs self-hosted) — whether to support cloud mode officially | User-facing install flow |

## Distribution / release

### Public repo
Currently private. Going public when the shape is stable, the ADR invocation model is decided, and there's at least one external-user walkthrough (solo developer on macOS, no OpenClaw, no Pi) that demonstrably works.

### Plugin marketplace listing
After Claude Code plugin manifest is in and CI is green, register with the Claude Code plugin marketplace conventions.

## How this doc is maintained

- When a new plan is written, the item moves into the "next 1–3 items" list.
- When a plan ships, the item moves to "Shipped" with evidence (commit SHA + tag).
- Items can split or merge as we learn more. Don't worship the structure — use it.
- ADRs don't go here; they live under [docs/decisions/](docs/decisions/). This doc points at them.
