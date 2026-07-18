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
  --max-age-hours N   Freshness threshold in hours (default 26 — day-granular
                      counters make <24h thresholds lie; 26 gives a daily-use
                      box some slack)
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

MAX_AGE_HOURS=26
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
      _require_value "$1" "$#" "${2:-}"; MAX_AGE_HOURS="$2"; shift 2 ;;
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

# Reject empty, non-numeric chars, 2+ dots, AND a bare "." (which passes the
# other guards but makes float(".") throw an uncaught error downstream).
case "$MAX_AGE_HOURS" in
  ''|.|*[!0-9.]*|*.*.*)
    echo "um-alert: CHECK FAILED — --max-age-hours must be a number (got '$MAX_AGE_HOURS')" >&2
    exit 2 ;;
esac

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

max_age = float(sys.argv[1])
want = sys.argv[2]

def emit(status, msg):
    print(status + "|" + msg)
    sys.exit(0)

try:
    stats = json.load(sys.stdin)
    if not isinstance(stats, dict):
        raise ValueError("not an object")
except Exception:
    emit("ERROR", "unparseable /api/stats response (not JSON)")

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
' "$MAX_AGE_HOURS" "$SURFACE" < "$BODY_FILE" 2>/dev/null) || VERDICT=""

STATUS="${VERDICT%%|*}"
MESSAGE="${VERDICT#*|}"

case "$STATUS" in
  FRESH)
    echo "um-alert: OK — $MESSAGE"
    exit 0 ;;
  STALE)
    echo "um-alert: STALE — $MESSAGE" >&2
    exit 1 ;;
  ERROR)
    echo "um-alert: CHECK FAILED — $MESSAGE" >&2
    exit 2 ;;
  *)
    echo "um-alert: CHECK FAILED — internal parser produced no verdict" >&2
    exit 2 ;;
esac
