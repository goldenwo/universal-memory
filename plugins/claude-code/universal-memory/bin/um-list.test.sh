#!/usr/bin/env bash
# bin/um-list.test.sh — verify um-list.sh wraps GET /api/list correctly
# Run: bash bin/um-list.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-list.sh"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Helper: write a mock curl that emits a canned JSON response + "200" status line
# (wrapper expects body\n<http_code> on the last line via -w $'\n%{http_code}')
_make_mock_curl() {
  local dir="$1"
  local response="$2"
  mkdir -p "$dir"
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

# ─── T1: happy path — enveloped results → JSONL output ──────────────────────
echo "=== T1: happy path — JSONL output ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"results":[{"id":"a","title":"A","snippet":"s1"},{"id":"b","title":"B","snippet":"s2"}]}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" 2>&1) && rc=0 || rc=$?
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

# ─── T3: --full passes full=1 and response has body field ───────────────────
echo ""
echo "=== T3: --full flag → full=1 in URL, body field in output ==="
tmp3=$(mktemp -d)
args_file3="$tmp3/curl-args"
_make_recording_curl "$tmp3/bin" '{"results":[{"id":"a","title":"A","snippet":"s","body":"full body text","metadata":{}}]}' "$args_file3"
output=$(PATH="$tmp3/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --full 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T3-exit-0"
else
  fail "T3-exit-0 (rc=$rc, out=$output)"
fi
if grep -q "full=1" "$args_file3" 2>/dev/null; then
  pass "T3-full-query-param"
else
  fail "T3-full-query-param: curl args did not contain full=1: $(cat "$args_file3" 2>/dev/null || echo missing)"
fi
if echo "$output" | jq -e '.body' >/dev/null 2>&1; then
  pass "T3-body-field-present"
else
  fail "T3-body-field-present: $output"
fi
rm -rf "$tmp3"

# ─── T4: JSONL parses via jq -c '.' ─────────────────────────────────────────
echo ""
echo "=== T4: JSONL parses via jq -c '.' ==="
tmp4=$(mktemp -d)
_make_mock_curl "$tmp4/bin" '{"results":[{"id":"a","title":"A","snippet":"s1"},{"id":"b","title":"B","snippet":"s2"}]}'
output=$(PATH="$tmp4/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" 2>&1) && rc=0 || rc=$?
all_parse=1
while IFS= read -r line; do
  if [ -n "$line" ]; then
    if ! echo "$line" | jq -c '.' >/dev/null 2>&1; then
      all_parse=0
      fail "T4-line-parse-fail: $line"
    fi
  fi
done <<< "$output"
if [ "$all_parse" -eq 1 ]; then
  pass "T4-all-lines-parse-via-jq"
fi
rm -rf "$tmp4"

# ─── T5: respects $UM_SERVER_URL override ────────────────────────────────────
echo ""
echo "=== T5: \$UM_SERVER_URL override ==="
tmp5=$(mktemp -d)
args_file5="$tmp5/curl-args"
_make_recording_curl "$tmp5/bin" '{"results":[]}' "$args_file5"
PATH="$tmp5/bin:$PATH" UM_SERVER_URL="http://custom:9999" bash "$BIN" >/dev/null 2>&1 || true
if grep -q "http://custom:9999" "$args_file5" 2>/dev/null; then
  pass "T5-url-override"
else
  fail "T5-url-override: $(cat "$args_file5" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmp5"

# ─── T6: --limit N passes limit=N in URL ────────────────────────────────────
echo ""
echo "=== T6: --limit N → limit=N in URL ==="
tmp6=$(mktemp -d)
args_file6="$tmp6/curl-args"
_make_recording_curl "$tmp6/bin" '{"results":[]}' "$args_file6"
PATH="$tmp6/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --limit 5 >/dev/null 2>&1 || true
if grep -q "limit=5" "$args_file6" 2>/dev/null; then
  pass "T6-limit-param"
else
  fail "T6-limit-param: curl args did not contain limit=5: $(cat "$args_file6" 2>/dev/null || echo missing)"
fi
rm -rf "$tmp6"

# ─── T7: positional arg ignored with warning ────────────────────────────────
echo ""
echo "=== T7: positional arg → ignored with warning ==="
tmp7=$(mktemp -d)
_make_mock_curl "$tmp7/bin" '{"results":[]}'
warn_out=$(PATH="$tmp7/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" some-proj 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T7-exit-0-not-fatal"
else
  fail "T7-exit-0-not-fatal (rc=$rc)"
fi
if echo "$warn_out" | grep -q "ignored"; then
  pass "T7-warning-printed"
else
  fail "T7-warning-printed: expected 'ignored' in stderr, got: $warn_out"
fi
rm -rf "$tmp7"

# ─── T8: empty array returns empty output ───────────────────────────────────
echo ""
echo "=== T8: empty array → empty JSONL output ==="
tmp8=$(mktemp -d)
_make_mock_curl "$tmp8/bin" '{"results":[]}'
output=$(PATH="$tmp8/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T8-exit-0"
else
  fail "T8-exit-0 (rc=$rc)"
fi
if [ -z "$output" ]; then
  pass "T8-empty-output"
else
  fail "T8-empty-output: expected empty, got: $output"
fi
rm -rf "$tmp8"

# ─── T9: --full + --limit together ──────────────────────────────────────────
echo ""
echo "=== T9: --full + --limit combined ==="
tmp9=$(mktemp -d)
args_file9="$tmp9/curl-args"
_make_recording_curl "$tmp9/bin" '{"results":[]}' "$args_file9"
PATH="$tmp9/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --full --limit 3 >/dev/null 2>&1 || true
if grep -q "full=1" "$args_file9" && grep -q "limit=3" "$args_file9" 2>/dev/null; then
  pass "T9-combined-params"
else
  fail "T9-combined-params: curl args: $(cat "$args_file9" 2>/dev/null || echo missing)"
fi
rm -rf "$tmp9"

# ─── T10: v0.6 retrofit — Authorization + User-Agent headers (B.7) ──────────
echo ""
echo "=== T10: v0.6 Authorization + User-Agent headers present ==="
CLI="$BIN"
if grep -q 'Authorization: Bearer' "$CLI"; then
  pass "T10-authorization-header"
else
  fail "T10-authorization-header: $CLI missing 'Authorization: Bearer' header"
fi
if grep -qE 'User-Agent: um-(cli|bridge)/' "$CLI"; then
  pass "T10-user-agent-header"
else
  fail "T10-user-agent-header: $CLI missing UM User-Agent marker"
fi

# ─── T-file-tier: ~/.um/endpoint file tier (no env) — #159 T6b spec §4 ──────
echo ""
echo "=== T-file-tier: ~/.um/endpoint used when env unset ==="
tmpft=$(mktemp -d)
args_fileft="$tmpft/curl-args"
_make_recording_curl "$tmpft/bin" '{"results":[]}' "$args_fileft"
mkdir -p "$tmpft/home/.um"
printf 'http://filetier:6335\n' > "$tmpft/home/.um/endpoint"
PATH="$tmpft/bin:$PATH" HOME="$tmpft/home" UM_SERVER_URL="" UM_ENDPOINT="" \
  bash "$BIN" >/dev/null 2>&1 || true
if grep -q "http://filetier:6335" "$args_fileft" 2>/dev/null; then
  pass "T-file-tier-endpoint"
else
  fail "T-file-tier-endpoint: $(cat "$args_fileft" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmpft"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-list.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
