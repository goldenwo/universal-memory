#!/usr/bin/env bash
# install-plugin-codex.test.sh — tests for installer/install-plugin-codex.sh
#
# The installer registers the plugin through Codex's own marketplace commands,
# which install the same plugin tree Claude Code gets, hooks included. A fake
# `codex` on PATH records every call; no network. Rewritten 2026-10-20 when
# the copy of an MCP-only plugin into ~/.codex/plugins/universal-memory was
# retired: a 2026-10-20 clean-room run showed Codex never loads that directory.
#
# Run: bash installer/install-plugin-codex.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"

# shellcheck source=installer/lib/test-harness.sh
source "$REPO_ROOT/installer/lib/test-harness.sh"
PLUGIN_CODEX_SH="$SCRIPT_DIR/install-plugin-codex.sh"

# ─── Test harness ─────────────────────────────────────────────────────────────
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
assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"; else fail_test "$name" "should NOT contain '$needle'"; fi
}
assert_file_exists() {
  local name="$1" file="$2"
  if [ -e "$file" ]; then pass "$name"; else fail_test "$name" "file not found: $file"; fi
}
assert_absent() {
  local name="$1" file="$2"
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then pass "$name"; else fail_test "$name" "unexpectedly present: $file"; fi
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

# make_fakecodex <dir> — a fake `codex` that appends "<argv>|CODEX_HOME=<value>"
# to <dir>/codex.calls. Exit codes per step come from UM_TEST_CODEX_MKT_ADD_RC,
# UM_TEST_CODEX_UPGRADE_RC and UM_TEST_CODEX_ADD_RC (default 0). A successful
# `plugin add` prints the line real Codex 0.157.1 prints.
make_fakecodex() {
  local dest="$1"
  mkdir -p "$dest"
  cat > "$dest/codex" <<FAKE
#!/usr/bin/env bash
printf '%s|CODEX_HOME=%s\n' "\$*" "\${CODEX_HOME:-}" >> "$dest/codex.calls"
case "\$*" in
  "plugin marketplace add "*) exit "\${UM_TEST_CODEX_MKT_ADD_RC:-0}" ;;
  "plugin marketplace upgrade"*) exit "\${UM_TEST_CODEX_UPGRADE_RC:-0}" ;;
  "plugin add "*)
    rc="\${UM_TEST_CODEX_ADD_RC:-0}"
    if [ "\$rc" -eq 0 ]; then
      echo "Added plugin \\\`universal-memory\\\` from marketplace \\\`universal-memory\\\`."
      echo "Installed plugin root: \${CODEX_HOME:-\$HOME/.codex}/plugins/cache/universal-memory/universal-memory/1.28.2"
    fi
    exit "\$rc" ;;
esac
exit 0
FAKE
  chmod +x "$dest/codex"
}

# calls_of <dir> — the recorded argv lines, without the CODEX_HOME field.
calls_of() { cut -d'|' -f1 "$1/codex.calls" 2>/dev/null || true; }

# run_plugin_codex <path_prefix> [env_var=val ...] — run the installer with the fake first on PATH.
# shellcheck disable=SC2317,SC2329  # invoked indirectly through _tx_capture (SC2329 is the newer code)
run_plugin_codex() {
  local prefix="$1"; shift
  env PATH="$prefix:$PATH" "$@" bash "$PLUGIN_CODEX_SH" --yes 2>&1
}

# run_without_codex <bindir> [env_var=val ...] — a PATH that hides any real codex.
# shellcheck disable=SC2317,SC2329
run_without_codex() {
  local bindir="$1"; shift
  env PATH="$bindir:/usr/bin:/bin" "$@" bash "$PLUGIN_CODEX_SH" --yes 2>&1
}
codex_on_system_path() { PATH="/usr/bin:/bin" command -v codex >/dev/null 2>&1; }

EXPECTED_CALLS='plugin marketplace add goldenwo/universal-memory
plugin marketplace upgrade universal-memory
plugin add universal-memory@universal-memory'

# ─── C1: a fresh host — the three marketplace calls, nothing copied ──────────
# ~/.codex does not exist yet: `codex plugin marketplace add` creates it, so a
# Codex that has never run still gets the plugin.
echo ""
echo "=== C1: registers through codex plugin marketplace on a fresh host ==="
T="$TMPROOT/c1"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C1 run_plugin_codex "$T/bin" HOME="$T/home"
_dump_on_fail C1
assert_exit_zero "C1: exits 0" "$TX_EXIT_C1"
assert_eq "C1: marketplace add, upgrade, plugin add — in that order" "$(calls_of "$T/bin")" "$EXPECTED_CALLS"
assert_absent "C1: no copy under ~/.codex/plugins" "$T/home/.codex/plugins/universal-memory"
assert_contains "C1: says where Codex installed it" "$TX_OUT_C1" "plugins/cache/universal-memory/universal-memory/1.28.2"
assert_contains "C1: names the one step left — trusting the hooks" "$TX_OUT_C1" "trust the universal-memory hooks"
if [ -e "$T/home/.bashrc" ] || [ -e "$T/home/.zshrc" ] || [ -e "$T/home/.profile" ]; then
  fail_test "C1: no shell rc written" "an rc file appeared in $T/home"
else
  pass "C1: no shell rc written"
fi

# ─── C2: a re-run moves an existing install forward ──────────────────────────
# Codex has no `plugin update`: upgrade refreshes the Git marketplace, and a
# repeated `plugin add` installs its current version (measured 2026-10-20).
echo ""
echo "=== C2: re-run on a host that already has ~/.codex ==="
T="$TMPROOT/c2"; mkdir -p "$T/home/.codex"; make_fakecodex "$T/bin"
_tx_capture C2 run_plugin_codex "$T/bin" HOME="$T/home"
assert_exit_zero "C2: exits 0" "$TX_EXIT_C2"
assert_eq "C2: same three calls" "$(calls_of "$T/bin")" "$EXPECTED_CALLS"

# ─── C3: UM_PLUGIN_MARKETPLACE names another Git source ──────────────────────
echo ""
echo "=== C3: UM_PLUGIN_MARKETPLACE override (Git source) ==="
T="$TMPROOT/c3"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C3 run_plugin_codex "$T/bin" HOME="$T/home" UM_PLUGIN_MARKETPLACE=someone/universal-memory-fork
assert_exit_zero "C3: exits 0" "$TX_EXIT_C3"
assert_contains "C3: marketplace add uses the override" "$(calls_of "$T/bin")" "plugin marketplace add someone/universal-memory-fork"
assert_contains "C3: a Git source is still upgraded" "$(calls_of "$T/bin")" "plugin marketplace upgrade universal-memory"

# ─── C4: a local checkout as the marketplace — nothing to upgrade ────────────
# `codex plugin marketplace upgrade` exits 1 on a local source ("not configured
# as a Git marketplace"); Codex reads a local source live, so it is skipped.
echo ""
echo "=== C4: UM_PLUGIN_MARKETPLACE is a local directory ==="
T="$TMPROOT/c4"; mkdir -p "$T/home" "$T/checkout"; make_fakecodex "$T/bin"
_tx_capture C4 run_plugin_codex "$T/bin" HOME="$T/home" UM_PLUGIN_MARKETPLACE="$T/checkout"
_dump_on_fail C4
assert_exit_zero "C4: exits 0" "$TX_EXIT_C4"
assert_eq "C4: add the checkout, then the plugin; no upgrade" "$(calls_of "$T/bin")" "plugin marketplace add $T/checkout
plugin add universal-memory@universal-memory"
assert_not_contains "C4: no upgrade warning" "$TX_OUT_C4" "upgrade failed"

# ─── C5: Codex's home exists but no codex CLI — say the two commands ─────────
echo ""
echo "=== C5: ~/.codex present, codex CLI missing ==="
T="$TMPROOT/c5"; mkdir -p "$T/home/.codex" "$T/bin"
if codex_on_system_path; then
  pass "C5: skipped (a codex CLI lives in /usr/bin or /bin on this machine)"
else
  _tx_capture C5 run_without_codex "$T/bin" HOME="$T/home"
  assert_exit_zero "C5: exits 0" "$TX_EXIT_C5"
  assert_contains "C5: names marketplace add" "$TX_OUT_C5" "codex plugin marketplace add goldenwo/universal-memory"
  assert_contains "C5: names plugin add" "$TX_OUT_C5" "codex plugin add universal-memory@universal-memory"
  assert_absent "C5: nothing written under ~/.codex/plugins" "$T/home/.codex/plugins"
fi

# ─── C6: no codex CLI and no Codex home — skip quietly (was T19) ─────────────
echo ""
echo "=== C6: Codex absent → skip, exit 0, nothing created ==="
T="$TMPROOT/c6"; mkdir -p "$T/home" "$T/bin"
if codex_on_system_path; then
  pass "C6: skipped (a codex CLI lives in /usr/bin or /bin on this machine)"
else
  _tx_capture C6 run_without_codex "$T/bin" HOME="$T/home"
  assert_exit_zero "C6: exits 0 when Codex is absent" "$TX_EXIT_C6"
  assert_contains "C6: skip message for absent Codex" "$TX_OUT_C6" "Codex CLI not detected"
  assert_absent "C6: ~/.codex not created" "$T/home/.codex"
fi

# ─── C7: a failing marketplace add fails the installer ───────────────────────
echo ""
echo "=== C7: marketplace add fails ==="
T="$TMPROOT/c7"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C7 run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_CODEX_MKT_ADD_RC=1
assert_exit_nonzero "C7: non-zero exit" "$TX_EXIT_C7"
assert_contains "C7: says which step failed" "$TX_OUT_C7" "codex plugin marketplace add goldenwo/universal-memory failed"
assert_not_contains "C7: no plugin add after a failed marketplace add" "$(calls_of "$T/bin")" "plugin add universal-memory@universal-memory"

# ─── C8: a failing plugin add fails the installer ────────────────────────────
echo ""
echo "=== C8: plugin add fails ==="
T="$TMPROOT/c8"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C8 run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_CODEX_ADD_RC=1
assert_exit_nonzero "C8: non-zero exit" "$TX_EXIT_C8"
assert_contains "C8: says which step failed" "$TX_OUT_C8" "codex plugin add universal-memory@universal-memory failed"
assert_not_contains "C8: no success claim" "$TX_OUT_C8" "trust the universal-memory hooks"

# ─── C9: a failing upgrade only warns; the add still runs ────────────────────
echo ""
echo "=== C9: marketplace upgrade fails ==="
T="$TMPROOT/c9"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C9 run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_CODEX_UPGRADE_RC=1
assert_exit_zero "C9: exits 0" "$TX_EXIT_C9"
assert_contains "C9: warns about the upgrade" "$TX_OUT_C9" "codex plugin marketplace upgrade universal-memory failed"
assert_contains "C9: plugin add still runs" "$(calls_of "$T/bin")" "plugin add universal-memory@universal-memory"

# ─── C10: an old copy is reported, not deleted (CODEX_HOME honoured) ─────────
echo ""
echo "=== C10: old \$CODEX_HOME/plugins/universal-memory copy ==="
T="$TMPROOT/c10"; mkdir -p "$T/home" "$T/codexhome/plugins/universal-memory/.codex-plugin"; make_fakecodex "$T/bin"
echo '{ "name": "universal-memory", "version": "0.7.0-alpha" }' > "$T/codexhome/plugins/universal-memory/.codex-plugin/plugin.json"
_tx_capture C10 run_plugin_codex "$T/bin" HOME="$T/home" CODEX_HOME="$T/codexhome"
assert_exit_zero "C10: exits 0" "$TX_EXIT_C10"
assert_contains "C10: names the old copy" "$TX_OUT_C10" "$T/codexhome/plugins/universal-memory"
assert_contains "C10: says Codex does not load it" "$TX_OUT_C10" "Codex does not load it"
assert_contains "C10: gives the removal command" "$TX_OUT_C10" "rm -rf '$T/codexhome/plugins/universal-memory'"
assert_file_exists "C10: the old copy is left in place" "$T/codexhome/plugins/universal-memory/.codex-plugin/plugin.json"
assert_contains "C10: codex runs with the caller's CODEX_HOME" "$(cat "$T/bin/codex.calls")" "CODEX_HOME=$T/codexhome"

# ─── C11: CODEX_HOME locates Codex when the CLI is missing ───────────────────
echo ""
echo "=== C11: CODEX_HOME present, ~/.codex absent, codex CLI missing ==="
T="$TMPROOT/c11"; mkdir -p "$T/home" "$T/codexhome" "$T/bin"
if codex_on_system_path; then
  pass "C11: skipped (a codex CLI lives in /usr/bin or /bin on this machine)"
else
  _tx_capture C11 run_without_codex "$T/bin" HOME="$T/home" CODEX_HOME="$T/codexhome"
  assert_exit_zero "C11: exits 0" "$TX_EXIT_C11"
  assert_contains "C11: names the commands" "$TX_OUT_C11" "codex plugin add universal-memory@universal-memory"
fi

# ─── C12: the marketplace serves Codex the plugin with hooks ─────────────────
# Codex reads .claude-plugin/marketplace.json; its universal-memory entry is the
# Claude Code plugin tree. The MCP-only plugins/codex copy is retired.
echo ""
echo "=== C12: marketplace entry and the retired copy ==="
assert_contains "C12: marketplace entry points at the hooks tree" \
  "$(cat "$REPO_ROOT/.claude-plugin/marketplace.json")" '"source": "./plugins/claude-code/universal-memory"'
assert_file_exists "C12: that tree ships hooks/hooks.json" "$REPO_ROOT/plugins/claude-code/universal-memory/hooks/hooks.json"
assert_absent "C12: plugins/codex/universal-memory is retired" "$REPO_ROOT/plugins/codex/universal-memory"

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
