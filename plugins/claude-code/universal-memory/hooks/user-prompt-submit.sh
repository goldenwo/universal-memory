#!/bin/bash
# user-prompt-submit.sh — inject vector-search hits on first prompt only.
#
# Behavior:
#   - Fires on EVERY user prompt (registered as UserPromptSubmit hook).
#   - On first prompt of a session: POST /api/search with the prompt text,
#     inject top 3-5 hits as "## Relevant from your memory" additionalContext.
#   - On subsequent prompts: exit 0 with empty output immediately.
#
# Session tracking:
#   Counter file: $VAULT/.telemetry/session-<SESSION_ID>.count
#   "First" = file absent OR contains "0".
#   Counter increments on every invocation regardless.
#
# Token budget: ~2k tokens max (~8k chars). Truncate if over.
#
# Exits silently (exit 0) on any failure — never block the prompt.

# Recursive-hook guard — if invoked inside a summarizer subprocess (A3's
# claude-agent-sdk backend spawns `claude -p`), exit immediately. Without
# this, the nested `claude` process would re-trigger this hook, causing
# duplicate captures at best and infinite loop at worst.
if [ "${UM_IN_SUMMARIZER_SUBPROCESS:-}" = "1" ]; then exit 0; fi

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

# shellcheck disable=SC1091
source "$LIB_DIR/vault.sh"

# ---------------------------------------------------------------------------
# 1. Read prompt from stdin
#    Claude Code passes the UserPromptSubmit event as a JSON envelope:
#      {"prompt": "<user message text>"}
#    Fall back to treating stdin as plain text if JSON parse fails.
# ---------------------------------------------------------------------------
RAW_STDIN=$(cat)

if [ -z "$RAW_STDIN" ]; then
  printf '{}\n'
  exit 0
fi

PROMPT_TEXT=$(printf '%s' "$RAW_STDIN" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    # Try known envelope fields in priority order
    text = (data.get("prompt") or
            data.get("user_message") or
            data.get("message") or
            data.get("text") or
            "")
    if text:
        print(text)
    else:
        # JSON but no recognized field — fall back to raw
        print(raw)
except Exception:
    # Not JSON — treat as plain text
    print(raw)
' 2>/dev/null | head -c 5000)

# Bail if prompt too short to be meaningful
if [ "${#PROMPT_TEXT}" -lt 5 ]; then
  printf '{}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Endpoint check — no endpoint means nothing to search
# ---------------------------------------------------------------------------
if [ -z "${UM_ENDPOINT:-}" ]; then
  printf '{}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Session ID — prefer CLAUDE_SESSION_ID; derive fallback from PPID + mtime
# ---------------------------------------------------------------------------
SESSION_ID="${CLAUDE_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  # Derive a stable-ish session identifier from parent PID + its start time
  # (changes on restart, stable within a session)
  SESSION_ID=$(printf '%s-%s' "$PPID" "$(
    # Try to get parent process start time for stability
    cat /proc/"$PPID"/stat 2>/dev/null | awk '{print $22}' ||
    stat -c %Y /proc/"$PPID" 2>/dev/null ||
    date +%s
  )" | md5sum 2>/dev/null | cut -c1-16 || printf '%s' "$$-$(date +%s)")
fi
# Final safety net
[ -z "$SESSION_ID" ] && SESSION_ID="fallback-$$"

# ---------------------------------------------------------------------------
# 4. Session counter — check if first prompt, increment regardless
# ---------------------------------------------------------------------------
VAULT=$(vault_path)
COUNTER_DIR="$VAULT/.telemetry"
COUNTER_FILE="$COUNTER_DIR/session-${SESSION_ID}.count"
mkdir -p "$COUNTER_DIR"

current_count=0
if [ -f "$COUNTER_FILE" ]; then
  current_count=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
  # Sanitize: ensure it's a non-negative integer
  case "$current_count" in
    ''|*[!0-9]*) current_count=0 ;;
  esac
fi

# Increment and persist
printf '%d\n' "$((current_count + 1))" > "$COUNTER_FILE"

# Not the first prompt → emit empty output immediately
if [ "$current_count" -ge 1 ]; then
  printf '{}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. FIRST PROMPT — vector search
# ---------------------------------------------------------------------------
# Cross-project search — no project filter on the query. If project-scoped
# search is wanted here in the future, compute PROJECT=$(project_name) and
# pass it via the search payload.
ENDPOINT="${UM_ENDPOINT}"

# Build POST body: use 'query' field (not 'q') for POST /api/search
search_payload=$(printf '%s' "$PROMPT_TEXT" | python3 -c '
import json, sys
text = sys.stdin.read().strip()
print(json.dumps({"query": text, "limit": 5}))
' 2>/dev/null)

if [ -z "$search_payload" ]; then
  printf '{}\n'
  exit 0
fi

response=$(curl -sfm 3 -X POST "$ENDPOINT/api/search" \
  -H 'Content-Type: application/json' \
  -d "$search_payload" 2>/dev/null || printf '{"results":[]}\n')

# ---------------------------------------------------------------------------
# 6. Assemble context block from search results
# ---------------------------------------------------------------------------
additional_context=$(printf '%s' "$response" | python3 -c '
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
  # Match session-start.sh output format: {"additionalContext": "..."}
  printf '%s' "$additional_context" | python3 -c '
import json, sys
content = sys.stdin.read()
sys.stdout.write(json.dumps({"additionalContext": content}) + "\n")
' 2>/dev/null || printf '{}\n'
else
  printf '{}\n'
fi

exit 0
