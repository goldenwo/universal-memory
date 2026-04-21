#!/usr/bin/env bash
# bin/um-capture.sh.test.sh — verify um-capture.sh wrapper delegates to bin/um-capture
# NOTE: filename is literally um-capture.sh.test.sh to avoid collision with
#       um-capture.test.sh (which tests the A.1 fs-direct binary directly).
# Run: bash bin/um-capture.sh.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SH="$SCRIPT_DIR/um-capture.sh"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TODAY="$(date -u +%Y-%m-%d)"

# ─── T1: stdin flows through — wrapper passes stdin to binary ────────────────
echo "=== T1: stdin flows through to fs-direct binary ==="
tmp=$(mktemp -d)
export UM_VAULT_DIR="$tmp/vault"
unset UM_PROJECT 2>/dev/null || true

echo "test content from stdin" | bash "$BIN_SH" --project t1-proj --type note
expected="$UM_VAULT_DIR/captures/t1-proj/raw/$TODAY.md"
if [ -s "$expected" ]; then
  pass "T1-file-created"
else
  fail "T1-file-created: raw file missing at $expected"
fi
if grep -q "test content from stdin" "$expected" 2>/dev/null; then
  pass "T1-stdin-content-present"
else
  fail "T1-stdin-content-present: content not found in $expected"
fi
rm -rf "$tmp"

# ─── T2: --help exits 0 with usage text (delegates to binary's --help) ───────
echo ""
echo "=== T2: --help exits 0 with usage ==="
out=$(bash "$BIN_SH" --help 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T2-help-exit-0"
else
  fail "T2-help-exit-0 (rc=$rc)"
fi
if echo "$out" | grep -q "Usage:"; then
  pass "T2-help-usage-text"
else
  fail "T2-help-usage-text: 'Usage:' not found in output: $out"
fi

# ─── T3: --text arg path flows through ───────────────────────────────────────
echo ""
echo "=== T3: --text arg flows through to binary ==="
tmp3=$(mktemp -d)
export UM_VAULT_DIR="$tmp3/vault"
unset UM_PROJECT 2>/dev/null || true

bash "$BIN_SH" --project t3-proj --type note --text "hello world from --text"
expected3="$UM_VAULT_DIR/captures/t3-proj/raw/$TODAY.md"
if [ -s "$expected3" ]; then
  pass "T3-file-created"
else
  fail "T3-file-created: file missing at $expected3"
fi
if grep -q "hello world from --text" "$expected3" 2>/dev/null; then
  pass "T3-text-content-present"
else
  fail "T3-text-content-present: content not found in $expected3"
fi
rm -rf "$tmp3"

# ─── T4: --type flag is honored (appears in frontmatter) ─────────────────────
echo ""
echo "=== T4: --type flag passes through to frontmatter ==="
tmp4=$(mktemp -d)
export UM_VAULT_DIR="$tmp4/vault"
unset UM_PROJECT 2>/dev/null || true

echo "type test content" | bash "$BIN_SH" --project t4-proj --type decision
expected4="$UM_VAULT_DIR/captures/t4-proj/raw/$TODAY.md"
if grep -q "^type: decision" "$expected4" 2>/dev/null; then
  pass "T4-type-in-frontmatter"
else
  fail "T4-type-in-frontmatter: 'type: decision' not found in $expected4 (content: $(cat "$expected4" 2>/dev/null || echo missing))"
fi
rm -rf "$tmp4"

# ─── T5: missing --project, no env, no git → exit 2 ─────────────────────────
echo ""
echo "=== T5: no --project, no env, no git → exit 2 ==="
tmp5=$(mktemp -d)
export UM_VAULT_DIR="$tmp5/vault"
unset UM_PROJECT 2>/dev/null || true

out5=$(cd "$tmp5" && echo "x" | bash "$BIN_SH" --type note 2>&1) || rc5=$?
rc5=${rc5:-0}

if [ "$rc5" = "2" ]; then
  pass "T5-exit-2"
else
  fail "T5-exit-2: expected rc=2, got $rc5 (out: $out5)"
fi
if echo "$out5" | grep -q "no project specified"; then
  pass "T5-helpful-message"
else
  fail "T5-helpful-message: 'no project specified' not in output: $out5"
fi
rm -rf "$tmp5"

# ─── T6: missing binary → wrapper exits 1 with clear error ───────────────────
echo ""
echo "=== T6: binary missing → wrapper exits 1 with clear error ==="
tmp6=$(mktemp -d)
# Copy wrapper but NOT the binary into tmp6
cp "$BIN_SH" "$tmp6/um-capture.sh"
# Adjust SCRIPT_DIR to resolve relative to tmp6 (the copy has BASH_SOURCE[0]-based path)
# We use a wrapper that sets a fake SCRIPT_DIR pointing to tmp6 (no binary there)
# The simplest approach: run the script directly from tmp6 where um-capture doesn't exist
out6=$(bash "$tmp6/um-capture.sh" 2>&1) || rc6=$?
rc6=${rc6:-0}

if [ "$rc6" = "1" ]; then
  pass "T6-exit-1"
else
  fail "T6-exit-1: expected rc=1, got $rc6 (out: $out6)"
fi
if echo "$out6" | grep -q "wrapped binary missing"; then
  pass "T6-clear-error-message"
else
  fail "T6-clear-error-message: expected 'wrapped binary missing' in: $out6"
fi
rm -rf "$tmp6"

# ─── T7: exit code preserved (binary exit code flows back through exec) ───────
echo ""
echo "=== T7: exit code is preserved from binary ==="
# An unknown flag → binary exits 2. Verify wrapper preserves it.
tmp7=$(mktemp -d)
export UM_VAULT_DIR="$tmp7/vault"
unset UM_PROJECT 2>/dev/null || true

bash "$BIN_SH" --unknown-flag 2>/dev/null || rc7=$?
rc7=${rc7:-0}

if [ "$rc7" = "2" ]; then
  pass "T7-exit-code-preserved"
else
  fail "T7-exit-code-preserved: expected rc=2 from binary's unknown-flag, got $rc7"
fi
rm -rf "$tmp7"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-capture.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
