#!/usr/bin/env bash
# bin/um-capture.test.sh — verify the um-capture CLI writes raw captures correctly
# Run: bash bin/um-capture.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-capture"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TODAY="$(date -u +%Y-%m-%d)"

# ─── T1: capture appends to today's raw file ────────────────────────────────
echo "=== T1: capture writes to captures/<proj>/raw/<YYYY-MM-DD>.md ==="
tmp=$(mktemp -d)
export UM_VAULT_DIR="$tmp/vault"
unset UM_PROJECT 2>/dev/null || true

echo "turn: user asked about auth" | bash "$BIN" --project test-proj --type note
if [ -s "$UM_VAULT_DIR/captures/test-proj/raw/$TODAY.md" ]; then
  pass "T1: raw file created and non-empty"
else
  fail "T1: raw file missing or empty at $UM_VAULT_DIR/captures/test-proj/raw/$TODAY.md"
fi
rm -rf "$tmp"

# ─── T2: fresh vault (no captures/<project>/raw/ dir) — auto-mkdir ──────────
echo ""
echo "=== T2: fresh vault — auto-mkdir creates parent dirs ==="
tmp2=$(mktemp -d)
export UM_VAULT_DIR="$tmp2/vault"
unset UM_PROJECT 2>/dev/null || true

if [ -d "$UM_VAULT_DIR/captures" ]; then
  fail "T2-precondition: captures/ should not exist yet"
else
  pass "T2-precondition: captures/ absent"
fi

echo "note" | bash "$BIN" --project fresh-proj --type note
if [ -s "$UM_VAULT_DIR/captures/fresh-proj/raw/$TODAY.md" ]; then
  pass "T2: raw file created with auto-mkdir"
else
  fail "T2: raw file missing after auto-mkdir at $UM_VAULT_DIR/captures/fresh-proj/raw/$TODAY.md"
fi
rm -rf "$tmp2"

# ─── T3: no --project, no UM_PROJECT, no git repo → exit 2 with message ─────
echo ""
echo "=== T3: no project specified → exit 2 with helpful message ==="
tmp3=$(mktemp -d)
export UM_VAULT_DIR="$tmp3/vault"
unset UM_PROJECT 2>/dev/null || true

# Run from tmp3 dir (no git repo)
out=$(cd "$tmp3" && echo "note" | bash "$BIN" --type note 2>&1) || rc=$?
rc=${rc:-0}

if [ "$rc" = "2" ]; then
  pass "T3: exits with code 2"
else
  fail "T3: expected exit 2, got $rc"
fi
if echo "$out" | grep -q 'no project specified'; then
  pass "T3: message contains 'no project specified'"
else
  fail "T3: message missing 'no project specified' (got: $out)"
fi
rm -rf "$tmp3"

# ─── T4: stdin-read path works ───────────────────────────────────────────────
echo ""
echo "=== T4: stdin input path ==="
tmp4=$(mktemp -d)
export UM_VAULT_DIR="$tmp4/vault"
unset UM_PROJECT 2>/dev/null || true

printf 'user: described a new auth flow\nassistant: acknowledged and asked for details\n' \
  | bash "$BIN" --project stdin-proj --type session

RAWFILE="$UM_VAULT_DIR/captures/stdin-proj/raw/$TODAY.md"
if [ -s "$RAWFILE" ]; then
  pass "T4: file created via stdin"
else
  fail "T4: file missing after stdin capture"
fi
if grep -q 'user: described a new auth flow' "$RAWFILE" 2>/dev/null; then
  pass "T4: stdin content present in file"
else
  fail "T4: stdin content not found in file"
fi
rm -rf "$tmp4"

# ─── T5: --text flag path works (non-stdin input) ────────────────────────────
echo ""
echo "=== T5: --text flag path ==="
tmp5=$(mktemp -d)
export UM_VAULT_DIR="$tmp5/vault"
unset UM_PROJECT 2>/dev/null || true

bash "$BIN" --project text-proj --type note --text "decided to use postgres"
RAWFILE5="$UM_VAULT_DIR/captures/text-proj/raw/$TODAY.md"
if [ -s "$RAWFILE5" ]; then
  pass "T5: file created via --text"
else
  fail "T5: file missing after --text capture"
fi
if grep -q 'decided to use postgres' "$RAWFILE5" 2>/dev/null; then
  pass "T5: --text content present in file"
else
  fail "T5: --text content not found in file"
fi
rm -rf "$tmp5"

# ─── T6: --type <t> appears in frontmatter ───────────────────────────────────
echo ""
echo "=== T6: --type appears in frontmatter ==="
tmp6=$(mktemp -d)
export UM_VAULT_DIR="$tmp6/vault"
unset UM_PROJECT 2>/dev/null || true

bash "$BIN" --project fm-proj --type decision --text "chosen RS256 for JWT signing"
RAWFILE6="$UM_VAULT_DIR/captures/fm-proj/raw/$TODAY.md"
if grep -q '^type: decision' "$RAWFILE6" 2>/dev/null; then
  pass "T6: 'type: decision' present in frontmatter"
else
  fail "T6: 'type: decision' missing from frontmatter (file: $(cat "$RAWFILE6" 2>/dev/null || echo 'missing'))"
fi
if grep -q '^captured_at:' "$RAWFILE6" 2>/dev/null; then
  pass "T6: 'captured_at' field present in frontmatter"
else
  fail "T6: 'captured_at' field missing from frontmatter"
fi
rm -rf "$tmp6"

# ─── T7: subsequent captures on the same day APPEND (don't overwrite) ────────
echo ""
echo "=== T7: same-day captures append rather than overwrite ==="
tmp7=$(mktemp -d)
export UM_VAULT_DIR="$tmp7/vault"
unset UM_PROJECT 2>/dev/null || true

bash "$BIN" --project append-proj --type note --text "first capture"
bash "$BIN" --project append-proj --type note --text "second capture"
RAWFILE7="$UM_VAULT_DIR/captures/append-proj/raw/$TODAY.md"

if grep -q 'first capture' "$RAWFILE7" 2>/dev/null && grep -q 'second capture' "$RAWFILE7" 2>/dev/null; then
  pass "T7: both captures present (append mode confirmed)"
else
  fail "T7: one or both captures missing — possibly overwrite mode (file: $(cat "$RAWFILE7" 2>/dev/null || echo 'missing'))"
fi
# Count frontmatter separators — should have at least 4 (2 per entry)
FM_COUNT=$(grep -c '^---$' "$RAWFILE7" 2>/dev/null || echo 0)
if [ "$FM_COUNT" -ge 4 ]; then
  pass "T7: two frontmatter blocks present ($FM_COUNT --- lines)"
else
  fail "T7: expected >=4 '---' lines, found $FM_COUNT"
fi
rm -rf "$tmp7"

# ─── T8: path-traversal via --project "../evil" → exit 2 ────────────────────
echo ""
echo "=== T8: path-traversal via --project '../evil' ==="
tmp8=$(mktemp -d)
export UM_VAULT_DIR="$tmp8/vault"
unset UM_PROJECT 2>/dev/null || true

out8=$(cd "$tmp8" && echo "body" | bash "$BIN" --project "../evil" --type note 2>&1) || rc8=$?
rc8=${rc8:-0}
if [ "$rc8" = "2" ]; then
  pass "T8: --project '../evil' exits with code 2"
else
  fail "T8: expected exit 2 for path-traversal project, got $rc8 (out: $out8)"
fi
if echo "$out8" | grep -q 'invalid project slug'; then
  pass "T8: error message mentions 'invalid project slug'"
else
  fail "T8: expected 'invalid project slug' in output (got: $out8)"
fi
rm -rf "$tmp8"

# ─── T9: frontmatter injection via --type "note\n---\ninjected: true" → exit 2
echo ""
echo "=== T9: frontmatter injection via --type with newline ==="
tmp9=$(mktemp -d)
export UM_VAULT_DIR="$tmp9/vault"
unset UM_PROJECT 2>/dev/null || true

out9=$(cd "$tmp9" && echo "body" | bash "$BIN" --project myproj --type $'note\n---\ninjected: true' 2>&1) || rc9=$?
rc9=${rc9:-0}
if [ "$rc9" = "2" ]; then
  pass "T9: --type with newline exits with code 2"
else
  fail "T9: expected exit 2 for invalid type, got $rc9 (out: $out9)"
fi
if echo "$out9" | grep -q 'invalid --type'; then
  pass "T9: error message mentions 'invalid --type'"
else
  fail "T9: expected 'invalid --type' in output (got: $out9)"
fi
rm -rf "$tmp9"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
