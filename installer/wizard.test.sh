#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$SCRIPT_DIR/install.sh"
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1" >&2; }

# Portable mktemp subdirectory: mktemp -d -p is GNU-only; macOS requires TMPDIR=.
mktemp_in() { TMPDIR="$1" mktemp -d; }

# T1: Wizard option 1 (Everything detected) fires server + cli delegates
# Input: 1 (choice) + blank (vault default) + blank (api key default) + Y (proceed)
T1=$(mktemp_in "$TMPROOT")
OUT=$(printf '1\n\n\nY\n' | HOME="$T1" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: server/install.sh"; then pass "T1: wizard option 1 → server delegate fires"
else fail "T1: wizard option 1 did not trigger server install; out: $(echo "$OUT" | head -20)"; fi

# T2: Wizard option 3 (CLI-only) + custom server URL
# Input: 3 (choice) + URL + blank (vault) + blank (api key) + Y (proceed)
T2=$(mktemp_in "$TMPROOT")
OUT=$(printf '3\nhttp://pi.local:6335\n\n\nY\n' | HOME="$T2" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T2: wizard option 3 → cli delegate fires"
else fail "T2: wizard option 3 did not trigger cli install; out: $(echo "$OUT" | head -20)"; fi

# T3: Invalid menu choices retry before succeeding
# Input: X (invalid) + 99 (invalid) + 4 (valid) + blank + blank + Y
OUT=$(printf 'X\n99\n4\n\n\nY\n' | HOME="$TMPROOT/t3" mkdir -p "$TMPROOT/t3" 2>/dev/null; \
      printf 'X\n99\n4\n\n\nY\n' | HOME="$TMPROOT/t3" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
COUNT=$(echo "$OUT" | grep -c "Invalid choice" || true)
if [[ "$COUNT" -ge 2 ]]; then pass "T3: retries on invalid menu input ($COUNT invalid-choice messages)"
else fail "T3: expected ≥2 'Invalid choice' messages, got $COUNT; out: $(echo "$OUT" | head -20)"; fi

# T4: Wizard option 2 (Just Claude Code plugin)
# Input: 2 (choice) + blank (vault) + blank (api key) + Y (proceed)
T4=$(mktemp_in "$TMPROOT")
OUT=$(printf '2\n\n\nY\n' | HOME="$T4" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T4: wizard option 2 → plugin-cc delegate fires"
else fail "T4: wizard option 2 did not trigger plugin-cc install; out: $(echo "$OUT" | head -20)"; fi

# T5: Wizard option 4 (Server only)
# Input: 4 (choice) + blank (vault) + blank (api key) + Y (proceed)
T5=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n\nY\n' | HOME="$T5" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: server/install.sh"; then pass "T5: wizard option 4 → server delegate fires"
else fail "T5: wizard option 4 did not trigger server install; out: $(echo "$OUT" | head -20)"; fi

# T6: Wizard option 5 (Custom) — server + cli, decline plugins
# Input: 5 (choice) + Y (server) + n (cc) + n (codex) + Y (cli) + blank (vault) + blank (api key) + Y (proceed)
T6=$(mktemp_in "$TMPROOT")
OUT=$(printf '5\nY\nn\nn\nY\n\n\nY\n' | HOME="$T6" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: server/install.sh" && echo "$OUT" | grep -q "delegate: installer/install-cli.sh"; then
  pass "T6: custom → server + cli both fire"
else fail "T6: custom did not fire both delegates; out: $(echo "$OUT" | head -25)"; fi

# T7: Decline proceed — should abort with "Aborted."
# Input: 1 (choice) + blank (vault) + blank (api key) + n (decline proceed)
T7=$(mktemp_in "$TMPROOT")
OUT=$(printf '1\n\n\nn\n' | HOME="$T7" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "Aborted"; then pass "T7: decline proceed aborts cleanly"
else fail "T7: expected 'Aborted.' in output; out: $(echo "$OUT" | head -20)"; fi

# T8: --interactive with pre-seeded --cli flag — wizard still runs
# (--interactive forces wizard regardless of other component flags)
T8=$(mktemp_in "$TMPROOT")
OUT=$(printf '1\n\n\nY\n' | HOME="$T8" UM_DRY_RUN=1 bash "$INSTALL" --interactive --cli --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "universal-memory v0.5.0 installer"; then pass "T8: --interactive + --cli still runs wizard"
else fail "T8: wizard didn't run with --interactive --cli; out: $(echo "$OUT" | head -15)"; fi

# T9: Wizard header shows v0.5.0
T9=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n\nY\n' | HOME="$T9" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "v0.5.0"; then pass "T9: wizard header shows v0.5.0"
else fail "T9: v0.5.0 not found in wizard output; out: $(echo "$OUT" | head -5)"; fi

# T10: wizard_detect_env prints environment detection block
T10=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n\nY\n' | HOME="$T10" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "Detected environment"; then pass "T10: wizard shows 'Detected environment' block"
else fail "T10: 'Detected environment' not found; out: $(echo "$OUT" | head -10)"; fi

# T11: wizard_summarize shows "About to install:" before execution
T11=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n\nY\n' | HOME="$T11" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "About to install:"; then pass "T11: wizard shows 'About to install:' summary"
else fail "T11: 'About to install:' not found in output; out: $(echo "$OUT" | head -20)"; fi

# T12: option 3 custom server URL appears in summary
T12=$(mktemp_in "$TMPROOT")
OUT=$(printf '3\nhttp://pi.local:6335\n\n\nY\n' | HOME="$T12" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "pi.local:6335"; then pass "T12: custom server URL appears in wizard summary"
else fail "T12: custom server URL not found in summary; out: $(echo "$OUT" | head -20)"; fi

# ─── F1: wizard_select unit tests ─────────────────────────────────────────────
# Source wizard-lib.sh to test wizard_select directly via canned stdin.

# shellcheck source=installer/wizard-lib.sh
. "$SCRIPT_DIR/wizard-lib.sh"

assert_eq() {
  # assert_eq <actual> <expected> <label>
  if [ "$1" = "$2" ]; then pass "$3"
  else fail "$3 (expected=$2 actual=$1)"; fi
}

test_wizard_select_basic() {
  # Use a here-string so wizard_select runs in the current shell (eval modifies
  # $CHOICE in this scope). A `... | wizard_select` pipe would put it in a
  # subshell and the assignment would be lost.
  CHOICE=""
  wizard_select CHOICE "Pick one:" alpha beta gamma <<< $'2\n' >/dev/null
  assert_eq "$CHOICE" "beta" "F1.T1: wizard_select selects option 2 (beta)"
}

test_wizard_select_reprompts_on_invalid() {
  CHOICE=""
  wizard_select CHOICE "Pick:" alpha beta <<< $'bogus\n9\n1\n' >/dev/null
  assert_eq "$CHOICE" "alpha" "F1.T2: wizard_select re-prompts on bogus + out-of-range, accepts 1 (alpha)"
}

test_wizard_select_eof_returns_nonzero() {
  unset CHOICE
  if wizard_select CHOICE "Pick:" alpha beta < /dev/null; then
    fail "F1.T3: expected non-zero on EOF, got 0"
  else
    pass "F1.T3: wizard_select returns non-zero on EOF"
  fi
}

test_wizard_select_empty_opts_returns_nonzero() {
  unset CHOICE
  if wizard_select CHOICE "Pick:"; then
    fail "F1.T4: expected non-zero on empty opts, got 0"
  else
    pass "F1.T4: wizard_select returns non-zero on empty opts"
  fi
}

test_wizard_select_basic
test_wizard_select_reprompts_on_invalid
test_wizard_select_eof_returns_nonzero
test_wizard_select_empty_opts_returns_nonzero

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
