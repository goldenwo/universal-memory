---
description: Force a memory checkpoint — summarize current session + update state.md
---

Execute `bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.sh"` via the Bash tool.

This fires the same detached `POST /api/checkpoint {project}` that `SessionEnd` sends automatically
on a clean exit — running it on demand just doesn't require exiting first. The hook returns
immediately (the POST itself is DETACHED, on its own 120s client-side `curl --max-time` — not a
server-side budget; server-side synthesis can still take a while, this just bounds how long the
detached child waits for it); the outcome lands in `~/.um/hook.log` (`posted http=200` / `error=...`
/ `skip=...`), not in this command's own output. There is no client-side summarizer or `state.md`
merge anymore — the server's checkpoint pipeline owns synthesis end to end.

**Chunked semantics.** Server-side, checkpoint synthesis is chunked: each call digests at most a
few chunks of raw captures (shipped default 3), each an independently committed transaction, then
reports whether more backlog remains (`backlog_remaining`). A normal session's worth of captures
fits in one chunk, so one call is usually enough. If the project has a large undigested backlog —
after an outage, a long gap between sessions, or a first-ever checkpoint on an older project — a
single call can leave `backlog_remaining: true`; the fix is simply to run this command again. Each
call resumes exactly where the last one left off (a durable per-project cursor, not a re-read of
everything), so repeated calls are the normal way to catch up — never lossy, at worst a little
redundant across a crash boundary.

Use this before:
- Switching devices — ensures `state.md` on disk is current so the next session picks up fresh context
- Approaching auto-compact — the post-compact session reads the refreshed `state.md` via the SessionStart hook
- Long breaks — avoids relying on `SessionEnd` firing cleanly (which it often doesn't: crashes, kills, and terminal closes all skip it)

**Draining a large backlog.** This command is for one session's on-demand checkpoint. To catch up a
large backlog across many calls or many projects at once (e.g. after an extended outage), use the
operator tool `bin/um-drain.sh` instead — it loops the same POST until `backlog_remaining: false`,
with a cost estimate and confirm gate up front. See the paragraph on progressive drain semantics
right below the plugin README's component table.

The hook is fail-soft: missing API key, server down, malformed LLM output — all surface as warnings
in `~/.um/hook.log`, never data loss. Raw captures stay on disk either way; nothing already digested
is ever re-read.
