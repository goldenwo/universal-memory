# Project conventions for AI agents

> Universal rules live in `~/.claude/CLAUDE.md` (Claude Code) and its generated mirror
> `~/.codex/AGENTS.md` (Codex CLI) and apply to every repo on this machine. This file
> is project framing only.

## State
- `.claude/state.json` holds the objective, current focus, and deliverables. The
  SessionStart hook prints a WHERE YOU ARE block from it on both tools; update it with
  the `update-state` skill and write `.claude/handoffs/latest.md` with `handoff` before
  a session ends.

## Always do / Never do / Ask first
- (project-specific rules go here — see `.claude/CLAUDE.md` if one is added later)
