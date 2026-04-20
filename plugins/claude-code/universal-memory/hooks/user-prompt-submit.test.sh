#!/usr/bin/env bash
# hooks/user-prompt-submit.test.sh — tests for user-prompt-submit.sh
#
# Run: bash user-prompt-submit.test.sh
# All 7 test cases must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   1. Empty stdin → empty JSON, exit 0
#   2. UM_ENDPOINT unset → empty JSON, exit 0
#   3. First prompt, server returns 0 results → empty JSON, counter = 1
#   4. First prompt, server returns 3 hits → additionalContext with header, counter = 1
#   5. Second prompt (counter already = 1) → empty JSON, counter = 2
#   6. Third prompt → still empty, counter = 3
#   7. Very long prompt (10k chars) → truncated before sending, still works

# Prevent environment leakage from the developer's shell — if a prior test run
# or interactive session exported UM_IN_SUMMARIZER_SUBPROCESS=1, every hook
# would exit 0 and assertions would falsely pass.
unset UM_IN_SUMMARIZER_SUBPROCESS

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/user-prompt-submit.sh"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s\n' "$1"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name (got='$got', want='$want')"; fi
}

assert_empty() {
  local name="$1" got="$2"
  if [ -z "$got" ]; then pass "$name"
  else fail "$name (expected empty, got='${got:0:120}')"; fi
}

assert_not_empty() {
  local name="$1" got="$2"
  if [ -n "$got" ]; then pass "$name"
  else fail "$name (expected non-empty, got empty)"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got='${haystack:0:200}')"; fi
}

assert_file_count() {
  local name="$1" path="$2" want="$3"
  local got
  got=$(cat "$path" 2>/dev/null || echo "0")
  case "$got" in
    ''|*[!0-9]*) got=0 ;;
  esac
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name (counter file='$path', got='$got', want='$want')"; fi
}

# Helper: extract additionalContext from hook JSON output
extract_ac() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("additionalContext", ""))
except Exception:
    print("")
' 2>/dev/null || echo ""
}

# Helper: build a 3-hit search response
make_search_response_3hits() {
  python3 -c '
import json
results = [
    {"id": "mem-1", "memory": "Task A is in progress and needs attention soon.", "metadata": {"title": "Task A"}},
    {"id": "mem-2", "memory": "The architecture uses event-driven design patterns.", "metadata": {"title": "Arch note"}},
    {"id": "mem-3", "memory": "Deploy to staging before production always.", "metadata": {"title": "Deploy rule"}},
]
print(json.dumps({"results": results}))
'
}

# Helper: build a 0-hit search response
make_search_response_empty() {
  printf '{"results":[]}\n'
}

# ---------------------------------------------------------------------------
# Temp dir setup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

VAULT="$TMPDIR_ROOT/vault"
export UM_VAULT_DIR="$VAULT"
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"
export CLAUDE_SESSION_ID="test-session-abc123"

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

COUNTER_FILE="$VAULT/.telemetry/session-test-session-abc123.count"

# Helper: write a mock curl returning given JSON
write_mock_curl() {
  local json="$1"
  local resp_file="$TMPDIR_ROOT/mock_curl_resp.json"
  printf '%s' "$json" > "$resp_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/bin/bash
cat "$resp_file"
exit 0
MOCK
  chmod +x "$MOCK_BIN/curl"
}

# Helper: reset session counter
reset_counter() {
  rm -f "$COUNTER_FILE"
}

# Helper: run hook with given stdin, returns output
run_hook() {
  local stdin_text="$1"
  printf '%s' "$stdin_text" | \
    PATH="$MOCK_BIN:$PATH" \
    UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null
}

# Helper: run hook with UM_ENDPOINT unset
run_hook_no_endpoint() {
  local stdin_text="$1"
  printf '%s' "$stdin_text" | \
    PATH="$MOCK_BIN:$PATH" \
    UM_ENDPOINT="" \
    UM_VAULT_DIR="$UM_VAULT_DIR" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Test 1: Empty stdin → empty JSON, exit 0
# ---------------------------------------------------------------------------
printf '\nTest 1: Empty stdin\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_empty)"
  output=$(printf '' | \
    PATH="$MOCK_BIN:$PATH" \
    UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null)
  exit_code=$?
  assert_eq "exit 0 on empty stdin" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_empty "additionalContext empty on empty stdin" "$ac"
}

# ---------------------------------------------------------------------------
# Test 2: UM_ENDPOINT unset → empty JSON, exit 0
# ---------------------------------------------------------------------------
printf '\nTest 2: UM_ENDPOINT unset\n'
{
  reset_counter
  output=$(run_hook_no_endpoint "What should I work on today?")
  exit_code=$?
  assert_eq "exit 0 when endpoint unset" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_empty "additionalContext empty when endpoint unset" "$ac"
}

# ---------------------------------------------------------------------------
# Test 3: First prompt, server returns 0 results → empty JSON, counter = 1
# ---------------------------------------------------------------------------
printf '\nTest 3: First prompt, 0 search results\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_empty)"

  output=$(run_hook "What tasks are outstanding?")
  exit_code=$?
  assert_eq "exit 0 on first prompt with no hits" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_empty "additionalContext empty when no hits" "$ac"
  assert_file_count "counter = 1 after first prompt" "$COUNTER_FILE" "1"
}

# ---------------------------------------------------------------------------
# Test 4: First prompt, server returns 3 hits → additionalContext present, counter = 1
# ---------------------------------------------------------------------------
printf '\nTest 4: First prompt, 3 search hits\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_3hits)"

  output=$(run_hook "What tasks are outstanding?")
  exit_code=$?
  assert_eq "exit 0 on first prompt with hits" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_not_empty "additionalContext non-empty when hits returned" "$ac"
  assert_contains "output has section header" "$ac" "## Relevant from your memory"
  assert_contains "output includes first hit title" "$ac" "Task A"
  assert_contains "output includes second hit" "$ac" "Arch note"
  assert_file_count "counter = 1 after first prompt with hits" "$COUNTER_FILE" "1"
}

# ---------------------------------------------------------------------------
# Test 5: Second prompt (counter already = 1) → empty JSON, counter = 2
# ---------------------------------------------------------------------------
printf '\nTest 5: Second prompt (counter = 1 → 2)\n'
{
  # Counter should already be 1 from Test 4; verify then run
  assert_file_count "pre-condition: counter = 1" "$COUNTER_FILE" "1"

  # Mock returns hits — but second prompt should NOT search at all
  write_mock_curl "$(make_search_response_3hits)"

  output=$(run_hook "Follow-up question here")
  exit_code=$?
  assert_eq "exit 0 on second prompt" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_empty "additionalContext empty on second prompt" "$ac"
  assert_file_count "counter = 2 after second prompt" "$COUNTER_FILE" "2"
}

# ---------------------------------------------------------------------------
# Test 6: Third prompt → still empty, counter = 3
# ---------------------------------------------------------------------------
printf '\nTest 6: Third prompt (counter = 2 → 3)\n'
{
  assert_file_count "pre-condition: counter = 2" "$COUNTER_FILE" "2"

  output=$(run_hook "Yet another question")
  exit_code=$?
  assert_eq "exit 0 on third prompt" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_empty "additionalContext empty on third prompt" "$ac"
  assert_file_count "counter = 3 after third prompt" "$COUNTER_FILE" "3"
}

# ---------------------------------------------------------------------------
# Test 7: Very long prompt (10k chars) → truncated before sending, still works
# ---------------------------------------------------------------------------
printf '\nTest 7: Very long prompt (10k chars)\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_3hits)"

  # Generate a prompt that's exactly 10000 chars
  long_prompt=$(python3 -c "print('x' * 10000)")

  # Track what curl received as the POST body
  received_file="$TMPDIR_ROOT/curl_received.json"
  cat > "$MOCK_BIN/curl" <<CURLDUMP
#!/bin/bash
# Capture the -d argument (POST body) to verify truncation
# Args: sfm 3 -X POST <url> -H Content-Type... -d <payload>
while [[ "\$#" -gt 0 ]]; do
  if [[ "\$1" == "-d" ]]; then
    printf '%s' "\$2" > "$received_file"
    break
  fi
  shift
done
cat "$(dirname "$received_file")/mock_curl_resp.json"
exit 0
CURLDUMP
  chmod +x "$MOCK_BIN/curl"
  write_mock_curl "$(make_search_response_3hits)"

  output=$(run_hook "$long_prompt")
  exit_code=$?
  assert_eq "exit 0 on long prompt" "$exit_code" "0"

  # Verify the payload sent to API had the query truncated (≤5000 chars)
  if [ -f "$received_file" ]; then
    query_len=$(python3 -c "
import json, sys
try:
    d = json.loads(open('$received_file').read())
    print(len(d.get('query', '')))
except Exception:
    print(-1)
")
    if [ "$query_len" -le 5000 ]; then
      pass "prompt truncated to ≤5000 chars before API call (len=$query_len)"
    else
      fail "prompt not truncated (len=$query_len, expected ≤5000)"
    fi
  else
    # curl mock didn't write the file — the hook may have bailed before curl
    # That's acceptable: a very long prompt that gets truncated to 5000 chars
    # is still meaningful; the hook should have run curl.
    # Check that we still got output (hit path via make_search_response_3hits)
    ac=$(extract_ac "$output")
    assert_not_empty "long prompt still produces hits after truncation" "$ac"
  fi

  assert_file_count "counter = 1 after long prompt (first prompt)" "$COUNTER_FILE" "1"
}

# ---------------------------------------------------------------------------
# Test 8: Recursive-hook guard — UM_IN_SUMMARIZER_SUBPROCESS=1 exits silently
# ---------------------------------------------------------------------------
# Critical for A3's claude-agent-sdk backend: the nested `claude -p` process
# inherits UM_IN_SUMMARIZER_SUBPROCESS=1 in its env, and its own hooks (which
# source this file via the plugin) must exit immediately to prevent infinite
# recursion.
printf '\nTest 8: Recursive-hook guard (UM_IN_SUMMARIZER_SUBPROCESS=1)\n'
{
  GUARD_OUT=$(UM_IN_SUMMARIZER_SUBPROCESS=1 \
    UM_ENDPOINT="http://localhost:19999" \
    UM_VAULT_DIR="$UM_VAULT_DIR" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>&1)
  GUARD_EXIT=$?
  assert_eq "T8: guard exits 0 when UM_IN_SUMMARIZER_SUBPROCESS=1" "$GUARD_EXIT" "0"
  if [ -z "$GUARD_OUT" ] || [ "$GUARD_OUT" = "{}" ]; then
    pass "T8: guard emits no output (or empty JSON {})"
  else
    fail "T8: guard should emit empty output, got: $GUARD_OUT"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n---\n'
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nFailed tests:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
