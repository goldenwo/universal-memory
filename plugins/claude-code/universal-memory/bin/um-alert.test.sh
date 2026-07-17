#!/usr/bin/env bash
# bin/um-alert.test.sh — verify um-alert.sh's capture-freshness exit taxonomy
# (#171 Stage A, spec §4 / A3). Run: bash bin/um-alert.test.sh
#
# Strategy: house MOCK_BIN style — a fake `curl` on PATH serves canned
# /api/stats JSON in um-api.sh's wire format (body + __UM_HTTP_CODE__<code>
# sentinel line), under an isolated HOME so no real ~/.um config leaks in.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-alert.sh"

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Isolated HOME (no ~/.um endpoint/token leakage) shared by every case.
HOME_DIR="$TMPDIR_ROOT/home"
mkdir -p "$HOME_DIR"

# Helper: write a mock curl emitting canned body + um-api.sh's HTTP-code
# sentinel (matches _um_api_request's `-w '\n__UM_HTTP_CODE__%{http_code}'`).
_make_mock_curl() {
  local dir="$1" http_code="$2" body="$3"
  mkdir -p "$dir"
  printf '%s\n__UM_HTTP_CODE__%s\n' "$body" "$http_code" > "$dir/response.txt"
  cat > "$dir/curl" <<EOF
#!/bin/bash
cat "$dir/response.txt"
exit 0
EOF
  chmod +x "$dir/curl"
}

# Helper: mock curl that fails at transport level (exit 7, no output) —
# um-api.sh maps that to UM_API_HTTP_CODE=000.
_make_dead_curl() {
  local dir="$1"
  mkdir -p "$dir"
  printf '#!/bin/bash\nexit 7\n' > "$dir/curl"
  chmod +x "$dir/curl"
}

# Helper: recording mock curl — saves args, serves canned 200 body.
_make_recording_curl() {
  local dir="$1" body="$2" args_file="$3"
  mkdir -p "$dir"
  printf '%s\n__UM_HTTP_CODE__200\n' "$body" > "$dir/response.txt"
  cat > "$dir/curl" <<EOF
#!/bin/bash
echo "\$@" > "$args_file"
cat "$dir/response.txt"
exit 0
EOF
  chmod +x "$dir/curl"
}

# run_alert <mock_dir> [args...] — invokes um-alert.sh under the isolated HOME
# with the mock on PATH; captures combined output in $output, exit in $rc.
run_alert() {
  local mock_dir="$1"; shift
  output=$(PATH="$mock_dir:$PATH" HOME="$HOME_DIR" UM_SERVER_URL="http://mock" \
    UM_ENDPOINT="" bash "$BIN" "$@" 2>&1) && rc=0 || rc=$?
}

# Canned /api/stats bodies (real route shape: capture keyed by surface).
FRESH_AND_STALE='{"schema_version":1,"generated_at":"2026-07-17T12:00:00Z","capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}},"discord-bot":{"last_day_seen":"2026-07-10","freshness_hours":150.5,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'
ALL_STALE='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-10","freshness_hours":150.5,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}},"discord-bot":{"last_day_seen":"2026-07-01","freshness_hours":366.2,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'
EMPTY_CAPTURE='{"schema_version":1,"capture":{}}'
DEGRADED='{"schema_version":1,"capture":null,"degraded":["counters-unavailable"]}'
BOUNDARY_EXACT='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-16","freshness_hours":26,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'
BOUNDARY_OVER='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-16","freshness_hours":26.1,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'

# ─── T1: fresh-any — one fresh + one stale surface ⇒ exit 0 ─────────────────
echo "=== T1: any-mode, one surface fresh ⇒ exit 0 ==="
mock="$TMPDIR_ROOT/t1"; _make_mock_curl "$mock" 200 "$FRESH_AND_STALE"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T1-exit-0"
else
  fail "T1-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "OK"; then
  pass "T1-ok-message"
else
  fail "T1-ok-message: $output"
fi

# ─── T2: fresh-named — --surface names the fresh surface ⇒ exit 0 ───────────
echo ""
echo "=== T2: --surface fresh ⇒ exit 0 ==="
mock="$TMPDIR_ROOT/t2"; _make_mock_curl "$mock" 200 "$FRESH_AND_STALE"
run_alert "$mock" --surface claude-code-plugin
if [ "$rc" -eq 0 ]; then
  pass "T2-exit-0"
else
  fail "T2-exit-0 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "claude-code-plugin"; then
  pass "T2-names-surface"
else
  fail "T2-names-surface: $output"
fi

# ─── T3: stale-any — ALL surfaces exceed N ⇒ exit 1, message content ────────
echo ""
echo "=== T3: any-mode, all stale ⇒ exit 1 + message names freshest ==="
mock="$TMPDIR_ROOT/t3"; _make_mock_curl "$mock" 200 "$ALL_STALE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T3-exit-1"
else
  fail "T3-exit-1 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "STALE"; then
  pass "T3-stale-marker"
else
  fail "T3-stale-marker: $output"
fi
# Freshest surface (claude-code-plugin, 150.5h, last seen 2026-07-10) is named
# with its last_day_seen and freshness value (A3 message contract).
if echo "$output" | grep -q "claude-code-plugin" \
  && echo "$output" | grep -q "2026-07-10" \
  && echo "$output" | grep -q "150.5"; then
  pass "T3-message-content"
else
  fail "T3-message-content: $output"
fi

# ─── T4: stale-named — named surface stale while another is fresh ⇒ exit 1 ──
echo ""
echo "=== T4: --surface stale (other surface fresh) ⇒ exit 1 ==="
mock="$TMPDIR_ROOT/t4"; _make_mock_curl "$mock" 200 "$FRESH_AND_STALE"
run_alert "$mock" --surface discord-bot
if [ "$rc" -eq 1 ]; then
  pass "T4-exit-1"
else
  fail "T4-exit-1 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "discord-bot" \
  && echo "$output" | grep -q "2026-07-10" \
  && echo "$output" | grep -q "150.5"; then
  pass "T4-message-content"
else
  fail "T4-message-content: $output"
fi

# ─── T5: --surface never seen at all ⇒ exit 1 (maximally stale) ─────────────
echo ""
echo "=== T5: --surface with no capture rows ⇒ exit 1 ==="
mock="$TMPDIR_ROOT/t5"; _make_mock_curl "$mock" 200 "$FRESH_AND_STALE"
run_alert "$mock" --surface never-seen
if [ "$rc" -eq 1 ]; then
  pass "T5-exit-1"
else
  fail "T5-exit-1 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "never-seen"; then
  pass "T5-names-surface"
else
  fail "T5-names-surface: $output"
fi

# ─── T6: empty capture section (no surfaces ever) ⇒ exit 1 ──────────────────
echo ""
echo "=== T6: empty capture {} ⇒ exit 1 (no captures at all = the incident) ==="
mock="$TMPDIR_ROOT/t6"; _make_mock_curl "$mock" 200 "$EMPTY_CAPTURE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T6-exit-1"
else
  fail "T6-exit-1 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -qi "no captures"; then
  pass "T6-message"
else
  fail "T6-message: $output"
fi

# ─── T7: degraded capture:null ⇒ exit 2 (check can't SEE freshness) ─────────
echo ""
echo "=== T7: capture:null degraded ⇒ exit 2, not exit 1 ==="
mock="$TMPDIR_ROOT/t7"; _make_mock_curl "$mock" 200 "$DEGRADED"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T7-exit-2"
else
  fail "T7-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -qi "degraded"; then
  pass "T7-message"
else
  fail "T7-message: $output"
fi

# ─── T8: transport failure (curl dies, code 000) ⇒ exit 2 ───────────────────
echo ""
echo "=== T8: unreachable (UM_API_HTTP_CODE=000) ⇒ exit 2 ==="
mock="$TMPDIR_ROOT/t8"; _make_dead_curl "$mock"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T8-exit-2"
else
  fail "T8-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -qi "unreachable"; then
  pass "T8-message"
else
  fail "T8-message: $output"
fi

# ─── T9: 401 auth rejection ⇒ exit 2 with auth-specific message ─────────────
echo ""
echo "=== T9: 401 ⇒ exit 2 ==="
mock="$TMPDIR_ROOT/t9"; _make_mock_curl "$mock" 401 '{"error":"unauthorized"}'
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T9-exit-2"
else
  fail "T9-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -qi "auth"; then
  pass "T9-message"
else
  fail "T9-message: $output"
fi

# ─── T10: garbage JSON body ⇒ exit 2 ────────────────────────────────────────
echo ""
echo "=== T10: unparseable JSON ⇒ exit 2 ==="
mock="$TMPDIR_ROOT/t10"; _make_mock_curl "$mock" 200 'this is not json {'
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T10-exit-2"
else
  fail "T10-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -qi "unparseable\|parse"; then
  pass "T10-message"
else
  fail "T10-message: $output"
fi

# ─── T11: threshold boundary — freshness == N is fresh, > N is stale ────────
echo ""
echo "=== T11: boundary (freshness == N ⇒ 0; freshness > N ⇒ 1) ==="
mock="$TMPDIR_ROOT/t11a"; _make_mock_curl "$mock" 200 "$BOUNDARY_EXACT"
run_alert "$mock" --max-age-hours 26
if [ "$rc" -eq 0 ]; then
  pass "T11-exact-fresh"
else
  fail "T11-exact-fresh (rc=$rc, out=$output)"
fi
mock="$TMPDIR_ROOT/t11b"; _make_mock_curl "$mock" 200 "$BOUNDARY_OVER"
run_alert "$mock" --max-age-hours 26
if [ "$rc" -eq 1 ]; then
  pass "T11-over-stale"
else
  fail "T11-over-stale (rc=$rc, out=$output)"
fi

# ─── T12: --server override reaches the given URL ───────────────────────────
echo ""
echo "=== T12: --server override hits <url>/api/stats ==="
mock="$TMPDIR_ROOT/t12"; args_file="$TMPDIR_ROOT/t12-args"
_make_recording_curl "$mock" "$FRESH_AND_STALE" "$args_file"
PATH="$mock:$PATH" HOME="$HOME_DIR" UM_SERVER_URL="http://mock" UM_ENDPOINT="" \
  bash "$BIN" --server "http://custom:9999" >/dev/null 2>&1 || true
if grep -q "http://custom:9999/api/stats" "$args_file" 2>/dev/null; then
  pass "T12-server-override"
else
  fail "T12-server-override: $(cat "$args_file" 2>/dev/null || echo 'args file missing')"
fi

# ─── T13: --help exits 0 with usage ─────────────────────────────────────────
echo ""
echo "=== T13: --help ==="
output=$(bash "$BIN" --help 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "T13-help-exit-0"
else
  fail "T13-help-exit-0 (rc=$rc)"
fi
if echo "$output" | grep -q "Usage:"; then
  pass "T13-help-text"
else
  fail "T13-help-text: $output"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-alert.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
