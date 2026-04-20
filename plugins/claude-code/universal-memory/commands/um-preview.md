---
description: Preview what state.md would look like right now (no file writes)
---

Execute `bash "${CLAUDE_PLUGIN_ROOT}/bin/um-preview"` via the Bash tool and show the output verbatim.

This is a PREVIEW — a draft of what `state.md` would contain if `session-end.sh` ran right now. It does NOT modify any files in the vault:
- No write to `$UM_VAULT_DIR/state/<project>/state.md`
- No lockdir acquisition
- No cost-log.csv telemetry append (`update-state.sh --stdout` suppresses it)
- No reindex

Use this to sanity-check the merge before committing. If the preview looks good and you want to commit it, run `/um-checkpoint` instead — that invokes the canonical session-end pipeline that writes to disk and reindexes.

The underlying CLI is fail-soft: missing API key, empty captures, or LLM errors all exit non-zero with a human-readable message on stderr; they never corrupt data.
