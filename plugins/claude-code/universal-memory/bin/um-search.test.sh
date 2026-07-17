#!/usr/bin/env bash
# bin/um-search.test.sh — verify um-search.sh wraps GET /api/search correctly
# Run: bash bin/um-search.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-search.sh"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Helper: write a mock curl that emits a canned JSON response + "200" status line
# (wrapper expects body\n<http_code> on the last line via -w $'\n%{http_code}')
_make_mock_curl() {
  local dir="$1"
  local response="$2"
  mkdir -p "$dir"
  # Write the canned response into a temp file to avoid heredoc quoting issues
  local resp_file="$dir/response.json"
  printf '%s\n200\n' "$response" > "$resp_file"
  cat > "$dir/curl" <<EOF
#!/bin/bash
# Mock curl — emits canned response + 200 status line, exit 0
cat "$resp_file"
exit 0
EOF
  chmod +x "$dir/curl"
}

# Helper: write a mock curl that records its args AND emits canned JSON + "200"
_make_recording_curl() {
  local dir="$1"
  local response="$2"
  local args_file="$3"
  mkdir -p "$dir"
  local resp_file="$dir/response.json"
  printf '%s\n200\n' "$response" > "$resp_file"
  cat > "$dir/curl" <<EOF
#!/bin/bash
# Recording mock curl — saves args to file, emits canned response + 200 status line
echo "\$@" > "$args_file"
cat "$resp_file"
exit 0
EOF
  chmod +x "$dir/curl"
}

# ─── T1: happy path — JSONL output with at least one result ─────────────────
echo "=== T1: happy path — JSONL output ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"results":[{"id":"test-1","title":"Test","score":0.9,"snippet":"sample snippet"}]}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" "query" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T1-exit-0"
else
  fail "T1-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | jq -e '.id == "test-1"' >/dev/null 2>&1; then
  pass "T1-jsonl-output"
else
  fail "T1-jsonl-output: got: $output"
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

# ─── T3: missing query arg → exit 2 with error message ──────────────────────
echo ""
echo "=== T3: missing query arg → exit 2 ==="
out=$(bash "$BIN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "T3-missing-arg-exit-2"
else
  fail "T3-missing-arg-exit-2 (rc=$rc)"
fi
if echo "$out" | grep -qi "query"; then
  pass "T3-missing-arg-message"
else
  fail "T3-missing-arg-message: expected 'query' in error, got: $out"
fi

# ─── T4: --full flag → response has body field ──────────────────────────────
echo ""
echo "=== T4: --full flag → body field in output ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[{"id":"test-1","title":"Test","score":0.9,"body":"full body content"}]}' "$args_file"
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --full "query" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T4-full-exit-0"
else
  fail "T4-full-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | jq -e '.body' >/dev/null 2>&1; then
  pass "T4-full-body-field"
else
  fail "T4-full-body-field: $output"
fi
# Also verify ?full=1 appeared in the URL
if grep -q "full=1" "$args_file" 2>/dev/null; then
  pass "T4-full-query-param"
else
  fail "T4-full-query-param: curl args did not contain full=1: $(cat "$args_file" 2>/dev/null || echo missing)"
fi
rm -rf "$tmp"

# ─── T5: empty query string → exit 2 ────────────────────────────────────────
echo ""
echo "=== T5: empty query string → exit 2 ==="
out=$(bash "$BIN" "" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "T5-empty-query-exit-2"
else
  fail "T5-empty-query-exit-2 (rc=$rc)"
fi

# ─── T6: JSONL output — multiple results, each parses via jq -c '.' ─────────
echo ""
echo "=== T6: JSONL output — multiple results ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"results":[{"id":"a","title":"A","score":0.9,"snippet":"s1"},{"id":"b","title":"B","score":0.8,"snippet":"s2"}]}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" "q" 2>&1) && rc=0 || rc=$?
line_count=$(echo "$output" | grep -c '^{' || echo 0)
if [ "$line_count" -ge 2 ]; then
  pass "T6-multiple-jsonl (${line_count} lines)"
else
  fail "T6-multiple-jsonl: expected >=2 JSON lines, got $line_count (output: $output)"
fi
if echo "$output" | jq -c '.' >/dev/null 2>&1; then
  pass "T6-parses-via-jq"
else
  fail "T6-parses-via-jq: $output"
fi
rm -rf "$tmp"

# ─── T7: respects $UM_SERVER_URL override ────────────────────────────────────
echo ""
echo "=== T7: \$UM_SERVER_URL override ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[]}' "$args_file"
PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://custom:9999" bash "$BIN" "q" >/dev/null 2>&1 || true
if grep -q "http://custom:9999" "$args_file" 2>/dev/null; then
  pass "T7-url-override"
else
  fail "T7-url-override: $(cat "$args_file" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmp"

# ─── T8: v0.6 retrofit — Authorization + User-Agent headers (B.7) ───────────
echo ""
echo "=== T8: v0.6 Authorization + User-Agent headers present ==="
CLI="$BIN"
if grep -q 'Authorization: Bearer' "$CLI"; then
  pass "T8-authorization-header"
else
  fail "T8-authorization-header: $CLI missing 'Authorization: Bearer' header"
fi
if grep -qE 'User-Agent: um-(cli|bridge)/' "$CLI"; then
  pass "T8-user-agent-header"
else
  fail "T8-user-agent-header: $CLI missing UM User-Agent marker"
fi

# ─── T9: ~/.um/endpoint file tier (no env) — #159 T6b spec §4 ───────────────
echo ""
echo "=== T9: ~/.um/endpoint file tier used when env unset ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"results":[]}' "$args_file"
mkdir -p "$tmp/home/.um"
printf 'http://filetier:6335\n' > "$tmp/home/.um/endpoint"
PATH="$tmp/bin:$PATH" HOME="$tmp/home" UM_SERVER_URL="" UM_ENDPOINT="" \
  bash "$BIN" "q" >/dev/null 2>&1 || true
if grep -q "http://filetier:6335" "$args_file" 2>/dev/null; then
  pass "T9-file-tier-endpoint"
else
  fail "T9-file-tier-endpoint: $(cat "$args_file" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmp"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-search.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
