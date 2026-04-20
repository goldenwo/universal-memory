#!/usr/bin/env bash
# hooks/lib/summarize.test.sh — unit tests for summarize.sh
# Run: bash summarize.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Tests 1-4 cover failure modes without any real API calls.
# Test 5 covers the happy path using a mock curl binary injected into PATH.
# Test 6 is an optional live smoke test (requires UM_SUMMARIZE_ALLOW_LIVE=1 and a real key).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUMMARIZE="$SCRIPT_DIR/summarize.sh"

# --- Test harness ---

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
  else fail "$name (expected empty, got='$got')"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got='$haystack')"; fi
}

# --- Temp dir setup ---

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Use a fake vault so tests don't pollute the real vault
export UM_VAULT_DIR="$TMPDIR_ROOT/vault"
export UM_SUMMARY_DAILY_CAP=50

# A transcript long enough to pass the 50-char guard
LONG_TRANSCRIPT="This is a sufficiently long transcript to pass the fifty-character minimum guard check for summarization purposes."

# ============================================================
# Test 1: Missing API key — silent exit 0, empty stdout
# ============================================================
echo "=== Test 1: Missing API key ==="

T1_OUT=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
T1_EXIT=$?

assert_eq "T1: exit code 0 on missing key" "$T1_EXIT" "0"
assert_empty "T1: empty stdout on missing key" "$T1_OUT"

# ============================================================
# Test 2: Empty transcript — silent exit 0, empty stdout
# ============================================================
echo "=== Test 2: Empty transcript ==="

export UM_OPENAI_API_KEY="sk-test-fake-key-for-testing"

T2_OUT=$(bash "$SUMMARIZE" <<< "" 2>/dev/null)
T2_EXIT=$?

assert_eq "T2: exit code 0 on empty transcript" "$T2_EXIT" "0"
assert_empty "T2: empty stdout on empty transcript" "$T2_OUT"

# ============================================================
# Test 3: Tiny transcript (< 50 chars) — silent exit 0, empty stdout
# ============================================================
echo "=== Test 3: Tiny transcript (<50 chars) ==="

T3_OUT=$(bash "$SUMMARIZE" <<< "too short" 2>/dev/null)
T3_EXIT=$?

assert_eq "T3: exit code 0 on tiny transcript" "$T3_EXIT" "0"
assert_empty "T3: empty stdout on tiny transcript" "$T3_OUT"

# ============================================================
# Test 4: Daily cap reached — exit 0, empty stdout, message on stderr
# ============================================================
echo "=== Test 4: Daily cap reached ==="

# Set CLAUDE_CWD so project_name is predictable
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"
T4_PROJECT="testproject"
T4_TODAY=$(date -u +%Y-%m-%d)
T4_COUNTER_DIR="$TMPDIR_ROOT/vault/.telemetry"
T4_COUNTER_FILE="$T4_COUNTER_DIR/${T4_TODAY}-${T4_PROJECT}.count"
mkdir -p "$T4_COUNTER_DIR"
# Pre-fill at the cap limit
echo "50" > "$T4_COUNTER_FILE"

T4_STDERR=$(bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)
T4_EXIT=$?
T4_STDOUT=$(bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)

assert_eq "T4: exit code 0 on daily cap" "$T4_EXIT" "0"
assert_empty "T4: empty stdout on daily cap" "$T4_STDOUT"
assert_contains "T4: stderr mentions daily cap" "$T4_STDERR" "daily cap"
assert_contains "T4: stderr mentions project" "$T4_STDERR" "$T4_PROJECT"

# Clean up for subsequent tests
unset CLAUDE_CWD
rm -f "$T4_COUNTER_FILE"

# ============================================================
# Test 5: Happy path with mock curl
#
# Strategy: inject a fake `curl` binary early in PATH that returns a
# fixture OpenAI response. No test-only code is required in summarize.sh.
# ============================================================
echo "=== Test 5: Happy path (mock curl) ==="

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# The mock curl must produce:
#   1. The JSON body (on its own lines)
#   2. A trailing line matching the __UM_HTTP_CODE__NNN sentinel
cat > "$MOCK_BIN/curl" <<'MOCK_EOF'
#!/usr/bin/env bash
# Mock curl — returns a fixture OpenAI chat.completions response
printf '%s\n' '{"choices":[{"message":{"content":"## What happened\n\nImplemented the summarize.sh hook library.\n\n## Next steps\n\n- Run integration tests"}}],"usage":{"prompt_tokens":100,"completion_tokens":42}}'
printf '\n__UM_HTTP_CODE__200'
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

# Prepend mock_bin to PATH for this test
T5_PATH="$MOCK_BIN:$PATH"

# Reset counter so the cap check passes
T5_TODAY=$(date -u +%Y-%m-%d)
export CLAUDE_CWD="$TMPDIR_ROOT/testproject5"
T5_PROJECT="testproject5"
T5_COUNTER_DIR="$TMPDIR_ROOT/vault/.telemetry"
mkdir -p "$T5_COUNTER_DIR"
rm -f "$T5_COUNTER_DIR/${T5_TODAY}-${T5_PROJECT}.count"

T5_STDERR=$(PATH="$T5_PATH" bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)
T5_STDOUT=$(PATH="$T5_PATH" bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
T5_EXIT=$?

assert_eq "T5: exit code 0 on success" "$T5_EXIT" "0"
assert_contains "T5: stdout has summary section" "$T5_STDOUT" "## What happened"
assert_contains "T5: stdout has summary content" "$T5_STDOUT" "summarize.sh"
assert_contains "T5: stderr has telemetry line" "$T5_STDERR" "[um-summarize]"
assert_contains "T5: stderr has tokens_in" "$T5_STDERR" "tokens_in=100"
assert_contains "T5: stderr has tokens_out" "$T5_STDERR" "tokens_out=42"
assert_contains "T5: stderr has cost_estimate_usd" "$T5_STDERR" "cost_estimate_usd="

# Verify cost-log.csv was created with header + data row
T5_COST_LOG="$UM_VAULT_DIR/.telemetry/cost-log.csv"
if [ -f "$T5_COST_LOG" ]; then
  T5_HEADER=$(head -1 "$T5_COST_LOG")
  T5_DATA=$(grep "gpt-4o-mini" "$T5_COST_LOG" | tail -1)
  assert_contains "T5: cost-log header correct" "$T5_HEADER" "timestamp,project,model,tokens_in,tokens_out,cost_usd"
  assert_contains "T5: cost-log data has model" "$T5_DATA" "gpt-4o-mini"
  assert_contains "T5: cost-log data has token counts" "$T5_DATA" "100,42,"
else
  fail "T5: cost-log.csv was not created at $T5_COST_LOG"
fi

unset CLAUDE_CWD

# ============================================================
# Test A2: UM_SUMMARIZER dispatch
#
# Verifies the pluggable summarizer interface introduced in A2:
#   - openai (default / explicit) → existing OpenAI path runs
#   - claude-agent-sdk → stub warning + fallback to openai
#   - ollama → stub warning + fallback to openai
#   - unknown value → warning + fallback to openai
#
# Reuses the mock_bin/curl setup from T5 so no real HTTP is made.
# ============================================================

# Shared mock curl setup (identical to T5 fixture, returns a fresh fixture
# response so each A2 test sees a predictable summary body).
A2_MOCK_BIN="$TMPDIR_ROOT/a2_mock_bin"
mkdir -p "$A2_MOCK_BIN"
cat > "$A2_MOCK_BIN/curl" <<'A2_MOCK_EOF'
#!/usr/bin/env bash
printf '%s\n' '{"choices":[{"message":{"content":"A2 dispatch canned summary."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}'
printf '\n__UM_HTTP_CODE__200'
A2_MOCK_EOF
chmod +x "$A2_MOCK_BIN/curl"
A2_PATH="$A2_MOCK_BIN:$PATH"

# Each A2 test uses its own project name so the daily-cap counter is fresh.

# ============================================================
# Test A2.1: UM_SUMMARIZER=openai (explicit) dispatches to OpenAI
# ============================================================
echo "=== Test A2.1: UM_SUMMARIZER=openai (explicit) ==="

export CLAUDE_CWD="$TMPDIR_ROOT/a2_openai_proj"
A2_1_STDOUT=$(PATH="$A2_PATH" UM_SUMMARIZER=openai \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
A2_1_STDERR=$(PATH="$A2_PATH" UM_SUMMARIZER=openai \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)

assert_contains "A2.1: openai path returns canned summary" "$A2_1_STDOUT" "A2 dispatch canned summary."
# Should NOT emit a fallback warning on explicit openai
if [[ "$A2_1_STDERR" == *"falling back"* ]] || [[ "$A2_1_STDERR" == *"not yet implemented"* ]]; then
  fail "A2.1: unexpected fallback warning on explicit openai (stderr='$A2_1_STDERR')"
else
  pass "A2.1: no fallback warning on explicit openai"
fi
unset CLAUDE_CWD

# ============================================================
# Test A2.2: UM_SUMMARIZER unset (default) dispatches to OpenAI
# ============================================================
echo "=== Test A2.2: UM_SUMMARIZER unset (default → openai) ==="

export CLAUDE_CWD="$TMPDIR_ROOT/a2_default_proj"
A2_2_STDOUT=$(env -u UM_SUMMARIZER PATH="$A2_PATH" \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
assert_contains "A2.2: default path returns canned summary" "$A2_2_STDOUT" "A2 dispatch canned summary."
unset CLAUDE_CWD

# ============================================================
# Test A2.3: UM_SUMMARIZER=claude-agent-sdk → stub warning + fallback
# ============================================================
echo "=== Test A2.3: UM_SUMMARIZER=claude-agent-sdk (stub) ==="

export CLAUDE_CWD="$TMPDIR_ROOT/a2_cas_proj"
A2_3_STDOUT=$(PATH="$A2_PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
A2_3_STDERR=$(PATH="$A2_PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)

assert_contains "A2.3: stub warning shown (not yet implemented / falling back)" "$A2_3_STDERR" "claude-agent-sdk"
if [[ "$A2_3_STDERR" == *"not yet implemented"* ]] || [[ "$A2_3_STDERR" == *"falling back"* ]]; then
  pass "A2.3: claude-agent-sdk stub warning present"
else
  fail "A2.3: no stub warning (stderr='$A2_3_STDERR')"
fi
assert_contains "A2.3: [um-summarize] prefix used" "$A2_3_STDERR" "[um-summarize]"
assert_contains "A2.3: openai fallback actually ran" "$A2_3_STDOUT" "A2 dispatch canned summary."
unset CLAUDE_CWD

# ============================================================
# Test A2.4: UM_SUMMARIZER=ollama → stub warning + fallback
# ============================================================
echo "=== Test A2.4: UM_SUMMARIZER=ollama (stub) ==="

export CLAUDE_CWD="$TMPDIR_ROOT/a2_ollama_proj"
A2_4_STDOUT=$(PATH="$A2_PATH" UM_SUMMARIZER=ollama \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
A2_4_STDERR=$(PATH="$A2_PATH" UM_SUMMARIZER=ollama \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)

assert_contains "A2.4: stub warning mentions ollama" "$A2_4_STDERR" "ollama"
if [[ "$A2_4_STDERR" == *"not yet implemented"* ]] || [[ "$A2_4_STDERR" == *"falling back"* ]]; then
  pass "A2.4: ollama stub warning present"
else
  fail "A2.4: no stub warning (stderr='$A2_4_STDERR')"
fi
assert_contains "A2.4: [um-summarize] prefix used" "$A2_4_STDERR" "[um-summarize]"
assert_contains "A2.4: openai fallback actually ran" "$A2_4_STDOUT" "A2 dispatch canned summary."
unset CLAUDE_CWD

# ============================================================
# Test A2.5: UM_SUMMARIZER=garbage → unknown-value warning + fallback
# ============================================================
echo "=== Test A2.5: UM_SUMMARIZER=garbage (unknown) ==="

export CLAUDE_CWD="$TMPDIR_ROOT/a2_garbage_proj"
A2_5_STDOUT=$(PATH="$A2_PATH" UM_SUMMARIZER=garbage \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
A2_5_STDERR=$(PATH="$A2_PATH" UM_SUMMARIZER=garbage \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)

if [[ "$A2_5_STDERR" == *"unknown"* ]] || [[ "$A2_5_STDERR" == *"falling back"* ]]; then
  pass "A2.5: unknown-value warning present"
else
  fail "A2.5: no unknown-value warning (stderr='$A2_5_STDERR')"
fi
assert_contains "A2.5: [um-summarize] prefix used" "$A2_5_STDERR" "[um-summarize]"
assert_contains "A2.5: openai fallback actually ran" "$A2_5_STDOUT" "A2 dispatch canned summary."
unset CLAUDE_CWD

# ============================================================
# Test 6: Live smoke test (optional, token-gated)
# Skipped unless UM_SUMMARIZE_ALLOW_LIVE=1 AND UM_OPENAI_API_KEY is set.
# ============================================================
if [ "${UM_SUMMARIZE_ALLOW_LIVE:-0}" = "1" ] && [ -n "${UM_OPENAI_API_KEY:-}" ]; then
  echo "=== Test 6: Live smoke test (UM_SUMMARIZE_ALLOW_LIVE=1) ==="

  LIVE_TRANSCRIPT="Session transcript (most recent turns):

User: Can you add a retry mechanism to the API client?
Assistant: I've added exponential backoff retry logic to api_client.py. The function retry_request now accepts a max_retries parameter defaulting to 3, with a base delay of 1 second doubled each attempt. I also updated the tests in test_api_client.py to mock the failure scenarios.
User: Looks good. Can you commit that?
Assistant: Committed as 'feat: add retry with exponential backoff to api_client' (abc1234)."

  # Use real PATH (not mock_bin) for the live test
  T6_STDOUT=$(PATH="$PATH" bash "$SUMMARIZE" <<< "$LIVE_TRANSCRIPT" 2>/tmp/um_live_stderr)
  T6_EXIT=$?
  T6_STDERR=$(cat /tmp/um_live_stderr 2>/dev/null || true)

  assert_eq "T6: exit code 0 on live call" "$T6_EXIT" "0"
  if [ -n "$T6_STDOUT" ]; then
    pass "T6: stdout non-empty"
    printf '  Live summary preview: %s\n' "$(echo "$T6_STDOUT" | head -3)"
  else
    fail "T6: empty stdout on live call"
  fi
  if [[ "$T6_STDERR" == *"[um-summarize]"* ]]; then
    pass "T6: telemetry emitted"
    printf '  Telemetry: %s\n' "$T6_STDERR"
  else
    fail "T6: no telemetry emitted"
  fi
else
  echo "=== Test 6: Live smoke test — SKIPPED (set UM_SUMMARIZE_ALLOW_LIVE=1 and UM_OPENAI_API_KEY to run) ==="
fi

# ============================================================
# Summary
# ============================================================

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
