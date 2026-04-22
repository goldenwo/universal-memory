---
schema_version: 1
type: state
id: state-universal-memory-v04
title: State of play — universal-memory v0.4
status: current
valid_from: 2026-04-21T10:30:00Z
project: universal-memory
---

# State of play — universal-memory

## Current focus

Executing Phase 0 of the v0.4 HYBRID-REBALANCE plan. Phase 0 is a measurement and scaffolding phase (no behavior changes yet). Task 0.1 (token-cost harness stub) and Task 0.2 (dev-dep isolation audit) are complete. Task 0.3 (measurement sweep + baseline capture) is in progress.

## In flight

- **Task 0.3** — Extending `server/test/token-cost.test.mjs` with 4 additional measurement locations (MCP response payloads, SessionStart injection, summarizer prompt). Fixtures created at `server/test/fixtures/`. Baseline output will be committed to `server/test/token-cost-baseline.txt`.
- **Task 0.4** — SessionStart boundary investigation (scoped to state.md only for Task 0.3; full boundary map deferred to 0.4). Not yet started.
- Branch: `v0.4-hybrid-rebalance` (worktree at `E:\Projects\universal-memory-v0.4`)

## Recent decisions

- 2026-04-21: DROP the .gitignore note from Task 0.3 Step 2 — the baseline IS committed. The plan had a contradiction; resolution is: commit the baseline file, do not gitignore it.
- 2026-04-21: Tokenizer methodology for Phase 0: tiktoken o200k_base primary for mixed/CLI-agnostic surfaces (MCP schemas, response payloads, summarizer prompt); @anthropic-ai/tokenizer secondary for reference. SessionStart injection is Claude-consumed — emphasize anthropic number there.
- 2026-04-21: Vault web UI (D.5.2–D.5.4) deferred to v0.4+, tracked in GH issue #16. Revisit when multi-user/shared-host direction clarifies.
- 2026-04-20: HYBRID-REBALANCE resolved: MCP transport for Claude Code, REST/OpenAPI for Codex/ChatGPT. Canonical record in `docs/research/2026-04-20-mcp-vs-api-cli.md`. Trigger conditions logged; don't re-open without a flip trigger.
- 2026-04-20: v0.4 plan passed 5 rounds of Opus-pair review (21→17→8→5→1 open items). Phase-0-ready. Subagent-driven-development approach confirmed for implementation phase.
- 2026-04-17: Adopted Path B (session-continuity focus) as v0.2.0 strategic direction; Path A deferred. All three continuity pillars (summaries, state-of-play, versioning) shipped in v0.2.0-alpha.

## Next actions

1. Complete Task 0.3: run `node --test server/test/token-cost.test.mjs`, capture output to `server/test/token-cost-baseline.txt`, commit with message `chore(phase-0): capture token-cost baseline`
2. Start Task 0.4: SessionStart boundary investigation — map exactly what tokens CC receives at session start, distinguish UM-injected vs. global CLAUDE.md vs. mem0-pi auto-inject
3. After Task 0.4: review Phase 0 findings, draft go/no-go for Phase A (snippet-on-read) based on baseline numbers
4. Open implementation issue for Task A.1 once Phase 0 gate clears

## Open questions

- What is the exact token budget for Claude Code's `additionalContext` field? The session-start.sh comment says "~1k tokens max" but this is undocumented by Anthropic — Task 0.4 should pin this down empirically.
- Should Phase A (snippet-on-read) land before or after the B-series (quality + pruning)? The plan has A before B, but if baseline numbers show response payloads are already large, A might need a size gate first.
- `memory_capture` vs `memory_add` consolidation: the codebase has both. The routing rubric covers both but the tool duplication is a maintenance burden — defer to v0.4.1?

## Environment

- Branch: `v0.4-hybrid-rebalance` (worktree at `E:\Projects\universal-memory-v0.4`)
- Main branch: `main` (in original worktree `E:\Projects\universal-memory`)
- Node: v22.x, test runner: `node --test`
- Docker Compose stack: NOT running during Phase 0 (measurement only, no live server calls)
- Dev deps in scope: tiktoken, @anthropic-ai/tokenizer (dev-only, confirmed NOT in Docker image by Task 0.2)
