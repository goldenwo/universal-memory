#!/usr/bin/env bash
# bin/um-recent.test.sh — verify um-recent.sh wraps GET /api/recent/{project} correctly
# Run: bash bin/um-recent.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-recent.sh"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Helper: write a mock curl that emits a canned JSON response
_make_mock_curl() {
  local dir="$1"
  local response="$2"
  mkdir -p "$dir"
  local resp_file="$dir/response.json"
  printf '%s\n' "$response" > "$resp_file"
  cat > "$dir/curl" <<EOF
#!/bin/bash
# Mock curl — emits canned response, exit 0
cat "$resp_file"
exit 0
EOF
  chmod +x "$dir/curl"
}

# Helper: write a mock curl that records its args AND emits canned JSON
_make_recording_curl() {
  local dir="$1"
  local response="$2"
  local args_file="$3"
  mkdir -p "$dir"
  local resp_file="$dir/response.json"
  printf '%s\n' "$response" > "$resp_file"
  cat > "$dir/curl" <<EOF
#!/bin/bash
# Recording mock curl — saves args to file, emits canned response
echo "\$@" > "$args_file"
cat "$resp_file"
exit 0
EOF
  chmod +x "$dir/curl"
}

# ─── T1: happy path — JSONL output for multiple recent results ───────────────
echo "=== T1: happy path — JSONL output ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"results":[{"id":"a","title":"A","snippet":"snip1"},{"id":"b","title":"B","snippet":"snip2"}]}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" "test-proj" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T1-exit-0"
else
  fail "T1-exit-0 (rc=$rc, out=$output)"
fi
line_count=$(echo "$output" | grep -c '^{' || echo 0)
if [ "$line_count" -ge 2 ]; then
  pass "T1-two-jsonl-lines (${line_count} lines)"
else
  fail "T1-two-jsonl-lines: expected >=2 JSON lines, got $line_count (output: $output)"
fi
if echo "$output" | jq -c '.' >/dev/null 2>&1; then
  pass "T1-each-line-parseable"
else
  fail "T1-each-line-parseable: $output"
fi
rm -rf "$tmp"

# ─── T2: --help exits 0 with usage ──────────────────────────────────────────
echo ""
echo "=== T2: --help flag ==="
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

# ─── T3: missing project arg (no UM_PROJECT, no git) → exit 2 ───────────────
echo ""
echo "=== T3: missing project arg → exit 2 ==="
tmp3=$(mktemp -d)
out=$(cd "$tmp3" && unset UM_PROJECT && bash "$BIN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "T3-missing-arg-exit-2"
else
  fail "T3-missing-arg-exit-2 (rc=$rc, out=$out)"
fi
rm -rf "$tmp3"

# ─── T4: -n N / --limit N flag honored (passed as ?limit=N) ─────────────────
echo ""
echo "=== T4: -n / --limit flag → limit param in URL ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[]}' "$args_file"
PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" -n 3 "test-proj" >/dev/null 2>&1 || true
if grep -q "limit=3" "$args_file" 2>/dev/null; then
  pass "T4-short-n-limit-param"
else
  fail "T4-short-n-limit-param: curl args did not contain limit=3: $(cat "$args_file" 2>/dev/null || echo missing)"
fi
# also test --limit
args_file2="$tmp/curl-args2"
_make_recording_curl "$tmp/bin2" '{"results":[]}' "$args_file2"
PATH="$tmp/bin2:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --limit 7 "test-proj" >/dev/null 2>&1 || true
if grep -q "limit=7" "$args_file2" 2>/dev/null; then
  pass "T4-long-limit-param"
else
  fail "T4-long-limit-param: curl args did not contain limit=7: $(cat "$args_file2" 2>/dev/null || echo missing)"
fi
rm -rf "$tmp"

# ─── T5: JSONL output parses via jq -c '.' ──────────────────────────────────
echo ""
echo "=== T5: JSONL parses via jq -c '.' ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"results":[{"id":"a","title":"A","snippet":"s1"},{"id":"b","title":"B","snippet":"s2"}]}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" "test-proj" 2>&1) && rc=0 || rc=$?
all_parse=1
while IFS= read -r line; do
  if [ -n "$line" ]; then
    if ! echo "$line" | jq -c '.' >/dev/null 2>&1; then
      all_parse=0
      fail "T5-line-parse-fail: $line"
    fi
  fi
done <<< "$output"
if [ "$all_parse" -eq 1 ]; then
  pass "T5-all-lines-parse-via-jq"
fi
rm -rf "$tmp"

# ─── T6: --full passes ?full=1 and response has body field ──────────────────
echo ""
echo "=== T6: --full flag → full=1 in URL, body field in output ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[{"id":"a","title":"A","snippet":"s","body":"full body text","metadata":{}}]}' "$args_file"
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --full "test-proj" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T6-exit-0"
else
  fail "T6-exit-0 (rc=$rc, out=$output)"
fi
if grep -q "full=1" "$args_file" 2>/dev/null; then
  pass "T6-full-query-param"
else
  fail "T6-full-query-param: curl args did not contain full=1: $(cat "$args_file" 2>/dev/null || echo missing)"
fi
if echo "$output" | jq -e '.body' >/dev/null 2>&1; then
  pass "T6-body-field-present"
else
  fail "T6-body-field-present: $output"
fi
rm -rf "$tmp"

# ─── T7: respects $UM_SERVER_URL override ────────────────────────────────────
echo ""
echo "=== T7: \$UM_SERVER_URL override ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[]}' "$args_file"
PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://custom:9999" bash "$BIN" "test-proj" >/dev/null 2>&1 || true
if grep -q "http://custom:9999" "$args_file" 2>/dev/null; then
  pass "T7-url-override"
else
  fail "T7-url-override: $(cat "$args_file" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmp"

# ─── T8: $UM_PROJECT env var fallback (no positional arg) ───────────────────
echo ""
echo "=== T8: \$UM_PROJECT env fallback ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[]}' "$args_file"
PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" UM_PROJECT="env-proj" bash "$BIN" >/dev/null 2>&1 || true
if grep -q "/api/recent/env-proj" "$args_file" 2>/dev/null; then
  pass "T8-env-project-fallback"
else
  fail "T8-env-project-fallback: curl args: $(cat "$args_file" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmp"

# ─── T9: v0.6 retrofit — Authorization + User-Agent headers (B.7) ───────────
echo ""
echo "=== T9: v0.6 Authorization + User-Agent headers present ==="
CLI="$BIN"
if grep -q 'Authorization: Bearer' "$CLI"; then
  pass "T9-authorization-header"
else
  fail "T9-authorization-header: $CLI missing 'Authorization: Bearer' header"
fi
if grep -qE 'User-Agent: um-(cli|bridge)/' "$CLI"; then
  pass "T9-user-agent-header"
else
  fail "T9-user-agent-header: $CLI missing UM User-Agent marker"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-recent.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
