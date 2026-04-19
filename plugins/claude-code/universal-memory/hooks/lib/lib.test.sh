#!/usr/bin/env bash
# hooks/lib/lib.test.sh — unit tests for frontmatter.sh and vault.sh
# Run: bash lib.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source both libs
# shellcheck source=./frontmatter.sh
source "$SCRIPT_DIR/frontmatter.sh"
# shellcheck source=./vault.sh
source "$SCRIPT_DIR/vault.sh"

# --- Test harness ---

PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s\n' "$1"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (got='$got', want='$want')"
  fi
}

assert_empty() {
  local name="$1" got="$2"
  if [ -z "$got" ]; then
    pass "$name"
  else
    fail "$name (expected empty, got='$got')"
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    fail "$name (expected to contain '$needle', got='$haystack')"
  fi
}

# --- Temp dir setup ---

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ============================================================
# frontmatter.sh tests
# ============================================================

echo "=== frontmatter.sh ==="

# Test 1: fm_read on a file with frontmatter → returns the field value
T1_FILE="$TMPDIR_ROOT/t1.md"
cat > "$T1_FILE" <<'EOF'
---
valid_from: 2026-04-01T00:00:00Z
title: Test Session
tags:
  - alpha
  - beta
---
Body content here.
EOF
val=$(fm_read "$T1_FILE" "valid_from")
assert_eq "T1: fm_read returns valid_from field" "$val" "2026-04-01T00:00:00Z"

# Test 2: fm_read on a file without frontmatter → empty string
T2_FILE="$TMPDIR_ROOT/t2.md"
cat > "$T2_FILE" <<'EOF'
Just plain markdown, no frontmatter.
EOF
val=$(fm_read "$T2_FILE" "valid_from")
assert_empty "T2: fm_read on no-frontmatter file returns empty" "$val"

# Test 3: fm_read on a file with malformed YAML → empty string
T3_FILE="$TMPDIR_ROOT/t3.md"
cat > "$T3_FILE" <<'EOF'
---
valid_from: [unclosed bracket
title: : : bad yaml
---
Body.
EOF
val=$(fm_read "$T3_FILE" "valid_from")
assert_empty "T3: fm_read on malformed YAML returns empty" "$val"

# Test 4: fm_read on missing file → empty string
val=$(fm_read "$TMPDIR_ROOT/does-not-exist.md" "valid_from")
assert_empty "T4: fm_read on missing file returns empty" "$val"

# Test 5: fm_write creates a new file with frontmatter + body
T5_FILE="$TMPDIR_ROOT/t5.md"
fm_write "$T5_FILE" "valid_from: 2026-04-10T00:00:00Z
title: Written File" "Body text from fm_write."
[ -f "$T5_FILE" ] || { fail "T5: fm_write did not create file"; }
val=$(fm_read "$T5_FILE" "title")
assert_eq "T5: fm_write creates file with correct frontmatter" "$val" "Written File"

# Test 6: fm_write overwrites existing file atomically
T6_FILE="$TMPDIR_ROOT/t6.md"
echo "old content" > "$T6_FILE"
fm_write "$T6_FILE" "valid_from: 2026-04-15T00:00:00Z
title: Overwritten" "New body."
val=$(fm_read "$T6_FILE" "valid_from")
assert_eq "T6: fm_write overwrites existing file" "$val" "2026-04-15T00:00:00Z"
# Verify no .tmp file left behind
tmp_count=$(find "$TMPDIR_ROOT" -name 't6.md.tmp.*' 2>/dev/null | wc -l)
assert_eq "T6: no leftover tmp file" "$tmp_count" "0"

# ============================================================
# vault.sh tests
# ============================================================

echo "=== vault.sh ==="

# Test 7: vault_path returns UM_VAULT_DIR when set
UM_VAULT_DIR="/custom/vault" val=$(vault_path)
assert_eq "T7: vault_path returns UM_VAULT_DIR" "$val" "/custom/vault"

# Test 8: vault_path returns default when UM_VAULT_DIR unset
unset UM_VAULT_DIR
val=$(vault_path)
assert_eq "T8: vault_path returns default ~/.um/vault" "$val" "$HOME/.um/vault"

# Test 9: project_name returns CLAUDE_CWD basename
CLAUDE_CWD="/home/user/projects/my-project" val=$(project_name)
assert_eq "T9: project_name returns CLAUDE_CWD basename" "$val" "my-project"

# Test 10: project_name falls back to pwd basename when CLAUDE_CWD unset
unset CLAUDE_CWD
val=$(cd "$TMPDIR_ROOT" && project_name)
assert_eq "T10: project_name falls back to pwd basename" "$val" "$(basename "$TMPDIR_ROOT")"

# ============================================================
# find_orphans tests — use a synthetic vault in TMPDIR_ROOT
# ============================================================

echo "=== find_orphans ==="

VAULT="$TMPDIR_ROOT/vault"
export UM_VAULT_DIR="$VAULT"
TEST_PROJECT="testproj"

# Helper: create a raw capture file with controlled mtime
make_raw() {
  local name="$1"
  local mtime_offset="${2:-0}"  # seconds relative to "now - 10"
  local raw_dir="$VAULT/captures/$TEST_PROJECT/raw"
  mkdir -p "$raw_dir"
  local f="$raw_dir/$name.md"
  cat > "$f" <<EOF
# Raw capture $name
EOF
  if [ "$mtime_offset" -ne 0 ]; then
    # Use touch with a specific timestamp: now + offset
    local ts
    ts=$(date -d "now $mtime_offset seconds" +"%Y%m%d%H%M.%S" 2>/dev/null \
      || date -v "${mtime_offset}S" +"%Y%m%d%H%M.%S" 2>/dev/null \
      || true)
    [ -n "$ts" ] && touch -t "$ts" "$f"
  fi
  echo "$f"
}

# Helper: create state.md with a valid_from
make_state() {
  local valid_from="$1"
  local state_dir="$VAULT/state/$TEST_PROJECT"
  mkdir -p "$state_dir"
  fm_write "$state_dir/state.md" "valid_from: $valid_from" "# State"
}

# Helper: create a session summary with a valid_from
make_summary() {
  local name="$1"
  local valid_from="$2"
  local sess_dir="$VAULT/sessions/$TEST_PROJECT"
  mkdir -p "$sess_dir"
  fm_write "$sess_dir/$name.md" "valid_from: $valid_from" "# Summary $name"
}

# Test 11: find_orphans with no raw captures → empty output
mkdir -p "$VAULT/state/$TEST_PROJECT"
result=$(find_orphans "$TEST_PROJECT")
assert_empty "T11: find_orphans with no raw dir returns empty" "$result"

# Test 12: find_orphans with a raw capture and no state.md → returns the capture
# Reset vault for this test
rm -rf "$VAULT"
raw12=$(make_raw "2026-04-10")
result=$(find_orphans "$TEST_PROJECT")
# Result should contain the relative path of the raw file
rel="${raw12#"$VAULT/"}"
assert_contains "T12: find_orphans returns orphan with no state.md" "$result" "$rel"

# Test 13: find_orphans with a raw capture OLDER than state.md's valid_from → no output
# Set state valid_from to a future date so the raw file (written just now) appears older
rm -rf "$VAULT"
# Create a raw file
raw13=$(make_raw "2026-04-10")
# Touch it to a past time (2025-01-01)
touch -t 202501010000.00 "$raw13"
# State valid_from: 2026-04-01 (after the raw file's fake mtime of 2025-01-01)
make_state "2026-04-01T00:00:00Z"
result=$(find_orphans "$TEST_PROJECT")
assert_empty "T13: raw file older than state valid_from is not orphan" "$result"

# Test 14: find_orphans with a raw capture newer than state.md AND a session summary covering it → no output
rm -rf "$VAULT"
# Raw file: set mtime to 2026-03-01 (past, but newer than state's valid_from)
raw14=$(make_raw "2026-04-10")
touch -t 202603010000.00 "$raw14"
# State valid_from: 2026-01-01 (so raw mtime 2026-03-01 > state 2026-01-01 → orphan candidate)
make_state "2026-01-01T00:00:00Z"
# Summary valid_from: 2026-04-01 (> raw mtime 2026-03-01 → covers it)
make_summary "2026-04-01-testproj" "2026-04-01T00:00:00Z"
result=$(find_orphans "$TEST_PROJECT")
assert_empty "T14: raw covered by summary is not orphan" "$result"

# ============================================================
# Summary
# ============================================================

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
