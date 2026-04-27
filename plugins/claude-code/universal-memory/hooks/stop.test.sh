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
# Test 3: T-CONC — sibling-lockdir mkdir serializes stop.sh appends
# ===========================================================================
# B.11 (v0.6): stop.sh migrated from perl Fcntl::flock against `.md.lock` to
# bash mkdir-based lockdir against `.md.lockdir`, matching B.9's Node-side
# append-turn migration. Both writers now coordinate on the same path.
echo "=== Test 3: T-CONC: lockdir serializes stop.sh appends ==="

T3_DIR=$(mktemp -d)
export UM_VAULT_DIR="$T3_DIR/vault"
export CLAUDE_CWD="$T3_DIR/proj"
mkdir -p "$CLAUDE_CWD"
T3_PROJ=$(basename "$CLAUDE_CWD")

# Fire 10 stop.sh instances in parallel; each gets ~1KB transcript via stdin
# with a distinguishable marker, to check for cross-stream interleaving.
for i in $(seq 1 10); do
  ( printf 'MARKER-%d-START\n%s\nMARKER-%d-END' "$i" "$(printf 'x%.0s' {1..500})" "$i" |
      bash "$STOP" ) &
done
wait

DATE=$(date -u +%Y-%m-%d)
T3_RAW_DIR="$UM_VAULT_DIR/captures/$T3_PROJ/raw"
T3_RAW="$T3_RAW_DIR/$DATE.md"

if [ ! -f "$T3_RAW" ]; then
  fail "T-CONC: raw file not created"
else
  for i in $(seq 1 10); do
    # Extract the block between MARKER-$i-START and MARKER-$i-END (inclusive)
    BLOCK=$(awk -v i="$i" '
      $0 == "MARKER-" i "-START" { flag=1 }
      flag { print }
      $0 == "MARKER-" i "-END" { flag=0 }
    ' "$T3_RAW")
    if [ -z "$BLOCK" ]; then
      fail "T-CONC: turn-$i block missing from raw file"
    else
      # Count OTHER markers in the block — any presence = interleaving = FAIL
      OTHERS=$(echo "$BLOCK" | grep -cE "MARKER-[0-9]+-(START|END)" | awk '{print $1}')
      # Each block should contain exactly 2 marker lines (its own START and END)
      if [ "$OTHERS" -le 2 ]; then
        pass "T-CONC: turn-$i intact (no interleaving)"
      else
        fail "T-CONC: turn-$i interleaved (found $OTHERS marker lines, expected 2)"
      fi
    fi
  done
fi

# B.11: lockdir cleanup — after all stop.sh runs complete, no `.lockdir`
# directories should remain (trap-on-EXIT must have rmdir'd them).
T3_LOCKDIR="$T3_RAW_DIR/$DATE.md.lockdir"
if [ -d "$T3_LOCKDIR" ]; then
  fail "T-CONC: lockdir still present after runs ($T3_LOCKDIR)"
else
  pass "T-CONC: lockdir cleaned up after runs"
fi

# B.11: legacy path — old `.md.lock` file (perl-flock target) must not be
# created by the bash-mkdir lockdir code. Catches accidental regressions.
T3_LEGACY_LOCK="$T3_RAW_DIR/$DATE.md.lock"
if [ -e "$T3_LEGACY_LOCK" ]; then
  fail "T-CONC: legacy .md.lock path created (should be .md.lockdir)"
else
  pass "T-CONC: legacy .md.lock path not used"
fi

rm -rf "$T3_DIR"
# Restore env to prior test values (test harness exports these globally)
export UM_VAULT_DIR="$TMPDIR_ROOT/vault"
export CLAUDE_CWD="$TMPDIR_ROOT/testproject"

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
