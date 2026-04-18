---
description: Force a memory checkpoint — summarize current session + update state.md
---

Execute `bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.sh"` via the Bash tool.

This runs the universal-memory session-end pipeline on demand:
- Reads today's raw captures for the current project from `$UM_VAULT_DIR/captures/<project>/raw/`
- Calls `summarize.sh` to produce a session summary via the configured LLM
- Merges the summary into `state.md` via `update-state.sh` (preserving human edits)
- Reindexes the session summary via `POST /api/reindex` (state.md is never reindexed)

Use this before:
- Switching devices — ensures `state.md` on disk is current so the next session picks up fresh context
- Approaching auto-compact — the post-compact session reads the refreshed `state.md` via the SessionStart hook
- Long breaks — avoids relying on `SessionEnd` firing cleanly (which it often doesn't: crashes, kills, and terminal closes all skip it)

The hook is fail-soft: missing API key, server down, malformed LLM output — all surface as warnings, never data loss. Raw captures stay on disk either way.
