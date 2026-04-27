#!/usr/bin/env bash
# installer/lib/test-harness.test.sh — verify _tx_capture + _dump_on_fail.
#
# Run from repo root:
#   bash installer/lib/test-harness.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=installer/lib/test-harness.sh
source "$SCRIPT_DIR/test-harness.sh"

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
  else fail "$name (got='$got' want='$want')"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got: '${haystack:0:200}')"; fi
}

# ---------------------------------------------------------------------------
# T1: _tx_capture records exit=0 + stdout for a successful command
# ---------------------------------------------------------------------------
printf '\nT1: _tx_capture success path\n'
_tx_capture echo_ok bash -c 'echo hello'
assert_eq "T1a: TX_EXIT_echo_ok=0"  "${TX_EXIT_echo_ok:-unset}" "0"
assert_eq "T1b: TX_OUT_echo_ok=hello" "${TX_OUT_echo_ok:-unset}" "hello"

# ---------------------------------------------------------------------------
# T2: _tx_capture records non-zero exit + merged stderr
# ---------------------------------------------------------------------------
printf '\nT2: _tx_capture failure path\n'
_tx_capture failbad bash -c 'echo to_stdout; echo to_stderr >&2; exit 7'
assert_eq "T2a: TX_EXIT_failbad=7" "${TX_EXIT_failbad:-unset}" "7"
assert_contains "T2b: TX_OUT_failbad has stdout"   "${TX_OUT_failbad:-}" "to_stdout"
assert_contains "T2c: TX_OUT_failbad has stderr"   "${TX_OUT_failbad:-}" "to_stderr"

# ---------------------------------------------------------------------------
# T3: independent labels do not clobber each other
# ---------------------------------------------------------------------------
printf '\nT3: independent labels\n'
_tx_capture first  bash -c 'echo A; exit 0'
_tx_capture second bash -c 'echo B; exit 1'
assert_eq "T3a: TX_OUT_first=A"  "${TX_OUT_first:-unset}"  "A"
assert_eq "T3b: TX_EXIT_first=0" "${TX_EXIT_first:-unset}" "0"
assert_eq "T3c: TX_OUT_second=B" "${TX_OUT_second:-unset}" "B"
assert_eq "T3d: TX_EXIT_second=1" "${TX_EXIT_second:-unset}" "1"

# ---------------------------------------------------------------------------
# T4: _dump_on_fail emits frame on non-zero exit
# ---------------------------------------------------------------------------
printf '\nT4: _dump_on_fail emits frame on failure\n'
dump_out=$(_dump_on_fail second 2>&1 || true)
assert_contains "T4a: dump frame begin"     "$dump_out" "=== DUMP (second exit=1) ==="
assert_contains "T4b: dump frame end"       "$dump_out" "=== END DUMP ==="
assert_contains "T4c: dump body content"    "$dump_out" "B"

# ---------------------------------------------------------------------------
# T5: _dump_on_fail is silent on success
# ---------------------------------------------------------------------------
printf '\nT5: _dump_on_fail silent on success\n'
dump_out2=$(_dump_on_fail first 2>&1 || true)
assert_eq "T5: no output" "$dump_out2" ""

# ---------------------------------------------------------------------------
# T6: _dump_on_fail handles unset label gracefully (treats as exit=0)
# ---------------------------------------------------------------------------
printf '\nT6: _dump_on_fail with unset label is silent\n'
dump_out3=$(_dump_on_fail nonexistent_label 2>&1 || true)
assert_eq "T6: unset label produces no output" "$dump_out3" ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n---\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nFailed tests:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
