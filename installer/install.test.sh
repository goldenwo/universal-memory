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
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"

# shellcheck source=installer/lib/test-harness.sh
source "$REPO_ROOT/installer/lib/test-harness.sh"

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
_tx_capture TF8 env UM_DRY_RUN=1 UM_INSTALL_DIR="$TF8/repo" \
  PATH="$TF8/bin:/usr/bin:/bin" bash "$INSTALLER" --server --cli
if echo "$TX_OUT_TF8" | grep -q "delegate:"; then pass "T-FLAGS-8: 'delegate:' present in dry-run"; else fail "T-FLAGS-8: 'delegate:' not found (got: $TX_OUT_TF8)"; fi
if ! echo "$TX_OUT_TF8" | grep -q "running:"; then pass "T-FLAGS-8: 'running:' absent in dry-run"; else fail "T-FLAGS-8: 'running:' leaked in dry-run"; fi
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

# ─── T-FLAGS-10: --all with a claude CLI → plugin-cc also delegated ──────────
echo ""
echo "=== T-FLAGS-10: --all + claude CLI → plugin-cc also delegated ==="
TF10=$(mktemp -d)
make_stubs "$TF10/bin"
printf '#!/bin/sh\nexit 0\n' > "$TF10/bin/claude"; chmod +x "$TF10/bin/claude"
TF10_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF10/repo" \
  env PATH="$TF10/bin:/usr/bin:/bin" HOME="$TF10/fakehome" bash "$INSTALLER" --all 2>&1) && TF10_EXIT=0 || TF10_EXIT=$?
if [ "$TF10_EXIT" -eq 0 ]; then pass "T-FLAGS-10: exit 0"; else fail "T-FLAGS-10: exit $TF10_EXIT (out: $TF10_OUT)"; fi
if echo "$TF10_OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T-FLAGS-10: plugin-cc in --all when the claude CLI exists"; else fail "T-FLAGS-10: plugin-cc not delegated (got: $TF10_OUT)"; fi
rm -rf "$TF10"

# ─── T-FLAGS-11: --yes propagates to passthrough args ────────────────────────
# v0.7 contract: --yes + server in scope refuses on missing API key, so we set
# a fake OPENAI_API_KEY so this delegation-propagation test stays green.
echo ""
echo "=== T-FLAGS-11: --yes propagates to delegation line ==="
TF11=$(mktemp -d)
make_stubs "$TF11/bin"
TF11_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF11/repo" \
  env PATH="$TF11/bin:/usr/bin:/bin" OPENAI_API_KEY=sk-fake-test-key bash "$INSTALLER" --server --yes 2>&1) && TF11_EXIT=0 || TF11_EXIT=$?
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

# ─── T-FLAGS-13: --skip-docker goes to SERVER delegate ONLY (not CLI) ────────
echo ""
echo "=== T-FLAGS-13: --skip-docker → server/install.sh only; NOT to install-cli.sh ==="
TF13=$(mktemp -d)
make_stubs "$TF13/bin"
TF13_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF13/repo" \
  env PATH="$TF13/bin:/usr/bin:/bin" bash "$INSTALLER" --server --cli --skip-docker 2>&1) && TF13_EXIT=0 || TF13_EXIT=$?
if [ "$TF13_EXIT" -eq 0 ]; then pass "T-FLAGS-13: exit 0 with --skip-docker"; else fail "T-FLAGS-13: exit $TF13_EXIT (out: $TF13_OUT)"; fi
if echo "$TF13_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-13: server still delegated with --skip-docker"; else fail "T-FLAGS-13: server not delegated (got: $TF13_OUT)"; fi
# --skip-docker must appear in the server delegation line
if echo "$TF13_OUT" | grep "delegate: server/install.sh" | grep -q "\-\-skip-docker"; then pass "T-FLAGS-13: --skip-docker in server delegation args"; else fail "T-FLAGS-13: --skip-docker not in server delegation args (got: $TF13_OUT)"; fi
# --skip-docker must NOT appear in the CLI delegation line
if ! echo "$TF13_OUT" | grep "delegate: installer/install-cli.sh" | grep -q "\-\-skip-docker"; then pass "T-FLAGS-13: --skip-docker NOT in cli delegation args"; else fail "T-FLAGS-13: --skip-docker leaked to cli delegation (got: $TF13_OUT)"; fi
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

# ─── T-FLAGS-13B: --cli --skip-docker succeeds (BUG-3 regression guard) ──────
echo ""
echo "=== T-FLAGS-13B: --cli --skip-docker should succeed (--skip-docker must NOT reach install-cli.sh) ==="
TF13B=$(mktemp -d)
make_stubs "$TF13B/bin"
TF13B_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF13B/repo" \
  env PATH="$TF13B/bin:/usr/bin:/bin" bash "$INSTALLER" --cli --skip-docker 2>&1) && TF13B_EXIT=0 || TF13B_EXIT=$?
if [ "$TF13B_EXIT" -eq 0 ]; then pass "T-FLAGS-13B: --cli --skip-docker exits 0 (no crash)"; else fail "T-FLAGS-13B: exit $TF13B_EXIT — --skip-docker reached install-cli.sh (out: $TF13B_OUT)"; fi
if echo "$TF13B_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-13B: cli still delegated"; else fail "T-FLAGS-13B: cli not delegated (got: $TF13B_OUT)"; fi
if ! echo "$TF13B_OUT" | grep "delegate: installer/install-cli.sh" | grep -q "\-\-skip-docker"; then pass "T-FLAGS-13B: --skip-docker filtered from cli delegation"; else fail "T-FLAGS-13B: --skip-docker leaked to cli (got: $TF13B_OUT)"; fi
rm -rf "$TF13B"

# ─── T-FLAGS-18: --dry-run propagates to delegation line ─────────────────────
echo ""
echo "=== T-FLAGS-18: --dry-run propagates in delegation args ==="
TF18=$(mktemp -d)
make_stubs "$TF18/bin"
TF18_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF18/repo" \
  env PATH="$TF18/bin:/usr/bin:/bin" bash "$INSTALLER" --server --cli --dry-run 2>&1) && TF18_EXIT=0 || TF18_EXIT=$?
if [ "$TF18_EXIT" -eq 0 ]; then pass "T-FLAGS-18: exit 0"; else fail "T-FLAGS-18: exit $TF18_EXIT (out: $TF18_OUT)"; fi
# Both server and cli delegation lines should include --dry-run
if echo "$TF18_OUT" | grep "delegate: server/install.sh" | grep -q "\-\-dry-run"; then pass "T-FLAGS-18: --dry-run in server delegation"; else fail "T-FLAGS-18: --dry-run not in server delegation (got: $TF18_OUT)"; fi
if echo "$TF18_OUT" | grep "delegate: installer/install-cli.sh" | grep -q "\-\-dry-run"; then pass "T-FLAGS-18: --dry-run in cli delegation"; else fail "T-FLAGS-18: --dry-run not in cli delegation (got: $TF18_OUT)"; fi
rm -rf "$TF18"

# ─── T-FLAGS-15: --interactive launches wizard (header + detect env) ─────────
echo ""
echo "=== T-FLAGS-15: --interactive (real wizard) prints header and detected env ==="
TF15=$(mktemp -d)
make_stubs "$TF15/bin"
_tx_capture TF15 env UM_DRY_RUN=1 UM_INSTALL_DIR="$TF15/repo" \
  PATH="$TF15/bin:/usr/bin:/bin" bash "$INSTALLER" --interactive
# Real wizard must print the installer header and detected environment
if echo "$TX_OUT_TF15" | grep -qiE "universal-memory|installer|Detected"; then pass "T-FLAGS-15: wizard header/detect printed"; else fail "T-FLAGS-15: expected wizard header (got: $TX_OUT_TF15)"; fi
rm -rf "$TF15"

# (T-PCC-1..3 retired 2026-10-14: they pinned the old copy route, which put
# prompts in ~/.claude/plugins/universal-memory and UM_PROMPT_DIR in the shell rc.
# Claude Code never loads that copy; install-plugin-cc.test.sh P1 now pins that
# neither is written.)

# ─── T-FLAGS-16: --server alone with a claude CLI → plugin-cc NOT triggered
echo ""
echo "=== T-FLAGS-16: --server with a claude CLI → plugin-cc NOT delegated ==="
TF16=$(mktemp -d)
make_stubs "$TF16/bin"
printf '#!/bin/sh\nexit 0\n' > "$TF16/bin/claude"; chmod +x "$TF16/bin/claude"
TF16_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF16/repo" \
  env PATH="$TF16/bin:/usr/bin:/bin" HOME="$TF16/fakehome" bash "$INSTALLER" --server 2>&1) && TF16_EXIT=0 || TF16_EXIT=$?
if [ "$TF16_EXIT" -eq 0 ]; then pass "T-FLAGS-16: exit 0"; else fail "T-FLAGS-16: exit $TF16_EXIT (out: $TF16_OUT)"; fi
if ! echo "$TF16_OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T-FLAGS-16: plugin-cc NOT triggered by --server alone"; else fail "T-FLAGS-16: plugin-cc incorrectly triggered (got: $TF16_OUT)"; fi
rm -rf "$TF16"

# ─── T-FLAGS-17: --yes alone (no other flags, non-TTY) = --all back-compat ───
# v0.7 contract: --yes + server in scope (--all back-compat puts it in scope)
# refuses on missing API key, so we set a fake OPENAI_API_KEY here.
echo ""
echo "=== T-FLAGS-17: --yes alone (non-TTY) → treated as --all ==="
TF17=$(mktemp -d)
make_stubs "$TF17/bin"
# Use a fake HOME with no .claude or .codex so plugins are skipped
TF17_OUT=$(UM_DRY_RUN=1 UM_INSTALL_DIR="$TF17/repo" \
  env PATH="$TF17/bin:/usr/bin:/bin" HOME="$TF17/fakehome" OPENAI_API_KEY=sk-fake-test-key bash "$INSTALLER" --yes 2>&1 </dev/null) && TF17_EXIT=0 || TF17_EXIT=$?
if [ "$TF17_EXIT" -eq 0 ]; then pass "T-FLAGS-17: exit 0"; else fail "T-FLAGS-17: exit $TF17_EXIT (out: $TF17_OUT)"; fi
if echo "$TF17_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-17: --yes alone triggers server (--all back-compat)"; else fail "T-FLAGS-17: server not triggered (got: $TF17_OUT)"; fi
if echo "$TF17_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-17: --yes alone triggers cli (--all back-compat)"; else fail "T-FLAGS-17: cli not triggered (got: $TF17_OUT)"; fi
rm -rf "$TF17"

# ─── T-FLAGS-19 (v0.7 G2.3): --yes + --server WITHOUT API key → exit 1 ───────
echo ""
echo "=== T-FLAGS-19: --yes --server WITHOUT API key → refuses with exit 1 (v0.7 contract) ==="
TF19=$(mktemp -d)
make_stubs "$TF19/bin"
# env -i strips OPENAI_API_KEY (and all other inherited vars) so we get a
# deterministic missing-key state regardless of the runner's shell env.
TF19_OUT=$(env -i PATH="$TF19/bin:/usr/bin:/bin" HOME="$TF19/fakehome" \
  UM_DRY_RUN=1 UM_INSTALL_DIR="$TF19/repo" \
  bash "$INSTALLER" --server --yes 2>&1) && TF19_EXIT=0 || TF19_EXIT=$?
if [ "$TF19_EXIT" -ne 0 ]; then pass "T-FLAGS-19: non-zero exit (refuses on missing key)"; else fail "T-FLAGS-19: expected non-zero exit, got 0 (out: $TF19_OUT)"; fi
if echo "$TF19_OUT" | grep -qi "OPENAI_API_KEY"; then pass "T-FLAGS-19: error names the missing var"; else fail "T-FLAGS-19: error didn't name OPENAI_API_KEY (got: $TF19_OUT)"; fi
if echo "$TF19_OUT" | grep -q "provider-prefixed"; then pass "T-FLAGS-19: error explains the provider-prefixed key contract"; else fail "T-FLAGS-19: error didn't explain the key contract (got: $TF19_OUT)"; fi
rm -rf "$TF19"

# ─── T-FLAGS-20 (v0.7 G2.3): --yes + --cli alone (no server) does NOT require key ─
echo ""
echo "=== T-FLAGS-20: --yes --cli alone (no server) does NOT trigger key guard ==="
TF20=$(mktemp -d)
make_stubs "$TF20/bin"
TF20_OUT=$(env -i PATH="$TF20/bin:/usr/bin:/bin" HOME="$TF20/fakehome" \
  UM_DRY_RUN=1 UM_INSTALL_DIR="$TF20/repo" \
  bash "$INSTALLER" --cli --yes 2>&1) && TF20_EXIT=0 || TF20_EXIT=$?
if [ "$TF20_EXIT" -eq 0 ]; then pass "T-FLAGS-20: --cli --yes exits 0 with no key (CLI doesn't need key)"; else fail "T-FLAGS-20: exit $TF20_EXIT (out: $TF20_OUT)"; fi
if echo "$TF20_OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T-FLAGS-20: cli still delegated"; else fail "T-FLAGS-20: cli not delegated (got: $TF20_OUT)"; fi
rm -rf "$TF20"

# ─── T-FLAGS-21 (v0.7 G2.3): --yes + --server with UM_OPENAI_API_KEY also accepted ─
echo ""
echo "=== T-FLAGS-21: --yes + --server accepts UM_OPENAI_API_KEY (alt env var) ==="
TF21=$(mktemp -d)
make_stubs "$TF21/bin"
TF21_OUT=$(env -i PATH="$TF21/bin:/usr/bin:/bin" HOME="$TF21/fakehome" \
  UM_DRY_RUN=1 UM_INSTALL_DIR="$TF21/repo" UM_OPENAI_API_KEY=sk-fake-um-prefix \
  bash "$INSTALLER" --server --yes 2>&1) && TF21_EXIT=0 || TF21_EXIT=$?
if [ "$TF21_EXIT" -eq 0 ]; then pass "T-FLAGS-21: exit 0 with UM_OPENAI_API_KEY"; else fail "T-FLAGS-21: exit $TF21_EXIT (out: $TF21_OUT)"; fi
if echo "$TF21_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-21: server delegated when alt key var set"; else fail "T-FLAGS-21: server not delegated (got: $TF21_OUT)"; fi
rm -rf "$TF21"

# ─── T-FLAGS-22 (v0.7 G2.3): --yes + Ollama provider does NOT require API key ─
echo ""
echo "=== T-FLAGS-22: --yes + UM_*_PROVIDER=ollama does NOT require API key ==="
TF22=$(mktemp -d)
make_stubs "$TF22/bin"
TF22_OUT=$(env -i PATH="$TF22/bin:/usr/bin:/bin" HOME="$TF22/fakehome" \
  UM_DRY_RUN=1 UM_INSTALL_DIR="$TF22/repo" \
  UM_EMBEDDING_PROVIDER=ollama UM_SUMMARIZER_PROVIDER=ollama UM_FACTS_PROVIDER=ollama \
  bash "$INSTALLER" --server --yes 2>&1) && TF22_EXIT=0 || TF22_EXIT=$?
if [ "$TF22_EXIT" -eq 0 ]; then pass "T-FLAGS-22: ollama path skips key guard"; else fail "T-FLAGS-22: exit $TF22_EXIT (out: $TF22_OUT)"; fi
if echo "$TF22_OUT" | grep -q "delegate: server/install.sh"; then pass "T-FLAGS-22: server delegated under ollama config"; else fail "T-FLAGS-22: server not delegated (got: $TF22_OUT)"; fi
rm -rf "$TF22"

# ─── T-WIZ-PREREQ: the wizard stops at a missing prerequisite before asking more ──
# The 2026-10-14 clean-room install: the wizard printed "✗ python3 not found",
# then asked for the component, the vault, the provider and "Proceed?", and only
# then failed. It also never checked PyYAML for a server install, which
# server/install.sh then refuses. Here python3 exists but cannot import yaml.
echo ""
echo "=== T-WIZ-PREREQ: wizard fails fast on missing PyYAML ==="
TWP=$(mktemp -d)
make_stubs "$TWP/bin"
printf '#!/usr/bin/env bash\n[[ "$*" == *"import yaml"* ]] && exit 1\nexit 0\n' > "$TWP/bin/python3"
chmod +x "$TWP/bin/python3"
TWP_OUT=$(printf '1\n\n\n\n\n\n' | env PATH="$TWP/bin:/usr/bin:/bin" HOME="$TWP" \
  UM_INSTALL_DIR="$TWP/repo" bash "$INSTALLER" --interactive 2>&1) && TWP_EXIT=0 || TWP_EXIT=$?
if [ "$TWP_EXIT" -ne 0 ]; then pass "T-WIZ-PREREQ: non-zero exit"; else fail "T-WIZ-PREREQ: expected non-zero exit"; fi
if echo "$TWP_OUT" | grep -q "required tools not found.*PyYAML"; then pass "T-WIZ-PREREQ: names PyYAML"; else fail "T-WIZ-PREREQ: PyYAML not named (got: $TWP_OUT)"; fi
# `read -p` prompts are silent without a TTY; the provider menu is echoed, so it marks "asked more".
if echo "$TWP_OUT" | grep -q "Provider setup"; then fail "T-WIZ-PREREQ: kept asking before failing"; else pass "T-WIZ-PREREQ: fails before the next prompt"; fi
if echo "$TWP_OUT" | grep -q "PyYAML: .*apt install python3-yaml"; then pass "T-WIZ-PREREQ: apt hint shown"; else fail "T-WIZ-PREREQ: no apt hint"; fi
if echo "$TWP_OUT" | grep -q "v0\.5\.0"; then fail "T-WIZ-PREREQ: stale v0.5.0 banner"; else pass "T-WIZ-PREREQ: banner not pinned to v0.5.0"; fi
rm -rf "$TWP"

# ─── T-WIZ-CAPTURE: a server install turns capture on ────────────────────────
# Operator rulings 2026-10-14: a fresh install that cannot capture is not what a
# user asked for (the clean-room install got 403 on its first capture and needed
# a .env edit + restart). Server installs, wizard and --yes / flag alike, hand
# server/install.sh UM_MCP_WRITE_ENABLED=true + UM_MOUNT_MODE=rw. Stub
# server/install.sh and install-cli.sh report what they got.
_capture_repo() {
  local repo="$1"
  mkdir -p "$repo/server" "$repo/installer" "$repo/.git"
  # shellcheck disable=SC2016  # the stub expands these when it runs, not here
  printf '#!/usr/bin/env bash\necho "CAPTURE writes=${UM_MCP_WRITE_ENABLED:-unset} mount=${UM_MOUNT_MODE:-unset}"\n' | tee "$repo/server/install.sh" > "$repo/installer/install-cli.sh"
}
echo ""
echo "=== T-WIZ-CAPTURE: wizard server install passes writes on ==="
TWC=$(mktemp -d)
make_stubs "$TWC/bin"; _capture_repo "$TWC/repo"
TWC_OUT=$(printf '4\n\n4\nY\n' | env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --interactive 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=true mount=rw"; then pass "T-WIZ-CAPTURE: server/install.sh gets writes on + rw"; else fail "T-WIZ-CAPTURE: capture not on (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
if echo "$TWC_OUT" | grep -q "Capture: on"; then pass "T-WIZ-CAPTURE: summary says capture is on"; else fail "T-WIZ-CAPTURE: summary silent about capture"; fi
# An explicit export still wins (an operator who wants a read-only server).
TWC_OUT=$(printf '4\n\n4\nY\n' | env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" UM_MCP_WRITE_ENABLED=false UM_MOUNT_MODE=ro \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --interactive 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=false mount=ro"; then pass "T-WIZ-CAPTURE: an explicit export wins"; else fail "T-WIZ-CAPTURE: explicit export overridden (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
# --yes / flag installs turn capture on too (operator ruling 2026-10-14, so an
# AI agent driving the non-interactive path gets a server that accepts
# captures); an explicit export still wins there as well. The --cli-only
# control installs no server, so nothing is exported.
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" OPENAI_API_KEY=sk-test \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --server --yes 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=true mount=rw"; then pass "T-WIZ-CAPTURE: --yes server install turns capture on"; else fail "T-WIZ-CAPTURE: --yes capture not on (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" OPENAI_API_KEY=sk-test UM_MCP_WRITE_ENABLED=false UM_MOUNT_MODE=ro \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --server --yes 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=false mount=ro"; then pass "T-WIZ-CAPTURE: --yes honours an explicit export"; else fail "T-WIZ-CAPTURE: --yes overrode the export (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --cli --yes 2>&1) || true
if [ "$(echo "$TWC_OUT" | grep -c "CAPTURE")" = 1 ] && echo "$TWC_OUT" | grep -q "CAPTURE writes=unset mount=unset"; then pass "T-WIZ-CAPTURE: --cli-only exports nothing"; else fail "T-WIZ-CAPTURE: --cli got capture vars (got: $(echo "$TWC_OUT" | grep CAPTURE | tr '\n' ' '))"; fi
# Exporting only the writes switch off must not get a rw mount, which
# server/install.sh refuses ("UM_MOUNT_MODE=rw requires UM_MCP_WRITE_ENABLED=true").
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" OPENAI_API_KEY=sk-test UM_MCP_WRITE_ENABLED=false \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --server --yes 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=false mount=ro"; then pass "T-WIZ-CAPTURE: writes=false alone gets a ro mount"; else fail "T-WIZ-CAPTURE: writes=false alone (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
# A re-run over an existing server/.env exports nothing, so server/install.sh
# keeps the switches written there (operator ruling 2026-10-15: a read-only
# choice survives a re-run).
printf 'UM_MCP_WRITE_ENABLED=false\nUM_MOUNT_MODE=ro\n' > "$TWC/repo/server/.env"
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" OPENAI_API_KEY=sk-test \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --server --yes 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=unset mount=unset"; then pass "T-WIZ-CAPTURE: --yes re-run keeps server/.env's switches"; else fail "T-WIZ-CAPTURE: --yes re-run exported (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
TWC_OUT=$(printf '4\n\n4\nY\n' | env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --interactive 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=unset mount=unset" && echo "$TWC_OUT" | grep -q "Capture: as set in the existing server/.env"; then pass "T-WIZ-CAPTURE: wizard re-run keeps server/.env's switches and says so"; else fail "T-WIZ-CAPTURE: wizard re-run (got: $(echo "$TWC_OUT" | grep -i capture | tr '\n' ' '))"; fi
# An export on a re-run still moves both switches: the mount must not come from
# .env, or writes=true lands on a ro mount (every capture fails) and
# writes=false on a rw one (server/install.sh refuses).
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" OPENAI_API_KEY=sk-test UM_MCP_WRITE_ENABLED=true \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --server --yes 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=true mount=rw"; then pass "T-WIZ-CAPTURE: re-run exporting writes=true gets rw"; else fail "T-WIZ-CAPTURE: re-run writes=true (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
printf 'UM_MCP_WRITE_ENABLED=true\nUM_MOUNT_MODE=rw\n' > "$TWC/repo/server/.env"
TWC_OUT=$(env PATH="$TWC/bin:/usr/bin:/bin" HOME="$TWC" OPENAI_API_KEY=sk-test UM_MCP_WRITE_ENABLED=false \
  UM_INSTALL_DIR="$TWC/repo" bash "$INSTALLER" --server --yes 2>&1) || true
if echo "$TWC_OUT" | grep -q "CAPTURE writes=false mount=ro"; then pass "T-WIZ-CAPTURE: re-run exporting writes=false gets ro"; else fail "T-WIZ-CAPTURE: re-run writes=false (got: $(echo "$TWC_OUT" | grep CAPTURE))"; fi
rm -f "$TWC/repo/server/.env"
rm -rf "$TWC"
# ─── T-SUMMARIZER: both installers are handed one UM_SUMMARIZER ──────────────
# server/install.sh announced "defaulting UM_SUMMARIZER=claude-agent-sdk" when a
# claude CLI was present, then install-cli.sh rewrote the same rc block from the
# environment with openai (the 2026-10-14 clean-room install ended up on openai).
# The dispatcher now picks the value once and exports it to every delegate.
_summarizer_repo() {
  local repo="$1"
  mkdir -p "$repo/server" "$repo/installer" "$repo/.git"
  # shellcheck disable=SC2016  # the stubs expand this when they run, not here
  printf '#!/usr/bin/env bash\necho "SUMMARIZER ${UM_SUMMARIZER:-unset}"\n' | tee "$repo/server/install.sh" > "$repo/installer/install-cli.sh"
}
echo ""
echo "=== T-SUMMARIZER: one UM_SUMMARIZER for server + CLI ==="
TSU=$(mktemp -d)
make_stubs "$TSU/bin"; _summarizer_repo "$TSU/repo"
TSU_OUT=$(env PATH="$TSU/bin:/usr/bin:/bin" HOME="$TSU" OPENAI_API_KEY=sk-test UM_INSTALL_DIR="$TSU/repo" \
  bash "$INSTALLER" --server --cli --yes 2>&1) || true
if [ "$(echo "$TSU_OUT" | grep -c "SUMMARIZER openai")" = 2 ]; then pass "T-SUMMARIZER: no claude CLI -> openai for both"; else fail "T-SUMMARIZER: got $(echo "$TSU_OUT" | grep SUMMARIZER | tr '\n' ' ')"; fi
printf '#!/bin/sh\nexit 0\n' > "$TSU/bin/claude"; chmod +x "$TSU/bin/claude"
TSU_OUT=$(env PATH="$TSU/bin:/usr/bin:/bin" HOME="$TSU" OPENAI_API_KEY=sk-test UM_INSTALL_DIR="$TSU/repo" \
  bash "$INSTALLER" --server --cli --yes 2>&1) || true
if [ "$(echo "$TSU_OUT" | grep -c "SUMMARIZER claude-agent-sdk")" = 2 ]; then pass "T-SUMMARIZER: claude CLI -> claude-agent-sdk for both"; else fail "T-SUMMARIZER: got $(echo "$TSU_OUT" | grep SUMMARIZER | tr '\n' ' ')"; fi
TSU_OUT=$(env PATH="$TSU/bin:/usr/bin:/bin" HOME="$TSU" OPENAI_API_KEY=sk-test UM_SUMMARIZER=openai UM_INSTALL_DIR="$TSU/repo" \
  bash "$INSTALLER" --server --cli --yes 2>&1) || true
if [ "$(echo "$TSU_OUT" | grep -c "SUMMARIZER openai")" = 2 ]; then pass "T-SUMMARIZER: an explicit export wins"; else fail "T-SUMMARIZER: got $(echo "$TSU_OUT" | grep SUMMARIZER | tr '\n' ' ')"; fi
rm -rf "$TSU"

# ─── T-SELF-CLONE: run from a clone, the installer uses that clone ───────────
# INSTALL_DIR defaulted to ~/universal-memory, so `git clone ... /some/dir;
# bash installer/install.sh` cloned (or pulled) a second copy there and ran its
# sub-installers instead of the clone's own (2026-10-14 agent-install test).
# curl | bash has no clone of its own and keeps the ~/universal-memory default.
echo ""
echo "=== T-SELF-CLONE: a clone outside ~/universal-memory installs from itself ==="
TSC=$(mktemp -d)
make_stubs "$TSC/bin"
# shellcheck disable=SC2016  # the stub expands $* when it runs, not here
printf '#!/bin/bash\necho "git $*" >> "%s/git.log"\n' "$TSC" > "$TSC/bin/git"
mkdir -p "$TSC/clone/installer" "$TSC/clone/server" "$TSC/clone/.git" "$TSC/home"
cp "$INSTALLER" "$TSC/clone/installer/install.sh"
# shellcheck disable=SC2016  # the stub expands $0 when it runs, not here
printf '#!/usr/bin/env bash\necho "SERVER-FROM $(cd "$(dirname "$0")/.." && pwd)"\n' > "$TSC/clone/server/install.sh"
TSC_OUT=$(cd "$TSC" && env -u UM_INSTALL_DIR PATH="$TSC/bin:/usr/bin:/bin" HOME="$TSC/home" OPENAI_API_KEY=sk-test \
  bash "$TSC/clone/installer/install.sh" --server --yes 2>&1) || true
if echo "$TSC_OUT" | grep -qx "SERVER-FROM $TSC/clone"; then pass "T-SELF-CLONE: the clone's own server/install.sh ran"; else fail "T-SELF-CLONE: clone's server installer not run (got: $(echo "$TSC_OUT" | tail -5 | tr '\n' ' '))"; fi
if [ ! -s "$TSC/git.log" ]; then pass "T-SELF-CLONE: no clone or pull"; else fail "T-SELF-CLONE: git ran: $(tr '\n' ' ' < "$TSC/git.log")"; fi
if [ ! -e "$TSC/home/universal-memory" ]; then pass "T-SELF-CLONE: ~/universal-memory untouched"; else fail "T-SELF-CLONE: ~/universal-memory was created"; fi
# Control: piped (curl | bash) has no script file, so ~/universal-memory stays the default.
TSC_OUT=$(cd "$TSC/clone" && env -u UM_INSTALL_DIR PATH="$TSC/bin:/usr/bin:/bin" HOME="$TSC/home" OPENAI_API_KEY=sk-test \
  bash -s -- --server --yes --dry-run < "$INSTALLER" 2>&1) || true
if echo "$TSC_OUT" | grep -q "would: git clone .* $TSC/home/universal-memory"; then pass "T-SELF-CLONE: piped install still clones to ~/universal-memory"; else fail "T-SELF-CLONE: piped default changed (got: $(echo "$TSC_OUT" | tail -5 | tr '\n' ' '))"; fi
rm -rf "$TSC"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
