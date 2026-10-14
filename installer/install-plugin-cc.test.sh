#!/usr/bin/env bash
# install-plugin-cc.test.sh — tests for installer/install-plugin-cc.sh
#
# The installer registers the plugin through Claude Code's marketplace (the
# only route Claude Code loads) and installs the optional claude-mem bridge
# under ~/.local/share/um/bridge. A fake `claude` on PATH records every call;
# no network. Rewritten 2026-10-14 when the old copy-into-~/.claude/plugins
# route was retired: a 2026-10-14 clean-room run showed `claude plugin list`
# reporting "No plugins installed" right after that route ran.
#
# Run: bash installer/install-plugin-cc.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"

# shellcheck source=installer/lib/test-harness.sh
source "$REPO_ROOT/installer/lib/test-harness.sh"
PLUGIN_CC_SH="$SCRIPT_DIR/install-plugin-cc.sh"

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
assert_exit_zero() {
  local name="$1" code="$2"
  if [ "$code" -eq 0 ]; then pass "$name"; else fail_test "$name" "exit code $code (expected 0)"; fi
}

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# make_fakebin <dir> [claude_add_rc] — a fake `claude` that appends each call
# to $dir/claude.calls and exits with claude_add_rc for `marketplace add`, and a
# fake `npm` that succeeds (UM_TEST_NPM_RC overrides) without touching the net.
make_fakebin() {
  local dest="$1" add_rc="${2:-0}"
  mkdir -p "$dest"
  cat > "$dest/claude" <<FAKE
#!/usr/bin/env bash
echo "\$*" >> "$dest/claude.calls"
[[ "\$*" == "plugin marketplace add"* ]] && exit $add_rc
exit 0
FAKE
  cat > "$dest/npm" <<'FAKE'
#!/usr/bin/env bash
exit "${UM_TEST_NPM_RC:-0}"
FAKE
  chmod +x "$dest/claude" "$dest/npm"
}

# run_plugin_cc <path_prefix> [env_var=val ...] — run the installer with REPO_ROOT pinned.
# shellcheck disable=SC2317,SC2329  # invoked indirectly through _tx_capture (SC2329 is the newer code)
run_plugin_cc() {
  local prefix="$1"; shift
  env PATH="$prefix:$PATH" _UM_REPO_ROOT="$REPO_ROOT" "$@" bash "$PLUGIN_CC_SH" --yes 2>&1
}

# ─── P1: the plugin goes through the marketplace, nowhere else ───────────────
echo ""
echo "=== P1: registers through claude plugin marketplace ==="
T="$TMPROOT/p1"; mkdir -p "$T/home"; make_fakebin "$T/bin"
_tx_capture P1 run_plugin_cc "$T/bin" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge"
_dump_on_fail P1
assert_exit_zero "P1: exits 0" "$TX_EXIT_P1"
P1_CALLS=$(cat "$T/bin/claude.calls" 2>/dev/null || true)
assert_contains "P1: marketplace add goldenwo/universal-memory" "$P1_CALLS" "plugin marketplace add goldenwo/universal-memory"
assert_contains "P1: marketplace update" "$P1_CALLS" "plugin marketplace update universal-memory"
assert_contains "P1: plugin install" "$P1_CALLS" "plugin install universal-memory@universal-memory"
assert_contains "P1: plugin update" "$P1_CALLS" "plugin update universal-memory@universal-memory"
if [ -e "$T/home/.claude/plugins/universal-memory" ]; then
  fail_test "P1: no copy under ~/.claude/plugins" "found $T/home/.claude/plugins/universal-memory"
else
  pass "P1: no copy under ~/.claude/plugins"
fi
assert_contains "P1: next step is /um-setup" "$TX_OUT_P1" "/um-setup"
if [ -e "$T/home/.bashrc" ] || [ -e "$T/home/.zshrc" ]; then
  fail_test "P1: no shell rc written" "an rc file appeared in $T/home"
else
  pass "P1: no shell rc written"
fi

# ─── P2: a local checkout can be the marketplace ─────────────────────────────
echo ""
echo "=== P2: UM_PLUGIN_MARKETPLACE override ==="
T="$TMPROOT/p2"; mkdir -p "$T/home"; make_fakebin "$T/bin"
_tx_capture P2 run_plugin_cc "$T/bin" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge" UM_PLUGIN_MARKETPLACE=/src/um
assert_exit_zero "P2: exits 0" "$TX_EXIT_P2"
assert_contains "P2: marketplace add uses the override" "$(cat "$T/bin/claude.calls")" "plugin marketplace add /src/um"

# ─── P3: no claude CLI — say the two commands, install nothing ───────────────
echo ""
echo "=== P3: claude CLI missing ==="
T="$TMPROOT/p3"; mkdir -p "$T/home"; make_fakebin "$T/bin"; rm -f "$T/bin/claude"
# Hide any real claude on this machine behind a PATH that lacks it.
P3_PATH="$T/bin:/usr/bin:/bin"
_tx_capture P3 env PATH="$P3_PATH" _UM_REPO_ROOT="$REPO_ROOT" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge" bash "$PLUGIN_CC_SH" --yes
if command -v -p claude >/dev/null 2>&1 || PATH="$P3_PATH" command -v claude >/dev/null 2>&1; then
  pass "P3: skipped (a claude CLI lives in /usr/bin or /bin on this machine)"
else
  assert_exit_zero "P3: exits 0" "$TX_EXIT_P3"
  assert_contains "P3: names marketplace add" "$TX_OUT_P3" "claude plugin marketplace add goldenwo/universal-memory"
  assert_contains "P3: names plugin install" "$TX_OUT_P3" "claude plugin install universal-memory@universal-memory"
fi

# ─── P4: a failing marketplace add fails the installer ───────────────────────
echo ""
echo "=== P4: marketplace add fails ==="
T="$TMPROOT/p4"; mkdir -p "$T/home"; make_fakebin "$T/bin" 1
_tx_capture P4 run_plugin_cc "$T/bin" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge"
if [ "$TX_EXIT_P4" -ne 0 ]; then pass "P4: non-zero exit"; else fail_test "P4: non-zero exit" "exit 0"; fi
assert_contains "P4: says which step failed" "$TX_OUT_P4" "marketplace add goldenwo/universal-memory failed"
assert_not_contains "P4: no install after a failed add" "$(cat "$T/bin/claude.calls")" "plugin install"

# ─── P5: an old copy is reported, not deleted ────────────────────────────────
echo ""
echo "=== P5: old ~/.claude/plugins copy ==="
T="$TMPROOT/p5"; mkdir -p "$T/home" "$T/plugins/universal-memory"; make_fakebin "$T/bin"
echo keep > "$T/plugins/universal-memory/marker"
_tx_capture P5 run_plugin_cc "$T/bin" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge" \
  CLAUDE_PLUGINS_DIR="$T/plugins" UM_PROMPT_DIR="$T/plugins/universal-memory/hooks/lib/prompts"
assert_exit_zero "P5: exits 0" "$TX_EXIT_P5"
assert_contains "P5: warns Claude Code does not load it" "$TX_OUT_P5" "Claude Code does not load it"
assert_contains "P5: warns about UM_PROMPT_DIR" "$TX_OUT_P5" "UM_PROMPT_DIR points into that old copy"
assert_file_exists "P5: the old copy is left in place" "$T/plugins/universal-memory/marker"

# ─── B1: the bridge lives in its own directory with real modules ─────────────
echo ""
echo "=== B1: claude-mem bridge under UM_BRIDGE_DIR ==="
if ! command -v node >/dev/null 2>&1; then
  pass "B1: skipped (no node on this machine)"
else
  T="$TMPROOT/b1"; mkdir -p "$T/home"; make_fakebin "$T/bin"
  _tx_capture B1 run_plugin_cc "$T/bin" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge"
  _dump_on_fail B1
  assert_exit_zero "B1: exits 0" "$TX_EXIT_B1"
  for f in um-bridge-claude-mem translate.mjs package.json lib/bridge-contract.mjs lib/lockdir.mjs; do
    assert_file_exists "B1: $f installed" "$T/bridge/$f"
  done
  assert_not_contains "B1: bridge-contract is the real module, not the dev shim" "$(cat "$T/bridge/lib/bridge-contract.mjs")" "Dev-tree shim"
  assert_not_contains "B1: lockdir is the real module, not the dev shim" "$(cat "$T/bridge/lib/lockdir.mjs")" "Dev-tree shim"
  assert_file_exists "B1: ~/.local/bin entry" "$T/home/.local/bin/um-bridge-claude-mem"
  # Loadability: --help imports translate.mjs + lib/* (better-sqlite3 loads only on a run).
  B1_HELP_RC=0
  B1_HELP=$(HOME="$T/home" "$T/home/.local/bin/um-bridge-claude-mem" --help 2>&1) || B1_HELP_RC=$?
  assert_exit_zero "B1: the linked bridge loads (--help) — out: ${B1_HELP:0:200}" "$B1_HELP_RC"

  # A failed native build warns and leaves the install successful.
  T="$TMPROOT/b2"; mkdir -p "$T/home"; make_fakebin "$T/bin"
  _tx_capture B2 run_plugin_cc "$T/bin" HOME="$T/home" UM_BRIDGE_DIR="$T/bridge" UM_TEST_NPM_RC=1
  assert_exit_zero "B2: npm failure still exits 0" "$TX_EXIT_B2"
  assert_contains "B2: npm failure is reported" "$TX_OUT_B2" "native build failed"
fi

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
