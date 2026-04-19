---
schema_version: 1
type: state
id: state-universal-memory
title: State of play — universal-memory
status: current
valid_from: 2026-04-17T14:32:00Z
project: universal-memory
---

# State of play — universal-memory

## Current focus

Implementing v0.2.0 session-continuity features. The immediate work is Task 2
(state.md concept doc + fixture), one step in the Phase A documentation pass
that must be complete before the Phase B implementation begins.

## In flight

- Task 2: writing `docs/state-of-play.md` and `server/test/fixtures/sample-state.md`; commit pending
- Task 1 complete: `docs/frontmatter-schema.md` landed in commit `a3f9c12`
- Task 3 not started: session-summary concept doc; depends on nothing, can begin immediately after Task 2
- Phase B implementation (Tasks 4–12) blocked on Phase A docs pass (Tasks 1–3) per plan gate

## Recent decisions

- 2026-04-17: Adopted Path B (session-continuity focus) as v0.2.0 strategic direction; Path A (social/multi-user) deferred to v0.3.x
- 2026-04-17: `state.md` is not indexed in mem0; accessed only by direct file read to avoid polluting semantic search with transient session state
- 2026-04-16: Fixed headers required verbatim — no free-form section names — so SessionStart hook can use a simple substring match rather than an LLM parse
- 2026-04-16: Size cap set at ~3000 chars; LLM writer is responsible for evicting old "Recent decisions" entries rather than a separate trimming script
- 2026-04-15: `valid_from` drives staleness calculation (not file mtime) so the file ages correctly across git clones and vault syncs
- 2026-04-14: Catchup designated as primary writer; SessionEnd is bonus path because termination is frequently abrupt and hook may not fire reliably

## Next actions

1. Commit Task 2 files: `git add docs/state-of-play.md server/test/fixtures/sample-state.md && git commit -m "docs: state-of-play concept + fixture"`
2. Begin Task 3: write `docs/session-summary.md` concept doc
3. Review Task 2.5 gate criteria (blocking Phase B) — confirm all Phase A docs are present before opening Phase B issues
4. Open implementation issue for Task 4 (raw-capture writer) once gate clears

## Open questions

- Should `memory_state()` return an error or an empty response when `state.md`
  is missing? The SessionStart hook silently skips; the MCP tool behavior is
  not yet specified. Needs decision before Task 8 (MCP tool implementation).
- Staleness threshold of 30 days: is this too long for active projects? A project
  worked daily for a month will never see a stale state, but one touched once a
  week might inject a 29-day-old file. Revisit after dogfooding.
- `/um-checkpoint` command: does this live in the Claude Code plugin manifest, or
  is it a user-defined slash command alias? Task 13 (merge prompt) will clarify
  the invocation path.

## Environment

- Branch: `close-continuity-gap` (worktree at `.claude/worktrees/close-continuity-gap`)
- Main branch: `main` (clean, no pending merges)
- Node server entry point: `server/mem0-mcp-http.mjs`
- Test runner: `server/test/smoke.sh`
- No long-running processes; Docker Compose stack is not currently running
