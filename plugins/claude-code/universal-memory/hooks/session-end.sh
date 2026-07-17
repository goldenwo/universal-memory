#!/usr/bin/env bash
# session-end.sh v2 — detached checkpoint trigger to POST /api/checkpoint
# (#159 T4, spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §5).
#
# Claude Code passes SessionEnd hooks a small metadata JSON on stdin
# ({session_id, transcript_path, cwd, reason, hook_event_name, ...}). This
# hook reads it ONLY to derive the project slug — no transcript parsing, no
# client-side summarizer (the server's checkpoint pipeline owns synthesis;
# the old summarize.sh/update-state.sh orchestration is retired).
#
# Behavior (all pinned by spec §5):
#   - POST /api/checkpoint {project} — DETACHED (the v2 keeps the old
#     UM_DETACH wisdom): the parent backgrounds a fully fd-detached child
#     and returns immediately; server-side LLM synthesis routinely exceeds
#     the shared 10s curl budget, so the child uses its own 120s max-time
#     and Claude Code's hook timeout never sees the wait.
#   - The CHILD logs the final result to ~/.um/hook.log. Reason taxonomy
#     (same as stop.sh, spec §5 T3-review amendment): skip=writes-disabled
#     (403, + G7 banner text), error=input-invalid (400), error=auth (401),
#     skip=server-too-old (other non-403 4xx), error=http-<code> (5xx,
#     000=unreachable + G7 banner text). Checkpoint-specific: 502
#     UPSTREAM_FAILURE means state.md WAS written and only the vector index
#     is stale — the log carries note=state-written-index-stale.
#   - Project = cwd basename, sanitized to [A-Za-z0-9._-] client-side
#     (mirrors the server's PROJECT_SLUG_RE; unsanitized slugs 400).
#   - Fail-open: the parent always exits 0 — CC session integrity beats
#     capture.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_HOOK_NAME="session-end"
# shellcheck source=lib/um-api.sh
source "$SCRIPT_DIR/lib/um-api.sh"

# ---------------------------------------------------------------------------
# stdin = hook metadata JSON. Only cwd matters here.
# ---------------------------------------------------------------------------
HOOK_INPUT=$(cat)
if [ -z "$HOOK_INPUT" ]; then um_log "skip=empty-stdin"; exit 0; fi

PY=$(um_find_python) || { um_log "skip=no-python"; exit 0; }

PROJECT=$(printf '%s' "$HOOK_INPUT" | "$PY" -c '
import json, os, sys
try:
    meta = json.load(sys.stdin)
except Exception:
    print("SKIP:bad-stdin"); sys.exit(0)
cwd = meta.get("cwd") or ""
print(os.path.basename(cwd.replace("\\", "/").rstrip("/")) if cwd else "")
' 2>/dev/null)

case "$PROJECT" in
  SKIP:*) um_log "skip=${PROJECT#SKIP:}"; exit 0 ;;
esac
if [ -z "$PROJECT" ]; then PROJECT=$(basename "${CLAUDE_CWD:-$(pwd)}"); fi
# Sanitize client-side — the server hard-fails non-[A-Za-z0-9._-] projects
# (400), same guard as stop.sh (spec §5 amendment).
PROJECT="${PROJECT//[^A-Za-z0-9._-]/-}"

# Safe to interpolate: the slug is reduced to [A-Za-z0-9._-] above, so no
# JSON metacharacters can survive into the body.
BODY="{\"project\":\"$PROJECT\"}"

# ---------------------------------------------------------------------------
# Detached child. All three fds are detached so the parent's caller (and the
# test harness's command substitution) never waits on the child; um_log is
# the child's only output channel. `disown` drops it from job control so a
# parent-shell teardown can't HUP it mid-checkpoint.
# ---------------------------------------------------------------------------
ENDPOINT=$(um_api_endpoint 2>/dev/null)
(
  if um_api_post '/api/checkpoint' "$BODY" 120 </dev/null >/dev/null 2>&1; then
    um_log "posted http=$UM_API_HTTP_CODE"
  else
    case "$UM_API_HTTP_CODE" in
      403)
        um_log "skip=writes-disabled"
        # SessionEnd has no visible channel (spec §5 G7) — the banner text
        # goes to hook.log; session-start.sh owns the user-visible surface.
        um_log "$(um_g7_message writes-disabled)"
        ;;
      000)
        um_log "error=http-000"
        um_log "$(um_g7_message unreachable "$ENDPOINT")"
        ;;
      # 400/401 carved out of server-too-old (spec §5 T3-review amendment).
      400)
        um_log "error=input-invalid"
        ;;
      401)
        um_log "error=auth"
        ;;
      4[0-9][0-9])
        um_log "skip=server-too-old http=$UM_API_HTTP_CODE"
        ;;
      502)
        # Checkpoint UPSTREAM_FAILURE: state.md WAS written; only the
        # reindex/vector step failed — partial success, not a lost session.
        um_log "error=http-502 note=state-written-index-stale"
        ;;
      *)
        um_log "error=http-$UM_API_HTTP_CODE"
        ;;
    esac
  fi
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
