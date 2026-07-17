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
# shellcheck disable=SC2034  # CLAUDE_CWD is set for the project_name invocation
# only (inline VAR=value cmd idiom); project_name reads it from its env.
CLAUDE_CWD="/home/user/projects/my-project" val=$(project_name)
assert_eq "T9: project_name returns CLAUDE_CWD basename" "$val" "my-project"

# Test 10: project_name falls back to pwd basename when CLAUDE_CWD unset
unset CLAUDE_CWD
val=$(cd "$TMPDIR_ROOT" && project_name)
assert_eq "T10: project_name falls back to pwd basename" "$val" "$(basename "$TMPDIR_ROOT")"

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
