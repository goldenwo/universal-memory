---
description: Preview a local draft of state.md from today's captures (no file writes)
---

Execute `bash "${CLAUDE_PLUGIN_ROOT}/bin/um-preview"` via the Bash tool and show the output verbatim.

This is a **local, client-side draft**, not a preview of what a checkpoint will write. It reads today's
raw captures from the local vault (`$UM_VAULT_DIR`, default `~/.um/vault`), summarizes them and merges
the summary into the current `state.md` with the plugin's own `summarize.sh` and `update-state.sh`.
Checkpoints no longer run that pipeline: `/um-checkpoint` and `SessionEnd` POST to the server, whose
checkpoint synthesis (chunked digestion and section-aware state shaping) writes the real `state.md`. The
two can differ, and against a remote server with no local vault there is nothing for this draft to read.

It writes nothing:
- No write to `$UM_VAULT_DIR/state/<project>/state.md`
- No lockdir acquisition
- No cost-log.csv telemetry append (`update-state.sh --stdout` suppresses it)
- No reindex

It needs an OpenAI key on this machine (`UM_OPENAI_API_KEY` or `OPENAI_API_KEY`). It is fail-soft:
a missing key, empty captures or an LLM error exits non-zero with a message on stderr and never
corrupts data.
