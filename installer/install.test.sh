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
if echo "$T2_OUT" | grep -q "would: bash"; then pass "T2: server/install.sh dispatch intent printed"; else fail "T2: no dispatch intent"; fi
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

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
