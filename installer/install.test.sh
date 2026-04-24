#!/bin/bash
# installer/install.test.sh — verify bootstrap prereq checks + clone logic
#
# Design note: we use PATH="$fakebin:/usr/bin:/bin" (prepend convention matching
# server/install.test.sh) so real `bash` and coreutils still resolve. We do NOT
# stub `bash` itself because the outer invocation `bash $INSTALLER` needs real
# bash to execute the script (stubbing bash would make the test runner a stub).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Helper: create stubs for prereq tools (excluding bash — real bash is needed
# to execute the installer under test).
make_stubs() {
  local bindir="$1"
  mkdir -p "$bindir"
  for tool in git docker python3; do
    cat > "$bindir/$tool" <<'BIN'
#!/bin/bash
exit 0
BIN
    chmod +x "$bindir/$tool"
  done
}

# Resolve the absolute path to the real bash once, so T1 can run the installer
# under an empty PATH without losing the ability to launch bash at all.
REAL_BASH="$(command -v bash)"

# ─── T1: missing prereqs → friendly error ─────────────────────────────────────
echo "=== T1: missing prereqs (empty PATH) → exits non-zero with hint ==="
tmp=$(mktemp -d)
mkdir "$tmp/empty"
# We invoke bash by absolute path so the launch succeeds, then set PATH to an
# empty dir so the installer's own `command -v git/docker/python3/bash` all
# fail and it emits the friendly error.
T1_OUT=$(env -i PATH="$tmp/empty" HOME="$tmp" "$REAL_BASH" "$INSTALLER" --dry-run 2>&1) && T1_EXIT=0 || T1_EXIT=$?
if [ "$T1_EXIT" -ne 0 ]; then pass "T1: non-zero exit when tools missing"; else fail "T1: expected non-zero exit"; fi
if echo "$T1_OUT" | grep -q "required tools not found"; then pass "T1: friendly error shown"; else fail "T1: no friendly error (got: $T1_OUT)"; fi
rm -rf "$tmp"

# ─── T2: prereqs present, --dry-run prints clone intent ───────────────────────
echo ""
echo "=== T2: --dry-run prints clone intent when repo missing ==="
tmp=$(mktemp -d)
make_stubs "$tmp/bin"

T2_OUT=$(UM_INSTALL_DIR="$tmp/clonedir" UM_DRY_RUN=1 \
  env PATH="$tmp/bin:/usr/bin:/bin" bash "$INSTALLER" --dry-run 2>&1) && T2_EXIT=0 || T2_EXIT=$?

if [ "$T2_EXIT" -eq 0 ]; then pass "T2: dry-run exits 0"; else fail "T2: dry-run failed (exit $T2_EXIT)"; fi
if echo "$T2_OUT" | grep -q "would: git clone"; then pass "T2: clone intent printed"; else fail "T2: no clone intent (got: $T2_OUT)"; fi
if echo "$T2_OUT" | grep -qE "delegate: server/install\.sh|would: bash"; then pass "T2: server/install.sh dispatch intent printed"; else fail "T2: no dispatch intent"; fi
rm -rf "$tmp"

# ─── T3: existing clone → pull intent ─────────────────────────────────────────
echo ""
echo "=== T3: existing clone → pull (not re-clone) ==="
tmp=$(mktemp -d)
make_stubs "$tmp/bin"
mkdir -p "$tmp/clonedir/.git"  # simulate pre-existing clone

T3_OUT=$(UM_INSTALL_DIR="$tmp/clonedir" UM_DRY_RUN=1 \
  env PATH="$tmp/bin:/usr/bin:/bin" bash "$INSTALLER" --dry-run 2>&1) || T3_EXIT=$?
T3_EXIT=${T3_EXIT:-0}

if [ "$T3_EXIT" -eq 0 ]; then pass "T3: exit 0 on existing clone"; else fail "T3: exit $T3_EXIT"; fi
if echo "$T3_OUT" | grep -q "would: git -C.*pull"; then pass "T3: pull intent (not clone)"; else fail "T3: expected pull, got: $T3_OUT"; fi
if ! echo "$T3_OUT" | grep -q "would: git clone"; then pass "T3: no clone intent on existing repo"; else fail "T3: clone intent leaked"; fi
rm -rf "$tmp"

# ─── T-FLAGS-1: --cli alone delegates to install-cli.sh ──────────────────────
echo ""
echo "=== T-FLAGS-1: --cli → delegates to installer/install-cli.sh ==="
TF1=$(mktemp -d)
make_stubs "$TF1/bin"
TF1_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF1/repo" \
  env PATH="$TF1/bin:/usr/bin:/bin" bash "$INSTALLER" --cli 2>&1) && TF1_EXIT=0 || TF1_EXIT=$?
if [ "$TF1_EXIT" -eq 0 ]; then pass "T-FLAGS-1: exit 0"; else fail "T-FLAGS-1: exit $TF1_EXIT (out: $TF1_OUT)"; fi
if echo "$TF1_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-1: --cli → install-cli.sh"; else fail "T-FLAGS-1: expected delegation log (got: $TF1_OUT)"; fi
rm -rf "$TF1"

# ─── T-FLAGS-2: --server alone delegates to server/install.sh ────────────────
echo ""
echo "=== T-FLAGS-2: --server → delegates to server/install.sh ==="
TF2=$(mktemp -d)
make_stubs "$TF2/bin"
TF2_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF2/repo" \
  env PATH="$TF2/bin:/usr/bin:/bin" bash "$INSTALLER" --server 2>&1) && TF2_EXIT=0 || TF2_EXIT=$?
if [ "$TF2_EXIT" -eq 0 ]; then pass "T-FLAGS-2: exit 0"; else fail "T-FLAGS-2: exit $TF2_EXIT (out: $TF2_OUT)"; fi
if echo "$TF2_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-2: --server → server/install.sh"; else fail "T-FLAGS-2: expected delegation log (got: $TF2_OUT)"; fi
rm -rf "$TF2"

# ─── T-FLAGS-3: no flags (non-TTY) = --all back-compat ───────────────────────
echo ""
echo "=== T-FLAGS-3: no flags (non-TTY) → back-compat --all (delegates server/install.sh) ==="
TF3=$(mktemp -d)
make_stubs "$TF3/bin"
TF3_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF3/repo" \
  env PATH="$TF3/bin:/usr/bin:/bin" bash "$INSTALLER" 2>&1 </dev/null) && TF3_EXIT=0 || TF3_EXIT=$?
if [ "$TF3_EXIT" -eq 0 ]; then pass "T-FLAGS-3: exit 0"; else fail "T-FLAGS-3: exit $TF3_EXIT (out: $TF3_OUT)"; fi
if echo "$TF3_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-3: no-flags non-TTY → server/install.sh"; else fail "T-FLAGS-3: expected server delegation (got: $TF3_OUT)"; fi
rm -rf "$TF3"

# ─── T-FLAGS-4: --server + --cli runs both ───────────────────────────────────
echo ""
echo "=== T-FLAGS-4: --server + --cli → both delegations printed ==="
TF4=$(mktemp -d)
make_stubs "$TF4/bin"
TF4_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF4/repo" \
  env PATH="$TF4/bin:/usr/bin:/bin" bash "$INSTALLER" --server --cli 2>&1) && TF4_EXIT=0 || TF4_EXIT=$?
if [ "$TF4_EXIT" -eq 0 ]; then pass "T-FLAGS-4: exit 0"; else fail "T-FLAGS-4: exit $TF4_EXIT (out: $TF4_OUT)"; fi
if echo "$TF4_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-4: server delegated"; else fail "T-FLAGS-4: server not delegated (got: $TF4_OUT)"; fi
if echo "$TF4_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-4: cli delegated"; else fail "T-FLAGS-4: cli not delegated (got: $TF4_OUT)"; fi
rm -rf "$TF4"

# ─── T-FLAGS-5: --plugin-cc without --server delegates to install-plugin-cc.sh
echo ""
echo "=== T-FLAGS-5: --plugin-cc alone → installer/install-plugin-cc.sh ==="
TF5=$(mktemp -d)
make_stubs "$TF5/bin"
TF5_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF5/repo" \
  env PATH="$TF5/bin:/usr/bin:/bin" bash "$INSTALLER" --plugin-cc 2>&1) && TF5_EXIT=0 || TF5_EXIT=$?
if [ "$TF5_EXIT" -eq 0 ]; then pass "T-FLAGS-5: exit 0"; else fail "T-FLAGS-5: exit $TF5_EXIT (out: $TF5_OUT)"; fi
if echo "$TF5_OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T-FLAGS-5: --plugin-cc → install-plugin-cc.sh"; else fail "T-FLAGS-5: expected delegation (got: $TF5_OUT)"; fi
rm -rf "$TF5"

# ─── T-FLAGS-6: --plugin-codex when ~/.codex absent → soft-skip ──────────────
echo ""
echo "=== T-FLAGS-6: --plugin-codex, no ~/.codex → soft-skip message ==="
TF6=$(mktemp -d)
make_stubs "$TF6/bin"
# Use a fake HOME with no .codex dir
TF6_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF6/repo" \
  env PATH="$TF6/bin:/usr/bin:/bin" HOME="$TF6/fakehome" bash "$INSTALLER" --plugin-codex 2>&1) && TF6_EXIT=0 || TF6_EXIT=$?
if [ "$TF6_EXIT" -eq 0 ]; then pass "T-FLAGS-6: exit 0 (soft-skip)"; else fail "T-FLAGS-6: exit $TF6_EXIT (out: $TF6_OUT)"; fi
if echo "$TF6_OUT" | grep -q "soft-skipping Codex plugin"; then pass "T-FLAGS-6: soft-skip message printed"; else fail "T-FLAGS-6: expected soft-skip message (got: $TF6_OUT)"; fi
rm -rf "$TF6"

# ─── T-FLAGS-7: --plugin-cc + --cli → two delegations ───────────────────────
echo ""
echo "=== T-FLAGS-7: --plugin-cc + --cli → both install-plugin-cc.sh + install-cli.sh ==="
TF7=$(mktemp -d)
make_stubs "$TF7/bin"
TF7_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF7/repo" \
  env PATH="$TF7/bin:/usr/bin:/bin" bash "$INSTALLER" --plugin-cc --cli 2>&1) && TF7_EXIT=0 || TF7_EXIT=$?
if [ "$TF7_EXIT" -eq 0 ]; then pass "T-FLAGS-7: exit 0"; else fail "T-FLAGS-7: exit $TF7_EXIT (out: $TF7_OUT)"; fi
if echo "$TF7_OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T-FLAGS-7: plugin-cc delegated"; else fail "T-FLAGS-7: plugin-cc not delegated (got: $TF7_OUT)"; fi
if echo "$TF7_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-7: cli delegated"; else fail "T-FLAGS-7: cli not delegated (got: $TF7_OUT)"; fi
rm -rf "$TF7"

# ─── T-FLAGS-8: --dry-run prints "delegate:" not "running:" ──────────────────
echo ""
echo "=== T-FLAGS-8: --dry-run → all delegations print 'delegate:' (not 'running:') ==="
TF8=$(mktemp -d)
make_stubs "$TF8/bin"
TF8_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF8/repo" \
  env PATH="$TF8/bin:/usr/bin:/bin" bash "$INSTALLER" --server --cli 2>&1) && TF8_EXIT=0 || TF8_EXIT=$?
if echo "$TF8_OUT" | grep -q "delegate:"; then pass "T-FLAGS-8: 'delegate:' present in dry-run"; else fail "T-FLAGS-8: 'delegate:' not found (got: $TF8_OUT)"; fi
if ! echo "$TF8_OUT" | grep -q "running:"; then pass "T-FLAGS-8: 'running:' absent in dry-run"; else fail "T-FLAGS-8: 'running:' leaked in dry-run"; fi
rm -rf "$TF8"

# ─── T-FLAGS-9: --all triggers server + cli (+ plugins if dirs exist) ────────
echo ""
echo "=== T-FLAGS-9: --all → server + cli at minimum ==="
TF9=$(mktemp -d)
make_stubs "$TF9/bin"
# Use a fake HOME with no .claude or .codex so plugins are skipped
TF9_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF9/repo" \
  env PATH="$TF9/bin:/usr/bin:/bin" HOME="$TF9/fakehome" bash "$INSTALLER" --all 2>&1) && TF9_EXIT=0 || TF9_EXIT=$?
if [ "$TF9_EXIT" -eq 0 ]; then pass "T-FLAGS-9: exit 0"; else fail "T-FLAGS-9: exit $TF9_EXIT (out: $TF9_OUT)"; fi
if echo "$TF9_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-9: server in --all"; else fail "T-FLAGS-9: server not in --all (got: $TF9_OUT)"; fi
if echo "$TF9_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-9: cli in --all"; else fail "T-FLAGS-9: cli not in --all (got: $TF9_OUT)"; fi
rm -rf "$TF9"

# ─── T-FLAGS-10: --all with ~/.claude present → plugin-cc also delegated ─────
echo ""
echo "=== T-FLAGS-10: --all + ~/.claude present → plugin-cc also delegated ==="
TF10=$(mktemp -d)
make_stubs "$TF10/bin"
mkdir -p "$TF10/fakehome/.claude"
TF10_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF10/repo" \
  env PATH="$TF10/bin:/usr/bin:/bin" HOME="$TF10/fakehome" bash "$INSTALLER" --all 2>&1) && TF10_EXIT=0 || TF10_EXIT=$?
if [ "$TF10_EXIT" -eq 0 ]; then pass "T-FLAGS-10: exit 0"; else fail "T-FLAGS-10: exit $TF10_EXIT (out: $TF10_OUT)"; fi
if echo "$TF10_OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T-FLAGS-10: plugin-cc in --all when ~/.claude exists"; else fail "T-FLAGS-10: plugin-cc not delegated (got: $TF10_OUT)"; fi
rm -rf "$TF10"

# ─── T-FLAGS-11: --yes propagates to passthrough args ────────────────────────
echo ""
echo "=== T-FLAGS-11: --yes propagates to delegation line ==="
TF11=$(mktemp -d)
make_stubs "$TF11/bin"
TF11_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF11/repo" \
  env PATH="$TF11/bin:/usr/bin:/bin" bash "$INSTALLER" --server --yes 2>&1) && TF11_EXIT=0 || TF11_EXIT=$?
if [ "$TF11_EXIT" -eq 0 ]; then pass "T-FLAGS-11: exit 0"; else fail "T-FLAGS-11: exit $TF11_EXIT (out: $TF11_OUT)"; fi
if echo "$TF11_OUT" | grep -q "delegate: server/install.sh.*--yes"; then pass "T-FLAGS-11: --yes in delegation args"; else fail "T-FLAGS-11: --yes not propagated (got: $TF11_OUT)"; fi
rm -rf "$TF11"

# ─── T-FLAGS-12: --server-url propagates to delegation ───────────────────────
echo ""
echo "=== T-FLAGS-12: --server-url propagates to delegation ==="
TF12=$(mktemp -d)
make_stubs "$TF12/bin"
TF12_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF12/repo" \
  env PATH="$TF12/bin:/usr/bin:/bin" bash "$INSTALLER" --cli --server-url http://pi:6335 2>&1) && TF12_EXIT=0 || TF12_EXIT=$?
if [ "$TF12_EXIT" -eq 0 ]; then pass "T-FLAGS-12: exit 0"; else fail "T-FLAGS-12: exit $TF12_EXIT (out: $TF12_OUT)"; fi
if echo "$TF12_OUT" | grep -q "delegate: installer/install-cli.sh.*--server-url"; then pass "T-FLAGS-12: --server-url in delegation args"; else fail "T-FLAGS-12: --server-url not propagated (got: $TF12_OUT)"; fi
rm -rf "$TF12"

# ─── T-FLAGS-13: --skip-docker propagates to delegation args ─────────────────
echo ""
echo "=== T-FLAGS-13: --skip-docker propagates to delegation ==="
TF13=$(mktemp -d)
make_stubs "$TF13/bin"
TF13_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF13/repo" \
  env PATH="$TF13/bin:/usr/bin:/bin" bash "$INSTALLER" --server --skip-docker 2>&1) && TF13_EXIT=0 || TF13_EXIT=$?
if [ "$TF13_EXIT" -eq 0 ]; then pass "T-FLAGS-13: exit 0 with --skip-docker"; else fail "T-FLAGS-13: exit $TF13_EXIT (out: $TF13_OUT)"; fi
if echo "$TF13_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-13: server still delegated with --skip-docker"; else fail "T-FLAGS-13: server not delegated (got: $TF13_OUT)"; fi
if echo "$TF13_OUT" | grep -qE "delegate: server/install.sh.*--skip-docker|--skip-docker.*delegate: server/install.sh"; then pass "T-FLAGS-13: --skip-docker propagates in delegation args"; else fail "T-FLAGS-13: --skip-docker not in delegation args (got: $TF13_OUT)"; fi
rm -rf "$TF13"

# ─── T-FLAGS-14: --no-path propagates to delegation args ─────────────────────
echo ""
echo "=== T-FLAGS-14: --no-path propagates to delegation ==="
TF14=$(mktemp -d)
make_stubs "$TF14/bin"
TF14_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF14/repo" \
  env PATH="$TF14/bin:/usr/bin:/bin" bash "$INSTALLER" --cli --no-path 2>&1) && TF14_EXIT=0 || TF14_EXIT=$?
if [ "$TF14_EXIT" -eq 0 ]; then pass "T-FLAGS-14: exit 0 with --no-path"; else fail "T-FLAGS-14: exit $TF14_EXIT (out: $TF14_OUT)"; fi
if echo "$TF14_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-14: cli still delegated with --no-path"; else fail "T-FLAGS-14: cli not delegated (got: $TF14_OUT)"; fi
if echo "$TF14_OUT" | grep -qE "delegate: installer/install-cli.sh.*--no-path|--no-path.*delegate: installer/install-cli.sh"; then pass "T-FLAGS-14: --no-path propagates in delegation args"; else fail "T-FLAGS-14: --no-path not in delegation args (got: $TF14_OUT)"; fi
rm -rf "$TF14"

# ─── T-FLAGS-15: --interactive launches wizard (header + detect env) ─────────
echo ""
echo "=== T-FLAGS-15: --interactive (real wizard) prints header and detected env ==="
TF15=$(mktemp -d)
make_stubs "$TF15/bin"
TF15_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF15/repo" \
  env PATH="$TF15/bin:/usr/bin:/bin" bash "$INSTALLER" --interactive 2>&1) && TF15_EXIT=0 || TF15_EXIT=$?
# Real wizard must print the installer header and detected environment
if echo "$TF15_OUT" | grep -qiE "universal-memory|installer|Detected"; then pass "T-FLAGS-15: wizard header/detect printed"; else fail "T-FLAGS-15: expected wizard header (got: $TF15_OUT)"; fi
rm -rf "$TF15"

# ─── T-PCC-1: --plugin-cc copies prompt files to plugin-local prompts dir ─────
echo ""
echo "=== T-PCC-1: install-plugin-cc.sh copies prompts to \$PLUGIN_DIR/hooks/lib/prompts/ ==="
TPCC1=$(mktemp -d)
# Set up a fake plugin source with the required structure
mkdir -p "$TPCC1/repo/plugins/claude-code/universal-memory/.claude-plugin"
cat > "$TPCC1/repo/plugins/claude-code/universal-memory/.claude-plugin/plugin.json" <<'JSON'
{"name":"universal-memory","version":"0.5.0"}
JSON
mkdir -p "$TPCC1/repo/plugins/claude-code/universal-memory/hooks/lib"
# Create canonical prompts in expected server/config/prompts/ location
mkdir -p "$TPCC1/repo/server/config/prompts"
echo "summarize prompt" > "$TPCC1/repo/server/config/prompts/summarize.txt"
echo "update-state prompt" > "$TPCC1/repo/server/config/prompts/update-state.txt"

TPCC1_HOME="$TPCC1/home"
mkdir -p "$TPCC1_HOME/.claude/plugins"
# Pre-create .bashrc so the rc-writer finds it (rc writer skips non-existent files)
touch "$TPCC1_HOME/.bashrc"
TPCC1_OUT=$(
  _UM_REPO_ROOT="$TPCC1/repo" \
  CLAUDE_PLUGINS_DIR="$TPCC1_HOME/.claude/plugins" \
  HOME="$TPCC1_HOME" \
  UM_NONINTERACTIVE=1 \
  bash "$SCRIPT_DIR/install-plugin-cc.sh" --yes 2>&1
) && TPCC1_EXIT=0 || TPCC1_EXIT=$?

TPCC1_PLUGIN_DIR="$TPCC1_HOME/.claude/plugins/universal-memory"
if [ -f "$TPCC1_PLUGIN_DIR/hooks/lib/prompts/summarize.txt" ]; then
  pass "T-PCC-1: summarize.txt copied to plugin prompts dir"
else
  fail "T-PCC-1: summarize.txt not found at $TPCC1_PLUGIN_DIR/hooks/lib/prompts/summarize.txt (out: $TPCC1_OUT)"
fi

# ─── T-PCC-2: --plugin-cc writes UM_PROMPT_DIR to .bashrc ────────────────────
echo ""
echo "=== T-PCC-2: install-plugin-cc.sh writes UM_PROMPT_DIR= to shell rc ==="
# Re-use the same run from T-PCC-1 (same temp dir)
TPCC1_BASHRC="$TPCC1_HOME/.bashrc"
if grep -q "UM_PROMPT_DIR" "$TPCC1_BASHRC" 2>/dev/null; then
  pass "T-PCC-2: UM_PROMPT_DIR present in .bashrc"
else
  fail "T-PCC-2: UM_PROMPT_DIR not found in $TPCC1_BASHRC (out: $TPCC1_OUT)"
fi

# ─── T-PCC-3: UM_PROMPT_DIR value points to plugin-local prompts dir ─────────
echo ""
echo "=== T-PCC-3: UM_PROMPT_DIR value in .bashrc points to plugin-local prompts dir ==="
if grep -q "UM_PROMPT_DIR=.*plugins/universal-memory/hooks/lib/prompts" "$TPCC1_BASHRC" 2>/dev/null; then
  pass "T-PCC-3: UM_PROMPT_DIR points to plugin-local prompts path"
else
  fail "T-PCC-3: UM_PROMPT_DIR path incorrect in $TPCC1_BASHRC"
fi
rm -rf "$TPCC1"

# ─── T-FLAGS-16: --server alone with ~/.claude present → plugin-cc NOT triggered
echo ""
echo "=== T-FLAGS-16: --server with ~/.claude present → plugin-cc NOT delegated ==="
TF16=$(mktemp -d)
make_stubs "$TF16/bin"
mkdir -p "$TF16/fakehome/.claude"
TF16_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF16/repo" \
  env PATH="$TF16/bin:/usr/bin:/bin" HOME="$TF16/fakehome" bash "$INSTALLER" --server 2>&1) && TF16_EXIT=0 || TF16_EXIT=$?
if [ "$TF16_EXIT" -eq 0 ]; then pass "T-FLAGS-16: exit 0"; else fail "T-FLAGS-16: exit $TF16_EXIT (out: $TF16_OUT)"; fi
if ! echo "$TF16_OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T-FLAGS-16: plugin-cc NOT triggered by --server alone"; else fail "T-FLAGS-16: plugin-cc incorrectly triggered (got: $TF16_OUT)"; fi
rm -rf "$TF16"

# ─── T-FLAGS-17: --yes alone (no other flags, non-TTY) = --all back-compat ───
echo ""
echo "=== T-FLAGS-17: --yes alone (non-TTY) → treated as --all ==="
TF17=$(mktemp -d)
make_stubs "$TF17/bin"
# Use a fake HOME with no .claude or .codex so plugins are skipped
TF17_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF17/repo" \
  env PATH="$TF17/bin:/usr/bin:/bin" HOME="$TF17/fakehome" bash "$INSTALLER" --yes 2>&1 </dev/null) && TF17_EXIT=0 || TF17_EXIT=$?
if [ "$TF17_EXIT" -eq 0 ]; then pass "T-FLAGS-17: exit 0"; else fail "T-FLAGS-17: exit $TF17_EXIT (out: $TF17_OUT)"; fi
if echo "$TF17_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-17: --yes alone triggers server (--all back-compat)"; else fail "T-FLAGS-17: server not triggered (got: $TF17_OUT)"; fi
if echo "$TF17_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-17: --yes alone triggers cli (--all back-compat)"; else fail "T-FLAGS-17: cli not triggered (got: $TF17_OUT)"; fi
rm -rf "$TF17"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
