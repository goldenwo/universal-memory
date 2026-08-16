#!/usr/bin/env bash
# bin/um-alert.sh — cron-able capture-freshness check (#171 Stage A, spec §4).
#
# GETs /api/stats and exits per the A3 taxonomy:
#   0  fresh — some surface (or the --surface one) has freshness_hours ≤ N
#   1  STALE — captures exceed the threshold (or none have ever happened);
#      the direct alarm for the 2026-07-16 silent-capture-death incident
#   2  the check itself couldn't run (unreachable / auth / bad response /
#      degraded counters) — distinguishable from staleness by design: a
#      dark counters source means we can't SEE freshness, not that it's bad
#
# Cron shape: `26 6 * * * ~/.local/share/um/cli/um-alert.sh || <notify>`.
# Config comes from um-api.sh's tiers (UM_SERVER_URL env → ~/.um/endpoint
# file → loopback default; token from ~/.um/auth-token) — same as the hooks.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# LIB_DIR resolution mirrors the `um` dispatcher's 3 tiers (env → standalone
# install layout → plugin-local) rather than um-state.sh's 2: cron runs this
# script DIRECTLY from ~/.local/share/um/cli/ with no shell rc sourced, so
# the dispatcher's UM_LIB_DIR export never happens and ../hooks/lib doesn't
# exist in the installed layout.
if [ -n "${UM_LIB_DIR:-}" ]; then
  LIB_DIR="$UM_LIB_DIR"
elif [ -r "$HOME/.local/share/um/lib/um-api.sh" ]; then
  LIB_DIR="$HOME/.local/share/um/lib"
else
  LIB_DIR="$SCRIPT_DIR/../hooks/lib"
fi

# Unlike um-state.sh there is no legacy env-only fallback: um_api_get IS the
# transport here. A partial install that lacks um-api.sh means the check
# cannot run — that's the exit-2 class, not a degraded success.
if [ -r "$LIB_DIR/um-api.sh" ]; then
  # shellcheck source=../hooks/lib/um-api.sh
  source "$LIB_DIR/um-api.sh"
else
  echo "um-alert: CHECK FAILED — um-api.sh not found in $LIB_DIR (partial install? re-run installer/install-cli.sh)" >&2
  exit 2
fi

_usage() {
  cat <<EOF
Usage: um-alert.sh [options]

Capture-freshness check against GET /api/stats. Cron-able: silent-ish on
success, one actionable line + non-zero exit otherwise.

Options:
  --max-age-hours N   Freshness threshold in hours. Default: the server's
                      own /api/stats capture_freshness_threshold_hours field
                      (the same value the /control page compares against —
                      day-granular counters make <24h thresholds lie, so it
                      defaults to 26 there too). Falls back to a literal 26
                      only if the server predates that field. Passing this
                      flag always overrides the payload value.
  --surface S         Require surface S specifically to be fresh
                      (default: any surface passing the threshold is enough)
  --server URL        Override server URL (default: \$UM_SERVER_URL, else
                      ~/.um/endpoint, else http://localhost:6335)
  --help, -h          Show this message

Exit codes:
  0  fresh   — captures within the threshold
  1  STALE   — all (or the named) surfaces exceed the threshold, or no
               captures have ever been recorded
  2  check couldn't run — server unreachable, auth rejected, non-200,
               unparseable response, or capture counters degraded
EOF
}

# Empty MAX_AGE_HOURS is the "not explicitly set" sentinel — it lets the
# python verdict block tell "use the payload's threshold" apart from "an
# operator typed --max-age-hours", which a pre-filled default (e.g. 26)
# could never distinguish from a literal `--max-age-hours 26` (U2.6). The
# literal 26 fallback lives ONLY in the python block now, for the old-server
# case where the payload lacks capture_freshness_threshold_hours entirely.
MAX_AGE_HOURS=""
MAX_AGE_EXPLICIT=""
SURFACE=""

# A missing/empty option value is a CHECK-FAILED (exit 2), never exit 1: in the
# documented `um-alert.sh || <notify>` cron shape, exit 1 means STALE, so a
# typo'd invocation must not page the operator "your capture pipeline is dead".
# (`${2:?...}` would exit 1 — the wrong class.)
_require_value() { # _require_value <flag> <count> [value]
  { [ "$2" -ge 2 ] && [ -n "${3:-}" ]; } && return 0
  echo "um-alert: CHECK FAILED — $1 requires a value" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    --max-age-hours)
      _require_value "$1" "$#" "${2:-}"; MAX_AGE_HOURS="$2"; MAX_AGE_EXPLICIT=1; shift 2 ;;
    --surface)
      _require_value "$1" "$#" "${2:-}"; SURFACE="$2"; shift 2 ;;
    --server)
      # um_api_endpoint's tier 1 — an env override beats the file tier, so
      # exporting here is exactly the sibling CLIs' --server semantic.
      _require_value "$1" "$#" "${2:-}"; export UM_SERVER_URL="$2"; shift 2 ;;
    *)
      echo "um-alert: unknown option: $1" >&2; _usage >&2; exit 2 ;;
  esac
done

# Reject non-numeric chars, 2+ dots, AND a bare "." (which passes the other
# guards but makes float(".") throw an uncaught error downstream). Scoped to
# the explicit branch only (U2.6): when --max-age-hours was NOT passed,
# MAX_AGE_HOURS is the empty not-set sentinel by design (see above) and must
# reach python untouched so it can fall back to the payload's threshold —
# this guard would otherwise reject that legitimate empty value as if it
# were a malformed CLI arg (an empty explicit value is already caught
# earlier, by _require_value, so it never reaches this point).
if [ -n "$MAX_AGE_EXPLICIT" ]; then
  case "$MAX_AGE_HOURS" in
    ''|.|*[!0-9.]*|*.*.*)
      echo "um-alert: CHECK FAILED — --max-age-hours must be a number (got '$MAX_AGE_HOURS')" >&2
      exit 2 ;;
  esac
fi

PY=$(um_find_python) || {
  echo "um-alert: CHECK FAILED — no working python interpreter (py/python3/python) to parse the stats response" >&2
  exit 2
}

ENDPOINT=$(um_api_endpoint)

# um_api_get OUTSIDE command substitution — UM_API_HTTP_CODE doesn't survive
# a subshell (um-api.sh contract).
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT
um_api_get "/api/stats" > "$BODY_FILE" || true
HTTP_CODE="${UM_API_HTTP_CODE:-000}"

case "$HTTP_CODE" in
  200) : ;;
  000)
    echo "um-alert: CHECK FAILED — server unreachable at $ENDPOINT (transport failure/timeout)" >&2
    exit 2 ;;
  401)
    echo "um-alert: CHECK FAILED — server rejected auth (401): check ${UM_TOKEN_FILE:-~/.um/auth-token}" >&2
    exit 2 ;;
  404)
    # Same skew taxonomy the hooks + installer probes use: a 404 on a route
    # this client knows about means the SERVER predates it, not that the
    # check found staleness. Upgrading is the actionable fix.
    echo "um-alert: CHECK FAILED — $ENDPOINT has no /api/stats (HTTP 404): server too old — upgrade it to a release that ships the stats layer" >&2
    exit 2 ;;
  *)
    echo "um-alert: CHECK FAILED — /api/stats returned HTTP $HTTP_CODE from $ENDPOINT" >&2
    exit 2 ;;
esac

# Verdict computed in python (no jq dependency — same probe the hooks use):
# one `STATUS|message` line; bash maps STATUS → exit code + stream.
VERDICT=$("$PY" -c '
import json, sys

max_age_arg = sys.argv[1]
want = sys.argv[2]
explicit = sys.argv[3] == "1"

def emit(status, msg):
    print(status + "|" + msg)
    sys.exit(0)

try:
    stats = json.load(sys.stdin)
    if not isinstance(stats, dict):
        raise ValueError("not an object")
except Exception:
    emit("ERROR", "unparseable /api/stats response (not JSON)")

# Precedence (U2.6, spec R2-C-B1/R2-S-I4): CLI --max-age-hours (explicit,
# already numeric-validated in bash) beats the payload threshold beats the
# old-server literal fallback. "is None" - NEVER "or"/truthiness - so a
# deliberate payload 0 (UM_FRESHNESS_MAX_AGE_HOURS=0 on the server) survives
# instead of being coerced back to 26.
if explicit:
    max_age = float(max_age_arg)
else:
    threshold = stats.get("capture_freshness_threshold_hours")
    if threshold is None:
        max_age = 26.0  # old server predating this field
    else:
        try:
            max_age = float(threshold)
        except (TypeError, ValueError):
            max_age = 26.0  # defensive: malformed payload value, not a crash

capture = stats.get("capture")
if capture is None:
    flags = ", ".join(stats.get("degraded") or []) or "capture:null"
    emit("ERROR", "stats degraded (%s) — freshness cannot be assessed" % flags)
if not isinstance(capture, dict):
    emit("ERROR", "unexpected /api/stats shape (capture is not an object)")

def fmt(name, info):
    return "%s last captured %s (%sh ago)" % (
        name, info.get("last_day_seen"), info.get("freshness_hours"))

try:
    if not capture:
        emit("STALE", "no captures have EVER been recorded on any surface "
             "— the capture pipeline has never written")
    if want:
        info = capture.get(want)
        if info is None:
            emit("STALE", "surface %r has no capture rows at all "
                 "(surfaces seen: %s)" % (want, ", ".join(sorted(capture))))
        if float(info["freshness_hours"]) <= max_age:
            emit("FRESH", fmt(want, info))
        emit("STALE", fmt(want, info) +
             " — exceeds the %gh threshold" % max_age)
    freshest = min(capture, key=lambda s: float(capture[s]["freshness_hours"]))
    if float(capture[freshest]["freshness_hours"]) <= max_age:
        emit("FRESH", fmt(freshest, capture[freshest]))
    listing = "; ".join(fmt(s, capture[s]) for s in
                        sorted(capture, key=lambda s: float(capture[s]["freshness_hours"])))
    emit("STALE", "no surface captured within %gh — freshest: %s" % (max_age, listing))
except (KeyError, TypeError, ValueError):
    emit("ERROR", "unexpected /api/stats shape (bad freshness_hours field)")
' "$MAX_AGE_HOURS" "$SURFACE" "$MAX_AGE_EXPLICIT" < "$BODY_FILE" 2>/dev/null) || VERDICT=""

STATUS="${VERDICT%%|*}"
MESSAGE="${VERDICT#*|}"

# #201: capture-ledger error-growth check. um_capture_ledger_errors_total is
# Prometheus-only and this deployment has no scraper, so the cron IS the alarm
# surface. The curl runs IN-CONTAINER (docker exec … 127.0.0.1) because the
# host-cron path arrives via the docker bridge and the default metrics policy
# (loopback-only) 404s it. Fail-soft: docker/metric unavailable → skip, never
# degrade the freshness verdict. Growth since the last run escalates a FRESH
# verdict to exit 1 — a growing count means exchanges are silently becoming
# unaddressable by late reactions.
LEDGER_CONTAINER="${UM_LEDGER_ERRORS_CONTAINER:-um-server}"
LEDGER_STATE="${UM_LEDGER_ERRORS_STATE:-$HOME/.um/ledger-errors.count}"
LEDGER_ALERT=""
if [ -n "$LEDGER_CONTAINER" ] && command -v docker >/dev/null 2>&1; then
  _LTOKEN=$(cat "${UM_TOKEN_FILE:-$HOME/.um/auth-token}" 2>/dev/null || true)
  LEDGER_CURRENT=$(docker exec "$LEDGER_CONTAINER" wget -qO- \
      --header "Authorization: Bearer ${_LTOKEN}" \
      http://127.0.0.1:6335/metrics 2>/dev/null \
    | awk '/^um_capture_ledger_errors_total/ {s+=$2} END {printf "%d", s}') || LEDGER_CURRENT=""
  if [ -n "$LEDGER_CURRENT" ]; then
    LEDGER_PREV=$(cat "$LEDGER_STATE" 2>/dev/null || echo 0)
    echo "$LEDGER_CURRENT" > "$LEDGER_STATE" 2>/dev/null || true
    if [ "$LEDGER_CURRENT" -gt "${LEDGER_PREV:-0}" ] 2>/dev/null; then
      LEDGER_ALERT="capture-ledger errors grew ${LEDGER_PREV:-0} -> $LEDGER_CURRENT since the last check (exchanges may be unaddressable by late reactions)"
    fi
  fi
fi

# Task 10 (spec §6): LAYERS section — per-project filesystem-mtime freshness,
# independent of the counters-derived verdict above (the exact ground truth
# that would have caught the 2026-08-04 outage: capture.turn kept the
# counters-derived surface reading 0h "fresh" while nothing downstream
# advanced for five days). Mirrors the #201 LEDGER_ALERT pattern: a FRESH
# capture verdict is ESCALATED to exit 1 when the layers block names a stale
# project.
#
# Three-way taxonomy (python, same BODY_FILE, no jq — house pattern):
#   ABSENT — no `layers` key at all: an old server (predates v1.16). Skip the
#     check WITH a breadcrumb; the exit code is left to the capture verdict
#     above. A rollback to a pre-layers server must not silently disable this
#     arc's own monitor by going quiet about what it stopped checking.
#   ERROR  — `layers` present but unparseable/malformed. A malformed
#     monitoring payload is itself a loud CHECK-FAILED (exit 2), unconditionally
#     — this arc's own root failure mode was a silently-dropped broken monitor.
#   STALE/OK — `layers` present and well-shaped; STALE names every project
#     whose own `stale` flag is true.
LAYERS_VERDICT=$("$PY" -c '
import json, sys

def emit(status, msg):
    print(status + "|" + msg)
    sys.exit(0)

try:
    stats = json.load(sys.stdin)
    if not isinstance(stats, dict):
        raise ValueError("not an object")
except Exception:
    emit("ERROR", "unparseable /api/stats response (not JSON)")

if "layers" not in stats:
    emit("ABSENT", "layers key absent — server predates v1.16; per-layer freshness NOT checked")

layers = stats.get("layers")
if not isinstance(layers, dict):
    emit("ERROR", "layers key present but malformed (expected an object)")

stale = []
try:
    for name, info in layers.items():
        if not isinstance(info, dict) or not isinstance(info.get("stale"), bool):
            raise ValueError("project %r has a malformed or missing stale field" % name)
        if info["stale"]:
            # MINOR 7 (review round 1): the JSON sentinel for an infinite lag
            # is the STRING "Infinity" (see layers.mjs) — printed verbatim it
            # reads as the nonsensical "Infinityh"; render it as "never"
            # instead, same idea as um-alert.sh already applying its own
            # float()-coercion discipline to threshold/freshness values
            # elsewhere in this file.
            lag = info.get("lag_hours")
            lag_str = "never" if lag == "Infinity" else "%sh" % lag
            stale.append("%s (lag %s, pending %s bytes)" % (name, lag_str, info.get("pending_bytes")))
except Exception as e:
    emit("ERROR", "layers payload malformed: %s" % e)

if stale:
    emit("STALE", "; ".join(sorted(stale)))
emit("OK", "no stale projects")
' < "$BODY_FILE" 2>/dev/null) || LAYERS_VERDICT=""

LAYERS_STATUS="${LAYERS_VERDICT%%|*}"
LAYERS_MESSAGE="${LAYERS_VERDICT#*|}"

# Review round 1, IMPORTANT 2: the STALE/OK/ERROR taxonomy above says
# NOTHING about whether `layers` was fully computed — a payload can be a
# perfectly well-shaped `{}` (or a partial map) while stats.degraded names
# 'layers-unavailable'/'layers-partial'/'layers_saturated', meaning the
# check above just evaluated INCOMPLETE (or entirely absent) data and
# happily emitted "OK — no stale projects". That is exactly this arc's own
# silent-monitor failure mode: a broken layers computation going quiet
# because what little (or nothing) it COULD see looked fine. Independent,
# best-effort, NEVER fatal and NEVER changes STATUS/LAYERS_STATUS/the exit
# code decided below (same discipline as the ABSENT-key breadcrumb) — purely
# a breadcrumb naming which flag(s) fired.
LAYERS_DEGRADED_NOTE=$("$PY" -c '
import json, sys
try:
    stats = json.load(sys.stdin)
    degraded = stats.get("degraded") if isinstance(stats, dict) else None
    flags = sorted(d for d in degraded if isinstance(d, str) and d.startswith("layers")) if isinstance(degraded, list) else []
    print(", ".join(flags))
except Exception:
    print("")
' < "$BODY_FILE" 2>/dev/null) || LAYERS_DEGRADED_NOTE=""

if [ -n "$LAYERS_DEGRADED_NOTE" ]; then
  echo "um-alert: layers check degraded ($LAYERS_DEGRADED_NOTE) — per-layer freshness may be INCOMPLETE" >&2
fi

case "$LAYERS_STATUS" in
  ABSENT)
    echo "um-alert: $LAYERS_MESSAGE" >&2 ;;
  OK|STALE)
    : ;;
  *)
    # Unconditional, BEFORE the capture-verdict case below: a malformed
    # layers payload (or an EMPTY LAYERS_STATUS — the python process itself
    # crashed uncaught) is worth its own CHECK-FAILED regardless of what the
    # counters-derived verdict says (spec §6) — an operator seeing exit 2
    # here should investigate the monitor itself, not read it as "the
    # pipeline is stale". A garbage/empty status is folded into this same
    # branch rather than silently no-op'ing the layers check: this arc's own
    # root failure mode was exactly a broken monitor going quiet.
    echo "um-alert: CHECK FAILED — ${LAYERS_MESSAGE:-layers verdict parser produced no output}" >&2
    exit 2 ;;
esac

case "$STATUS" in
  FRESH)
    if [ "$LAYERS_STATUS" = "STALE" ]; then
      echo "um-alert: LAYERS-STALE — $LAYERS_MESSAGE (capture freshness itself OK: $MESSAGE)" >&2
      exit 1
    fi
    if [ -n "$LEDGER_ALERT" ]; then
      echo "um-alert: LEDGER-ERRORS — $LEDGER_ALERT (capture freshness itself OK: $MESSAGE)" >&2
      exit 1
    fi
    echo "um-alert: OK — $MESSAGE"
    exit 0 ;;
  STALE)
    if [ "$LAYERS_STATUS" = "STALE" ]; then
      echo "um-alert: STALE — $MESSAGE; also layers stale: $LAYERS_MESSAGE" >&2
    else
      echo "um-alert: STALE — $MESSAGE" >&2
    fi
    exit 1 ;;
  ERROR)
    echo "um-alert: CHECK FAILED — $MESSAGE" >&2
    exit 2 ;;
  *)
    echo "um-alert: CHECK FAILED — internal parser produced no verdict" >&2
    exit 2 ;;
esac
