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
#     000=unreachable + G7 banner text). Checkpoint-specific: a 502 means
#     UPSTREAM_FAILURE, but its TWO possible meanings disambiguate on the
#     response body's additive `error.stage` field (checkpoint chunked
#     summarization spec §4.7): stage "reindex" (or ABSENT — a legacy
#     pre-chunking server never sent stage at all, and for it every 502 WAS
#     the reindex-exhausted case) means state.md WAS written and only the
#     vector index is stale — the log carries note=state-written-index-stale.
#     stage "summarize" means nothing was written at all (a 0-chunk
#     summarizer failure) — logged plainly, no note. This requires the
#     response BODY, not just $UM_API_HTTP_CODE — see the mktemp
#     body-capture pattern below (um_api_post outside command substitution;
#     UM_API_HTTP_CODE does not survive a subshell — bin/um-alert.sh:134-136).
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

# #186: slug derivation now runs through the non-project guard
# (lib/project_guard.py): meta.cwd → $CLAUDE_CWD → pwd resolved as a FULL
# path, then home-check + marker walk-up. Every non-project outcome is an
# explicit SKIP sentinel — there is deliberately NO unguarded bash fallback
# (the old `[ -z "$PROJECT" ]` leg re-minted the exact home-basename slug the
# guard suppresses). Fail closed: guard failure ⇒ skip, never a bad slug.
GUARD_PY="$SCRIPT_DIR/lib/project_guard.py"
if command -v cygpath >/dev/null 2>&1; then GUARD_PY=$(cygpath -w "$GUARD_PY"); fi
PROJECT=$(printf '%s' "$HOOK_INPUT" | \
  UM_GUARD_FALLBACK="${CLAUDE_CWD:-$(pwd)}" "$PY" "$GUARD_PY" 2>/dev/null)

case "$PROJECT" in
  SKIP:*) um_log "skip=${PROJECT#SKIP:}"; exit 0 ;;
  '')     um_log "skip=guard-failed";     exit 0 ;;
esac
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
#
# STRUCTURAL change (checkpoint chunked summarization spec §4.7): the body is
# now captured to a temp file (um_api_post OUTSIDE command substitution —
# UM_API_HTTP_CODE does not survive a subshell, same mktemp pattern
# bin/um-alert.sh uses) instead of discarded via >/dev/null, so the 502
# branch can read `error.stage` and disambiguate its two meanings. Every
# other reason-taxonomy branch, and the detached + fail-open structure, are
# unchanged byte-for-byte.
# ---------------------------------------------------------------------------
ENDPOINT=$(um_api_endpoint 2>/dev/null)
(
  # Review round 1, MINOR 2: a bare `mktemp` failure (disk full, unwritable
  # TMPDIR) would leave CKPT_BODY_FILE empty; `> "$CKPT_BODY_FILE"` then
  # redirects to "" and fails BEFORE um_api_post ever runs, so
  # UM_API_HTTP_CODE is never set — under this script's `set -u`, the `case`
  # below would hit an unbound-variable error and the child would exit with
  # NOTHING logged. Fall back to /dev/null: the POST still fires and
  # UM_API_HTTP_CODE still gets set; only the 502 stage-parse degrades (to
  # the same safe "note present" reading an absent/legacy stage already
  # gets), never a silent, unlogged death.
  CKPT_BODY_FILE=$(mktemp 2>/dev/null) || CKPT_BODY_FILE=/dev/null
  if um_api_post '/api/checkpoint' "$BODY" 120 > "$CKPT_BODY_FILE" 2>/dev/null </dev/null; then
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
        # Two 502 meanings disambiguate on error.stage (spec §4.7):
        #   "reindex" or ABSENT (legacy server, predates the field) ->
        #     state.md WAS written; only the reindex/vector step failed ->
        #     partial success, not a lost session -> the note.
        #   "summarize" -> nothing was written at all (0-chunk summarizer
        #     failure) -> logged plainly, no note.
        CKPT_STAGE=$("$PY" -c '
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    err = d.get("error") if isinstance(d.get("error"), dict) else {}
    print(err.get("stage") or "")
except Exception:
    print("")
' "$CKPT_BODY_FILE" 2>/dev/null)
        if [ "$CKPT_STAGE" = "reindex" ] || [ -z "$CKPT_STAGE" ]; then
          um_log "error=http-502 note=state-written-index-stale"
        else
          um_log "error=http-502 stage=$CKPT_STAGE"
        fi
        ;;
      *)
        um_log "error=http-$UM_API_HTTP_CODE"
        ;;
    esac
  fi
  # Never rm the /dev/null fallback itself (the mktemp-failure leg above).
  [ "$CKPT_BODY_FILE" = "/dev/null" ] || rm -f "$CKPT_BODY_FILE"
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
