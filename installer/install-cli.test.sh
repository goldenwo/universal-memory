#!/usr/bin/env bash
# installer/install-cli.test.sh — unit tests for install-cli.sh
# Run: bash installer/install-cli.test.sh
#
# Tests use a sandboxed $HOME=$(mktemp -d) per test so no real user env is touched.
# Pattern matches server/install.test.sh for PASS/FAIL conventions.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")"
INSTALL_CLI="$SCRIPT_DIR/install-cli.sh"

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
  if [ "$got" = "$want" ]; then pass "$name"; else fail_test "$name" "got='$got', want='$want'"; fi
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

assert_exit_nonzero() {
  local name="$1" code="$2"
  if [ "$code" -ne 0 ]; then pass "$name"; else fail_test "$name" "exit code 0 (expected non-zero)"; fi
}

# ─── Temp root ────────────────────────────────────────────────────────────────
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# make_fakepython3 <dest_dir>
# Creates a fake python3 that succeeds for 'import yaml'.
make_fakepython3() {
  local dest="$1"
  mkdir -p "$dest"
  cat > "$dest/python3" <<'FAKE'
#!/usr/bin/env bash
[[ "$*" == *"import yaml"* ]] && exit 0
exec /usr/bin/python3 "$@" 2>/dev/null || exit 0
FAKE
  chmod +x "$dest/python3"
}

# make_nopython3 <dest_dir>
# Creates a dir WITHOUT python3 (for testing missing-python3 path).
make_nopython3() {
  local dest="$1"
  mkdir -p "$dest"
  # Intentionally no python3
}

# run_cli [HOME_DIR] [extra env=val ...]
# Runs install-cli.sh with sandboxed HOME and optional extra env vars.
run_cli() {
  local fake_home="$1"; shift
  env HOME="$fake_home" "$@" bash "$INSTALL_CLI" --yes 2>&1
}

# ─── T1: fresh env → install creates block + um --version works ───────────────
echo ""
echo "=== T1: fresh env → install creates block + um --version works ==="
T1="$TMPROOT/t1"
T1_HOME="$T1/home"
mkdir -p "$T1_HOME"
touch "$T1_HOME/.bashrc"
make_fakepython3 "$T1/bin"

T1_EXIT=0
T1_OUT=$(env PATH="$T1/bin:$PATH" HOME="$T1_HOME" bash "$INSTALL_CLI" --yes 2>&1) || T1_EXIT=$?

assert_exit_zero "T1: install exits 0" "$T1_EXIT"
assert_file_exists "T1: LIB_DIR created" "$T1_HOME/.local/share/um/lib"
assert_file_exists "T1: CLI_DIR created" "$T1_HOME/.local/share/um/cli"
assert_file_exists "T1: um dispatcher in CLI_DIR" "$T1_HOME/.local/share/um/cli/um"
assert_file_exists "T1: um dispatcher in BIN_DIR" "$T1_HOME/.local/bin/um"
assert_file_exists "T1: um-tunnel in CLI_DIR" "$T1_HOME/.local/share/um/cli/um-tunnel"
assert_file_exists "T1: plugin.json installed" "$T1_HOME/.local/.claude-plugin/plugin.json"
assert_contains "T1: marker block in bashrc" "$(cat "$T1_HOME/.bashrc")" "universal-memory (auto-added"
assert_contains "T1: UM_SERVER_URL in bashrc" "$(cat "$T1_HOME/.bashrc")" "UM_SERVER_URL"
assert_contains "T1: UM_LIB_DIR in bashrc" "$(cat "$T1_HOME/.bashrc")" "UM_LIB_DIR"
assert_contains "T1: UM_CLI_DIR in bashrc" "$(cat "$T1_HOME/.bashrc")" "UM_CLI_DIR"
assert_contains "T1: PATH guard in bashrc" "$(cat "$T1_HOME/.bashrc")" ".local/bin"

# um --version: symlink points at CLI_DIR/um; PLUGIN_DIR = CLI_DIR/.. = DATA_DIR
# which has .claude-plugin/plugin.json installed above.
T1_VER_EXIT=0
T1_VER=$(env PATH="$T1_HOME/.local/bin:$PATH" HOME="$T1_HOME" UM_LIB_DIR="$T1_HOME/.local/share/um/lib" um --version 2>&1) || T1_VER_EXIT=$?
assert_exit_zero "T1: um --version exits 0" "$T1_VER_EXIT"
assert_contains "T1: um --version prints a version" "$T1_VER" "alpha"

# ─── T2: server install ran first with key; CLI install env UNSET → block overwritten empty ─
echo ""
echo "=== T2: server block with key → CLI install (key unset) overwrites block empty ==="
T2="$TMPROOT/t2"
T2_HOME="$T2/home"
mkdir -p "$T2_HOME"
touch "$T2_HOME/.bashrc"
make_fakepython3 "$T2/bin"

# Pre-populate bashrc with a server-style block containing a key
cat >> "$T2_HOME/.bashrc" <<'EOF'

# --- universal-memory (auto-added by install.sh) ---
export UM_OPENAI_API_KEY='sk-from-server'
export UM_SUMMARIZER='openai'
# --- end universal-memory ---
EOF

_BASH_BIN2="$(command -v bash)"
T2_EXIT=0
# Run CLI install with UM_OPENAI_API_KEY deliberately unset (env-sourced contract)
T2_OUT=$(env -i PATH="$T2/bin:/usr/bin:/bin" HOME="$T2_HOME" SHELL="$_BASH_BIN2" \
  "$_BASH_BIN2" "$INSTALL_CLI" --yes 2>&1) || T2_EXIT=$?

assert_exit_zero "T2: install exits 0" "$T2_EXIT"

T2_BASHRC="$(cat "$T2_HOME/.bashrc")"
# Block should now be present (overwritten by CLI install)
assert_contains "T2: marker block present after CLI install" "$T2_BASHRC" "universal-memory (auto-added"
# The key should now be empty (env-sourced, not inherited from old block)
assert_not_contains "T2: old server key NOT in overwritten block" "$T2_BASHRC" "sk-from-server"
# Exactly one block (no duplicates)
T2_START_COUNT=$(grep -cF "# --- universal-memory (auto-added by install.sh) ---" "$T2_HOME/.bashrc")
assert_eq "T2: exactly one marker-start line" "$T2_START_COUNT" "1"

# ─── T3: CLI install ran first; server install (key unset) overwrites to default ─
echo ""
echo "=== T3: CLI block first → server install (key unset env) overwrites to default ==="
T3="$TMPROOT/t3"
T3_HOME="$T3/home"
mkdir -p "$T3_HOME" "$T3/plugins"
touch "$T3_HOME/.bashrc"
make_fakepython3 "$T3/bin"

# Locate bash for env -i invocations (env -i strips PATH, need explicit path)
_BASH_BIN="$(command -v bash)"

# Use a valid writable path for UM_LIB_DIR (can't use /custom — no write permission)
T3_CUSTOM_LIB="$T3/custom-lib"
mkdir -p "$T3_CUSTOM_LIB"

# Step 1: run CLI install with UM_LIB_DIR pointing at a custom writable path
T3_EXIT1=0
env -i PATH="$T3/bin:/usr/bin:/bin" HOME="$T3_HOME" SHELL="$_BASH_BIN" \
  UM_LIB_DIR="$T3_CUSTOM_LIB" \
  "$_BASH_BIN" "$INSTALL_CLI" --yes >/dev/null 2>&1 || T3_EXIT1=$?

# Verify CLI install wrote the custom path into the block
T3_BASHRC_AFTER_CLI="$(cat "$T3_HOME/.bashrc")"
assert_contains "T3: CLI block contains custom lib path" "$T3_BASHRC_AFTER_CLI" "$T3_CUSTOM_LIB"

# Step 2: emulate server install by directly calling _write_marker_block with empty env
# (UM_LIB_DIR unset → defaults to ~/.local/share/um/lib)
T3_PROFILE_TMP="$T3_HOME/.bashrc"
env -i HOME="$T3_HOME" "$_BASH_BIN" -c "
  source '$REPO_ROOT/installer/lib/marker-block.sh'
  _write_marker_block '$T3_PROFILE_TMP' '' ''
"

T3_BASHRC_AFTER_SERVER="$(cat "$T3_HOME/.bashrc")"
# Old custom lib path should be gone — replaced by default
assert_not_contains "T3: custom lib path NOT in block after server overwrite" "$T3_BASHRC_AFTER_SERVER" "$T3_CUSTOM_LIB"
assert_contains "T3: default lib dir in block after server overwrite" "$T3_BASHRC_AFTER_SERVER" ".local/share/um/lib"
# Exactly one block
T3_START_COUNT=$(grep -cF "# --- universal-memory (auto-added by install.sh) ---" "$T3_HOME/.bashrc")
assert_eq "T3: exactly one marker-start line" "$T3_START_COUNT" "1"

# ─── T4: missing python3 → fails fast with install instructions ──────────────
echo ""
echo "=== T4: missing python3 → fails fast with install instructions ==="
T4="$TMPROOT/t4"
T4_HOME="$T4/home"
mkdir -p "$T4_HOME"
make_nopython3 "$T4/empty-bin"

T4_EXIT=0
T4_OUT=$(env -i PATH="$T4/empty-bin:/usr/bin:/bin" HOME="$T4_HOME" SHELL=/bin/bash \
  bash "$INSTALL_CLI" --yes 2>&1) || T4_EXIT=$?

# python3 is present on the host but PATH is minimal — if host python3 is found
# on PATH above, the test may not trigger. So we only check IF exit was non-zero.
# On a host where /usr/bin/python3 exists, this test is skipped gracefully.
if ! command -v python3 >/dev/null 2>&1; then
  # python3 truly absent on host
  assert_exit_nonzero "T4: fails without python3" "$T4_EXIT"
  assert_contains "T4: error message has install hint" "$T4_OUT" "python3 is required"
else
  # python3 found on host PATH — test the yaml-missing path instead
  # Create a python3 wrapper that fails 'import yaml'
  mkdir -p "$T4/noyaml-bin"
  cat > "$T4/noyaml-bin/python3" <<'FAKE'
#!/usr/bin/env bash
if [[ "$*" == *"import yaml"* ]]; then exit 1; fi
exec /usr/bin/python3 "$@" 2>/dev/null
FAKE
  chmod +x "$T4/noyaml-bin/python3"
  T4B_EXIT=0
  T4B_OUT=$(env PATH="$T4/noyaml-bin:$PATH" HOME="$T4_HOME" \
    bash "$INSTALL_CLI" --yes 2>&1) || T4B_EXIT=$?
  assert_exit_nonzero "T4: fails without pyyaml" "$T4B_EXIT"
  assert_contains "T4: error message has pyyaml hint" "$T4B_OUT" "yaml module is required"
fi

# ─── T5: PATH guard written even when .local/bin not yet in PATH ──────────────
echo ""
echo "=== T5: PATH guard written to shell rc even when .local/bin absent from PATH ==="
T5="$TMPROOT/t5"
T5_HOME="$T5/home"
mkdir -p "$T5_HOME"
touch "$T5_HOME/.bashrc"
make_fakepython3 "$T5/bin"

_BASH_BIN5="$(command -v bash)"
T5_EXIT=0
# Explicitly omit $HOME/.local/bin from PATH to verify guard is always written
T5_OUT=$(env -i PATH="$T5/bin:/usr/bin:/bin" HOME="$T5_HOME" SHELL="$_BASH_BIN5" \
  "$_BASH_BIN5" "$INSTALL_CLI" --yes 2>&1) || T5_EXIT=$?

assert_exit_zero "T5: install exits 0" "$T5_EXIT"
T5_BASHRC="$(cat "$T5_HOME/.bashrc")"
# PATH guard must be in the block regardless of caller's PATH
assert_contains "T5: PATH guard present in bashrc" "$T5_BASHRC" 'case ":$PATH:"'
assert_contains "T5: PATH guard adds .local/bin" "$T5_BASHRC" ".local/bin"

# ─── T6: SHELL unset — no crash under set -u ─────────────────────────────────
# CRIT-2: when SHELL is unset (cron, systemd-run, minimal containers), the
# previous ${SHELL##*/} triggered "unbound variable" under set -u and aborted
# the script before reaching any warn/fallback path.
# Fix: _sh="${SHELL:-}" ensures an empty string, not an error.
#
# Note: bash always re-exports SHELL=<self> in child processes, so we cannot
# test the "script runs with SHELL truly unset" scenario by launching a child
# bash process.  Instead we verify two things:
#   (a) The helper snippet itself does not crash under set -u when SHELL is unset
#       (inline evaluation — SHELL genuinely absent in THIS shell's env).
#   (b) The fix (_sh="${SHELL:-}") is present in the installer source.
echo ""
echo "=== T6: SHELL unset — rc-detection snippet does not crash under set -u ==="

# (a) Run the shell-detection snippet with SHELL genuinely unset in this process.
T6_SNIPPET_EXIT=0
T6_SNIPPET_OUT=$(bash -c '
  set -euo pipefail
  unset SHELL
  _sh="${SHELL:-}"
  rc="/nonexistent/.bashrc"
  [ -f "$rc" ] || [ "${_sh##*/}" = "bash" ] || echo "continue_ok"
' 2>&1) || T6_SNIPPET_EXIT=$?
assert_exit_zero "T6: snippet exits 0 with SHELL unset" "$T6_SNIPPET_EXIT"
assert_contains "T6: continue path fires safely" "$T6_SNIPPET_OUT" "continue_ok"

# (b) Verify that the fix is present in the source — _sh="${SHELL:-}" must appear.
T6_SRC_FIX=$(grep -c '_sh="${SHELL:-}"' "$INSTALL_CLI" || true)
assert_eq "T6: _sh safe-default present in install-cli.sh" "$T6_SRC_FIX" "1"

# ─── T7: single-quote in UM_LIB_DIR does not break the written rc file ────────
# CRIT-5: path values containing a single-quote (e.g. /home/bob's data) must be
# escaped as '\'', otherwise the written export line is invalid bash.
# The fix adds _marker_escape_sq() to marker-block.sh.
echo ""
echo "=== T7: single-quote in value does not corrupt written rc file ==="
T7="$TMPROOT/t7"
T7_HOME="$T7/home"
# Path with a literal single-quote — valid on Linux, must be escaped in rc.
T7_SQ_LIB="$T7_HOME/.local/share/it's-um/lib"
mkdir -p "$T7_HOME" "$T7_SQ_LIB"
touch "$T7_HOME/.bashrc"
make_fakepython3 "$T7/bin"
_BASH_BIN7="$(command -v bash)"

T7_EXIT=0
T7_OUT=$(env PATH="$T7/bin:$PATH" HOME="$T7_HOME" \
  UM_LIB_DIR="$T7_SQ_LIB" \
  "$_BASH_BIN7" "$INSTALL_CLI" --yes 2>&1) || T7_EXIT=$?

assert_exit_zero "T7: install exits 0 with single-quote in UM_LIB_DIR" "$T7_EXIT"

# The written rc file must source cleanly and UM_LIB_DIR must round-trip correctly.
T7_SOURCE_OUT=$(bash -c "source '$T7_HOME/.bashrc'; printf '%s' \"\$UM_LIB_DIR\"" 2>&1)
T7_SOURCE_EXIT=$?
assert_exit_zero "T7: rc file sources cleanly after single-quote value written" "$T7_SOURCE_EXIT"
assert_eq "T7: UM_LIB_DIR round-trips through rc correctly" "$T7_SOURCE_OUT" "$T7_SQ_LIB"

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
