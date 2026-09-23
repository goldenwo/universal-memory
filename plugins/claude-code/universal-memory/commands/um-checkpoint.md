---
description: Force a memory checkpoint — summarize current session + update state.md
---

Execute `bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.sh"` via the Bash tool.

This fires the same `POST /api/checkpoint {project, mode:"accepted"}` that `SessionEnd` sends
automatically on a clean exit — running it on demand just doesn't require exiting first.

**The command reports acceptance, not completion (#309).** The server validates the request, answers
`202` immediately, and runs synthesis afterwards, so the hook is back in well under a second and
writes `accepted project=<slug>` to `~/.um/hook.log`. That line means the job was **taken**, not that
anything was digested — success or failure is decided minutes later, and the outcome reaches neither
this command nor the log. A failed checkpoint surfaces instead in the daily `um-alert.sh` run, under
its `CHECKPOINT-FAILURE` section. Pre-flight problems (`error=auth`, `skip=writes-disabled`,
`error=input-invalid`, `error=http-000`) are still decided before the 202 and still land in the log.

There is no client-side summarizer or `state.md` merge — the server's checkpoint pipeline owns
synthesis end to end.

**Chunked semantics.** Server-side, checkpoint synthesis is chunked: each call digests at most a
few chunks of raw captures (shipped default 3), each an independently committed transaction, then
reports whether more backlog remains. A normal session's worth of captures fits in one chunk, so one
call is usually enough. If the project has a large undigested backlog — after an outage, a long gap
between sessions, or a first-ever checkpoint on an older project — a single call can leave work
behind. Each call resumes exactly where the last one left off (a durable per-project cursor, not a
re-read of everything), so repeated calls are the normal way to catch up — never lossy, at worst a
little redundant across a crash boundary.

**Draining without feedback.** The empty 202 carries no `backlog_remaining`, so this command can no
longer tell you whether more work is left; re-running it is still how you continue a drain, you just
do it blind. Re-running while a checkpoint is still synthesising is **harmless** — the second call
hits the per-project lock and resolves as `contended`, which is recorded and never alerted — but it
also does nothing, so pacing the calls is worth more than stacking them. To watch a drain **with**
progress, use `bin/um-drain.sh` instead: it POSTs directly, is not an opt-in caller, reads
`backlog_remaining` and `stopped.reason` itself, and is unaffected by accepted mode. And a drain that
has genuinely stopped shows up in `um-alert.sh`'s `CHECKPOINT-FAILURE` section, not here.

Use this before:
- Switching devices — ensures `state.md` on disk is current so the next session picks up fresh context
- Approaching auto-compact — the post-compact session reads the refreshed `state.md` via the SessionStart hook
- Long breaks — avoids relying on `SessionEnd` firing cleanly (which it often doesn't: crashes, kills, and terminal closes all skip it)

**Many projects at once.** To catch up a large backlog across many projects (e.g. after an extended
outage), use the operator tool `bin/um-drain.sh` — it loops the same POST until
`backlog_remaining: false`, with a cost estimate and confirm gate up front. See the paragraph on
progressive drain semantics right below the plugin README's component table.

The hook is fail-soft: missing API key, server down, malformed LLM output — none of them lose data.
Raw captures stay on disk either way and nothing already digested is ever re-read, so an undigested
session is a delay, not a loss.
