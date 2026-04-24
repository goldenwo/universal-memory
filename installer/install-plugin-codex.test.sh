#!/usr/bin/env bash
# install-plugin-codex.test.sh — tests for installer/install-plugin-codex.sh
# Migrated from server/install.test.sh (T13, T19) as part of Task 3.1
# test-ownership fix (post-commit 003d950).
#
# Run: bash installer/install-plugin-codex.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")"
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

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"; else fail_test "$name" "expected to contain '$needle'"; fi
}

assert_file_exists() {
  local name="$1" file="$2"
  if [ -e "$file" ]; then pass "$name"; else fail_test "$name" "file not found: $file"; fi
}

assert_exit_zero() {
  local name="$1" code="$2"
  if [ "$code" -eq 0 ]; then pass "$name"; else fail_test "$name" "exit code $code (expected 0)"; fi
}

# ─── Temp root ───────────────────────────────────────────────────────────────
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# run_plugin_codex <home_dir> [env_var=val ...]
# Runs install-plugin-codex.sh with HOME and _UM_REPO_ROOT set.
run_plugin_codex() {
  local home_dir="$1"; shift
  env _UM_REPO_ROOT="$REPO_ROOT" HOME="$home_dir" "$@" \
    bash "$PLUGIN_CODEX_SH" 2>&1
}

# ─── T13: Codex detected → Codex plugin installed ────────────────────────────
# install-plugin-codex.sh auto-detects a Codex CLI install by the presence of
# $CODEX_CONFIG_DIR (default ~/.codex) and drops plugins/codex/universal-memory
# into ~/.codex/plugins/. Install is idempotent.
echo ""
echo "=== T13: Codex detected → Codex plugin installed ==="
T13="$TMPROOT/t13"
mkdir -p "$T13/home/.codex"

T13_EXIT=0
T13_OUT=$(run_plugin_codex "$T13/home" \
  CODEX_CONFIG_DIR="$T13/home/.codex") || T13_EXIT=$?

assert_exit_zero "T13: install exits 0 when Codex present" "$T13_EXIT"
assert_contains "T13: Codex detection message in output" "$T13_OUT" "Codex CLI detected"
assert_file_exists "T13: Codex plugin dir created" "$T13/home/.codex/plugins/universal-memory"
assert_file_exists "T13: Codex plugin manifest landed" "$T13/home/.codex/plugins/universal-memory/.codex-plugin/plugin.json"
assert_file_exists "T13: Codex .mcp.json landed" "$T13/home/.codex/plugins/universal-memory/.mcp.json"
assert_file_exists "T13: Codex plugin README landed" "$T13/home/.codex/plugins/universal-memory/README.md"

# Idempotency: a second run with the same version should report "already installed".
T13B_EXIT=0
T13B_OUT=$(run_plugin_codex "$T13/home" \
  CODEX_CONFIG_DIR="$T13/home/.codex") || T13B_EXIT=$?

assert_exit_zero "T13: second run (idempotency) exits 0" "$T13B_EXIT"
assert_contains "T13: second run reports already installed" "$T13B_OUT" "already installed"

# ─── T19: Codex absent → Codex plugin skipped (silent, does not fail install) ─
echo ""
echo "=== T19: Codex absent → Codex plugin skip path (does not fail install) ==="
T19="$TMPROOT/t19"
mkdir -p "$T19/home"  # no .codex dir

T19_EXIT=0
T19_OUT=$(run_plugin_codex "$T19/home" \
  CODEX_CONFIG_DIR="$T19/home/.codex") || T19_EXIT=$?

assert_exit_zero "T19: install exits 0 when Codex absent" "$T19_EXIT"
assert_contains "T19: skip message for absent Codex" "$T19_OUT" "Codex CLI not detected"
# The Codex plugin dir must NOT have been created.
if [ ! -e "$T19/home/.codex" ]; then
  pass "T19: ~/.codex not created when Codex absent"
else
  fail_test "T19: ~/.codex unexpectedly created" "$(ls -la "$T19/home/.codex" 2>/dev/null)"
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
