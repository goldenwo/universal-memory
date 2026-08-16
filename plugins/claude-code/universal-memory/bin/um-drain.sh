#!/usr/bin/env bash
# bin/um-drain.sh — operator backlog-drain script (checkpoint chunked
# summarization arc, spec docs/plans/2026-08-15-checkpoint-chunked-summarization-spec.md
# §5, PR-4/Task 11).
#
# Repeatedly POSTs /api/checkpoint {project} for an explicit list of projects
# until each reports backlog_remaining:false (or the legacy-shaped
# thin_transcript abstention), implementing the FULL spec §5 response
# taxonomy — evaluated top-down, first match wins. This is the client-side
# retry/progress layer chunked checkpoint relies on (spec §3): each server
# call digests at most `max_chunks_per_run` chunks and reports how much
# backlog remains; um-drain.sh is what turns that into "keep going until
# done" without an operator babysitting SessionEnd fires one at a time.
#
# House pattern (read bin/um-alert.sh + hooks/session-end.sh + hooks/lib/um-api.sh
# before touching this file): um-api.sh sourcing + its 3-tier LIB_DIR
# resolution, um_api_post/um_api_get OUTSIDE command substitution via the
# mktemp body-capture pattern (UM_API_HTTP_CODE does not survive a subshell),
# python for ALL JSON parsing (no jq).
#
# NEVER auto-invoked: no hook calls this script. It is an explicit operator
# action, gated at runtime by its own confirm prompt (--yes to skip).
#
# Exit codes:
#   0  every project in the worklist reached "complete" (backlog_remaining:
#      false, or the thin_transcript abstention) — full success.
#   1  the run executed but at least one project ended parked (cost cap) or
#      stopped (an error branch) — see the per-project report for detail.
#   2  could not run at all: bad arguments, missing python/um-api.sh, the
#      operator declined the confirm gate, or the server-version preflight
#      determined the server predates chunked checkpoint.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# LIB_DIR resolution mirrors um-alert.sh's 3 tiers exactly (env → standalone
# install layout → plugin-local): an operator runs this script the same way
# they run um-alert.sh — directly from ~/.local/share/um/cli/ with no shell
# rc sourced (see installer/install-cli.sh's copy list) — so ../hooks/lib
# only exists in a repo checkout, never in the installed layout.
if [ -n "${UM_LIB_DIR:-}" ]; then
  LIB_DIR="$UM_LIB_DIR"
elif [ -r "$HOME/.local/share/um/lib/um-api.sh" ]; then
  LIB_DIR="$HOME/.local/share/um/lib"
else
  LIB_DIR="$SCRIPT_DIR/../hooks/lib"
fi

if [ -r "$LIB_DIR/um-api.sh" ]; then
  # shellcheck source=../hooks/lib/um-api.sh
  source "$LIB_DIR/um-api.sh"
else
  echo "um-drain: CANNOT RUN — um-api.sh not found in $LIB_DIR (partial install? re-run installer/install-cli.sh)" >&2
  exit 2
fi

_usage() {
  cat <<EOF
Usage: um-drain.sh [--probe <project> | <project> [<project> ...]] [options]

Operator backlog-drain: repeatedly POSTs /api/checkpoint {project} for each
named project until it reports backlog_remaining:false (spec §5). Prints a
per-project cost/pending-bytes estimate and a confirm gate BEFORE any POST.

Arguments:
  <project> [<project> ...]   Explicit project list (no discovery magic).

Options:
  --probe <project>   Drain exactly this ONE project, then exit — print the
                       produced summary paths and an instruction to review
                       them before re-running without --probe for the full
                       worklist. Mutually exclusive with a positional list.
  --yes                Skip the confirm gate (non-interactive use).
  --server URL         Override server URL (default: \$UM_SERVER_URL, else
                       ~/.um/endpoint, else http://localhost:6335).
  --help, -h           Show this message.

Exit codes:
  0  every worklist project reached "complete" (backlog_remaining:false, or
     the thin_transcript abstention).
  1  the run executed but >=1 project ended parked (cost cap) or stopped
     (see the per-project report).
  2  could not run at all — bad args, missing python/um-api.sh, the operator
     declined the confirm gate, or the server predates chunked checkpoint.
EOF
}

PROBE_PROJECT=""
SKIP_CONFIRM=0
declare -a CLI_PROJECTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    --probe)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "um-drain: --probe requires a project name" >&2
        exit 2
      fi
      PROBE_PROJECT="$2"; shift 2 ;;
    --yes) SKIP_CONFIRM=1; shift ;;
    --server)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "um-drain: --server requires a value" >&2
        exit 2
      fi
      export UM_SERVER_URL="$2"; shift 2 ;;
    -*) echo "um-drain: unknown option: $1" >&2; _usage >&2; exit 2 ;;
    *) CLI_PROJECTS+=("$1"); shift ;;
  esac
done

if [ -n "$PROBE_PROJECT" ] && [ "${#CLI_PROJECTS[@]}" -gt 0 ]; then
  echo "um-drain: --probe drains exactly one project — do not also pass a positional list" >&2
  exit 2
fi
if [ -z "$PROBE_PROJECT" ] && [ "${#CLI_PROJECTS[@]}" -eq 0 ]; then
  echo "um-drain: no projects given — pass an explicit project list or --probe <project>" >&2
  _usage >&2
  exit 2
fi

PROBE_MODE=0
declare -a WORKLIST=()
if [ -n "$PROBE_PROJECT" ]; then
  PROBE_MODE=1
  WORKLIST=("$PROBE_PROJECT")
else
  WORKLIST=("${CLI_PROJECTS[@]}")
fi

PY=$(um_find_python) || {
  echo "um-drain: CANNOT RUN — no working python interpreter (py/python3/python) to parse server responses" >&2
  exit 2
}

ENDPOINT=$(um_api_endpoint)

# One shared tmp dir for every response body this run reads (checkpoint POST,
# stats GET, reindex POST) — mktemp pattern per um-alert.sh:134-136: um_api_post/
# um_api_get are called OUTSIDE command substitution (redirected to a file)
# because UM_API_HTTP_CODE does not survive a subshell.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
BODY_FILE="$TMP_DIR/checkpoint-body.json"
STATS_FILE="$TMP_DIR/stats-body.json"
REINDEX_FILE="$TMP_DIR/reindex-body.json"

# ─── JSON helpers (python; no jq — house pattern) ───────────────────────────

# _parse_checkpoint_response < body.json
# Emits ONE line: 10 fields joined by \x1f (unit separator) — deliberately
# NOT bash arrays/mapfile (bash4-only; this script also runs on macOS's
# stock bash 3.2 in CI's installer-test matrix). Mirrors um-alert.sh's
# single-line "STATUS|MESSAGE" idiom, extended to the richer checkpoint
# envelope this script must branch on (spec §4.6/§4.7): chunks_done,
# backlog_remaining, stopped.reason, thin_tail, skipped, summary_path (top-
# level, success shape), error.stage, error.provider_class, error.message,
# error.summary_path (nested — the HTTP error envelope merges doCheckpoint's
# sibling summary_id/summary_path INTO `error`, see
# server/lib/error-envelope.mjs's errorResponse(); a malformed/non-JSON body
# degrades to all-empty fields rather than throwing, so a garbage response
# lands in this script's own "anything else" catch-all instead of crashing).
# `ok` and `error.code` are deliberately not carried through: every taxonomy
# branch is fully disambiguated by the 10 fields below without them.
_parse_checkpoint_response() {
  "$PY" -c '
import json, sys
SEP = chr(0x1f)
def s(v):
    if v is None:
        return ""
    return str(v).replace(SEP, " ").replace("\n", " ").replace("\r", "")
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
err = d.get("error") if isinstance(d.get("error"), dict) else {}
stopped = d.get("stopped") if isinstance(d.get("stopped"), dict) else {}
fields = [
    d.get("chunks_done"), d.get("backlog_remaining"),
    stopped.get("reason"), d.get("thin_tail"), d.get("skipped"),
    d.get("summary_path"), err.get("stage"),
    err.get("provider_class"), err.get("message"), err.get("summary_path"),
]
# print() (not sys.stdout.write) so the line ends with a newline: bash
# read returns non-zero when its input lacks a trailing newline even
# though the assignment still happens, which would trip this whole
# script set -e on every single iteration. (No apostrophes in this
# comment on purpose -- it lives inside the enclosing bash single-quoted
# string, and a stray apostrophe here closes that string early.)
print(SEP.join(s(f) for f in fields))
'
}

# _pending_bytes_for <project> — reads pending_bytes out of $STATS_FILE
# (the layers block; spec §6). Prints the integer, or empty when the layers
# key is absent (old server), the project has no captures yet, or the value
# is unusable — callers must treat empty as "unknown", never as 0.
_pending_bytes_for() {
  "$PY" -c '
import json, sys
project = sys.argv[1]
try:
    d = json.load(open(sys.argv[2], encoding="utf-8"))
except Exception:
    sys.exit(0)
layers = d.get("layers")
if not isinstance(layers, dict):
    sys.exit(0)
info = layers.get(project)
if not isinstance(info, dict):
    sys.exit(0)
pb = info.get("pending_bytes")
if isinstance(pb, bool) or not isinstance(pb, (int, float)):
    sys.exit(0)
print(int(pb))
' "$1" "$STATS_FILE"
}

# _print_project_preflight <project> — spec §5 "before any POST, print the
# computed init point + cost estimate". This script is client-side: it does
# not compute a cursor position itself, it reports what the server's own
# /api/stats layers block already knows (pending_bytes, last_capture_at,
# last_summary_at, lag_hours, stale) — the layers block IS the init-point
# signal (§6). Cost estimate is deliberately order-of-magnitude only (spec
# §5): bytes/4 ≈ tokens, priced at gpt-4o-mini's input rate
# ($0.00015/1k tok, server/lib/pricing.mjs) — input dominates a summarize
# call's cost, so omitting output tokens keeps this a rough-but-honest
# lower-ish bound, not a precise quote.
_print_project_preflight() {
  "$PY" -c '
import json, sys
project = sys.argv[1]
try:
    d = json.load(open(sys.argv[2], encoding="utf-8"))
except Exception:
    d = {}
layers = d.get("layers")
if not isinstance(layers, dict):
    print("  %s: no layers data from /api/stats (server may predate v1.16, or degraded)" % project)
    sys.exit(0)
info = layers.get(project)
if not isinstance(info, dict):
    print("  %s: no captures recorded for this project yet (nothing pending)" % project)
    sys.exit(0)
pending = info.get("pending_bytes")
print("  %s: pending_bytes=%s last_capture_at=%s last_summary_at=%s lag_hours=%s stale=%s" % (
    project, info.get("pending_bytes"), info.get("last_capture_at"),
    info.get("last_summary_at"), info.get("lag_hours"), info.get("stale")))
if isinstance(pending, (int, float)) and not isinstance(pending, bool):
    tokens_est = pending / 4.0
    cost_est = (tokens_est / 1000.0) * 0.00015
    print("  %s: cost estimate ~$%.4f (~%d input tokens @ gpt-4o-mini rate — order-of-magnitude only)" % (
        project, cost_est, int(tokens_est)))
' "$1" "$STATS_FILE"
}

# _next_utc_midnight — ISO timestamp of the next UTC midnight, for the
# cost_cap park message (spec §5: "park until UTC midnight, say so").
_next_utc_midnight() {
  "$PY" -c '
import datetime
now = datetime.datetime.now(datetime.timezone.utc)
tomorrow = (now + datetime.timedelta(days=1)).date()
midnight = datetime.datetime.combine(tomorrow, datetime.time(0, 0, 0), tzinfo=datetime.timezone.utc)
print(midnight.strftime("%Y-%m-%dT%H:%M:%SZ"))
'
}

# _json_body_project <project> — {"project": "<project>"} via python
# json.dumps (never naive string interpolation — operator-typed project
# names are not pre-sanitized the way session-end.sh's hook-derived slugs
# are; an invalid name simply reaches the server and comes back as the
# taxonomy's "other 400 → stop project" branch, which is correct).
_json_body_project() {
  "$PY" -c 'import json, sys; print(json.dumps({"project": sys.argv[1]}))' "$1"
}

# _json_body_path <path> — {"path": "<path>"} for /api/reindex.
_json_body_path() {
  "$PY" -c 'import json, sys; print(json.dumps({"path": sys.argv[1]}))' "$1"
}

_fetch_stats() {
  um_api_get "/api/stats" 30 > "$STATS_FILE" 2>/dev/null || true
  STATS_CODE="${UM_API_HTTP_CODE:-000}"
}

# ─── Preflight print (spec §5: BEFORE any POST) ─────────────────────────────

echo "um-drain: worklist = ${WORKLIST[*]}"
echo "um-drain: server = $ENDPOINT"
echo ""
echo "=== Pre-drain snapshot (GET /api/stats) ==="
_fetch_stats
if [ "$STATS_CODE" != "200" ]; then
  echo "  (could not reach $ENDPOINT/api/stats — HTTP $STATS_CODE; proceeding anyway, the drain loop's own taxonomy handles a down server)"
else
  for _p in "${WORKLIST[@]}"; do
    _print_project_preflight "$_p"
  done
fi
echo ""
echo "#215 frame reminder: this script only ever calls /api/reindex per-doc (the"
echo "  502 stage=reindex repair branch below) — never a vault-wide reindex."

# ─── Confirm gate (operator-gated at runtime; no hook ever calls this script) ──
# No TTY-specific special-case: `read` just reads whatever stdin offers (a
# real terminal, a piped `echo y |`, or nothing at all). Closed/empty stdin
# hits EOF, CONFIRM stays empty, and the default case below declines — the
# same safe-by-default outcome a hard TTY check would give, without needing
# one (and without making this gate untestable from a non-TTY harness).
if [ "$SKIP_CONFIRM" != "1" ]; then
  echo ""
  CONFIRM=""
  read -r -p "Proceed draining ${#WORKLIST[@]} project(s)? [y/N] " CONFIRM || true
  case "$CONFIRM" in
    y|Y|yes|YES) : ;;
    *) echo "um-drain: aborted — operator did not confirm"; exit 2 ;;
  esac
fi

# ─── Main taxonomy loop (spec §5 — first-match-wins, EVERY branch) ──────────

# Set the first time a 200 checkpoint response proves the server understands
# chunked checkpoint (either it carries the backlog_remaining key, or it IS
# the legacy-shaped-but-chunking-era thin_transcript abstention envelope,
# which deliberately has no backlog_remaining key — spec §5's own carve-out:
# do NOT misread a quiet project as an old server). Checked once globally
# ("one POST per worklist" — the FIRST real checkpoint POST of the whole run
# doubles as the version preflight; there is no separate throwaway probe
# call). A 200 that has neither signal is a pre-chunking server: abort the
# entire run loudly before any further POSTs.
VERSION_CONFIRMED=0

# Aggregate exit-code bookkeeping across the whole worklist.
ANY_INCOMPLETE=0
declare -a SUMMARY_PATHS=()

# _drain_project <project> — runs the taxonomy loop for one project. Sets
# PROJECT_STATUS to "complete" | "parked" | "stopped" and PROJECT_REASON to
# a human-readable one-liner. Appends any produced summary_path to the
# global SUMMARY_PATHS array.
_drain_project() {
  local project="$1"
  local zero_progress_streak=0
  local http000_streak=0
  local prev_000_pending=""
  local in_progress_streak=0
  local reindex_repair_cycles=0
  PROJECT_STATUS=""
  PROJECT_REASON=""

  echo ""
  echo "=== Draining: $project ==="

  while true; do
    local body reindex_body code
    body=$(_json_body_project "$project")
    um_api_post "/api/checkpoint" "$body" 900 > "$BODY_FILE" 2>/dev/null || true
    code="${UM_API_HTTP_CODE:-000}"

    local resp_chunks_done resp_backlog_remaining resp_stopped_reason \
      resp_thin_tail resp_skipped resp_summary_path resp_err_stage \
      resp_err_provider_class resp_err_message resp_err_summary_path
    # `|| true`: a $PY that fails to even start (not the normal case — it was
    # already probed at script startup — but defensive) makes `read` hit EOF
    # with nothing assigned and return non-zero; every var above is freshly
    # `local`-declared (empty) this iteration either way, so the fallback is
    # the same "all fields empty" shape the taxonomy's own catch-alls handle.
    IFS=$'\x1f' read -r resp_chunks_done resp_backlog_remaining resp_stopped_reason \
      resp_thin_tail resp_skipped resp_summary_path resp_err_stage \
      resp_err_provider_class resp_err_message resp_err_summary_path \
      < <(_parse_checkpoint_response < "$BODY_FILE") || true

    if [ "$code" = "200" ]; then
      # Any non-000, non-checkpoint_in_progress response means the previous
      # writer's lock (if any) genuinely cleared — reset both streaks so
      # "consecutive" keeps its literal meaning.
      http000_streak=0
      prev_000_pending=""
      in_progress_streak=0
      reindex_repair_cycles=0

      if [ "$VERSION_CONFIRMED" != "1" ]; then
        if [ -n "$resp_backlog_remaining" ]; then
          VERSION_CONFIRMED=1
        elif [ "$resp_skipped" = "thin_transcript" ]; then
          # Review round 1, IMPORTANT C1: do NOT confirm the whole server on
          # this leg. A legacy (pre-v1.16) server emits this EXACT envelope
          # too — it is indistinguishable from the chunking-era abstention by
          # shape alone. Suppressing the abort for THIS project (it falls
          # through to its own complete_thin_transcript branch below) is
          # correct and matches spec §5's carve-out; but permanently setting
          # VERSION_CONFIRMED here would silently disarm the gate for every
          # LATER project in the worklist, one of which could be a real
          # backlog against that same legacy server — the exact case the
          # gate exists to catch loudly. Only a response that actually
          # carries `backlog_remaining` proves chunking-awareness.
          :
        else
          # A hard, immediate exit (not the per-project stopped/report
          # machinery below) — this disqualifies the WHOLE server, not just
          # this project, so every other worklist entry would hit the
          # identical abort. Matches the documented exit-2 contract.
          echo "" >&2
          echo "um-drain: ABORT — server predates chunked checkpoint (need >= v1.16); refusing to drain" >&2
          exit 2
        fi
      fi

      if [ -n "$resp_summary_path" ]; then
        SUMMARY_PATHS+=("$resp_summary_path")
      fi

      local chunks_done="${resp_chunks_done:-0}"
      case "$chunks_done" in ''|*[!0-9]*) chunks_done=0 ;; esac
      local zero_progress_now=0
      if [ "$chunks_done" -eq 0 ] && [ "$resp_backlog_remaining" = "True" ]; then
        zero_progress_now=1
      fi

      local action=""
      if [ "$resp_stopped_reason" = "provider_ratelimit" ]; then
        echo "  BRANCH=provider_ratelimit — TPM window; sleeping 65s"
        action="continue"; local sleep_s=65
      elif [ "$resp_stopped_reason" = "cost_cap" ]; then
        local park_until; park_until=$(_next_utc_midnight)
        echo "  BRANCH=cost_cap — daily cost cap reached; parking $project until $park_until"
        PROJECT_STATUS="parked"; PROJECT_REASON="cost_cap until $park_until"
        return 0
      elif [ "$resp_stopped_reason" = "raw_lock" ]; then
        echo "  BRANCH=raw_lock — a live session holds the next raw file's lock; waiting 30s"
        action="continue"; local sleep_s=30
      elif [ "$resp_stopped_reason" = "chunk_cap" ]; then
        echo "  BRANCH=chunk_cap — max_chunks_per_run reached, backlog remains; continuing"
        action="continue"; local sleep_s=0
      elif [ -n "$resp_stopped_reason" ]; then
        echo "  BRANCH=unrecognized_stopped_reason reason=$resp_stopped_reason — logged verbatim, waiting 30s (open-enum §4.6)"
        action="continue"; local sleep_s=30
      elif [ "$resp_backlog_remaining" = "True" ]; then
        echo "  BRANCH=continue_backlog_remaining — no stopped reason; continuing"
        action="continue"; local sleep_s=0
      elif [ "$resp_backlog_remaining" = "False" ]; then
        local thin_note=""
        if [ "$resp_thin_tail" = "True" ]; then thin_note=" (thin_tail)"; fi
        echo "  BRANCH=complete — backlog_remaining:false$thin_note"
        PROJECT_STATUS="complete"; PROJECT_REASON="backlog drained$thin_note"
        return 0
      elif [ "$resp_skipped" = "thin_transcript" ]; then
        echo "  BRANCH=complete_thin_transcript — whole pending window is thin; nothing digestible"
        PROJECT_STATUS="complete"; PROJECT_REASON="thin_transcript (nothing pending)"
        return 0
      else
        echo "  BRANCH=unexpected_200_shape — response had neither stopped/backlog_remaining/skipped fields" >&2
        PROJECT_STATUS="stopped"; PROJECT_REASON="unexpected 200 response shape"
        return 1
      fi

      # Zero-progress guard (spec §5, all 200 branches): 5 consecutive
      # iterations with chunks_done==0 && backlog_remaining:true → stop,
      # regardless of which branch above matched. Applied only to
      # "continue"-type branches — a terminal branch already returns above.
      if [ "$zero_progress_now" = "1" ]; then
        zero_progress_streak=$((zero_progress_streak + 1))
      else
        zero_progress_streak=0
      fi
      if [ "$zero_progress_streak" -ge 5 ]; then
        echo "  BRANCH=zero_progress_guard — 5 consecutive chunks_done=0 iterations against backlog_remaining:true; stopping"
        PROJECT_STATUS="stopped"; PROJECT_REASON="zero-progress guard (busy-loop against a live/locked project)"
        return 1
      fi

      if [ "$action" = "continue" ]; then
        if [ "$sleep_s" -gt 0 ]; then sleep "$sleep_s"; fi
        continue
      fi
      # Should be unreachable — every branch above either returns or sets action=continue.
      PROJECT_STATUS="stopped"; PROJECT_REASON="internal: no action decided for a 200 response"
      return 1

    elif [ "$code" = "502" ]; then
      http000_streak=0
      prev_000_pending=""
      in_progress_streak=0
      if [ "$resp_err_stage" = "summarize" ] && [ "$resp_err_provider_class" = "ratelimit" ]; then
        reindex_repair_cycles=0
        echo "  BRANCH=502_summarize_ratelimit — 0-chunk provider ratelimit; sleeping 65s"
        sleep 65
        continue
      elif [ "$resp_err_stage" = "reindex" ]; then
        # Review round 1, MINOR 5: this is the script's one otherwise-
        # unbounded loop — a server that 502s stage=reindex on EVERY
        # checkpoint call while /api/reindex itself keeps 200ing (a
        # pathological server-side condition, not a transient one the
        # per-cycle x2 retry below is meant for) would sleep-free `continue`
        # forever, since the zero-progress guard only watches 200 responses.
        # A generous cap — stop-and-report is always a legal drain outcome
        # (spec §5), this just bounds a pathology beyond the letter of the
        # spec, contradicting nothing in it.
        reindex_repair_cycles=$((reindex_repair_cycles + 1))
        if [ "$reindex_repair_cycles" -gt 25 ]; then
          echo "  BRANCH=502_reindex_repair_cycle_cap — 25 consecutive stage=reindex cycles (each self-repaired, but the server keeps 502ing the next checkpoint call too); stopping rather than looping forever" >&2
          PROJECT_STATUS="stopped"; PROJECT_REASON="502 stage=reindex repair-cycle cap (25) reached"
          return 1
        fi
        echo "  BRANCH=502_reindex_repair — durable-but-unindexed doc at ${resp_err_summary_path:-<unknown>}; retrying /api/reindex (cycle $reindex_repair_cycles/25)"
        if [ -z "$resp_err_summary_path" ]; then
          echo "  BRANCH=502_reindex_repair_no_path — envelope carried no summary_path to repair" >&2
          PROJECT_STATUS="stopped"; PROJECT_REASON="502 stage=reindex with no summary_path"
          return 1
        fi
        local repaired=0 attempt reindex_code
        # "retry x2" (spec §5): 2 total /api/reindex attempts, on top of the
        # server's own already-exhausted 3x internal retry for this doc.
        for attempt in 1 2; do
          reindex_body=$(_json_body_path "$resp_err_summary_path")
          um_api_post "/api/reindex" "$reindex_body" 60 > "$REINDEX_FILE" 2>/dev/null || true
          reindex_code="${UM_API_HTTP_CODE:-000}"
          if [ "$reindex_code" = "200" ]; then
            repaired=1
            break
          fi
          echo "  BRANCH=502_reindex_repair_attempt attempt=$attempt http=$reindex_code — not yet repaired"
        done
        if [ "$repaired" = "1" ]; then
          echo "  BRANCH=502_reindex_repair_success — reindexed; continuing"
          continue
        fi
        echo "  BRANCH=502_reindex_repair_exhausted — /api/reindex failed twice; stopping"
        PROJECT_STATUS="stopped"; PROJECT_REASON="reindex repair exhausted for $resp_err_summary_path"
        return 1
      else
        echo "  BRANCH=502_other stage=${resp_err_stage:-<absent>} — not a recognized 502 taxonomy branch; stopping" >&2
        PROJECT_STATUS="stopped"; PROJECT_REASON="unrecognized 502 (stage=${resp_err_stage:-<absent>})"
        return 1
      fi

    elif [ "$code" = "400" ]; then
      http000_streak=0
      prev_000_pending=""
      reindex_repair_cycles=0
      if [ "$resp_err_message" = "checkpoint_in_progress" ]; then
        in_progress_streak=$((in_progress_streak + 1))
        if [ "$in_progress_streak" -gt 10 ]; then
          echo "  BRANCH=400_checkpoint_in_progress_exhausted — another writer held the lock for >10 retries (~600s); stopping" >&2
          PROJECT_STATUS="stopped"; PROJECT_REASON="checkpoint_in_progress exceeded 10 retries"
          return 1
        fi
        echo "  BRANCH=400_checkpoint_in_progress attempt=$in_progress_streak — another writer holds the lock; waiting 60s"
        sleep 60
        continue
      elif [ "$resp_err_message" = "cost cap hit" ]; then
        local park_until; park_until=$(_next_utc_midnight)
        echo "  BRANCH=400_cost_cap_hit — run-start cost cap; parking $project until $park_until"
        PROJECT_STATUS="parked"; PROJECT_REASON="cost cap hit (run-start) until $park_until"
        return 0
      else
        echo "  BRANCH=400_other message=${resp_err_message:-<absent>} — real input error; stopping" >&2
        PROJECT_STATUS="stopped"; PROJECT_REASON="400: ${resp_err_message:-invalid input}"
        return 1
      fi

    elif [ "$code" = "000" ]; then
      in_progress_streak=0
      reindex_repair_cycles=0
      http000_streak=$((http000_streak + 1))
      if [ "$http000_streak" -gt 3 ]; then
        echo "  BRANCH=000_exhausted — 3 consecutive transport failures/timeouts; stopping" >&2
        PROJECT_STATUS="stopped"; PROJECT_REASON="3 consecutive HTTP 000 (transport failure/timeout)"
        return 1
      fi
      _fetch_stats
      local current_pending; current_pending=$(_pending_bytes_for "$project")
      if [ -n "$prev_000_pending" ] && [ -n "$current_pending" ] \
        && [ "$current_pending" -lt "$prev_000_pending" ] 2>/dev/null; then
        echo "  BRANCH=000_shrinking — pending_bytes $prev_000_pending -> $current_pending; server still working, waiting 30s"
        prev_000_pending="$current_pending"
        sleep 30
        continue
      elif [ -z "$prev_000_pending" ]; then
        echo "  BRANCH=000_first_poll — transport failure/timeout; pending_bytes baseline=$current_pending, waiting 30s"
        prev_000_pending="$current_pending"
        sleep 30
        continue
      else
        echo "  BRANCH=000_not_shrinking — pending_bytes $prev_000_pending -> ${current_pending:-<unknown>}; server may be stuck, stopping" >&2
        PROJECT_STATUS="stopped"; PROJECT_REASON="HTTP 000 with non-shrinking pending_bytes"
        return 1
      fi

    else
      echo "  BRANCH=anything_else http=$code — unrecognized HTTP status; stopping" >&2
      PROJECT_STATUS="stopped"; PROJECT_REASON="unrecognized HTTP $code"
      return 1
    fi
  done
}

declare -a REPORT_LINES=()
for _project in "${WORKLIST[@]}"; do
  # A version-preflight failure inside _drain_project calls `exit 2` directly
  # (it disqualifies the whole server, not just this project) — control only
  # ever returns here with a genuine per-project outcome.
  _drain_project "$_project" || true
  REPORT_LINES+=("$_project: $PROJECT_STATUS — $PROJECT_REASON")
  if [ "$PROJECT_STATUS" != "complete" ]; then
    ANY_INCOMPLETE=1
  fi
done

echo ""
echo "=== Per-project report ==="
for _line in "${REPORT_LINES[@]}"; do
  echo "  $_line"
done

if [ "$PROBE_MODE" = "1" ]; then
  echo ""
  echo "=== Probe complete ==="
  if [ "${#SUMMARY_PATHS[@]}" -eq 0 ]; then
    echo "  (no summary docs were produced — nothing pending, or the probe stopped before committing a chunk)"
  else
    echo "  Produced summary paths:"
    for _sp in "${SUMMARY_PATHS[@]}"; do
      echo "    $_sp"
    done
  fi
  echo "  review these, then re-run without --probe for the full worklist"
  [ "$ANY_INCOMPLETE" = "0" ] && exit 0 || exit 1
fi

echo ""
echo "=== Verification checklist (spec §5 — run these, then confirm) ==="
echo "  1. GET /api/stats -> layers block shows no stale projects (stale:false"
echo "     for every project just drained)."
echo "  2. sessions/<project>/ now spans the gap era (covers_from/covers_until"
echo "     frontmatter — ADVISORY only: a turn 'header' can be forged by quoted"
echo "     text at column 0, so cross-check against the signals below)."
echo "  3. state/<project>/state.md mtimes have advanced."
echo "  4. counters show capture.checkpoint outcome=stored resuming per project"
echo "     (counters + mtimes are the authoritative pair; frontmatter windows"
echo "     are the human-readable map)."

if [ "$ANY_INCOMPLETE" = "0" ]; then
  echo ""
  echo "um-drain: all ${#WORKLIST[@]} project(s) complete."
  exit 0
else
  echo ""
  echo "um-drain: run finished with incomplete project(s) — see the report above." >&2
  exit 1
fi
