#!/usr/bin/env bash
# hooks/stop.test.sh — tests for stop.sh (append-only raw capture hook)
#
# Run: bash stop.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   1. Smoke: raw capture appended to today's file for current project
#   2. Recursive-hook guard — UM_IN_SUMMARIZER_SUBPROCESS=1 exits silently
#      with no side effects (no raw file written)

# Prevent environment leakage from the developer's shell — if a prior test run
# or interactive session exported UM_IN_SUMMARIZER_SUBPROCESS=1, every hook
# would exit 0 and assertions would falsely pass.
unset UM_IN_SUMMARIZER_SUBPROCESS

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP="$SCRIPT_DIR/stop.sh"

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

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got='${haystack:0:200}')"; fi
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
PROJECT="testproject"
TODAY=$(date -u +%Y-%m-%d)
RAW_FILE="$UM_VAULT_DIR/captures/$PROJECT/raw/$TODAY.md"

# ===========================================================================
# Test 1: Smoke — raw capture is appended to today's file
# ===========================================================================
echo "=== Test 1: Smoke (append raw capture) ==="

rm -rf "$UM_VAULT_DIR"
T1_INPUT="User: hello
Assistant: hi there"

T1_EXIT=0
echo "$T1_INPUT" | bash "$STOP" >/dev/null 2>&1 || T1_EXIT=$?

assert_eq "T1: exit code 0 on smoke" "$T1_EXIT" "0"
assert_file_exists "T1: raw capture file created" "$RAW_FILE"
if [ -f "$RAW_FILE" ]; then
  T1_CONTENT=$(cat "$RAW_FILE")
  assert_contains "T1: raw file contains input text" "$T1_CONTENT" "Assistant: hi there"
fi

# ===========================================================================
# Test 2: Recursive-hook guard — UM_IN_SUMMARIZER_SUBPROCESS=1 exits silently
# ===========================================================================
# Critical for A3's claude-agent-sdk backend: the nested `claude -p` process
# inherits UM_IN_SUMMARIZER_SUBPROCESS=1 in its env, and its own hooks (which
# source this file via the plugin) must exit immediately to prevent infinite
# recursion + duplicate raw captures.
echo "=== Test 2: Recursive-hook guard (UM_IN_SUMMARIZER_SUBPROCESS=1) ==="

# Clean vault so we can verify no side effects
rm -rf "$UM_VAULT_DIR"

T2_GUARD_OUT=$(UM_IN_SUMMARIZER_SUBPROCESS=1 \
  UM_VAULT_DIR="$UM_VAULT_DIR" CLAUDE_CWD="$CLAUDE_CWD" \
  bash "$STOP" <<< "some transcript content that should NOT be captured" 2>&1)
T2_GUARD_EXIT=$?

assert_eq "T2: guard exits 0 when UM_IN_SUMMARIZER_SUBPROCESS=1" "$T2_GUARD_EXIT" "0"
if [ -z "$T2_GUARD_OUT" ] || [ "$T2_GUARD_OUT" = "{}" ]; then
  pass "T2: guard emits no output (or empty JSON {})"
else
  fail "T2: guard should emit empty output, got: $T2_GUARD_OUT"
fi
assert_file_missing "T2: no raw capture written under guard" "$RAW_FILE"

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
