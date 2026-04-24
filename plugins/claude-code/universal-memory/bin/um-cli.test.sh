#!/usr/bin/env bash
# bin/um-cli.test.sh — integration tests for um-forget and um-supersede
#
# Run: bash um-cli.test.sh
# All 6 tests must pass.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_FORGET="$SCRIPT_DIR/um-forget"
UM_SUPERSEDE="$SCRIPT_DIR/um-supersede"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
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
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name (got='$got', want='$want')"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got: '${haystack:0:200}')"; fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"
  else fail "$name (expected NOT to contain '$needle')"; fi
}

assert_file_exists() {
  local name="$1" path="$2"
  if [ -f "$path" ]; then pass "$name"
  else fail "$name (file not found: $path)"; fi
}

# ---------------------------------------------------------------------------
# Temp dir + global setup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export UM_VAULT_DIR="$TMPDIR_ROOT/vault"
export UM_ENDPOINT="http://localhost:19999"   # guaranteed unreachable normally

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# ---------------------------------------------------------------------------
# Helper: write a simple fixture doc under the vault
# usage: write_fixture <id> [<yaml_extra_lines>...]
# prints the absolute path
# ---------------------------------------------------------------------------
write_fixture() {
  local id="$1"
  shift
  local extra="${*:-}"
  local doc_dir="$UM_VAULT_DIR/docs"
  mkdir -p "$doc_dir"
  local path="$doc_dir/${id}.md"
  cat > "$path" <<DOC
---
id: ${id}
schema_version: 1
type: doc
status: current
title: Test doc ${id}
${extra}
---

Body of ${id}.
DOC
  echo "$path"
}

# ---------------------------------------------------------------------------
# Helper: write a mock curl that records calls and succeeds
# ---------------------------------------------------------------------------
write_mock_curl_ok() {
  local calls_file="$1"
  echo "0" > "$calls_file"
  cat > "$MOCK_BIN/curl" <<MOCK
#!/usr/bin/env bash
# Mock curl — records call count, always succeeds
count=\$(cat "$calls_file" 2>/dev/null || echo 0)
count=\$((count + 1))
echo "\$count" > "$calls_file"
printf '{"ok":true}\n'
exit 0
MOCK
  chmod +x "$MOCK_BIN/curl"
}

# ---------------------------------------------------------------------------
# Helper: write a mock curl that always fails
# ---------------------------------------------------------------------------
write_mock_curl_fail() {
  cat > "$MOCK_BIN/curl" <<'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
  chmod +x "$MOCK_BIN/curl"
}

# ===========================================================================
# Test 1: um-forget with no args → usage message, exit 2
# ===========================================================================
echo "=== Test 1: um-forget no args → usage + exit 2 ==="

T1_EXIT=0
T1_OUT=$(bash "$UM_FORGET" 2>&1) || T1_EXIT=$?

assert_eq    "T1: exit code 2 on no args"    "$T1_EXIT" "2"
assert_contains "T1: usage message shown"    "$T1_OUT"  "usage: um-forget <id>"
assert_contains "T1: mentions deprecated"    "$T1_OUT"  "deprecated"

# Also test --help flag
T1H_EXIT=0
T1H_OUT=$(bash "$UM_FORGET" --help 2>&1) || T1H_EXIT=$?
assert_eq    "T1h: exit code 2 on --help"   "$T1H_EXIT" "2"
assert_contains "T1h: usage on --help"      "$T1H_OUT"  "usage: um-forget"

# ===========================================================================
# Test 2: um-forget with nonexistent id → "no doc found", exit 1
# ===========================================================================
echo "=== Test 2: um-forget nonexistent id → error + exit 1 ==="

T2_EXIT=0
T2_STDERR=$(bash "$UM_FORGET" "no-such-doc-xyz" 2>&1) || T2_EXIT=$?

assert_eq       "T2: exit code 1 on missing doc" "$T2_EXIT" "1"
assert_contains "T2: error mentions id"          "$T2_STDERR" "no-such-doc-xyz"
assert_contains "T2: error says no doc found"    "$T2_STDERR" "no doc found"

# ===========================================================================
# Test 3: um-forget happy path
# - fixture doc with frontmatter in temp vault
# - mutate → verify status=deprecated + invalidated_at set
# - verify reindex posted (mock curl)
# ===========================================================================
echo "=== Test 3: um-forget happy path ==="

T3_PATH=$(write_fixture "doc-alpha")
T3_CALLS="$TMPDIR_ROOT/t3_curl_calls"
write_mock_curl_ok "$T3_CALLS"

T3_EXIT=0
T3_OUT=$(PATH="$MOCK_BIN:$PATH" bash "$UM_FORGET" "doc-alpha" 2>&1) || T3_EXIT=$?

assert_eq       "T3: exit code 0 on success"         "$T3_EXIT" "0"
assert_contains "T3: stdout confirms deprecation"     "$T3_OUT"  "deprecated 'doc-alpha'"

# Verify frontmatter mutation
T3_CONTENT=$(cat "$T3_PATH")
assert_contains "T3: status=deprecated in file"       "$T3_CONTENT" "status: deprecated"
assert_contains "T3: invalidated_at set"              "$T3_CONTENT" "invalidated_at:"
assert_not_contains "T3: status not current anymore"  "$T3_CONTENT" "status: current"

# Verify reindex was posted (mock curl called at least once)
T3_CALL_COUNT=$(cat "$T3_CALLS" 2>/dev/null || echo 0)
if [ "$T3_CALL_COUNT" -ge 1 ]; then
  pass "T3: reindex curl was called ($T3_CALL_COUNT time(s))"
else
  fail "T3: reindex curl was NOT called (count=$T3_CALL_COUNT)"
fi

# ===========================================================================
# Test 4: um-supersede with missing args → usage message, exit 2
# ===========================================================================
echo "=== Test 4: um-supersede missing args → usage + exit 2 ==="

T4_EXIT=0
T4_OUT=$(bash "$UM_SUPERSEDE" 2>&1) || T4_EXIT=$?

assert_eq       "T4: exit code 2 on no args"   "$T4_EXIT" "2"
assert_contains "T4: usage message shown"       "$T4_OUT"  "usage: um-supersede"
assert_contains "T4: mentions supersedes"       "$T4_OUT"  "supersedes"

# Also test with only one arg
T4B_EXIT=0
T4B_OUT=$(bash "$UM_SUPERSEDE" "just-one-arg" 2>&1) || T4B_EXIT=$?
assert_eq       "T4b: exit 2 with one arg only" "$T4B_EXIT" "2"

# ===========================================================================
# Test 5: um-supersede with new file missing 'supersedes: [old_id]' → error
# ===========================================================================
echo "=== Test 5: um-supersede new file missing supersedes field → error ==="

# Create old doc
T5_OLD_PATH=$(write_fixture "doc-beta-old")

# Create new doc WITHOUT 'supersedes' field pointing to old_id
T5_NEW_PATH=$(write_fixture "doc-beta-new" "")

T5_EXIT=0
T5_STDERR=$(PATH="$MOCK_BIN:$PATH" bash "$UM_SUPERSEDE" "doc-beta-old" "$T5_NEW_PATH" 2>&1) || T5_EXIT=$?

assert_eq       "T5: exit non-zero on missing supersedes" "$T5_EXIT" "1"
assert_contains "T5: error mentions supersedes field"     "$T5_STDERR" "supersedes"
assert_contains "T5: error names old_id"                  "$T5_STDERR" "doc-beta-old"

# Verify old doc NOT mutated (still current)
T5_OLD_CONTENT=$(cat "$T5_OLD_PATH")
assert_contains "T5: old doc still has status: current"   "$T5_OLD_CONTENT" "status: current"

# ===========================================================================
# Test 6: um-supersede happy path
# - two fixture docs, new has 'supersedes: [old_id]'
# - mutate old → verify status=superseded, superseded_by, invalidated_at
# - verify both reindexed (mock curl called twice)
# ===========================================================================
echo "=== Test 6: um-supersede happy path ==="

# Create old doc
T6_OLD_PATH=$(write_fixture "doc-gamma-v1")

# Create new doc WITH supersedes:[doc-gamma-v1] and an id field
T6_NEW_DIR="$UM_VAULT_DIR/docs"
T6_NEW_PATH="$T6_NEW_DIR/doc-gamma-v2.md"
cat > "$T6_NEW_PATH" <<'NEWDOC'
---
id: doc-gamma-v2
schema_version: 1
type: doc
status: current
title: Doc gamma v2
supersedes:
- doc-gamma-v1
---

Updated body.
NEWDOC

T6_CALLS="$TMPDIR_ROOT/t6_curl_calls"
write_mock_curl_ok "$T6_CALLS"

T6_EXIT=0
T6_OUT=$(PATH="$MOCK_BIN:$PATH" bash "$UM_SUPERSEDE" "doc-gamma-v1" "$T6_NEW_PATH" 2>&1) || T6_EXIT=$?

assert_eq       "T6: exit code 0 on success"                  "$T6_EXIT" "0"
assert_contains "T6: stdout confirms supersede"               "$T6_OUT"  "superseded by 'doc-gamma-v2'"
assert_contains "T6: stdout shows old path"                   "$T6_OUT"  "status=superseded"
assert_contains "T6: stdout shows superseded_by"              "$T6_OUT"  "superseded_by=doc-gamma-v2"

# Verify old doc mutated
T6_OLD_CONTENT=$(cat "$T6_OLD_PATH")
assert_contains "T6: old doc status=superseded"               "$T6_OLD_CONTENT" "status: superseded"
assert_contains "T6: old doc has superseded_by"               "$T6_OLD_CONTENT" "superseded_by: doc-gamma-v2"
assert_contains "T6: old doc has invalidated_at"              "$T6_OLD_CONTENT" "invalidated_at:"
assert_not_contains "T6: old doc no longer status: current"   "$T6_OLD_CONTENT" "status: current"

# Verify both docs reindexed (mock curl called twice: new + old)
T6_CALL_COUNT=$(cat "$T6_CALLS" 2>/dev/null || echo 0)
if [ "$T6_CALL_COUNT" -ge 2 ]; then
  pass "T6: reindex curl called for both docs ($T6_CALL_COUNT time(s))"
else
  fail "T6: expected 2 reindex calls, got $T6_CALL_COUNT"
fi

# ===========================================================================
# Test 7: v0.6 retrofit — Authorization + User-Agent headers on both CLIs (B.7)
# ===========================================================================
echo "=== Test 7: v0.6 Authorization + User-Agent headers ==="
for CLI in "$UM_FORGET" "$UM_SUPERSEDE"; do
  CLI_NAME="$(basename "$CLI")"
  if grep -q 'Authorization: Bearer' "$CLI"; then
    pass "T7: $CLI_NAME has Authorization: Bearer header"
  else
    fail "T7: $CLI_NAME missing Authorization: Bearer header"
  fi
  if grep -qE 'User-Agent: um-(cli|bridge)/' "$CLI"; then
    pass "T7: $CLI_NAME has UM User-Agent marker"
  else
    fail "T7: $CLI_NAME missing UM User-Agent marker"
  fi
done

# ===========================================================================
# Summary
# ===========================================================================

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
