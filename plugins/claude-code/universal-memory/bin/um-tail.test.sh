#!/usr/bin/env bash
# bin/um-tail.test.sh — verify um-tail.sh: FS-direct tail of raw captures
# Run: bash bin/um-tail.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-tail.sh"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# ─── Helper: seed a raw capture entry into the test vault ────────────────────
# Usage: _seed_raw <project> <date> <captured_at> <type> <body>
_seed_raw() {
  local project="$1" date="$2" captured_at="$3" etype="$4" body="$5"
  local dir="$UM_VAULT_DIR/captures/$project/raw"
  mkdir -p "$dir"
  cat >> "$dir/$date.md" <<EOF
---
captured_at: $captured_at
type: $etype
---
$body

EOF
}

# ─── T1: happy path — tail default N entries from seeded raw files ───────────
echo "=== T1: happy path — default tail (3 entries, newest first) ==="
tmp1=$(mktemp -d)
export UM_VAULT_DIR="$tmp1/vault"
export UM_PROJECT="proj1"

_seed_raw "proj1" "2026-04-21" "2026-04-21T10:00:00Z" "note"     "First note body"
_seed_raw "proj1" "2026-04-21" "2026-04-21T11:00:00Z" "decision" "Second decision body"
_seed_raw "proj1" "2026-04-21" "2026-04-21T12:00:00Z" "note"     "Third note body"

output=$(bash "$BIN" "proj1" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T1-exit-0"
else
  fail "T1-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "First note body"; then
  pass "T1-contains-first-entry"
else
  fail "T1-contains-first-entry: got: $output"
fi
if echo "$output" | grep -q "Third note body"; then
  pass "T1-contains-third-entry"
else
  fail "T1-contains-third-entry: got: $output"
fi
# Newest-first: "Third" should appear before "First" in output
third_pos=$(echo "$output" | grep -n "Third note" | head -1 | cut -d: -f1)
first_pos=$(echo "$output" | grep -n "First note" | head -1 | cut -d: -f1)
if [ -n "$third_pos" ] && [ -n "$first_pos" ] && [ "$third_pos" -lt "$first_pos" ]; then
  pass "T1-newest-first"
else
  fail "T1-newest-first: third_pos=$third_pos first_pos=$first_pos in: $output"
fi
rm -rf "$tmp1"
unset UM_VAULT_DIR UM_PROJECT

# ─── T2: --help exits 0 with "Usage:" ────────────────────────────────────────
echo ""
echo "=== T2: --help exits 0 ==="
output=$(bash "$BIN" --help 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T2-help-exit-0"
else
  fail "T2-help-exit-0 (rc=$rc)"
fi
if echo "$output" | grep -q "Usage:"; then
  pass "T2-help-text"
else
  fail "T2-help-text: 'Usage:' not found in output: $output"
fi

# ─── T3: -n N / --limit N honored ────────────────────────────────────────────
echo ""
echo "=== T3: -n / --limit flag honored ==="
tmp3=$(mktemp -d)
export UM_VAULT_DIR="$tmp3/vault"
export UM_PROJECT="proj3"

for i in 01 02 03 04 05; do
  _seed_raw "proj3" "2026-04-21" "2026-04-21T${i}:00:00Z" "note" "Entry $i"
done

# -n 2 should return only 2 entries
output=$( bash "$BIN" -n 2 "proj3" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T3-short-n-exit-0"
else
  fail "T3-short-n-exit-0 (rc=$rc, out=$output)"
fi
entry_count=$(echo "$output" | grep -c "^---$" || echo 0)
if [ "$entry_count" -le 2 ]; then
  pass "T3-short-n-limit-2 (separators=${entry_count})"
else
  fail "T3-short-n-limit-2: expected <=2 separators, got $entry_count"
fi

# --limit 3 should return only 3 entries
output2=$(bash "$BIN" --limit 3 "proj3" 2>&1) && rc=0 || rc=$?
entry_count2=$(echo "$output2" | grep -c "^---$" || echo 0)
if [ "$entry_count2" -le 3 ]; then
  pass "T3-long-limit-3 (separators=${entry_count2})"
else
  fail "T3-long-limit-3: expected <=3 separators, got $entry_count2"
fi
rm -rf "$tmp3"
unset UM_VAULT_DIR UM_PROJECT

# ─── T4: missing project → exit 2 ────────────────────────────────────────────
echo ""
echo "=== T4: missing project → exit 2 ==="
tmp4=$(mktemp -d)
out=$(cd "$tmp4" && unset UM_PROJECT && bash "$BIN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "T4-missing-project-exit-2"
else
  fail "T4-missing-project-exit-2 (rc=$rc, out=$out)"
fi
rm -rf "$tmp4"

# ─── T5: non-existent project → exit 0 with empty output ─────────────────────
echo ""
echo "=== T5: non-existent project → exit 0 empty ==="
tmp5=$(mktemp -d)
export UM_VAULT_DIR="$tmp5/vault"

output=$(bash "$BIN" "no-such-project" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T5-exit-0"
else
  fail "T5-exit-0 (rc=$rc, out=$output)"
fi
trimmed="$(echo "$output" | tr -d '[:space:]')"
if [ -z "$trimmed" ]; then
  pass "T5-empty-output"
else
  fail "T5-empty-output: got: $output"
fi
rm -rf "$tmp5"
unset UM_VAULT_DIR

# ─── T6: --json emits JSONL of {captured_at, type, body} ─────────────────────
echo ""
echo "=== T6: --json emits valid JSONL ==="
tmp6=$(mktemp -d)
export UM_VAULT_DIR="$tmp6/vault"

_seed_raw "proj6" "2026-04-21" "2026-04-21T09:00:00Z" "note"     "JSON body one"
_seed_raw "proj6" "2026-04-21" "2026-04-21T10:00:00Z" "decision" "JSON body two"

output=$(bash "$BIN" --json "proj6" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T6-exit-0"
else
  fail "T6-exit-0 (rc=$rc, out=$output)"
fi

# Each non-empty line should be parseable JSON
all_json=1
json_count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  json_count=$((json_count+1))
  if ! echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1; then
    all_json=0
    fail "T6-line-not-json: $line"
  fi
done <<< "$output"

if [ "$all_json" -eq 1 ] && [ "$json_count" -ge 2 ]; then
  pass "T6-all-lines-json ($json_count lines)"
else
  [ "$all_json" -eq 1 ] || true  # already failed above
  [ "$json_count" -ge 2 ] || fail "T6-expected-2-json-lines got $json_count: $output"
fi

# Check required keys in first line
first_line=$(echo "$output" | grep -v '^$' | head -1)
if echo "$first_line" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'captured_at' in d, 'missing captured_at'
assert 'type' in d, 'missing type'
assert 'body' in d, 'missing body'
" >/dev/null 2>&1; then
  pass "T6-required-keys"
else
  fail "T6-required-keys: first line: $first_line"
fi

# Check body content is present
if echo "$output" | grep -q "JSON body"; then
  pass "T6-body-content"
else
  fail "T6-body-content: body text not found in: $output"
fi
rm -rf "$tmp6"
unset UM_VAULT_DIR

# ─── T7: multi-day captures span multiple YYYY-MM-DD.md files ────────────────
echo ""
echo "=== T7: multi-day — tail across 3 date files in captured_at order ==="
tmp7=$(mktemp -d)
export UM_VAULT_DIR="$tmp7/vault"

# Seed entries across 3 different date files
_seed_raw "proj7" "2026-04-19" "2026-04-19T08:00:00Z" "note"     "Day 1 first entry"
_seed_raw "proj7" "2026-04-19" "2026-04-19T14:00:00Z" "decision" "Day 1 second entry"
_seed_raw "proj7" "2026-04-20" "2026-04-20T09:30:00Z" "note"     "Day 2 entry"
_seed_raw "proj7" "2026-04-21" "2026-04-21T07:00:00Z" "note"     "Day 3 early entry"
_seed_raw "proj7" "2026-04-21" "2026-04-21T15:00:00Z" "decision" "Day 3 latest entry"

# Default tail (10 entries) should contain all 5
output=$(bash "$BIN" "proj7" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T7-exit-0"
else
  fail "T7-exit-0 (rc=$rc, out=$output)"
fi

for entry in "Day 1 first" "Day 1 second" "Day 2 entry" "Day 3 early" "Day 3 latest"; do
  if echo "$output" | grep -q "$entry"; then
    pass "T7-contains: $entry"
  else
    fail "T7-contains: '$entry' not found in output: $output"
  fi
done

# Newest should come first: "Day 3 latest" before "Day 1 first"
latest_pos=$(echo "$output" | grep -n "Day 3 latest" | head -1 | cut -d: -f1)
oldest_pos=$(echo "$output" | grep -n "Day 1 first" | head -1 | cut -d: -f1)
if [ -n "$latest_pos" ] && [ -n "$oldest_pos" ] && [ "$latest_pos" -lt "$oldest_pos" ]; then
  pass "T7-newest-first-across-days"
else
  fail "T7-newest-first-across-days: latest_pos=$latest_pos oldest_pos=$oldest_pos"
fi

# With -n 5, tail should retrieve all 5 entries (spanning all 3 files)
output5=$(bash "$BIN" -n 5 "proj7" 2>&1) && rc=0 || rc=$?
all_present=1
for entry in "Day 1 first" "Day 2 entry" "Day 3 latest"; do
  if ! echo "$output5" | grep -q "$entry"; then
    all_present=0
    fail "T7-n5-missing: '$entry' not found"
  fi
done
if [ "$all_present" -eq 1 ]; then
  pass "T7-n5-all-3-files-covered"
fi
rm -rf "$tmp7"
unset UM_VAULT_DIR

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-tail.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
