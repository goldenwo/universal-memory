#!/bin/bash
# user-prompt-submit.sh — inject vector-search hits on first prompt only.
# (#159 T6b, spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §4–§5)
#
# Behavior:
#   - Fires on EVERY user prompt (registered as UserPromptSubmit hook).
#   - On first prompt of a session: POST /api/search with the prompt text
#     (via um-api.sh — Bearer-authed, works against remote endpoints),
#     inject top 3-5 hits as "## Relevant from your memory" additionalContext.
#   - On subsequent prompts: exit 0 with empty output immediately.
#
# Session tracking:
#   Counter file: ~/.um/state/prompt-count-<SESSION_ID> — same home as
#   stop.sh's delta cursors. UM_VAULT_DIR is no longer a client-side concept
#   (spec §4), so the old $VAULT/.telemetry location is gone. The session id
#   is sanitized to [A-Za-z0-9._-] before any path use, and counters older
#   than 7 days are swept on each fire (mirrors stop.sh's cursor sweep).
#   "First" = file absent OR contains "0". Counter increments on every
#   invocation regardless.
#
# Retired here (T6b): the UM_IN_SUMMARIZER_SUBPROCESS recursion guard. Its
# writer chain died with the T4 client-summarizer retirement — no hook spawns
# `claude -p` anymore. summarize.sh (alive only via the manual `um-preview`
# CLI) still exports the sentinel, but a nested claude firing this hook costs
# exactly one bounded curl and cannot recurse (this hook never spawns claude).
#
# Token budget: ~2k tokens max (~8k chars). Truncate if over.
#
# Exits silently (exit 0) on any failure — never block the prompt.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

UM_HOOK_NAME="user-prompt-submit"
# shellcheck source=lib/um-api.sh
source "$LIB_DIR/um-api.sh"

# Interpreter probe FIRST (same rationale as session-start.sh): on Windows a
# bare `python3` is often a Microsoft Store app-execution-alias stub that
# exists on PATH but doesn't run — it would silently kill the whole feature.
PY=$(um_find_python) || { printf '{}\n'; exit 0; }

# ---------------------------------------------------------------------------
# 1. Read prompt + session_id from stdin
#    Claude Code passes the UserPromptSubmit event as a JSON envelope:
#      {"session_id": "...", "prompt": "<user message text>", ...}
#    Fall back to treating stdin as plain text if JSON parse fails.
#    One python pass extracts BOTH fields: line 1 = session_id (whitespace
#    collapsed so the line protocol holds; '' when stdin lacks it), rest =
#    prompt truncated CHARACTER-safe to 5000 chars (a byte-level `head -c`
#    could split a multibyte char and crash a strict decode downstream).
# ---------------------------------------------------------------------------
RAW_STDIN=$(cat)

if [ -z "$RAW_STDIN" ]; then
  printf '{}\n'
  exit 0
fi

PARSED=$(printf '%s' "$RAW_STDIN" | "$PY" -c '
import sys, json, re
raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
session_id = ""
text = raw
try:
    data = json.loads(raw)
    # Try known envelope fields in priority order
    candidate = (data.get("prompt") or
                 data.get("user_message") or
                 data.get("message") or
                 data.get("text") or
                 "")
    if isinstance(candidate, str) and candidate:
        text = candidate
    # session_id rides the same envelope (CC hook input contract)
    sid = data.get("session_id") or ""
    if isinstance(sid, str):
        session_id = re.sub(r"\s+", "-", sid.strip())
except Exception:
    pass  # Not JSON — treat as plain text, no session_id
print(session_id)
print(text[:5000])
' 2>/dev/null)
SESSION_ID_STDIN=$(printf '%s\n' "$PARSED" | head -n1)
PROMPT_TEXT=$(printf '%s\n' "$PARSED" | tail -n +2)

# Bail if prompt too short to be meaningful
if [ "${#PROMPT_TEXT}" -lt 5 ]; then
  printf '{}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Config gate — spec §4 composed resolution via um-api.sh: env tiers
#    (UM_SERVER_URL / deprecated UM_ENDPOINT) → ~/.um/endpoint file → none.
#    Unconfigured boxes stay silent.
# ---------------------------------------------------------------------------
if ! um_api_configured; then
  printf '{}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Session ID — stdin's session_id is authoritative (Claude Code sends it in
# the hook input envelope and does NOT set CLAUDE_SESSION_ID). The env var and
# the PPID/mtime derivation survive ONLY as fallbacks for stdin that lacks it
# (plain-text stdin, older CC). Without the stdin source, macOS/Windows fell
# through /proc to `date +%s` — a NEW id every prompt, so the "first prompt
# only" gate fired every prompt and leaked one counter file per prompt.
# ---------------------------------------------------------------------------
SESSION_ID="$SESSION_ID_STDIN"
[ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  # Derive a stable-ish session identifier from parent PID + its start time
  # (changes on restart, stable within a session)
  SESSION_ID=$(printf '%s-%s' "$PPID" "$(
    # Try to get parent process start time for stability
    awk '{print $22}' /proc/"$PPID"/stat 2>/dev/null ||
    stat -c %Y /proc/"$PPID" 2>/dev/null ||
    date +%s
  )" | md5sum 2>/dev/null | cut -c1-16 || printf '%s' "$$-$(date +%s)")
fi
# Sanitize before ANY path use (same character class stop.sh validates):
# hostile/odd ids ('/', spaces, ...) collapse deterministically to '-', so
# the counter name is path-safe yet stable across fires of the same session.
SESSION_ID="${SESSION_ID//[^A-Za-z0-9._-]/-}"
# Final safety net
[ -z "$SESSION_ID" ] && SESSION_ID="fallback-$$"

# ---------------------------------------------------------------------------
# 4. Session counter — check if first prompt, increment regardless.
#    Lives in ~/.um/state (stop-cursor's home); stale counters (>7d) are
#    swept with the same per-candidate character guard stop.sh uses.
# ---------------------------------------------------------------------------
STATE_DIR="$HOME/.um/state"
COUNTER_FILE="$STATE_DIR/prompt-count-$SESSION_ID"
mkdir -p "$STATE_DIR" 2>/dev/null || true

for f in "$STATE_DIR"/prompt-count-*; do
  [ -f "$f" ] || continue
  sid_part="${f##*/prompt-count-}"
  [[ "$sid_part" =~ ^[A-Za-z0-9._-]+$ ]] || continue
  if [ -n "$(find "$f" -maxdepth 0 -mtime +7 2>/dev/null)" ]; then
    rm -f "$f" 2>/dev/null || true
  fi
done

current_count=0
if [ -f "$COUNTER_FILE" ]; then
  current_count=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
  # Sanitize: ensure it's a non-negative integer
  case "$current_count" in
    ''|*[!0-9]*) current_count=0 ;;
  esac
fi

# Increment and persist
printf '%d\n' "$((current_count + 1))" > "$COUNTER_FILE" 2>/dev/null || true

# Not the first prompt → emit empty output immediately
if [ "$current_count" -ge 1 ]; then
  printf '{}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. FIRST PROMPT — vector search
# ---------------------------------------------------------------------------
# Cross-project search — no project filter on the query. If project-scoped
# search is wanted here in the future, compute the project client-side and
# pass it via the search payload.

# Build POST body: use 'query' field (not 'q') for POST /api/search
search_payload=$(printf '%s' "$PROMPT_TEXT" | "$PY" -c '
import json, sys
text = sys.stdin.read().strip()
print(json.dumps({"query": text, "limit": 5}))
' 2>/dev/null)

if [ -z "$search_payload" ]; then
  printf '{}\n'
  exit 0
fi

# um_api_post resolves the endpoint (env → file → default), adds the Bearer
# token when one exists, and bounds the call (connect 3s / total 10s). The
# body flows through even on non-2xx; downstream parsing is fail-soft.
response=$(um_api_post "/api/search" "$search_payload" 2>/dev/null) || true
[ -z "$response" ] && response='{"results":[]}'

# ---------------------------------------------------------------------------
# 6. Assemble context block from search results
# ---------------------------------------------------------------------------
additional_context=$(printf '%s' "$response" | "$PY" -c '
import json, sys

try:
    data = json.load(sys.stdin)
    results = data.get("results", [])
except Exception:
    sys.exit(0)

if not results:
    sys.exit(0)

# Token budget: ~2k tokens ≈ 8000 chars (rough 4-char/token estimate)
TOKEN_BUDGET = 8000
hits = results[:5]  # max 5 hits

lines = ["## Relevant from your memory", ""]
total_chars = sum(len(l) + 1 for l in lines)

for r in hits:
    memory = r.get("memory", "") or ""
    metadata = r.get("metadata", {}) or {}
    title = (metadata.get("title") or
             metadata.get("id") or
             r.get("id") or
             "memory")
    snippet = memory[:500]  # 500 chars per hit
    entry = f"- **{title}**: {snippet}"
    if total_chars + len(entry) + 1 > TOKEN_BUDGET:
        break
    lines.append(entry)
    total_chars += len(entry) + 1

if len(lines) <= 2:
    sys.exit(0)  # only header, no hits — skip

print("\n".join(lines))
' 2>/dev/null)

# ---------------------------------------------------------------------------
# 7. Emit output
# ---------------------------------------------------------------------------
if [ -n "$additional_context" ]; then
  # Documented UserPromptSubmit envelope (code.claude.com/docs/en/hooks):
  # additionalContext MUST ride inside hookSpecificOutput with the event
  # name — a top-level additionalContext is silently ignored by Claude Code.
  printf '%s' "$additional_context" | "$PY" -c '
import json, sys
content = sys.stdin.read()
sys.stdout.write(json.dumps({"hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": content,
}}) + "\n")
' 2>/dev/null || printf '{}\n'
else
  printf '{}\n'
fi

exit 0
