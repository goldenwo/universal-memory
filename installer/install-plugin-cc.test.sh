#!/usr/bin/env bash
# install-plugin-cc.test.sh — tests for installer/install-plugin-cc.sh
# Migrated from server/install.test.sh (T1/T2/T3/T11/T14/T12) as part of
# Task 3.1 test-ownership fix (post-commit 003d950).
#
# Run: bash installer/install-plugin-cc.test.sh

# shellcheck disable=SC2034
# TX_OUT scaffold vars (T3_OUT, T14_OUT) captured for dump-on-fail diagnostics.
# TODO(v0.6): wire into a _dump_on_fail helper.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")"
PLUGIN_CC_SH="$SCRIPT_DIR/install-plugin-cc.sh"
PLUGIN_SRC="$REPO_ROOT/plugins/claude-code/universal-memory"

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

# ─── Temp root ───────────────────────────────────────────────────────────────
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# ─── Helper: make_fakebin ────────────────────────────────────────────────────
make_fakebin() {
  local dest="$1"
  mkdir -p "$dest"
  # fake docker (not needed by plugin-cc but kept for PATH completeness)
  cat > "$dest/docker" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
  chmod +x "$dest/docker"
  # fake curl
  cat > "$dest/curl" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
  chmod +x "$dest/curl"
  # fake python3
  cat > "$dest/python3" <<'FAKE'
#!/usr/bin/env bash
[[ "$*" == *"import yaml"* ]] && exit 0
exec /usr/bin/python3 "$@" 2>/dev/null || exit 0
FAKE
  chmod +x "$dest/python3"
}

# run_plugin_cc <fakebin_dir> [env_var=val ...] -- [script_args...]
# Run install-plugin-cc.sh with fake PATH injected and REPO_ROOT pinned.
# env vars before '--' are passed as env overrides; args after '--' go to script.
run_plugin_cc() {
  local fakebin="$1"; shift
  local -a env_vars=()
  local -a script_args=()
  local after_sep=0
  for arg in "$@"; do
    if [ "$arg" = "--" ]; then after_sep=1; continue; fi
    if [ "$after_sep" = "1" ]; then script_args+=("$arg")
    else env_vars+=("$arg"); fi
  done
  env PATH="$fakebin:$PATH" _UM_REPO_ROOT="$REPO_ROOT" "${env_vars[@]}" \
    bash "$PLUGIN_CC_SH" "${script_args[@]}" 2>&1
}

# ─── T1: Fresh install — plugin copy ─────────────────────────────────────────
echo ""
echo "=== T1: Fresh install (no plugin) ==="
T1="$TMPROOT/t1"
mkdir -p "$T1/plugins" "$T1/home"
touch "$T1/home/.bashrc"
make_fakebin "$T1/bin"

T1_EXIT=0
T1_OUT=$(run_plugin_cc "$T1/bin" \
  UM_NONINTERACTIVE=1 \
  CLAUDE_PLUGINS_DIR="$T1/plugins" \
  SHELL=/bin/bash \
  HOME="$T1/home") || T1_EXIT=$?

assert_exit_zero "T1: install exits 0" "$T1_EXIT"
assert_file_exists "T1: plugin directory created" "$T1/plugins/universal-memory"
assert_file_exists "T1: plugin.json present inside install" "$T1/plugins/universal-memory/.claude-plugin/plugin.json"
assert_contains "T1: plugin install message in output" "$T1_OUT" "Plugin copied"

# ─── T2: Re-install — same version plugin already installed ───────────────────
echo ""
echo "=== T2: Re-install (plugin same version) ==="
T2="$TMPROOT/t2"
mkdir -p "$T2/plugins" "$T2/home"
touch "$T2/home/.bashrc"
make_fakebin "$T2/bin"

# Pre-install: copy plugin once
cp -r "$PLUGIN_SRC" "$T2/plugins/universal-memory"

T2_EXIT=0
T2_OUT=$(run_plugin_cc "$T2/bin" \
  UM_NONINTERACTIVE=1 \
  CLAUDE_PLUGINS_DIR="$T2/plugins" \
  SHELL=/bin/bash \
  HOME="$T2/home") || T2_EXIT=$?

assert_exit_zero "T2: re-install exits 0" "$T2_EXIT"
assert_contains "T2: skip message for same-version plugin" "$T2_OUT" "already installed"

# ─── T3: Non-interactive mode ─────────────────────────────────────────────────
echo ""
echo "=== T3: Non-interactive mode (UM_NONINTERACTIVE=1) ==="
T3="$TMPROOT/t3"
mkdir -p "$T3/plugins" "$T3/home"
touch "$T3/home/.bashrc"
make_fakebin "$T3/bin"

T3_EXIT=0
T3_OUT=$(run_plugin_cc "$T3/bin" \
  UM_NONINTERACTIVE=1 \
  CLAUDE_PLUGINS_DIR="$T3/plugins" \
  SHELL=/bin/bash \
  HOME="$T3/home") || T3_EXIT=$?

assert_exit_zero "T3: non-interactive exits 0" "$T3_EXIT"
assert_file_exists "T3: plugin installed non-interactively" "$T3/plugins/universal-memory"

# ─── T11: picking 'skip' at install prompt — non-destructive ─────────────────
# Regression: previously, _install_plugin rm'd the target BEFORE the case that
# picked the action, so picking (s)kip deleted the user's installed plugin
# without installing anything. Skip must be non-destructive.
echo ""
echo "=== T11: picking 'skip' at install prompt preserves pre-existing plugin ==="
T11="$TMPROOT/t11"
mkdir -p "$T11/plugins" "$T11/home"
touch "$T11/home/.bashrc"
make_fakebin "$T11/bin"

# Pre-install a plugin dir WITHOUT plugin.json so the version-compare block
# (needs both src_ver and target_ver non-empty) is skipped and execution
# reaches the copy/link/skip prompt directly.
mkdir -p "$T11/plugins/universal-memory"
echo "user-customized content" > "$T11/plugins/universal-memory/CUSTOM.txt"

# Run interactively (no UM_NONINTERACTIVE), feeding 's' on stdin to skip.
T11_EXIT=0
T11_OUT=$(printf 's\n' | env PATH="$T11/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  CLAUDE_PLUGINS_DIR="$T11/plugins" \
  SHELL=/bin/bash \
  HOME="$T11/home" \
  bash "$PLUGIN_CC_SH" 2>&1) || T11_EXIT=$?

assert_exit_zero "T11: install exits 0 when user picks skip" "$T11_EXIT"
assert_contains "T11: skip message shown at plugin prompt" "$T11_OUT" "install manually"
assert_file_exists "T11: pre-existing plugin content preserved on skip" "$T11/plugins/universal-memory/CUSTOM.txt"

# ─── T14: plugin install copies rubric to target ─────────────────────────────
echo ""
echo "=== T14: plugin install copies rubric.md to target ==="
T14="$TMPROOT/t14"
mkdir -p "$T14/plugins" "$T14/home"
touch "$T14/home/.bashrc"
make_fakebin "$T14/bin"

T14_EXIT=0
T14_OUT=$(run_plugin_cc "$T14/bin" \
  UM_NONINTERACTIVE=1 \
  CLAUDE_PLUGINS_DIR="$T14/plugins" \
  SHELL=/bin/bash \
  HOME="$T14/home") || T14_EXIT=$?

assert_exit_zero "T14: install exits 0" "$T14_EXIT"
assert_file_exists "T14: rubric.md copied to installed plugin" "$T14/plugins/universal-memory/rubric.md"

# ─── T12: --yes non-interactive with all defaults ─────────────────────────────
# A single `--yes`/`-y` flag should accept every default (plugin copy) without
# prompting and without requiring UM_NONINTERACTIVE=1 to be set manually.
echo ""
echo "=== T12: --yes accepts all defaults ==="
T12="$TMPROOT/t12"
mkdir -p "$T12/plugins" "$T12/home"
touch "$T12/home/.bashrc"
make_fakebin "$T12/bin"

T12_EXIT=0
T12_OUT=$(env PATH="$T12/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  CLAUDE_PLUGINS_DIR="$T12/plugins" \
  SHELL=/bin/bash \
  HOME="$T12/home" \
  bash "$PLUGIN_CC_SH" --yes 2>&1) || T12_EXIT=$?

assert_exit_zero "T12: --yes exits 0" "$T12_EXIT"
assert_contains "T12: plugin copied message" "$T12_OUT" "Plugin copied"
assert_file_exists "T12: plugin installed to default target" "$T12/plugins/universal-memory/.claude-plugin/plugin.json"

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
