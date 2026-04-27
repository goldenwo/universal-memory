#!/usr/bin/env bash
# bin/um-state.test.sh — verify um-state.sh wraps GET /api/state/{project} correctly
# Run: bash bin/um-state.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-state.sh"

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

# ─── T1: happy path — plain body output ─────────────────────────────────────
echo "=== T1: happy path — plain body output ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"ok":true,"project":"test-proj","state":{"frontmatter":{"valid_from":"2026-04-21"},"body":"# State body content"},"valid_from":"2026-04-21"}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" "test-proj" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T1-exit-0"
else
  fail "T1-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "State body content"; then
  pass "T1-plain-body"
else
  fail "T1-plain-body: got: $output"
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

# ─── T4: --json emits {project, body, valid_from} ───────────────────────────
echo ""
echo "=== T4: --json emits structured object ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"ok":true,"project":"p","state":{"frontmatter":{},"body":"body text"},"valid_from":"2026-04-21"}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" --json "p" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T4-exit-0"
else
  fail "T4-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | jq -e '.project == "p" and .body == "body text" and .valid_from == "2026-04-21"' >/dev/null 2>&1; then
  pass "T4-json-shape"
else
  fail "T4-json-shape: got: $output"
fi
rm -rf "$tmp"

# ─── T5: non-existent project (state:null) → exit 0 with empty body ─────────
echo ""
echo "=== T5: state:null → exit 0 with empty output ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"ok":true,"project":"unknown","state":null,"valid_from":null}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" bash "$BIN" "unknown" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T5-exit-0"
else
  fail "T5-exit-0 (rc=$rc)"
fi
trimmed="$(echo "$output" | tr -d '[:space:]')"
if [ -z "$trimmed" ]; then
  pass "T5-empty-output"
else
  fail "T5-empty-output: got: $output"
fi
rm -rf "$tmp"

# ─── T6: respects $UM_SERVER_URL override ────────────────────────────────────
echo ""
echo "=== T6: \$UM_SERVER_URL override ==="
tmp=$(mktemp -d)
args_file="$tmp/curl-args"
_make_recording_curl "$tmp/bin" '{"ok":true,"project":"p","state":null,"valid_from":null}' "$args_file"
PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://custom:9999" bash "$BIN" "p" >/dev/null 2>&1 || true
if grep -q "http://custom:9999" "$args_file" 2>/dev/null; then
  pass "T6-url-override"
else
  fail "T6-url-override: $(cat "$args_file" 2>/dev/null || echo 'args file missing')"
fi
rm -rf "$tmp"

# ─── T7: $UM_PROJECT env fallback (no positional arg) ───────────────────────
echo ""
echo "=== T7: \$UM_PROJECT env fallback ==="
tmp=$(mktemp -d)
_make_mock_curl "$tmp/bin" '{"ok":true,"project":"env-proj","state":{"frontmatter":{},"body":"from-env"},"valid_from":null}'
output=$(PATH="$tmp/bin:$PATH" UM_SERVER_URL="http://mock" UM_PROJECT="env-proj" bash "$BIN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T7-exit-0"
else
  fail "T7-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "from-env"; then
  pass "T7-env-fallback"
else
  fail "T7-env-fallback: got: $output"
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

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-state.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
