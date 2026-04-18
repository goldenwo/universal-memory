#!/bin/bash
# session-start.sh — universal-memory SessionStart hook for Claude Code
#
# Behavior:
#   1. Auto-start check (existing v0.1.3) — ensures docker stack is up if needed.
#   2. If UM_ENDPOINT unset → exit 0 silently.
#   3. Detached catchup branch — if orphan raw captures exist, fork session-end.sh
#      in the background with the orphan date range.
#   4. Synchronous read branch — fetch state.md via GET /api/state/:project,
#      apply staleness rules, inject as additionalContext.
#
# Staleness rules (based on valid_from frontmatter field):
#   Age ≤ 7 days  → inject verbatim under "# State of play"
#   Age 7-30 days → inject with "# State of play (last active YYYY-MM-DD, may be outdated)" prefix
#   Age > 30 days → empty additionalContext (stale, skip)
#   Missing/null  → empty additionalContext
#
# Token budget: ~1k tokens max. No /api/search injection here.
#
# Exits silently (exit 0) on any failure — never block session start.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

# shellcheck disable=SC1091
source "$LIB_DIR/vault.sh"

# ---------------------------------------------------------------------------
# 1. Auto-start (existing v0.1.3) — ensure docker stack is up if needed
# ---------------------------------------------------------------------------
AUTO_START_SCRIPT="$SCRIPT_DIR/auto-start.sh"
if [ -x "$AUTO_START_SCRIPT" ]; then
  bash "$AUTO_START_SCRIPT" || true  # fail-soft
fi

# ---------------------------------------------------------------------------
# 2. Bail if endpoint unset — no state injection possible
# ---------------------------------------------------------------------------
if [ -z "${UM_ENDPOINT:-}" ]; then
  echo '{}'
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Project + vault
# ---------------------------------------------------------------------------
PROJECT=$(project_name)
VAULT=$(vault_path)

# ---------------------------------------------------------------------------
# 4. Catchup branch (detached background)
# ---------------------------------------------------------------------------
ORPHANS=$(find_orphans "$PROJECT" 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  # Compute oldest + newest raw file mtime as epoch seconds
  oldest_mtime=""
  newest_mtime=""
  while IFS= read -r raw_rel; do
    [ -n "$raw_rel" ] || continue
    raw_abs="$VAULT/$raw_rel"
    [ -f "$raw_abs" ] || continue
    mtime=$(stat -c %Y "$raw_abs" 2>/dev/null || stat -f %m "$raw_abs" 2>/dev/null || echo 0)
    if [ -z "$oldest_mtime" ] || [ "$mtime" -lt "$oldest_mtime" ]; then
      oldest_mtime=$mtime
    fi
    if [ -z "$newest_mtime" ] || [ "$mtime" -gt "$newest_mtime" ]; then
      newest_mtime=$mtime
    fi
  done <<< "$ORPHANS"

  if [ -n "$oldest_mtime" ] && [ -n "$newest_mtime" ]; then
    since=$(date -u -d "@$oldest_mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
            date -u -r "$oldest_mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
    until_ts=$(date -u -d "@$newest_mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
               date -u -r "$newest_mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

    if [ -n "$since" ] && [ -n "$until_ts" ]; then
      # Fork detached — session-end.sh handles UM_DETACH=1 internally
      UM_PROJECT="$PROJECT" \
      UM_CATCHUP_RAW_SINCE="$since" \
      UM_CATCHUP_RAW_UNTIL="$until_ts" \
      UM_DETACH=1 \
      bash "$SCRIPT_DIR/session-end.sh" &
      disown 2>/dev/null || true
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. Read branch — fetch state.md via API (synchronous, 3s timeout)
# ---------------------------------------------------------------------------
endpoint="${UM_ENDPOINT}"
response=$(curl -sfm 3 "$endpoint/api/state/$PROJECT" 2>/dev/null || echo '{}')

# Single Python invocation: parse state, apply staleness rules, emit JSON output.
# Combining parse + JSON encode avoids a second python3 startup (~200ms on Windows).
printf '%s' "$response" | python3 -c '
import json, sys, re
from datetime import datetime, timezone

def emit_empty():
    sys.stdout.write("{}\n")
    sys.exit(0)

try:
    data = json.load(sys.stdin)
except Exception:
    emit_empty()

state = data.get("state")
if not state:
    emit_empty()

body = state.get("body", "") or ""
# valid_from: check state.frontmatter first, then state, then top-level data
frontmatter = state.get("frontmatter") or {}
valid_from = frontmatter.get("valid_from") if isinstance(frontmatter, dict) else None
if not valid_from:
    valid_from = state.get("valid_from") or data.get("valid_from")

if not valid_from:
    # No age info — treat as fresh, inject verbatim
    sys.stdout.write(json.dumps({"additionalContext": body}) + "\n")
    sys.exit(0)

# Compute age in days
try:
    vf_str = str(valid_from)
    vf_dt = datetime.fromisoformat(vf_str.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    age_days = (now - vf_dt).total_seconds() / 86400
except Exception:
    age_days = 0  # unknown age — treat as fresh

if age_days > 30:
    emit_empty()  # stale, skip injection
elif age_days > 7:
    try:
        date_str = vf_dt.strftime("%Y-%m-%d")
    except Exception:
        date_str = str(valid_from)[:10]
    prefix = "# State of play (last active " + date_str + ", may be outdated)\n\n"
    # Strip existing "# State of play" heading from body if present, then prepend new one
    body_stripped = re.sub(r"^# State of play[^\n]*\n+", "", body, count=1)
    body_out = prefix + body_stripped
else:
    body_out = body

sys.stdout.write(json.dumps({"additionalContext": body_out}) + "\n")
' 2>/dev/null || printf '{}\n'

# ---------------------------------------------------------------------------
# (output already emitted by Python above)
# ---------------------------------------------------------------------------

exit 0
