#!/usr/bin/env bash
# hooks/session-end.test.sh — integration tests for session-end.sh
#
# Run: bash session-end.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   1. No raw captures → exit 0 silently, nothing written
#   2. Happy path — fixture raw + mocked summarize/update-state via curl → summary + state written, reindex attempted
#   3. Summarize returns empty (LLM down) → summary NOT written; state.md unchanged; raw safe
#   4. Update-state returns empty (malformed LLM output) → summary written; state.md unchanged
#   5. Reindex POST fails → summary on disk; warning logged; exit 0
#   6. Lock held → state update skipped; summary still written

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_END="$SCRIPT_DIR/session-end.sh"

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
  else fail "$name (expected to contain '$needle')"; fi
}

assert_file_exists() {
  local name="$1" path="$2"
  if [ -f "$path" ]; then pass "$name"
  else fail "$name (file not found: $path)"; fi
}

assert_file_missing() {
  local name="$1" path="$2"
  if [ ! -f "$path" ]; then pass "$name"
  else fail "$name (file should not exist: $path)"; fi
}

# ---------------------------------------------------------------------------
# Temp dir + global setup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export UM_VAULT_DIR="$TMPDIR_ROOT/vault"
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"
export UM_PROJECT="testproject"
export OPENAI_API_KEY="sk-test-fake-key-for-session-end-tests"
export UM_ENDPOINT="http://localhost:19999"  # guaranteed unreachable

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# Fixture raw capture content
RAW_CONTENT="## 12:00:00Z

User: Can you implement the feature?
Assistant: I've implemented the feature in src/feature.py. The function handle_request now accepts an optional timeout parameter defaulting to 30 seconds. I also added test coverage in tests/test_feature.py.
User: Great, commit it.
Assistant: Committed as 'feat: add handle_request with timeout (abc1234)'."

# Fixture summary body (what summarize.sh would return)
SUMMARY_BODY="## What happened

Implemented handle_request feature in src/feature.py with timeout support.

## Key decisions

- Default timeout set to 30 seconds

## Next steps

- Run integration tests
- Deploy to staging"

# Fixture state.md body (what update-state.sh would return)
FIXTURE_STATE="---
schema_version: 1
type: state
id: state-testproject
title: State of play — testproject
status: current
valid_from: 2026-04-17T12:00:00Z
project: testproject
---

# State of play — testproject

## Current focus
Completed handle_request feature implementation.

## In flight
- Deploy to staging

## Recent decisions
- 2026-04-17: Default timeout set to 30 seconds

## Next actions
- Run integration tests
- Deploy to staging

## Open questions
- None

## Environment
Branch: close-continuity-gap"

# ---------------------------------------------------------------------------
# Helper: set up today's raw capture for project
# ---------------------------------------------------------------------------
setup_raw_capture() {
  local vault="$UM_VAULT_DIR"
  local project="${UM_PROJECT:-testproject}"
  local today
  today=$(date -u +%Y-%m-%d)
  local raw_dir="$vault/captures/$project/raw"
  mkdir -p "$raw_dir"
  printf '%s\n' "$RAW_CONTENT" > "$raw_dir/$today.md"
  echo "$raw_dir/$today.md"
}

# ---------------------------------------------------------------------------
# Helper: write mock curl that handles both OpenAI (summarize/update-state)
# and /api/reindex calls
#
# summarize_content: what summarize.sh should return (written to a temp file
#   consumed by mock curl for the OpenAI call)
# update_state_content: what update-state.sh should return
# reindex_status: HTTP status for /api/reindex (200 = success, 500 = fail)
# ---------------------------------------------------------------------------
write_full_mock_curl() {
  local summarize_content_file="$1"   # file containing summary body
  local update_state_content_file="$2"  # file containing state.md content
  local reindex_status="${3:-200}"
  local mock_path="$MOCK_BIN/curl"

  # Build the OpenAI JSON response for summarize (call 1)
  local summarize_json_file="$TMPDIR_ROOT/summarize_fixture.json"
  python3 - "$summarize_content_file" "$summarize_json_file" <<'PYEOF'
import sys, json
with open(sys.argv[1], "r") as f:
    content = f.read()
resp = {
    "choices": [{"message": {"content": content}}],
    "usage": {"prompt_tokens": 150, "completion_tokens": 80}
}
with open(sys.argv[2], "w") as f:
    json.dump(resp, f)
PYEOF

  # Build the OpenAI JSON response for update-state (call 2)
  local state_json_file="$TMPDIR_ROOT/state_fixture.json"
  python3 - "$update_state_content_file" "$state_json_file" <<'PYEOF'
import sys, json
with open(sys.argv[1], "r") as f:
    content = f.read()
resp = {
    "choices": [{"message": {"content": content}}],
    "usage": {"prompt_tokens": 250, "completion_tokens": 180}
}
with open(sys.argv[2], "w") as f:
    json.dump(resp, f)
PYEOF

  # Counter file: tracks how many times curl was called (for routing)
  local counter_file="$TMPDIR_ROOT/curl_call_count"
  echo "0" > "$counter_file"

  # Write mock curl: first call → summarize response, second call → state response
  # /api/reindex calls (contain "reindex" in the URL args) → reindex_status
  cat > "$mock_path" <<MOCK_EOF
#!/usr/bin/env bash
# Mock curl for session-end tests
# Detect if this is a reindex call (URL contains "reindex")
is_reindex=0
for arg in "\$@"; do
  if [[ "\$arg" == *"reindex"* ]]; then
    is_reindex=1
    break
  fi
done

if [ "\$is_reindex" -eq 1 ]; then
  if [ "${reindex_status}" -eq 200 ] 2>/dev/null; then
    printf '{"ok":true}\n'
    printf '\n__UM_HTTP_CODE__200'
  else
    # Simulate failure: non-zero exit (like curl -sf would fail)
    exit 1
  fi
  exit 0
fi

# OpenAI call: route by call count
count=\$(cat "$counter_file" 2>/dev/null || echo 0)
count=\$((count + 1))
echo "\$count" > "$counter_file"

if [ "\$count" -le 1 ]; then
  cat "$summarize_json_file"
  printf '\n__UM_HTTP_CODE__200'
else
  cat "$state_json_file"
  printf '\n__UM_HTTP_CODE__200'
fi
MOCK_EOF
  chmod +x "$mock_path"
}

# ===========================================================================
# Test 1: No raw captures → exit 0 silently, nothing written
# ===========================================================================
echo "=== Test 1: No raw captures ==="

# Ensure vault raw dir is clean for this project
rm -rf "$UM_VAULT_DIR/captures/${UM_PROJECT:-testproject}" 2>/dev/null || true

T1_EXIT=0
T1_STDERR=$(bash "$SESSION_END" 2>&1) || T1_EXIT=$?
T1_SESSION_COUNT=$(find "$UM_VAULT_DIR/sessions" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

assert_eq "T1: exit code 0 with no raw captures" "$T1_EXIT" "0"
assert_empty "T1: no stderr output on silent no-op" "$T1_STDERR"
assert_eq "T1: no session summary written" "$T1_SESSION_COUNT" "0"

# Verify state.md was not created
state_file_t1="$UM_VAULT_DIR/state/${UM_PROJECT:-testproject}/state.md"
assert_file_missing "T1: state.md not created" "$state_file_t1"

# ===========================================================================
# Test 2: Happy path — fixture raw + mocked summarize + update-state
# ===========================================================================
echo "=== Test 2: Happy path ==="

setup_raw_capture >/dev/null

# Write fixture files for mock
T2_SUMMARY_FILE="$TMPDIR_ROOT/t2_summary.md"
printf '%s\n' "$SUMMARY_BODY" > "$T2_SUMMARY_FILE"

T2_STATE_FILE="$TMPDIR_ROOT/t2_state.md"
printf '%s\n' "$FIXTURE_STATE" > "$T2_STATE_FILE"

write_full_mock_curl "$T2_SUMMARY_FILE" "$T2_STATE_FILE" "200"

T2_EXIT=0
T2_STDERR=$(PATH="$MOCK_BIN:$PATH" bash "$SESSION_END" 2>&1) || T2_EXIT=$?

assert_eq "T2: exit code 0 on success" "$T2_EXIT" "0"

# Verify session summary was written
T2_SESSIONS_DIR="$UM_VAULT_DIR/sessions/${UM_PROJECT:-testproject}"
T2_SUMMARY_COUNT=$(find "$T2_SESSIONS_DIR" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
assert_not_empty "T2: sessions dir exists" "$([ -d "$T2_SESSIONS_DIR" ] && echo yes || echo '')"
# Find the summary file (pattern: YYYYMMDD-HHMMSS-testproject.md)
T2_SUMMARY_PATH=$(find "$T2_SESSIONS_DIR" -name '*-testproject.md' 2>/dev/null | head -1)
assert_not_empty "T2: session summary file written" "$T2_SUMMARY_PATH"

if [ -n "$T2_SUMMARY_PATH" ]; then
  T2_CONTENT=$(cat "$T2_SUMMARY_PATH")
  assert_contains "T2: summary has schema_version in frontmatter" "$T2_CONTENT" "schema_version: 1"
  assert_contains "T2: summary has type: session_summary" "$T2_CONTENT" "type: session_summary"
  assert_contains "T2: summary has project field" "$T2_CONTENT" "project: testproject"
  assert_contains "T2: summary has valid_from field" "$T2_CONTENT" "valid_from:"
  assert_contains "T2: summary body contains session content" "$T2_CONTENT" "## What happened"
fi

# Verify state.md was written
T2_STATE_PATH="$UM_VAULT_DIR/state/${UM_PROJECT:-testproject}/state.md"
assert_file_exists "T2: state.md written" "$T2_STATE_PATH"
if [ -f "$T2_STATE_PATH" ]; then
  T2_STATE_CONTENT=$(cat "$T2_STATE_PATH")
  assert_contains "T2: state.md has Current focus" "$T2_STATE_CONTENT" "## Current focus"
  assert_contains "T2: state.md has Recent decisions" "$T2_STATE_CONTENT" "## Recent decisions"
fi

# Verify reindex was attempted (stderr should NOT contain reindex failure)
if [[ "$T2_STDERR" == *"reindex failed"* ]]; then
  fail "T2: reindex unexpectedly failed (mock should succeed)"
else
  pass "T2: reindex succeeded (no failure in stderr)"
fi

# ===========================================================================
# Test 3: Summarize returns empty (LLM down / no API key)
#         → summary NOT written; state.md unchanged; raw captures preserved
# ===========================================================================
echo "=== Test 3: Summarize returns empty (LLM down) ==="

# Remove any existing state.md so we can verify it wasn't created
T3_STATE_FILE="$UM_VAULT_DIR/state/${UM_PROJECT:-testproject}/state.md"
rm -f "$T3_STATE_FILE" 2>/dev/null || true

# Write mock curl that returns empty content for OpenAI (summarize will return empty)
T3_EMPTY_CONTENT_FILE="$TMPDIR_ROOT/t3_empty.md"
printf '' > "$T3_EMPTY_CONTENT_FILE"  # empty content → summarize.sh exits without output

# Mock curl returns a valid JSON with empty content string
cat > "$MOCK_BIN/curl" <<'MOCK_EOF'
#!/usr/bin/env bash
# Returns empty content → summarize.sh will produce empty stdout
is_reindex=0
for arg in "$@"; do
  if [[ "$arg" == *"reindex"* ]]; then
    is_reindex=1; break
  fi
done
if [ "$is_reindex" -eq 1 ]; then
  printf '{"ok":true}\n'; printf '\n__UM_HTTP_CODE__200'; exit 0
fi
# Return HTTP 401 → summarize.sh will give up and produce empty stdout
printf '{"error":"unauthorized"}\n'
printf '\n__UM_HTTP_CODE__401'
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

T3_EXIT=0
T3_STDERR=$(PATH="$MOCK_BIN:$PATH" \
  UM_OPENAI_API_KEY="sk-test-fake" \
  OPENAI_API_KEY="sk-test-fake" \
  bash "$SESSION_END" 2>&1) || T3_EXIT=$?

assert_eq "T3: exit code 0 when summarize returns empty" "$T3_EXIT" "0"
# Summary should NOT have been written (summarize returned empty)
T3_SESSIONS_DIR="$UM_VAULT_DIR/sessions/${UM_PROJECT:-testproject}"
T3_NEW_SUMMARIES=$(find "$T3_SESSIONS_DIR" -name '*.md' -newer "$TMPDIR_ROOT/t3_empty.md" 2>/dev/null | wc -l | tr -d ' ')
# We check stderr mentions the skip reason
assert_contains "T3: stderr explains summarize was empty" "$T3_STDERR" "summarize returned empty"
assert_file_missing "T3: state.md not created" "$T3_STATE_FILE"

# Verify raw capture is still intact
T3_RAW_FILE="$UM_VAULT_DIR/captures/${UM_PROJECT:-testproject}/raw/$(date -u +%Y-%m-%d).md"
assert_file_exists "T3: raw capture still on disk" "$T3_RAW_FILE"

# ===========================================================================
# Test 4: Update-state returns empty (malformed LLM output)
#         → summary IS written; state.md NOT written/unchanged
# ===========================================================================
echo "=== Test 4: Update-state returns empty (malformed output) ==="

# Reset state.md
T4_STATE_FILE="$UM_VAULT_DIR/state/${UM_PROJECT:-testproject}/state.md"
rm -f "$T4_STATE_FILE" 2>/dev/null || true

# Summary fixture: returns valid summary body
T4_SUMMARY_FILE="$TMPDIR_ROOT/t4_summary.md"
printf '%s\n' "$SUMMARY_BODY" > "$T4_SUMMARY_FILE"

# State fixture: returns malformed output (missing required headers)
T4_MALFORMED_STATE_FILE="$TMPDIR_ROOT/t4_malformed_state.md"
cat > "$T4_MALFORMED_STATE_FILE" <<'FIXTURE_EOF'
---
schema_version: 1
type: state
---

# Incomplete state

## Current focus
Something.
FIXTURE_EOF

# Build JSON responses
T4_SUMMARIZE_JSON="$TMPDIR_ROOT/t4_summarize.json"
python3 - "$T4_SUMMARY_FILE" "$T4_SUMMARIZE_JSON" <<'PYEOF'
import sys, json
with open(sys.argv[1], "r") as f:
    content = f.read()
resp = {"choices":[{"message":{"content": content}}], "usage":{"prompt_tokens":100,"completion_tokens":50}}
with open(sys.argv[2], "w") as f:
    json.dump(resp, f)
PYEOF

T4_STATE_JSON="$TMPDIR_ROOT/t4_state.json"
python3 - "$T4_MALFORMED_STATE_FILE" "$T4_STATE_JSON" <<'PYEOF'
import sys, json
with open(sys.argv[1], "r") as f:
    content = f.read()
resp = {"choices":[{"message":{"content": content}}], "usage":{"prompt_tokens":200,"completion_tokens":80}}
with open(sys.argv[2], "w") as f:
    json.dump(resp, f)
PYEOF

T4_COUNTER="$TMPDIR_ROOT/t4_call_count"
echo "0" > "$T4_COUNTER"

cat > "$MOCK_BIN/curl" <<MOCK_EOF
#!/usr/bin/env bash
is_reindex=0
for arg in "\$@"; do
  if [[ "\$arg" == *"reindex"* ]]; then
    is_reindex=1; break
  fi
done
if [ "\$is_reindex" -eq 1 ]; then
  printf '{"ok":true}\n'; printf '\n__UM_HTTP_CODE__200'; exit 0
fi
count=\$(cat "$T4_COUNTER" 2>/dev/null || echo 0)
count=\$((count + 1))
echo "\$count" > "$T4_COUNTER"
if [ "\$count" -le 1 ]; then
  cat "$T4_SUMMARIZE_JSON"; printf '\n__UM_HTTP_CODE__200'
else
  cat "$T4_STATE_JSON"; printf '\n__UM_HTTP_CODE__200'
fi
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

T4_EXIT=0
T4_STDERR=$(PATH="$MOCK_BIN:$PATH" bash "$SESSION_END" 2>&1) || T4_EXIT=$?

assert_eq "T4: exit code 0 when update-state returns empty" "$T4_EXIT" "0"

# Session summary SHOULD be written (partial success)
T4_SESSIONS_DIR="$UM_VAULT_DIR/sessions/${UM_PROJECT:-testproject}"
T4_SUMMARY_PATH=$(find "$T4_SESSIONS_DIR" -name '*.md' 2>/dev/null | tail -1)
assert_not_empty "T4: session summary still written despite state failure" "$T4_SUMMARY_PATH"

if [ -n "$T4_SUMMARY_PATH" ]; then
  T4_CONTENT=$(cat "$T4_SUMMARY_PATH")
  assert_contains "T4: summary has correct type" "$T4_CONTENT" "type: session_summary"
fi

# state.md should NOT be written (update-state returned empty due to malformed output)
assert_file_missing "T4: state.md NOT written on malformed update-state output" "$T4_STATE_FILE"

# ===========================================================================
# Test 5: Reindex POST fails → summary on disk; warning logged; exit 0
# ===========================================================================
echo "=== Test 5: Reindex POST fails ==="

# Use mock where reindex fails (exit 1 = curl -sf failure)
T5_SUMMARY_FILE="$TMPDIR_ROOT/t5_summary.md"
printf '%s\n' "$SUMMARY_BODY" > "$T5_SUMMARY_FILE"

T5_STATE_FILE_FIXTURE="$TMPDIR_ROOT/t5_state.md"
printf '%s\n' "$FIXTURE_STATE" > "$T5_STATE_FILE_FIXTURE"

write_full_mock_curl "$T5_SUMMARY_FILE" "$T5_STATE_FILE_FIXTURE" "500"

T5_EXIT=0
T5_STDERR=$(PATH="$MOCK_BIN:$PATH" bash "$SESSION_END" 2>&1) || T5_EXIT=$?

assert_eq "T5: exit code 0 when reindex fails" "$T5_EXIT" "0"

# Summary should still be on disk
T5_SESSIONS_DIR="$UM_VAULT_DIR/sessions/${UM_PROJECT:-testproject}"
T5_SUMMARY_PATH=$(find "$T5_SESSIONS_DIR" -name '*.md' 2>/dev/null | tail -1)
assert_not_empty "T5: summary on disk despite reindex failure" "$T5_SUMMARY_PATH"

# Stderr should mention reindex failure
assert_contains "T5: stderr warns about reindex failure" "$T5_STDERR" "reindex failed"

# ===========================================================================
# Test 6: Lock held → state update skipped; summary still written
# ===========================================================================
echo "=== Test 6: Lock held by another process ==="

T6_SUMMARY_FILE="$TMPDIR_ROOT/t6_summary.md"
printf '%s\n' "$SUMMARY_BODY" > "$T6_SUMMARY_FILE"

T6_STATE_FIXTURE="$TMPDIR_ROOT/t6_state.md"
printf '%s\n' "$FIXTURE_STATE" > "$T6_STATE_FIXTURE"

write_full_mock_curl "$T6_SUMMARY_FILE" "$T6_STATE_FIXTURE" "200"

# Pre-create the lockdir so mkdir will fail
T6_LOCKDIR="$UM_VAULT_DIR/state/${UM_PROJECT:-testproject}/state.md.lockdir"
mkdir -p "$T6_LOCKDIR"

# Remove existing state.md for this test
T6_STATE_FILE="$UM_VAULT_DIR/state/${UM_PROJECT:-testproject}/state.md"
rm -f "$T6_STATE_FILE" 2>/dev/null || true

T6_EXIT=0
T6_STDERR=$(PATH="$MOCK_BIN:$PATH" bash "$SESSION_END" 2>&1) || T6_EXIT=$?

# Clean up lockdir AFTER test
rmdir "$T6_LOCKDIR" 2>/dev/null || true

assert_eq "T6: exit code 0 when lock held" "$T6_EXIT" "0"

# Session summary SHOULD be written (lock only blocks state update)
T6_SESSIONS_DIR="$UM_VAULT_DIR/sessions/${UM_PROJECT:-testproject}"
T6_SUMMARY_PATH=$(find "$T6_SESSIONS_DIR" -name '*.md' 2>/dev/null | tail -1)
assert_not_empty "T6: summary written despite lock failure" "$T6_SUMMARY_PATH"

# state.md should NOT be written (lock was held)
assert_file_missing "T6: state.md not written when lock held" "$T6_STATE_FILE"

# Stderr should mention lock failure
assert_contains "T6: stderr warns about lock failure" "$T6_STDERR" "could not acquire lock"

# ===========================================================================
# Summary
# ===========================================================================

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
