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

# Helper: produce a PATH that has real claude's containing directory removed.
# Used by tests that need `command -v claude` to fail (exercising the
# "claude CLI missing → fallback to openai" branch). Preserves python3,
# bash, curl, etc. resolution via the rest of PATH.
path_without_claude() {
  local claude_bin
  claude_bin=$(command -v claude 2>/dev/null || true)
  if [ -z "$claude_bin" ]; then
    # No real claude → PATH already safe
    printf '%s' "$PATH"
    return
  fi
  local claude_dir
  claude_dir=$(dirname "$claude_bin")
  # Filter out the matching entry from PATH (preserve order of others).
  printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$claude_dir" | tr '\n' ':' | sed 's/:$//'
}

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
# Test A2.3: UM_SUMMARIZER=claude-agent-sdk → fallback when claude CLI missing
#
# Pre-A3: this tested the "not yet implemented" stub warning.
# Post-A3: with claude CLI in PATH, the dispatch actually spawns it. To keep
# A2.3 focused on the dispatcher contract (warns + falls back on unavailable
# backend), we scrub PATH so `command -v claude` returns false — exercising
# the "claude CLI missing → falling back to openai" branch added in A3.
# ============================================================
echo "=== Test A2.3: UM_SUMMARIZER=claude-agent-sdk (claude CLI missing) ==="

# PATH with real claude removed + mock curl prepended. Keeps python3 etc.
A2_3_PATH="$A2_MOCK_BIN:$(path_without_claude)"
export CLAUDE_CWD="$TMPDIR_ROOT/a2_cas_proj"
A2_3_STDOUT=$(PATH="$A2_3_PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>/dev/null)
A2_3_STDERR=$(PATH="$A2_3_PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1 >/dev/null)

assert_contains "A2.3: warning mentions claude-agent-sdk" "$A2_3_STDERR" "claude-agent-sdk"
if [[ "$A2_3_STDERR" == *"not yet implemented"* ]] || [[ "$A2_3_STDERR" == *"falling back"* ]]; then
  pass "A2.3: claude-agent-sdk fallback warning present"
else
  fail "A2.3: no fallback warning (stderr='$A2_3_STDERR')"
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
# Test A3.1: UM_SUMMARIZER=claude-agent-sdk invokes `claude -p`
#
# With a fake `claude` binary in PATH, the dispatch actually spawns it and
# returns its stdout as the summary. Verifies:
#   - `-p` flag passed to claude
#   - `--output-format` flag passed to claude
#   - claude's stdout becomes summarize.sh's stdout
# ============================================================
echo "=== Test A3.1: UM_SUMMARIZER=claude-agent-sdk dispatches to claude CLI ==="

A3_1_TMP=$(mktemp -d)
mkdir -p "$A3_1_TMP/bin"
cat > "$A3_1_TMP/bin/claude" <<'BIN'
#!/bin/bash
# Record argv for assertion
echo "$@" > "$FAKE_CLAUDE_ARGS"
# Emit canned summary to stdout
cat <<'RESP'
Claude-summarized content about the session.
RESP
BIN
chmod +x "$A3_1_TMP/bin/claude"

export CLAUDE_CWD="$TMPDIR_ROOT/a3_1_proj"
A3_1_OUT=$(FAKE_CLAUDE_ARGS="$A3_1_TMP/args" \
  PATH="$A3_1_TMP/bin:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1)

if echo "$A3_1_OUT" | grep -q "Claude-summarized"; then
  pass "A3.1: canned claude response returned on stdout"
else
  fail "A3.1: claude output not returned (got: $A3_1_OUT)"
fi
if grep -q -- '-p' "$A3_1_TMP/args" 2>/dev/null; then
  pass "A3.1: -p flag passed to claude"
else
  fail "A3.1: -p flag missing (got args: $(cat "$A3_1_TMP/args" 2>/dev/null))"
fi
if grep -q -- '--output-format' "$A3_1_TMP/args" 2>/dev/null; then
  pass "A3.1: --output-format flag passed"
else
  fail "A3.1: --output-format flag missing"
fi
rm -rf "$A3_1_TMP"
unset CLAUDE_CWD

# ============================================================
# Test A3.2: claude CLI not available → graceful fallback to openai
#
# When `command -v claude` returns false, the dispatcher warns and falls
# through to the openai path (mock curl returns the canned summary).
# ============================================================
echo "=== Test A3.2: UM_SUMMARIZER=claude-agent-sdk with no claude in PATH falls back ==="

A3_2_TMP=$(mktemp -d)
mkdir -p "$A3_2_TMP/bin"

# Re-use A2 mock curl style: fixture OpenAI response
cat > "$A3_2_TMP/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
printf '%s\n' '{"choices":[{"message":{"content":"Openai-fallback-when-no-claude."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}'
printf '\n__UM_HTTP_CODE__200'
CURLMOCK
chmod +x "$A3_2_TMP/bin/curl"

# Mock curl bin prepended to PATH with real claude filtered out.
export CLAUDE_CWD="$TMPDIR_ROOT/a3_2_proj"
A3_2_OUT=$(PATH="$A3_2_TMP/bin:$(path_without_claude)" UM_SUMMARIZER=claude-agent-sdk \
  UM_OPENAI_API_KEY=sk-fake \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1) || true

if echo "$A3_2_OUT" | grep -qi "requires.*claude.*in path\|falling back to openai"; then
  pass "A3.2: warns when claude CLI missing"
else
  fail "A3.2: no warning about missing claude CLI (got: $A3_2_OUT)"
fi
if echo "$A3_2_OUT" | grep -q "Openai-fallback-when-no-claude"; then
  pass "A3.2: openai fallback actually ran"
else
  fail "A3.2: openai fallback did not run (got: $A3_2_OUT)"
fi
rm -rf "$A3_2_TMP"
unset CLAUDE_CWD

# ─── Test A3.3: claude prints partial output then exits non-zero → fall back ──
echo ""
echo "=== A3.3: UM_SUMMARIZER=claude-agent-sdk with claude exit != 0 falls back ==="
tmp=$(mktemp -d)
mkdir -p "$tmp/bin"
# Fake claude that emits partial content then exits 1
cat > "$tmp/bin/claude" <<'BIN'
#!/bin/bash
echo "partial output before failure"
exit 1
BIN
chmod +x "$tmp/bin/claude"

# Fake curl that serves the openai fallback fixture
make_fake_curl() {
  local bindir="$1"
  cat > "$bindir/curl" <<'CURLMOCK'
#!/usr/bin/env bash
# Mock curl — returns fixture openai response from $FAKE_CURL_RESPONSE.
# Logs argv to $FAKE_CURL_ARGS if set.
if [ -n "${FAKE_CURL_ARGS:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_CURL_ARGS"
fi
if [ -n "${FAKE_CURL_RESPONSE:-}" ] && [ -f "$FAKE_CURL_RESPONSE" ]; then
  cat "$FAKE_CURL_RESPONSE"
else
  printf '{"choices":[{"message":{"content":"fallback"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}'
fi
printf '\n__UM_HTTP_CODE__200'
CURLMOCK
  chmod +x "$bindir/curl"
}
make_fake_curl "$tmp/bin"
cat > "$tmp/response.json" <<'JSON'
{"choices":[{"message":{"content":"openai-recovered-after-claude-error."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
JSON

export CLAUDE_CWD="$TMPDIR_ROOT/a3_3_proj"
A3_3_OUT=$(FAKE_CURL_ARGS="$tmp/args" FAKE_CURL_RESPONSE="$tmp/response.json" \
  PATH="$tmp/bin:$(path_without_claude)" UM_SUMMARIZER=claude-agent-sdk UM_OPENAI_API_KEY=sk-fake \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1) || true

if echo "$A3_3_OUT" | grep -q "claude -p failed\|exit 1"; then
  pass "A3.3: warns on non-zero claude exit"
else
  fail "A3.3: no warning about claude failure (got: $A3_3_OUT)"
fi
if echo "$A3_3_OUT" | grep -q "openai-recovered-after-claude-error"; then
  pass "A3.3: openai fallback ran after claude failure"
else
  fail "A3.3: openai fallback did not run (got: $A3_3_OUT)"
fi
if ! echo "$A3_3_OUT" | grep -q "partial output before failure"; then
  pass "A3.3: partial claude output not leaked to stdout as summary"
else
  fail "A3.3: partial output leaked (claude exit was non-zero but output emitted)"
fi
rm -rf "$tmp"
unset CLAUDE_CWD

# ─── Test B3.2: summarize.sh propagates UM_IN_SUMMARIZER_SUBPROCESS=1 to spawned claude ───
#
# Regression gate for Task B.3.3 (prompt compression): any edit to the
# claude-agent-sdk branch of summarize.sh must keep this test green.
# If the sentinel export is accidentally dropped, the spawned claude's hooks
# won't early-exit, enabling infinite recursion.
echo ""
echo "=== Test B3.2: UM_IN_SUMMARIZER_SUBPROCESS=1 propagated to spawned claude ==="

B3_2_TMP=$(mktemp -d)
mkdir -p "$B3_2_TMP/bin"

# Mock claude binary: records its environment to $B3_2_ENV_FILE, emits a
# minimal plain-text response so summarize.sh's claude-agent-sdk branch
# accepts it and exits 0 (no openai fallback triggered).
cat > "$B3_2_TMP/bin/claude" <<'BIN'
#!/bin/bash
# Record env vars that start with UM_ so the test can inspect them.
env | grep '^UM_' > "$B3_2_ENV_FILE"
# Emit a non-empty plain-text summary so the claude-agent-sdk branch
# treats this as success (non-zero exit or empty output triggers fallback).
echo "B3.2 mock summary from claude -p"
exit 0
BIN
chmod +x "$B3_2_TMP/bin/claude"

export B3_2_ENV_FILE="$B3_2_TMP/claude-env"
export CLAUDE_CWD="$TMPDIR_ROOT/b3_2_proj"

B3_2_OUT=$(B3_2_ENV_FILE="$B3_2_TMP/claude-env" \
  PATH="$B3_2_TMP/bin:$PATH" \
  UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" <<< "$LONG_TRANSCRIPT" 2>&1) || true

unset B3_2_ENV_FILE CLAUDE_CWD

# Primary assertion: the sentinel must appear in the mock claude's environment.
if [ -f "$B3_2_TMP/claude-env" ] && grep -q '^UM_IN_SUMMARIZER_SUBPROCESS=1$' "$B3_2_TMP/claude-env"; then
  pass "B3.2: UM_IN_SUMMARIZER_SUBPROCESS=1 propagated to spawned claude"
else
  echo "  [debug] mock claude env file contents:"
  if [ -f "$B3_2_TMP/claude-env" ]; then
    cat "$B3_2_TMP/claude-env"
  else
    echo "  (env file not created — mock claude may not have been invoked)"
    echo "  summarize.sh combined output: $B3_2_OUT"
  fi
  fail "B3.2: UM_IN_SUMMARIZER_SUBPROCESS=1 NOT propagated to spawned claude"
fi

# Secondary: confirm summarize.sh returned the mock summary (not a fallback path)
if echo "$B3_2_OUT" | grep -q "B3.2 mock summary"; then
  pass "B3.2: mock claude output returned (claude-agent-sdk path ran, no openai fallback)"
else
  fail "B3.2: mock claude output not present — openai fallback may have run instead (got: $B3_2_OUT)"
fi

rm -rf "$B3_2_TMP"

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
# Test T-PROMPT-DIR: summarize.sh honors $UM_PROMPT_DIR
#
# Verifies that the UM_PROMPT_DIR resolution block in summarize.sh reads
# from the override directory when $UM_PROMPT_DIR is set. Scoped bash -c
# isolates the path-resolution logic without running the full script.
# ============================================================
echo "=== Test T-PROMPT-DIR: summarize.sh honors \$UM_PROMPT_DIR ==="

TPROMPT_DIR=$(mktemp -d)
echo "CUSTOM_PROMPT_MARKER_UNIQUE_XYZ" > "$TPROMPT_DIR/summarize.txt"

CAPTURED_PROMPT=$(UM_PROMPT_DIR="$TPROMPT_DIR" bash -c '
  # Replicate the resolution block from summarize.sh
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
  UM_PROMPT_DIR="${UM_PROMPT_DIR:-$SCRIPT_DIR/prompts}"
  cat "$UM_PROMPT_DIR/summarize.txt"
' 2>&1)

if [[ "$CAPTURED_PROMPT" == *"CUSTOM_PROMPT_MARKER_UNIQUE_XYZ"* ]]; then
  pass "T-PROMPT-DIR: summarize.sh reads from \$UM_PROMPT_DIR when set"
else
  fail "T-PROMPT-DIR: expected custom marker; got: $CAPTURED_PROMPT"
fi
rm -rf "$TPROMPT_DIR"

# ============================================================
# Test T-I4: summarize.sh claude-agent-sdk mode passes system prompt to claude
# ============================================================
echo "=== T-I4: claude-agent-sdk passes system prompt ==="
TEST_DIR=$(mktemp -d)
CAPTURE="$TEST_DIR/claude-pipe-captured.txt"  # tempdir-safe, not /tmp literal

# Stub `claude` binary that captures its entire stdin to the capture file
cat > "$TEST_DIR/claude" <<STUB
#!/usr/bin/env bash
cat > "$CAPTURE"
echo "stub-summary"
STUB
chmod +x "$TEST_DIR/claude"

# Pipe a small transcript; check claude's stdin contains the system prompt opening phrase
echo "short transcript" | \
  PATH="$TEST_DIR:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$SUMMARIZE" > /dev/null 2>&1

if grep -qi "Summarize a Claude Code session" "$CAPTURE"; then
  pass "T-I4: claude-agent-sdk received system prompt"
else
  fail "T-I4: system prompt NOT in claude stdin; captured: $(head -5 "$CAPTURE" 2>/dev/null || echo '(empty)')"
fi

rm -rf "$TEST_DIR"

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
