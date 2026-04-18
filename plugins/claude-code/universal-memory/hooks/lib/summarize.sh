#!/usr/bin/env bash
# hooks/lib/summarize.sh — LLM summarization primitive
#
# Usage: summarize.sh < transcript.md > summary.md
# Or:    echo "$transcript" | summarize.sh > summary.md
#
# Reads transcript from stdin.
# Writes summary body (markdown, no frontmatter) to stdout.
# Telemetry + errors to stderr.
#
# Exit codes:
#   0 = success (summary on stdout) OR graceful no-op (missing key, tiny transcript, API error)
#   Never exits non-zero — fail-soft by design

set -uo pipefail

# Source vault.sh for vault_path and project_name
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -f vault_path >/dev/null 2>&1; then
  # shellcheck source=./vault.sh
  source "$SCRIPT_DIR/vault.sh"
fi

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------
UM_SUMMARIZE_MODEL="${UM_SUMMARIZE_MODEL:-gpt-4o-mini}"
UM_SUMMARY_MAX_CHARS="${UM_SUMMARY_MAX_CHARS:-24000}"
UM_SUMMARY_DAILY_CAP="${UM_SUMMARY_DAILY_CAP:-50}"
UM_SUMMARY_TIMEOUT_SEC="${UM_SUMMARY_TIMEOUT_SEC:-30}"

# Cost constants (gpt-4o-mini pricing)
# PRICE_PER_1K_INPUT_USD = 0.00015   # $0.15/1M input
# PRICE_PER_1K_OUTPUT_USD = 0.0006   # $0.60/1M output

# ---------------------------------------------------------------------------
# Resolve API key
# ---------------------------------------------------------------------------
api_key="${UM_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
if [ -z "$api_key" ]; then
  # Silent exit — missing key is a no-op
  exit 0
fi

# ---------------------------------------------------------------------------
# Read transcript from stdin
# ---------------------------------------------------------------------------
transcript=$(cat)

# Guard: empty or tiny transcript → silent no-op
transcript_len=${#transcript}
if [ "$transcript_len" -lt 50 ]; then
  exit 0
fi

# Truncate to UM_SUMMARY_MAX_CHARS (keep the tail — most recent content is most valuable)
if [ "$transcript_len" -gt "$UM_SUMMARY_MAX_CHARS" ]; then
  transcript="${transcript: -$UM_SUMMARY_MAX_CHARS}"
fi

# ---------------------------------------------------------------------------
# Daily cap check
# ---------------------------------------------------------------------------
vault=$(vault_path)
project=$(project_name)
today=$(date -u +%Y-%m-%d)
counter_file="$vault/.telemetry/${today}-${project}.count"
mkdir -p "$(dirname "$counter_file")"

current=$(cat "$counter_file" 2>/dev/null || echo 0)
if [ "$current" -ge "$UM_SUMMARY_DAILY_CAP" ]; then
  echo "[um-summarize] daily cap ${UM_SUMMARY_DAILY_CAP} reached for ${project}, skipping" >&2
  exit 0
fi

# Increment BEFORE API call so concurrent calls don't both slip through
echo "$((current + 1))" > "$counter_file"

# ---------------------------------------------------------------------------
# Build JSON payload via python3 (handles all escaping correctly)
# Prompts are passed via environment variables to avoid shell-quoting issues.
# ---------------------------------------------------------------------------

# Verbatim system prompt
export _UM_SYSTEM_PROMPT='You summarize a Claude Code working session into a concise markdown note. The summary must let a future Claude session resume the user'"'"'s work without re-reading the full transcript.

Structure the output as markdown with these sections (omit any that don'"'"'t apply):

## What happened
(1-3 sentences of what the session accomplished or worked on)

## Key decisions
(bullets — only if the session made decisions worth remembering)

## In flight
(bullets — things started but not finished, with enough specificity to resume)

## Next steps
(bullets — specific next actions if any were identified)

Be concrete: reference file paths, function names, commit hashes, ticket IDs where they appear. Avoid generic phrases like "continued development" or "made progress." If the session was trivial (e.g., one-line fix, exploration without results), produce a 2-3 sentence paragraph instead of headers.

Output ONLY the markdown body. No preamble, no meta-commentary, no frontmatter, no surrounding code fences.'

export _UM_USER_PROMPT="Session transcript (most recent turns):

${transcript}"

export _UM_MODEL="$UM_SUMMARIZE_MODEL"

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
  echo "[um-summarize] failed to build request payload" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# API call with retry once on 5xx / 429
# ---------------------------------------------------------------------------
response=""
http_code=""

for attempt in 1 2; do
  # Use -w to append a sentinel with the HTTP status code.
  # Do NOT use -f so we can inspect the response body on errors.
  raw_response=$(curl -s --max-time "$UM_SUMMARY_TIMEOUT_SEC" \
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
      echo "[um-summarize] API failed after retry (curl exit $curl_status), giving up" >&2
      exit 0
    fi
    sleep 1
    continue
  fi

  # Retry on 5xx or 429
  if [ -n "$http_code" ]; then
    if { [ "$http_code" -ge 500 ] 2>/dev/null; } || { [ "$http_code" -eq 429 ] 2>/dev/null; }; then
      if [ "$attempt" -eq 2 ]; then
        echo "[um-summarize] API error HTTP $http_code after retry, giving up" >&2
        exit 0
      fi
      sleep 1
      continue
    fi

    # Non-retryable 4xx (except 429 already handled)
    if [ "$http_code" -ge 400 ] 2>/dev/null; then
      echo "[um-summarize] API error HTTP $http_code, giving up" >&2
      exit 0
    fi
  fi

  break
done

# ---------------------------------------------------------------------------
# Parse summary from response
# ---------------------------------------------------------------------------
summary=$(printf '%s' "$response" | python3 -c '
import sys, json
try:
    d = json.loads(sys.stdin.read())
    content = d["choices"][0]["message"]["content"]
    sys.stdout.write(content)
    if content and not content.endswith("\n"):
        sys.stdout.write("\n")
except Exception as e:
    sys.stderr.write("[um-summarize] parse error: " + str(e) + "\n")
    sys.exit(1)
')

parse_status=$?
if [ $parse_status -ne 0 ] || [ -z "$summary" ]; then
  echo "[um-summarize] failed to parse API response" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Telemetry — parse token counts, emit to stderr + cost-log.csv
# ---------------------------------------------------------------------------
tokens_in=$(printf '%s' "$response" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("usage",{}).get("prompt_tokens",0))')
tokens_out=$(printf '%s' "$response" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("usage",{}).get("completion_tokens",0))')
cost=$(python3 -c "print(f'{($tokens_in * 0.00015 + $tokens_out * 0.0006) / 1000:.6f}')")

echo "[um-summarize] tokens_in=$tokens_in tokens_out=$tokens_out cost_estimate_usd=$cost" >&2

# Append to cost-log.csv (create with header if absent)
cost_log="$vault/.telemetry/cost-log.csv"
mkdir -p "$(dirname "$cost_log")"
if [ ! -f "$cost_log" ]; then
  echo "timestamp,project,model,tokens_in,tokens_out,cost_usd" > "$cost_log"
fi
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "${timestamp},${project},${UM_SUMMARIZE_MODEL},${tokens_in},${tokens_out},${cost}" >> "$cost_log"

# ---------------------------------------------------------------------------
# Write summary to stdout
# ---------------------------------------------------------------------------
printf '%s' "$summary"
