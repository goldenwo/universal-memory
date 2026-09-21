#!/usr/bin/env bash
# session-end.sh v3 — inline checkpoint trigger to POST /api/checkpoint
# (#159 T4, spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §5;
#  #309 accepted mode, docs/plans/2026-09-17-309-checkpoint-accepted-mode-*).
#
# Claude Code passes SessionEnd hooks a small metadata JSON on stdin
# ({session_id, transcript_path, cwd, reason, hook_event_name, ...}). This
# hook reads it ONLY to derive the project slug — no transcript parsing, no
# client-side summarizer (the server's checkpoint pipeline owns synthesis;
# the old summarize.sh/update-state.sh orchestration is retired).
#
# Behavior:
#   - POST /api/checkpoint {project, mode:"accepted"} — INLINE. v2 detached an
#     fd-detached child with its own 120s max-time, because server-side LLM
#     synthesis routinely exceeds the shared 10s curl budget. #309 proved that
#     structure is what broke Codex capture: under `codex exec` the child was
#     reaped before the POST completed (0/26 runs; 5/5 the moment anything kept
#     the PARENT alive a few ms longer). The fix moves the wait to the server —
#     accepted mode validates, answers an empty 202, and synthesises afterwards
#     — so this hook has nothing left to outlive and runs inline on the default
#     budget. The old `disown` comment claimed it protected against parent
#     teardown; it did not, and that claim is what the issue disproved.
#   - The hook logs the result to ~/.um/hook.log. On the 202 the line is
#     `accepted project=<slug>`, which means ACCEPTED, NOT DIGESTED: synthesis
#     has not started and its outcome never reaches this log. A failed
#     synthesis surfaces server-side instead, via the #309
#     signal.checkpoint_failure counter and um-alert.sh's CHECKPOINT-FAILURE
#     arm. A plain `posted http=200` line is still reachable — that is an older
#     server ignoring the unknown `mode` key and synthesising synchronously.
#   - Reason taxonomy for non-2xx (same as stop.sh, spec §5 T3-review
#     amendment): skip=writes-disabled (403, + G7 banner text),
#     error=input-invalid (400), error=auth (401), skip=server-too-old (other
#     non-403 4xx), error=http-<code> (5xx, 000=unreachable + G7 banner text).
#     The 502 `error.stage` disambiguation v2 carried here is GONE along with
#     its mktemp body-capture scaffolding: every synthesis outcome now happens
#     after the 202, where this hook cannot observe it.
#   - Project = the guard's ROOT-derived slug (#294 D1; naming rule:
#     project_guard.py guard() — the canonical statement), sanitized to
#     [A-Za-z0-9._-] client-side (mirrors the server's PROJECT_SLUG_RE;
#     unsanitized slugs 400).
#   - Fail-open: the hook always exits 0 — CC session integrity beats capture.

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
#
# #309: `mode:"accepted"` opts this call into the server's accepted mode — the
# server validates, answers an empty 202, and synthesises AFTER the response.
# That is what lets this hook survive a host that reaps its process tree: there
# is no longer any work for it to outlive. An older server ignores the unknown
# key and runs synchronously (handleCheckpointRequest destructures known keys),
# which is why T1 and T3 must land together — see the plan's Sequencing note.
BODY="{\"project\":\"$PROJECT\",\"mode\":\"accepted\"}"

# ---------------------------------------------------------------------------
# INLINE, not detached (#309). The detached child that used to live here is
# gone, and with it the `disown` that carried a comment claiming it protected
# against parent teardown. It did not: under `codex exec` the child was reaped
# before the POST completed, 0/26 runs, which is the whole of issue #309. The
# request is now sub-second (the server answers 202 after validation and
# synthesises afterwards), so there is nothing left to outlive and no reason to
# detach.
#
# The 120s budget went with it — synthesis no longer happens on this call, so
# um_api_post's default (3s connect / 10s total) applies. Note the cost, which
# is deliberate and accepted rather than overlooked: SessionEnd is now
# SYNCHRONOUS on BOTH hosts, so an unreachable or slow server blocks Claude
# Code's session teardown for up to that budget (~21s on the #307 429-retry
# path: max-time + 1s sleep + max-time) where it used to return instantly.
# That is still a 12x improvement on the old worst case, and a client-side
# timeout cannot lose work — the server registers no disconnect cancellation,
# so a hang-up does not stop a checkpoint it already accepted.
#
# The mktemp body-capture scaffolding and the 502 arm went too: both existed to
# read `error.stage` off a synthesis failure, and under accepted mode every
# synthesis outcome happens AFTER the 202, where this hook cannot see it. Those
# failures are now detected server-side by the #309 signal.checkpoint_failure
# counter and um-alert.sh's CHECKPOINT-FAILURE arm. Leaving unreachable branches
# whose comments describe semantics that no longer apply would reproduce the
# exact defect this change exists to correct.
#
# STDOUT MUST BE REDIRECTED. `_um_api_request` writes the response body to
# stdout by contract; the old form kept it off the hook's stdout via the
# `> "$CKPT_BODY_FILE"` redirect and the subshell's `>/dev/null`. Both are gone,
# so the redirect is explicit here — otherwise every session end prints the
# server's envelope on the SessionEnd hook's stdout, which the host reads.
# ---------------------------------------------------------------------------
ENDPOINT=$(um_api_endpoint 2>/dev/null)
if um_api_post '/api/checkpoint' "$BODY" >/dev/null 2>/dev/null </dev/null; then
  # THIS CONDITIONAL MUST LIVE INSIDE THE SUCCESS ARM. um_api_post returns 0
  # for ANY 2xx, so a 202 already lands here — the `case` block below is the
  # ELSE arm, reached only on non-2xx. A `202)` case added down there would be
  # dead code and the hook would ship `posted http=202`, which reads as "this
  # session was digested" when nothing has been synthesised yet. That is
  # precisely the misreported success the spec forbids.
  if [ "$UM_API_HTTP_CODE" = "202" ]; then
    # ACCEPTED, NOT DIGESTED. The server has taken the job and nothing has been
    # written yet; success or failure is decided after this line is logged. A
    # line reading as success when synthesis later failed would be worse than
    # no line at all.
    um_log "accepted project=$PROJECT"
  else
    # #294 D7: the resolved slug rides the success line, APPENDED as the
    # LAST field (never inserted — continuity.sh's order-sensitive greps
    # match the existing prefix as a substring). $PROJECT is sanitized
    # above before BODY is built. Reachable when an older server ignores the
    # unknown `mode` key and answers 200 synchronously.
    um_log "posted http=$UM_API_HTTP_CODE project=$PROJECT"
  fi
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
    429)
      # Remote rate-limiter — transient, already retried once by um-api.sh;
      # never the server-too-old prescription (2026-09-10).
      um_log "error=http-429"
      ;;
    4[0-9][0-9])
      um_log "skip=server-too-old http=$UM_API_HTTP_CODE"
      ;;
    *)
      # KEEP THIS CATCH-ALL. It is the only branch that logs an unanticipated
      # code, and 5xx BEFORE the 202 is still reachable — the route's outer
      # handler maps escapes to 500/413. Deleting it would turn an unexpected
      # response into a silent, unlogged hook exit: the same class of defect as
      # the original "no log line" symptom this issue began with.
      um_log "error=http-$UM_API_HTTP_CODE"
      ;;
  esac
fi

exit 0
