#!/usr/bin/env bash
# hooks/user-prompt-submit.test.sh — tests for user-prompt-submit.sh
#
# Run: bash user-prompt-submit.test.sh
# All test cases must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   1. Empty stdin → empty JSON, exit 0
#   2. No endpoint configured (env empty, no ~/.um/endpoint) → empty JSON, exit 0
#   3. First prompt, server returns 0 results → empty JSON, counter = 1
#   4. First prompt, server returns 3 hits → additionalContext with header, counter = 1
#   5. Second prompt (counter already = 1) → empty JSON, counter = 2
#   6. Third prompt → still empty, counter = 3
#   7. Very long prompt (10k chars) → truncated before sending, still works
#   8. UM_IN_SUMMARIZER_SUBPROCESS=1 → hook fires NORMALLY (T6b removed the
#      recursion guard: no hook invokes the client summarizer anymore, and a
#      um-preview-spawned `claude -p` firing this hook costs one bounded curl)
#   9. Counter lives at ~/.um/state/prompt-count-<session_id> (NOT the vault —
#      UM_VAULT_DIR is no longer a client-side concept, spec §4)
#  10. Hostile session id is sanitized ([^A-Za-z0-9._-] → '-') before path use
#  11. Age sweep: prompt-count files >7d old are removed; fresh ones stay
#  12. ~/.um/endpoint file tier alone (no env) is enough to fire the search

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
# Temp dir setup — ISOLATED HOME (the hook writes ~/.um/state and reads
# ~/.um/endpoint + ~/.um/auth-token; never touch the developer's real ones)
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export HOME="$TMPDIR_ROOT/home"
mkdir -p "$HOME"
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"
export CLAUDE_SESSION_ID="test-session-abc123"

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# T6b: counter relocated from $VAULT/.telemetry/ to ~/.um/state/ (same home
# as stop.sh's cursors — UM_VAULT_DIR stops being a client concept, spec §4).
STATE_DIR="$HOME/.um/state"
COUNTER_FILE="$STATE_DIR/prompt-count-test-session-abc123"

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

# Helper: run hook with given stdin, returns output.
# UM_SERVER_URL pinned empty so a developer-shell export can't shadow the
# test's UM_ENDPOINT tier.
run_hook() {
  local stdin_text="$1"
  printf '%s' "$stdin_text" | \
    PATH="$MOCK_BIN:$PATH" \
    HOME="$HOME" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="http://localhost:19999" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null
}

# Helper: run hook with NO endpoint configured (env tiers empty; isolated
# HOME has no ~/.um/endpoint file)
run_hook_no_endpoint() {
  local stdin_text="$1"
  printf '%s' "$stdin_text" | \
    PATH="$MOCK_BIN:$PATH" \
    HOME="$HOME" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="" \
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
    HOME="$HOME" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="http://localhost:19999" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null)
  exit_code=$?
  assert_eq "exit 0 on empty stdin" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_empty "additionalContext empty on empty stdin" "$ac"
}

# ---------------------------------------------------------------------------
# Test 2: No endpoint configured → empty JSON, exit 0
# ---------------------------------------------------------------------------
printf '\nTest 2: No endpoint configured\n'
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
    ac=$(extract_ac "$output")
    assert_not_empty "long prompt still produces hits after truncation" "$ac"
  fi

  assert_file_count "counter = 1 after long prompt (first prompt)" "$COUNTER_FILE" "1"
}

# ---------------------------------------------------------------------------
# Test 8: guard REMOVED — hook fires normally inside a summarizer subprocess.
# T6b decision: no hook spawns the client summarizer anymore (T4 retired it);
# summarize.sh survives only via the manual `um-preview` CLI, and a nested
# `claude -p` firing this hook costs exactly one bounded (3s/10s) curl — no
# recursion is possible because this hook never spawns `claude`.
# ---------------------------------------------------------------------------
printf '\nTest 8: UM_IN_SUMMARIZER_SUBPROCESS=1 no longer short-circuits\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_3hits)"
  output=$(printf '%s' "What tasks are outstanding?" | \
    UM_IN_SUMMARIZER_SUBPROCESS=1 \
    PATH="$MOCK_BIN:$PATH" \
    HOME="$HOME" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="http://localhost:19999" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null)
  exit_code=$?
  assert_eq "T8: exit 0 with UM_IN_SUMMARIZER_SUBPROCESS=1" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_not_empty "T8: search still fires (guard removed)" "$ac"
  assert_file_count "T8: counter written despite sentinel var" "$COUNTER_FILE" "1"
}

# ---------------------------------------------------------------------------
# Test 9: counter is NOT written to the vault (UM_VAULT_DIR ignored)
# ---------------------------------------------------------------------------
printf '\nTest 9: counter lives in ~/.um/state, not the vault\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_empty)"
  vault_dir="$TMPDIR_ROOT/decoy-vault"
  mkdir -p "$vault_dir"
  output=$(printf '%s' "Where does the counter go?" | \
    PATH="$MOCK_BIN:$PATH" \
    HOME="$HOME" \
    UM_VAULT_DIR="$vault_dir" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="http://localhost:19999" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null)
  assert_file_count "T9: counter written under ~/.um/state" "$COUNTER_FILE" "1"
  if [ -e "$vault_dir/.telemetry" ]; then
    fail "T9: vault .telemetry dir was created (should not exist)"
  else
    pass "T9: no vault .telemetry dir created"
  fi
}

# ---------------------------------------------------------------------------
# Test 10: hostile session id sanitized before path use
# ---------------------------------------------------------------------------
printf '\nTest 10: hostile session id sanitized\n'
{
  write_mock_curl "$(make_search_response_empty)"
  evil_id='../../evil/id'
  sanitized='..-..-evil-id'
  rm -f "$STATE_DIR/prompt-count-$sanitized"
  output=$(printf '%s' "Does path traversal work?" | \
    PATH="$MOCK_BIN:$PATH" \
    HOME="$HOME" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="http://localhost:19999" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="$evil_id" \
    bash "$HOOK" 2>/dev/null)
  exit_code=$?
  assert_eq "T10: exit 0 with hostile session id" "$exit_code" "0"
  assert_file_count "T10: counter written to SANITIZED name" \
    "$STATE_DIR/prompt-count-$sanitized" "1"
  if [ -e "$HOME/.um/evil" ] || [ -e "$TMPDIR_ROOT/home/evil" ]; then
    fail "T10: path traversal escaped the state dir"
  else
    pass "T10: no traversal outside the state dir"
  fi
  rm -f "$STATE_DIR/prompt-count-$sanitized"
}

# ---------------------------------------------------------------------------
# Test 11: age sweep — stale prompt-count files (>7d) removed, fresh kept
# ---------------------------------------------------------------------------
printf '\nTest 11: stale counter sweep\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_empty)"
  mkdir -p "$STATE_DIR"
  stale="$STATE_DIR/prompt-count-old-session"
  fresh="$STATE_DIR/prompt-count-fresh-session"
  printf '3\n' > "$stale"
  printf '2\n' > "$fresh"
  touch -d '10 days ago' "$stale" 2>/dev/null || touch -t "$(date -v-10d +%Y%m%d%H%M 2>/dev/null || echo 202601010000)" "$stale"
  run_hook "Sweep check prompt" >/dev/null
  if [ -f "$stale" ]; then
    fail "T11: stale counter (>7d) not swept"
  else
    pass "T11: stale counter swept"
  fi
  if [ -f "$fresh" ]; then
    pass "T11: fresh counter preserved"
  else
    fail "T11: fresh counter wrongly deleted"
  fi
  rm -f "$fresh"
}

# ---------------------------------------------------------------------------
# Test 12: ~/.um/endpoint file tier alone configures the hook (spec §4 tier 3)
# ---------------------------------------------------------------------------
printf '\nTest 12: endpoint file tier (no env)\n'
{
  reset_counter
  write_mock_curl "$(make_search_response_3hits)"
  mkdir -p "$HOME/.um"
  printf 'http://filetier:6335\n' > "$HOME/.um/endpoint"
  output=$(printf '%s' "What tasks are outstanding?" | \
    PATH="$MOCK_BIN:$PATH" \
    HOME="$HOME" \
    UM_SERVER_URL="" \
    UM_ENDPOINT="" \
    CLAUDE_CWD="$CLAUDE_CWD" \
    CLAUDE_SESSION_ID="test-session-abc123" \
    bash "$HOOK" 2>/dev/null)
  exit_code=$?
  assert_eq "T12: exit 0 on file-tier config" "$exit_code" "0"
  ac=$(extract_ac "$output")
  assert_not_empty "T12: search fired via file-tier endpoint" "$ac"
  rm -f "$HOME/.um/endpoint"
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
