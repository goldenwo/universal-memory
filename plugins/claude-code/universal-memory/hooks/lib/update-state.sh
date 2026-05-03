#!/usr/bin/env bash
# hooks/lib/update-state.sh — LLM-driven merge of old state.md + new session summary
#
# Usage: echo "$separated_input" | update-state.sh > updated-state.md
#
# stdin format:
#   ===UM-OLD-STATE===
#   <old state.md content, may be empty>
#   ===UM-SESSION-SUMMARY===
#   <new session summary, markdown body>
#   ===UM-END===
#
# stdout: updated state.md (frontmatter + body)
# stderr: telemetry + errors
# exit 0: always (fail-soft — empty stdout on any failure)

set -uo pipefail

# Source vault.sh for vault_path and project_name
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -f vault_path >/dev/null 2>&1; then
  # shellcheck source=./vault.sh
  source "$SCRIPT_DIR/vault.sh"
fi

# ---------------------------------------------------------------------------
# Load system prompt from file (Task 2.1: single source of truth)
# UM_PROMPT_DIR can be set by the installer's managed-block; defaults to
# <script-dir>/prompts/ so the plugin works standalone without the installer.
# ---------------------------------------------------------------------------
UM_PROMPT_DIR="${UM_PROMPT_DIR:-$SCRIPT_DIR/prompts}"
_UM_UPDATE_STATE_PROMPT_FILE="$UM_PROMPT_DIR/update-state.txt"
if [ ! -f "$_UM_UPDATE_STATE_PROMPT_FILE" ]; then
  echo "[um-update-state] prompt file not found: $_UM_UPDATE_STATE_PROMPT_FILE" >&2
  exit 0
fi
export _UM_SYSTEM_PROMPT
_UM_SYSTEM_PROMPT=$(cat "$_UM_UPDATE_STATE_PROMPT_FILE")
unset _UM_UPDATE_STATE_PROMPT_FILE

# ---------------------------------------------------------------------------
# Argument parsing (B1a): --stdout renders merge without side effects
# ---------------------------------------------------------------------------
# Modes:
#   write  (default) — render merged state, write telemetry, echo to stdout
#   stdout           — render merged state, skip telemetry, echo to stdout
# Note: this script never writes state.md or acquires a lockdir itself —
#       session-end.sh owns the atomic write + lock. The only side effect
#       gated by --stdout is the cost-log.csv telemetry append.
UM_MODE="write"
_um_remaining=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stdout)
      UM_MODE="stdout"
      shift
      ;;
    --project)
      if [ $# -lt 2 ]; then
        echo "[um-update-state] --project requires a value" >&2
        exit 0
      fi
      export UM_PROJECT="$2"
      shift 2
      ;;
    --) shift; while [ $# -gt 0 ]; do _um_remaining+=("$1"); shift; done; break ;;
    *)
      _um_remaining+=("$1")
      shift
      ;;
  esac
done
# Restore any non-flag args (currently unused by this script, but forward-compat).
if [ ${#_um_remaining[@]} -gt 0 ]; then
  set -- "${_um_remaining[@]}"
else
  set --
fi

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------
UM_STATE_MODEL="${UM_STATE_MODEL:-gpt-4o-mini}"
UM_STATE_MAX_CHARS="${UM_STATE_MAX_CHARS:-12000}"
UM_STATE_TIMEOUT_SEC="${UM_STATE_TIMEOUT_SEC:-30}"

# ---------------------------------------------------------------------------
# Resolve API key
# ---------------------------------------------------------------------------
api_key="${UM_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
if [ -z "$api_key" ]; then
  # Silent exit — missing key is a no-op
  exit 0
fi

# ---------------------------------------------------------------------------
# Read full stdin
# ---------------------------------------------------------------------------
raw_input=$(cat)

# ---------------------------------------------------------------------------
# Parse separated input: extract old_state and session_summary blocks
# ---------------------------------------------------------------------------

# Validate required separators are present
if ! printf '%s' "$raw_input" | grep -qF -- '===UM-OLD-STATE==='; then
  echo "[um-update-state] missing ===UM-OLD-STATE=== separator in stdin" >&2
  exit 0
fi

if ! printf '%s' "$raw_input" | grep -qF -- '===UM-SESSION-SUMMARY==='; then
  echo "[um-update-state] missing ===UM-SESSION-SUMMARY=== separator in stdin" >&2
  exit 0
fi

if ! printf '%s' "$raw_input" | grep -qF -- '===UM-END==='; then
  echo "[um-update-state] missing ===UM-END=== separator in stdin" >&2
  exit 0
fi

# Extract old state: text between ===UM-OLD-STATE=== and ===UM-SESSION-SUMMARY===
if ! old_state=$(printf '%s' "$raw_input" | python3 -c '
import sys
content = sys.stdin.read()
start_marker = "===UM-OLD-STATE==="
end_marker = "===UM-SESSION-SUMMARY==="
start = content.find(start_marker)
end = content.find(end_marker)
if start == -1 or end == -1:
    sys.exit(1)
block = content[start + len(start_marker):end]
# Strip leading/trailing newlines only
sys.stdout.write(block.strip())
'); then
  echo "[um-update-state] failed to parse old state block" >&2
  exit 0
fi

# Extract session summary: text between ===UM-SESSION-SUMMARY=== and ===UM-END===
if ! session_summary=$(printf '%s' "$raw_input" | python3 -c '
import sys
content = sys.stdin.read()
start_marker = "===UM-SESSION-SUMMARY==="
end_marker = "===UM-END==="
start = content.find(start_marker)
end = content.find(end_marker)
if start == -1 or end == -1:
    sys.exit(1)
block = content[start + len(start_marker):end]
sys.stdout.write(block.strip())
'); then
  echo "[um-update-state] failed to parse session summary block" >&2
  exit 0
fi

# Guard: if session summary is empty, nothing to do
summary_len=${#session_summary}
if [ "$summary_len" -lt 10 ]; then
  echo "[um-update-state] session summary too short (${summary_len} chars), skipping" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Truncate combined input to UM_STATE_MAX_CHARS
# Split budget: old_state gets up to half, summary gets the rest
# ---------------------------------------------------------------------------
half_max=$(( UM_STATE_MAX_CHARS / 2 ))

old_state_len=${#old_state}
if [ "$old_state_len" -gt "$half_max" ]; then
  old_state="${old_state: -$half_max}"
  echo "[um-update-state] old state truncated to $half_max chars" >&2
fi

summary_len=${#session_summary}
remaining=$(( UM_STATE_MAX_CHARS - ${#old_state} ))
if [ "$summary_len" -gt "$remaining" ]; then
  session_summary="${session_summary: -$remaining}"
  echo "[um-update-state] session summary truncated to $remaining chars" >&2
fi

# ---------------------------------------------------------------------------
# Resolve project name and current timestamp
# UM_PROJECT (set by --project flag or by callers like session-end.sh) wins
# over the cwd-derived project_name(). Falls through to project_name() so
# existing stdin-only callers behave unchanged.
# ---------------------------------------------------------------------------
project="${UM_PROJECT:-$(project_name)}"
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Determine if old state is empty (initial state case)
if [ -z "$old_state" ]; then
  old_state_display="(empty — this is the initial state for this project)"
else
  old_state_display="$old_state"
fi

# ---------------------------------------------------------------------------
# Build JSON payload via python3 (handles all escaping correctly)
# ---------------------------------------------------------------------------

export _UM_USER_PROMPT="Project: ${project}
Current timestamp (UTC): ${timestamp}

Old state:
---
${old_state_display}
---

New session summary:
---
${session_summary}
---

Produce the updated state.md (frontmatter + body)."

export _UM_MODEL="$UM_STATE_MODEL"

payload=$(python3 -c '
import os, json
payload = {
    "model": os.environ["_UM_MODEL"],
    "messages": [
        {"role": "system", "content": os.environ["_UM_SYSTEM_PROMPT"]},
        {"role": "user",   "content": os.environ["_UM_USER_PROMPT"]}
    ]
}
print(json.dumps(payload))
')

# Clean up env vars
unset _UM_SYSTEM_PROMPT _UM_USER_PROMPT _UM_MODEL

if [ -z "$payload" ]; then
  echo "[um-update-state] failed to build request payload" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# API call with retry once on 5xx / 429
# ---------------------------------------------------------------------------
response=""
http_code=""

for attempt in 1 2; do
  raw_response=$(curl -s --max-time "$UM_STATE_TIMEOUT_SEC" \
    -w '\n__UM_HTTP_CODE__%{http_code}' \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -X POST https://api.openai.com/v1/chat/completions \
    -d "$payload" 2>&1)
  curl_status=$?

  # Extract HTTP status from the trailing sentinel line
  http_code=$(printf '%s' "$raw_response" | grep -o '__UM_HTTP_CODE__[0-9]*' | tail -1 | sed 's/__UM_HTTP_CODE__//')
  # Strip the sentinel line from the response body
  response=$(printf '%s' "$raw_response" | sed '/^__UM_HTTP_CODE__[0-9]*$/d')

  if [ $curl_status -ne 0 ]; then
    if [ "$attempt" -eq 2 ]; then
      echo "[um-update-state] API failed after retry (curl exit $curl_status), giving up" >&2
      exit 0
    fi
    sleep 1
    continue
  fi

  # Retry on 5xx or 429
  if [ -n "$http_code" ]; then
    if { [ "$http_code" -ge 500 ] 2>/dev/null; } || { [ "$http_code" -eq 429 ] 2>/dev/null; }; then
      if [ "$attempt" -eq 2 ]; then
        echo "[um-update-state] API error HTTP $http_code after retry, giving up" >&2
        exit 0
      fi
      sleep 1
      continue
    fi

    # Non-retryable 4xx (except 429 already handled)
    if [ "$http_code" -ge 400 ] 2>/dev/null; then
      echo "[um-update-state] API error HTTP $http_code, giving up" >&2
      exit 0
    fi
  fi

  break
done

# ---------------------------------------------------------------------------
# Parse state document from response
# ---------------------------------------------------------------------------
state_doc=$(printf '%s' "$response" | python3 -c '
import sys, json
try:
    d = json.loads(sys.stdin.read())
    content = d["choices"][0]["message"]["content"]
    sys.stdout.write(content)
    if content and not content.endswith("\n"):
        sys.stdout.write("\n")
except Exception as e:
    sys.stderr.write("[um-update-state] parse error: " + str(e) + "\n")
    sys.exit(1)
')

parse_status=$?
if [ $parse_status -ne 0 ] || [ -z "$state_doc" ]; then
  echo "[um-update-state] failed to parse API response" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Validation — check output has required structure before returning
# ---------------------------------------------------------------------------

# 1. Starts with ---\n (has frontmatter)
if ! printf '%s' "$state_doc" | head -1 | grep -qF -- '---'; then
  echo "[um-update-state] LLM output malformed, rejecting (missing frontmatter start)" >&2
  exit 0
fi

# 2. Has a second --- closing frontmatter
fm_close_count=$(printf '%s' "$state_doc" | grep -c '^---$' || true)
if [ "$fm_close_count" -lt 2 ]; then
  echo "[um-update-state] LLM output malformed, rejecting (missing frontmatter close)" >&2
  exit 0
fi

# 3. Has all 6 required H2 headers
required_headers=(
  "## Current focus"
  "## In flight"
  "## Recent decisions"
  "## Next actions"
  "## Open questions"
  "## Environment"
)

for header in "${required_headers[@]}"; do
  if ! printf '%s' "$state_doc" | grep -qF -- "$header"; then
    echo "[um-update-state] LLM output malformed, rejecting (missing '$header')" >&2
    exit 0
  fi
done

# 4. Total length <= 5000 chars
doc_len=${#state_doc}
if [ "$doc_len" -gt 5000 ]; then
  echo "[um-update-state] LLM output malformed, rejecting (length $doc_len > 5000)" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Telemetry
#   In --stdout mode we still log to stderr (useful for preview cost signal)
#   but skip the persistent cost-log.csv append so preview calls don't
#   pollute cumulative usage stats.
# ---------------------------------------------------------------------------
tokens_in=$(printf '%s' "$response" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("usage",{}).get("prompt_tokens",0))')
tokens_out=$(printf '%s' "$response" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("usage",{}).get("completion_tokens",0))')
cost=$(python3 -c "print(f'{($tokens_in * 0.00015 + $tokens_out * 0.0006) / 1000:.6f}')")

echo "[um-update-state] tokens_in=$tokens_in tokens_out=$tokens_out cost_estimate_usd=$cost mode=$UM_MODE" >&2

if [ "$UM_MODE" != "stdout" ]; then
  # Append to cost-log.csv (write mode only — preview must not bump counters)
  vault=$(vault_path)
  cost_log="$vault/.telemetry/cost-log.csv"
  mkdir -p "$(dirname "$cost_log")"
  if [ ! -f "$cost_log" ]; then
    echo "timestamp,project,model,tokens_in,tokens_out,cost_usd" > "$cost_log"
  fi
  echo "${timestamp},${project},${UM_STATE_MODEL},${tokens_in},${tokens_out},${cost}" >> "$cost_log"
fi

# ---------------------------------------------------------------------------
# Write updated state.md to stdout (same in both modes)
# ---------------------------------------------------------------------------
printf '%s' "$state_doc"
