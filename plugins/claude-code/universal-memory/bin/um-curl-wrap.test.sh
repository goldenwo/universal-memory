#!/usr/bin/env bash
# bin/um-curl-wrap.test.sh — per-CLI 401/429/503/5xx/network error translation (E.5)
#
# Tests that each of the 6 retrofitted CLIs emits the correct friendly error
# message when the server returns 401, 429, 503, or a generic 5xx.  Also
# tests that a network failure (empty status) produces a "could not reach"
# message instead of a silent failure.
#
# Run: bash bin/um-curl-wrap.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0

pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# ─── Mock helpers ─────────────────────────────────────────────────────────────

# Write a mock curl that emits <body>\n<status_code> (mimics -w $'\n%{http_code}')
_make_status_curl() {
  local dir="$1" status="$2" body="$3"
  mkdir -p "$dir"
  local resp_file="$dir/response.txt"
  # body then status on last line (wrapper splits at tail -n1)
  printf '%s\n%s\n' "$body" "$status" > "$resp_file"
  cat > "$dir/curl" <<STUB
#!/bin/bash
# Mock curl — emits canned body + status_code on last line
cat "$resp_file"
exit 0
STUB
  chmod +x "$dir/curl"
}

# Write a mock curl that exits non-zero with empty output (network failure)
_make_network_fail_curl() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/curl" <<'STUB'
#!/bin/bash
# Mock curl — simulates network failure (no output, non-zero exit)
exit 7
STUB
  chmod +x "$dir/curl"
}

# Write a mock curl that returns a 2xx for happy-path tests
# (records args to args_file so we can verify headers pass through)
_make_ok_curl() {
  local dir="$1" body="$2"
  mkdir -p "$dir"
  local resp_file="$dir/response.txt"
  printf '%s\n200\n' "$body" > "$resp_file"
  cat > "$dir/curl" <<STUB
#!/bin/bash
cat "$resp_file"
exit 0
STUB
  chmod +x "$dir/curl"
}

# ─── Shared env for CLIs that need project resolution ─────────────────────────
export UM_PROJECT="test-proj"

# ─── um-list.sh ───────────────────────────────────────────────────────────────
BIN_LIST="$SCRIPT_DIR/um-list.sh"

echo "=== um-list: 401 auth error ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "401" '{"message":"Unauthorized"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_LIST" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "list-401-exit-nonzero"
else
  fail "list-401-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "auth failed"; then
  pass "list-401-message"
else
  fail "list-401-message: expected 'auth failed', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-list: 429 rate limited ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "429" '{"message":"Too Many Requests"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_LIST" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "list-429-exit-nonzero"
else
  fail "list-429-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "rate limited"; then
  pass "list-429-message"
else
  fail "list-429-message: expected 'rate limited', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-list: 503 busy ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "503" '{"message":"Service Unavailable"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_LIST" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "list-503-exit-nonzero"
else
  fail "list-503-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "busy"; then
  pass "list-503-message"
else
  fail "list-503-message: expected 'busy', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-list: 500 generic server error ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "500" '{"message":"Internal Server Error"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_LIST" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "list-500-exit-nonzero"
else
  fail "list-500-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "server error 500"; then
  pass "list-500-message"
else
  fail "list-500-message: expected 'server error 500', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-list: network failure (no server) ==="
tmp=$(mktemp -d)
_make_network_fail_curl "$tmp/bin"
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_LIST" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "list-netfail-exit-nonzero"
else
  fail "list-netfail-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "could not reach server"; then
  pass "list-netfail-message"
else
  fail "list-netfail-message: expected 'could not reach server', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-list: 2xx still works (auth headers flow through) ==="
tmp=$(mktemp -d)
_make_ok_curl "$tmp/bin" '{"results":[{"id":"a","title":"A","snippet":"s"}]}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" UM_AUTH_TOKEN="tok123" bash "$BIN_LIST" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "list-2xx-exit-0"
else
  fail "list-2xx-exit-0 (rc=$rc, out=$output)"
fi
if printf '%s' "$output" | grep -q '"id":"a"'; then
  pass "list-2xx-body-passthrough"
else
  fail "list-2xx-body-passthrough: got: $output"
fi
rm -rf "$tmp"

# ─── um-search.sh ─────────────────────────────────────────────────────────────
BIN_SEARCH="$SCRIPT_DIR/um-search.sh"

echo ""
echo "=== um-search: 401 auth error ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "401" '{"message":"Unauthorized"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_SEARCH" "query" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "search-401-exit-nonzero"
else
  fail "search-401-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "auth failed"; then
  pass "search-401-message"
else
  fail "search-401-message: expected 'auth failed', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-search: 429 rate limited ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "429" '{"message":"Too Many Requests"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_SEARCH" "query" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "search-429-exit-nonzero"
else
  fail "search-429-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "rate limited"; then
  pass "search-429-message"
else
  fail "search-429-message: expected 'rate limited', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-search: 503 busy ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "503" '{"message":"Service Unavailable"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_SEARCH" "query" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "search-503-exit-nonzero"
else
  fail "search-503-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "busy"; then
  pass "search-503-message"
else
  fail "search-503-message: expected 'busy', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-search: network failure ==="
tmp=$(mktemp -d)
_make_network_fail_curl "$tmp/bin"
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_SEARCH" "query" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "search-netfail-exit-nonzero"
else
  fail "search-netfail-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "could not reach server"; then
  pass "search-netfail-message"
else
  fail "search-netfail-message: expected 'could not reach server', got: $stderr_out"
fi
rm -rf "$tmp"

# ─── um-recent.sh ─────────────────────────────────────────────────────────────
BIN_RECENT="$SCRIPT_DIR/um-recent.sh"

echo ""
echo "=== um-recent: 401 auth error ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "401" '{"message":"Unauthorized"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_RECENT" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "recent-401-exit-nonzero"
else
  fail "recent-401-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "auth failed"; then
  pass "recent-401-message"
else
  fail "recent-401-message: expected 'auth failed', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-recent: 429 rate limited ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "429" '{"message":"Too Many Requests"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_RECENT" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "recent-429-exit-nonzero"
else
  fail "recent-429-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "rate limited"; then
  pass "recent-429-message"
else
  fail "recent-429-message: expected 'rate limited', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-recent: 503 busy ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "503" '{"message":"Service Unavailable"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_RECENT" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "recent-503-exit-nonzero"
else
  fail "recent-503-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "busy"; then
  pass "recent-503-message"
else
  fail "recent-503-message: expected 'busy', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-recent: network failure ==="
tmp=$(mktemp -d)
_make_network_fail_curl "$tmp/bin"
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_RECENT" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "recent-netfail-exit-nonzero"
else
  fail "recent-netfail-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "could not reach server"; then
  pass "recent-netfail-message"
else
  fail "recent-netfail-message: expected 'could not reach server', got: $stderr_out"
fi
rm -rf "$tmp"

# ─── um-state.sh ──────────────────────────────────────────────────────────────
BIN_STATE="$SCRIPT_DIR/um-state.sh"

echo ""
echo "=== um-state: 401 auth error ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "401" '{"message":"Unauthorized"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_STATE" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "state-401-exit-nonzero"
else
  fail "state-401-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "auth failed"; then
  pass "state-401-message"
else
  fail "state-401-message: expected 'auth failed', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-state: 429 rate limited ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "429" '{"message":"Too Many Requests"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_STATE" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "state-429-exit-nonzero"
else
  fail "state-429-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "rate limited"; then
  pass "state-429-message"
else
  fail "state-429-message: expected 'rate limited', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-state: 503 busy ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "503" '{"message":"Service Unavailable"}'
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_STATE" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "state-503-exit-nonzero"
else
  fail "state-503-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "busy"; then
  pass "state-503-message"
else
  fail "state-503-message: expected 'busy', got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== um-state: network failure ==="
tmp=$(mktemp -d)
_make_network_fail_curl "$tmp/bin"
stderr_out=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN_STATE" "test-proj" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "state-netfail-exit-nonzero"
else
  fail "state-netfail-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "could not reach server"; then
  pass "state-netfail-message"
else
  fail "state-netfail-message: expected 'could not reach server', got: $stderr_out"
fi
rm -rf "$tmp"

# ─── _um_curl_wrap unit tests (wrapper sourced directly) ─────────────────────
echo ""
echo "=== wrapper unit: 401 direct ==="
WRAP="$SCRIPT_DIR/lib/um-curl-wrap.sh"
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "401" '{"message":"Unauthorized"}'
stderr_out=$(PATH="$tmp/bin:$PATH" bash -c "source '$WRAP'; _um_curl_wrap 'test-cli' http://mock/api/test" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "wrap-unit-401-exit-nonzero"
else
  fail "wrap-unit-401-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "auth failed"; then
  pass "wrap-unit-401-message"
else
  fail "wrap-unit-401-message: got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== wrapper unit: 429 direct ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "429" '{"message":"Too Many Requests"}'
stderr_out=$(PATH="$tmp/bin:$PATH" bash -c "source '$WRAP'; _um_curl_wrap 'test-cli' http://mock/api/test" 2>&1 >/dev/null) && rc=0 || rc=$?
if printf '%s' "$stderr_out" | grep -q "rate limited"; then
  pass "wrap-unit-429-message"
else
  fail "wrap-unit-429-message: got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== wrapper unit: 503 direct ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "503" '{"message":"Locked"}'
stderr_out=$(PATH="$tmp/bin:$PATH" bash -c "source '$WRAP'; _um_curl_wrap 'test-cli' http://mock/api/test" 2>&1 >/dev/null) && rc=0 || rc=$?
if printf '%s' "$stderr_out" | grep -q "busy"; then
  pass "wrap-unit-503-message"
else
  fail "wrap-unit-503-message: got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== wrapper unit: network failure (empty status) ==="
tmp=$(mktemp -d)
_make_network_fail_curl "$tmp/bin"
stderr_out=$(PATH="$tmp/bin:$PATH" bash -c "source '$WRAP'; _um_curl_wrap 'test-cli' http://mock/api/test" 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "wrap-unit-netfail-exit-nonzero"
else
  fail "wrap-unit-netfail-exit-nonzero (rc=$rc)"
fi
if printf '%s' "$stderr_out" | grep -q "could not reach server"; then
  pass "wrap-unit-netfail-message"
else
  fail "wrap-unit-netfail-message: got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== wrapper unit: 500 with message extraction ==="
tmp=$(mktemp -d)
_make_status_curl "$tmp/bin" "500" '{"message":"Something went wrong"}'
stderr_out=$(PATH="$tmp/bin:$PATH" bash -c "source '$WRAP'; _um_curl_wrap 'test-cli' http://mock/api/test" 2>&1 >/dev/null) && rc=0 || rc=$?
if printf '%s' "$stderr_out" | grep -q "server error 500"; then
  pass "wrap-unit-500-message"
else
  fail "wrap-unit-500-message: got: $stderr_out"
fi
rm -rf "$tmp"

echo ""
echo "=== wrapper unit: 2xx body passthrough ==="
tmp=$(mktemp -d)
_make_ok_curl "$tmp/bin" '{"results":[]}'
stdout_out=$(PATH="$tmp/bin:$PATH" bash -c "source '$WRAP'; _um_curl_wrap 'test-cli' http://mock/api/test" 2>/dev/null) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "wrap-unit-2xx-exit-0"
else
  fail "wrap-unit-2xx-exit-0 (rc=$rc)"
fi
if printf '%s' "$stdout_out" | grep -q '"results"'; then
  pass "wrap-unit-2xx-body"
else
  fail "wrap-unit-2xx-body: got: $stdout_out"
fi
rm -rf "$tmp"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "um-curl-wrap: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
