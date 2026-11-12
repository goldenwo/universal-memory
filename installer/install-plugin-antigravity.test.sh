#!/usr/bin/env bash
# install-plugin-antigravity.test.sh — tests for installer/install-plugin-antigravity.sh
#
# The installer hands this repository's plugin folder to Antigravity's own
# `agy plugin` commands. A fake `agy` records every call; no network, and no
# real Antigravity: EVERY case sets PATH, HOME and LOCALAPPDATA to temp
# folders. On a Windows machine with Antigravity installed the real agy.exe
# sits under the real %LOCALAPPDATA%, and a test that could reach it would
# reinstall the operator's plugin from a temp folder.
#
# Run: bash installer/install-plugin-antigravity.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"

# shellcheck source=installer/lib/test-harness.sh
source "$REPO_ROOT/installer/lib/test-harness.sh"
PLUGIN_AGY_SH="$SCRIPT_DIR/install-plugin-antigravity.sh"

PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail_test() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s — %s\n' "$1" "${2:-}"
}
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"; else fail_test "$name" "got [$got], want [$want]"; fi
}
assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"; else fail_test "$name" "expected to contain '$needle'"; fi
}
assert_exit_zero() {
  local name="$1" code="$2"
  if [ "$code" -eq 0 ]; then pass "$name"; else fail_test "$name" "exit code $code (expected 0)"; fi
}
assert_exit_nonzero() {
  local name="$1" code="$2"
  if [ "$code" -ne 0 ]; then pass "$name"; else fail_test "$name" "exit 0 (expected non-zero)"; fi
}

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# make_fakeagy <file> <calls-file> — a fake `agy` at <file> that appends its
# argv to <calls-file> and whatever it can read from stdin to
# <calls-file>.stdin. Exit codes per step come from UM_TEST_AGY_VALIDATE_RC,
# UM_TEST_AGY_UNINSTALL_RC and UM_TEST_AGY_INSTALL_RC (default 0).
make_fakeagy() {
  local file="$1" calls="$2"
  mkdir -p "$(dirname "$file")"
  cat > "$file" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$calls"
cat >> "$calls.stdin"
case "\$1 \$2" in
  "plugin validate")  echo "validate says: 2 warnings"; exit "\${UM_TEST_AGY_VALIDATE_RC:-0}" ;;
  "plugin uninstall") exit "\${UM_TEST_AGY_UNINSTALL_RC:-0}" ;;
  "plugin install")   echo "install says: plugin copied"; exit "\${UM_TEST_AGY_INSTALL_RC:-0}" ;;
esac
exit 0
FAKE
  chmod +x "$file"
}

# make_plugin <dir> — the least a plugin folder needs to be accepted.
make_plugin() {
  mkdir -p "$1/.antigravity-plugin"
  printf '{"name":"universal-memory","version":"0.0.0"}\n' > "$1/.antigravity-plugin/plugin.json"
}

# as_agy_sees <dir> — the folder argument the installer should pass: Windows
# form under Git Bash (agy.exe is a native program), unchanged elsewhere.
as_agy_sees() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

# new_case <name> — a fresh sandbox: $T, with an empty home and localappdata,
# a plugin folder, and a bin folder for the fake. Nothing of the real machine.
new_case() {
  T="$TMPROOT/$1"
  mkdir -p "$T/home" "$T/localappdata" "$T/bin"
  make_plugin "$T/plugin"
  CALLS="$T/agy.calls"
  PLUGIN_ARG=$(as_agy_sees "$T/plugin")
}

# run_installer [env_var=val ...] — PATH holds the case's bin and the system
# tools only; HOME and LOCALAPPDATA are the case's own. The installer's stdin
# is $STDIN_FILE, empty unless a case sets it: the fake agy reads its stdin to
# the end, so an installer that passed its own stdin through would otherwise
# hang this suite on whatever stdin the suite was started with (it did, once).
STDIN_FILE=/dev/null
# shellcheck disable=SC2317,SC2329  # invoked indirectly through _tx_capture
run_installer() {
  env PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" LOCALAPPDATA="$T/localappdata" \
    UM_PLUGIN_DIR="$T/plugin" "$@" bash "$PLUGIN_AGY_SH" --yes < "$STDIN_FILE" 2>&1
}
calls() { cat "$CALLS" 2>/dev/null || true; }

if PATH="/usr/bin:/bin" command -v agy >/dev/null 2>&1; then
  echo "SKIP: an agy lives in /usr/bin or /bin on this machine; these tests cannot hide it" >&2
  exit 1
fi

# ─── N1: validate, uninstall, install — in that order ────────────────────────
echo ""
echo "=== N1: validate, then uninstall, then install ==="
new_case n1; make_fakeagy "$T/bin/agy" "$CALLS"
_tx_capture N1 run_installer
_dump_on_fail N1
assert_exit_zero "N1: exits 0" "$TX_EXIT_N1"
assert_eq "N1: the three calls, in order, with the folder and the name" "$(calls)" "plugin validate $PLUGIN_ARG
plugin uninstall universal-memory
plugin install $PLUGIN_ARG"
assert_contains "N1: says it is installed" "$TX_OUT_N1" "Antigravity plugin installed"
assert_contains "N1: says how to remove it" "$TX_OUT_N1" "agy plugin uninstall universal-memory"
if [ -e "$T/home/.bashrc" ] || [ -e "$T/home/.zshrc" ] || [ -e "$T/home/.profile" ] || [ -e "$T/home/.gemini" ]; then
  fail_test "N1: writes nothing into the home folder itself" "a file appeared in $T/home"
else
  pass "N1: writes nothing into the home folder itself"
fi

# ─── N2: a folder that does not validate removes nothing ─────────────────────
echo ""
echo "=== N2: a failing validate stops before uninstall ==="
new_case n2; make_fakeagy "$T/bin/agy" "$CALLS"
_tx_capture N2 run_installer UM_TEST_AGY_VALIDATE_RC=1
assert_exit_nonzero "N2: exits non-zero" "$TX_EXIT_N2"
assert_eq "N2: only validate ran" "$(calls)" "plugin validate $PLUGIN_ARG"
assert_contains "N2: shows what validate said" "$TX_OUT_N2" "validate says: 2 warnings"
assert_contains "N2: says nothing was changed" "$TX_OUT_N2" "Nothing was changed"

# ─── N3: nothing to uninstall is not a failure ───────────────────────────────
echo ""
echo "=== N3: a failing uninstall does not stop the install ==="
new_case n3; make_fakeagy "$T/bin/agy" "$CALLS"
_tx_capture N3 run_installer UM_TEST_AGY_UNINSTALL_RC=1
_dump_on_fail N3
assert_exit_zero "N3: exits 0" "$TX_EXIT_N3"
assert_eq "N3: install still ran" "$(calls | tail -1)" "plugin install $PLUGIN_ARG"

# ─── N4: a failed install says how to finish ─────────────────────────────────
echo ""
echo "=== N4: a failing install is a failure, with the command to re-run ==="
new_case n4; make_fakeagy "$T/bin/agy" "$CALLS"
_tx_capture N4 run_installer UM_TEST_AGY_INSTALL_RC=1
assert_exit_nonzero "N4: exits non-zero" "$TX_EXIT_N4"
assert_contains "N4: prints the exact command" "$TX_OUT_N4" "agy plugin install \"$PLUGIN_ARG\""
assert_contains "N4: says the earlier copy is gone" "$TX_OUT_N4" "was removed"

# ─── N5: no Antigravity at all ───────────────────────────────────────────────
echo ""
echo "=== N5: no agy and no data folder → clean skip ==="
new_case n5
_tx_capture N5 run_installer
assert_exit_zero "N5: exits 0" "$TX_EXIT_N5"
assert_contains "N5: says it skipped" "$TX_OUT_N5" "not detected"
assert_eq "N5: nothing ran" "$(calls)" ""

# ─── N6: Antigravity's data folder, but no CLI to call ───────────────────────
echo ""
echo "=== N6: data folder present, no agy → prints the commands ==="
new_case n6; mkdir -p "$T/home/.gemini/antigravity-cli"
_tx_capture N6 run_installer
assert_exit_zero "N6: exits 0" "$TX_EXIT_N6"
assert_contains "N6: prints the install command" "$TX_OUT_N6" "agy plugin install \"$PLUGIN_ARG\""
assert_contains "N6: prints the validate command" "$TX_OUT_N6" "agy plugin validate \"$PLUGIN_ARG\""
assert_eq "N6: nothing ran" "$(calls)" ""

# ─── N7: Windows — agy.exe under %LOCALAPPDATA%, not on PATH ─────────────────
echo ""
echo "=== N7: agy found only under LOCALAPPDATA ==="
new_case n7; make_fakeagy "$T/localappdata/agy/bin/agy.exe" "$CALLS"
_tx_capture N7 run_installer
_dump_on_fail N7
assert_exit_zero "N7: exits 0" "$TX_EXIT_N7"
assert_eq "N7: the three calls went to that agy.exe, with the folder as it reads paths" "$(calls)" "plugin validate $PLUGIN_ARG
plugin uninstall universal-memory
plugin install $PLUGIN_ARG"

# ─── N8: agy never reads the installer's stdin ───────────────────────────────
# Whether `agy plugin install` can ask a question is not known (none was seen).
# With no stdin a question fails at once instead of waiting for an answer no
# one is there to give.
echo ""
echo "=== N8: agy's stdin is empty, not the installer's ==="
new_case n8; make_fakeagy "$T/bin/agy" "$CALLS"
printf 'ANSWER-NOBODY-TYPED\n' > "$T/stdin.txt"
STDIN_FILE="$T/stdin.txt"
_tx_capture N8 run_installer
STDIN_FILE=/dev/null
_dump_on_fail N8
assert_exit_zero "N8: exits 0" "$TX_EXIT_N8"
assert_eq "N8: all three calls ran" "$(calls | wc -l | tr -d ' ')" "3"
assert_eq "N8: no call read anything from stdin" "$(cat "$CALLS.stdin" 2>/dev/null)" ""

# ─── N9: the plugin folder ───────────────────────────────────────────────────
echo ""
echo "=== N9: UM_PLUGIN_DIR is honoured; a folder without the manifest is refused ==="
new_case n9; make_fakeagy "$T/bin/agy" "$CALLS"
make_plugin "$T/other plugin"
_tx_capture N9 run_installer UM_PLUGIN_DIR="$T/other plugin"
_dump_on_fail N9
assert_exit_zero "N9: exits 0" "$TX_EXIT_N9"
assert_eq "N9: installs the folder it was given (a path with a space stays one argument)" \
  "$(calls | tail -1)" "plugin install $(as_agy_sees "$T/other plugin")"
new_case n9b; make_fakeagy "$T/bin/agy" "$CALLS"
rm -rf "$T/plugin/.antigravity-plugin"
_tx_capture N9B run_installer
assert_exit_nonzero "N9: a folder with no Antigravity manifest exits non-zero" "$TX_EXIT_N9B"
assert_eq "N9: and nothing ran" "$(calls)" ""

# ─── N10: this repository's own plugin folder is the default ─────────────────
echo ""
echo "=== N10: the default folder is this checkout's plugin ==="
new_case n10; make_fakeagy "$T/bin/agy" "$CALLS"
# shellcheck disable=SC2317,SC2329
run_default_dir() {
  env -u UM_PLUGIN_DIR PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" LOCALAPPDATA="$T/localappdata" \
    bash "$PLUGIN_AGY_SH" --yes < /dev/null 2>&1
}
_tx_capture N10 run_default_dir
_dump_on_fail N10
assert_exit_zero "N10: exits 0" "$TX_EXIT_N10"
assert_eq "N10: installs plugins/claude-code/universal-memory" \
  "$(calls | tail -1)" "plugin install $(as_agy_sees "$REPO_ROOT/plugins/claude-code/universal-memory")"

# ─── Summary ──────────────────────────────────────────────────────────────────
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
