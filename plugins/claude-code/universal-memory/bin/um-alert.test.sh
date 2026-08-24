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
trap 'cd / && rm -rf "$TMPDIR_ROOT"' EXIT

# Run every um-alert.sh spawn from a throwaway cwd, never the repo: the script
# resolves its inputs from absolute paths, and a child that writes anything
# relative (a Windows `py` bootstrap drops a whole runtime into CWD on first
# probe) must not litter the working tree. Mirrors control-page.test.mjs's
# runUmAlert. Everything below uses absolute paths, so one cd covers all cases.
WORK_DIR="$TMPDIR_ROOT/cwd"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR" || exit 1

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

# U2.6 fixtures — payload carries capture_freshness_threshold_hours (the
# field U2.5 added to /api/stats). PAYLOAD_THRESH_1 uses a non-26 value (1)
# on a surface that's stale-under-1h-but-fresh-under-26h (2h), so the verdict
# only flips to STALE if the payload threshold is actually being read (the
# old hardcoded-26 default would have called this FRESH). PAYLOAD_THRESH_0
# uses a deliberate 0 on a 0.5h-stale surface — a `field or 26` bug would
# coerce 0 to 26 and misreport FRESH.
PAYLOAD_THRESH_1='{"schema_version":1,"capture_freshness_threshold_hours":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":2,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'
PAYLOAD_THRESH_0='{"schema_version":1,"capture_freshness_threshold_hours":0,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0.5,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'

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

# ─── T14: bare "." for --max-age-hours ⇒ arg-error message + exit 2 ─────────
# (regression: "." passes the digit/dot glob guards but would make float(".")
# throw an uncaught error and fall through to the misleading "internal parser"
# exit-2 message instead of the clean arg-error one.)
echo ""
echo "=== T14: --max-age-hours . ⇒ arg-error + exit 2 ==="
output=$(bash "$BIN" --max-age-hours . 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "T14-exit-2"
else
  fail "T14-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "must be a number"; then
  pass "T14-arg-error-message"
else
  fail "T14-arg-error-message: $output"
fi

# ─── T16: 404 ⇒ "server too old" (skew taxonomy), exit 2 ───────────────────
# Found by the U5 keyed run: a server predating /api/stats returned a generic
# "returned HTTP 404" instead of the actionable upgrade message the hooks and
# installer probes use for the same condition.
echo ""
echo "=== T16: 404 ⇒ server-too-old message + exit 2 ==="
mock="$TMPDIR_ROOT/t16"; _make_mock_curl "$mock" 404 '{"error":"not found"}'
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T16-exit-2"
else
  fail "T16-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "server too old"; then
  pass "T16-upgrade-message"
else
  fail "T16-upgrade-message: $output"
fi

# ─── T15: missing/empty option values ⇒ exit 2 (NEVER 1) ───────────────────
# In the documented `um-alert.sh || <notify>` cron shape, exit 1 = STALE. A
# typo'd invocation must not page "your capture pipeline is dead" — bash's
# ${2:?...} would have exited 1, the wrong class.
echo ""
echo "=== T15: missing/empty option value ⇒ exit 2, not 1 ==="
for _case in "--max-age-hours" "--surface" "--server"; do
  output=$(bash "$BIN" $_case 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 2 ]; then
    pass "T15-missing-value-exit-2 ($_case)"
  else
    fail "T15-missing-value-exit-2 ($_case): rc=$rc (1 would falsely mean STALE), out=$output"
  fi
done
output=$(bash "$BIN" --max-age-hours "" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "T15-empty-value-exit-2"
else
  fail "T15-empty-value-exit-2: rc=$rc, out=$output"
fi

# ─── T17: payload threshold used when no --max-age-hours is given (U2.6) ────
# PAYLOAD_THRESH_1's surface is 2h stale — FRESH under the old hardcoded 26,
# but the payload's own capture_freshness_threshold_hours is 1, so a correct
# read of the field flips the verdict to STALE. This is the single-source-of-
# truth regression guard: it fails if the script ever goes back to ignoring
# the field.
echo ""
echo "=== T17: no CLI flag ⇒ payload's capture_freshness_threshold_hours(1) used, not 26 ==="
mock="$TMPDIR_ROOT/t17"; _make_mock_curl "$mock" 200 "$PAYLOAD_THRESH_1"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T17-payload-threshold-honored"
else
  fail "T17-payload-threshold-honored (rc=$rc, out=$output) — old-26 default would wrongly give rc=0"
fi
if echo "$output" | grep -q "within 1h"; then
  pass "T17-message-shows-threshold"
else
  fail "T17-message-shows-threshold: $output"
fi

# ─── T18: CLI --max-age-hours beats a differing payload threshold ──────────
# Same PAYLOAD_THRESH_1 (payload says 1) but the operator explicitly passes
# 26 — CLI must win per the precedence contract, flipping back to FRESH.
echo ""
echo "=== T18: --max-age-hours 26 beats payload's 1 ⇒ exit 0 (CLI wins) ==="
mock="$TMPDIR_ROOT/t18"; _make_mock_curl "$mock" 200 "$PAYLOAD_THRESH_1"
run_alert "$mock" --max-age-hours 26
if [ "$rc" -eq 0 ]; then
  pass "T18-cli-overrides-payload"
else
  fail "T18-cli-overrides-payload (rc=$rc, out=$output)"
fi

# ─── T19: payload threshold 0 is honored as 0, not coerced to 26 ───────────
# The `is None` vs falsy subtlety (R3-C-N2 #2): a naive `field or 26` would
# turn a deliberate payload 0 into 26, making a 0.5h-stale surface read FRESH.
echo ""
echo "=== T19: payload threshold 0 ⇒ 0.5h surface is STALE, not coerced to 26 ==="
mock="$TMPDIR_ROOT/t19"; _make_mock_curl "$mock" 200 "$PAYLOAD_THRESH_0"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T19-payload-zero-honored"
else
  fail "T19-payload-zero-honored (rc=$rc, out=$output) — 'field or 26' bug would wrongly give rc=0"
fi
if echo "$output" | grep -q "within 0h"; then
  pass "T19-message-shows-zero"
else
  fail "T19-message-shows-zero: $output"
fi

# ─── T20: field absent (old server) ⇒ falls back to 26, no CLI flag needed ──
# BOUNDARY_EXACT/BOUNDARY_OVER predate capture_freshness_threshold_hours (no
# such key in the fixture) — same behavior as T11's explicit --max-age-hours
# 26 must hold via the fallback alone, proving "absent field → 26" without
# relying on the operator passing anything.
echo ""
echo "=== T20: no threshold field + no CLI flag ⇒ 26 fallback (old-server case) ==="
mock="$TMPDIR_ROOT/t20a"; _make_mock_curl "$mock" 200 "$BOUNDARY_EXACT"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T20-exact-fresh-fallback"
else
  fail "T20-exact-fresh-fallback (rc=$rc, out=$output)"
fi
mock="$TMPDIR_ROOT/t20b"; _make_mock_curl "$mock" 200 "$BOUNDARY_OVER"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T20-over-stale-fallback"
else
  fail "T20-over-stale-fallback (rc=$rc, out=$output)"
fi

# ─── Task 10 (spec §6) fixtures: the `layers` block ─────────────────────────
# FRESH capture verdict (freshness_hours 0) in every fixture below, so any
# exit-1/exit-2 the LAYERS section produces is provably ITS OWN escalation,
# not a leftover from the capture-freshness verdict.
FRESH_CAPTURE='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}}}'

LAYERS_STALE='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{"universal-memory":{"last_capture_at":"2026-08-04T09:00:00.000Z","last_summary_at":"2026-07-30T08:00:00.000Z","last_state_at":null,"pending_bytes":7000,"stale":true,"lag_hours":121.0},"edge-catcher":{"last_capture_at":"2026-08-15T09:00:00.000Z","last_summary_at":"2026-08-15T08:00:00.000Z","last_state_at":"2026-08-15T08:00:00.000Z","pending_bytes":0,"stale":false,"lag_hours":1.0}}}'

LAYERS_ALL_FRESH='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{"edge-catcher":{"last_capture_at":"2026-08-15T09:00:00.000Z","last_summary_at":"2026-08-15T08:00:00.000Z","last_state_at":"2026-08-15T08:00:00.000Z","pending_bytes":0,"stale":false,"lag_hours":1.0}}}'

LAYERS_EMPTY='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{}}'

LAYERS_MALFORMED_NOT_OBJECT='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":[]}'

LAYERS_MALFORMED_STALE_FIELD='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{"broken-project":{"last_capture_at":"2026-08-15T09:00:00.000Z","pending_bytes":100,"stale":"yes"}}}'

# A FRESH capture verdict combined with a STALE layers block, so an old
# server (no layers key) reading exit 0 must NOT match a T21 fixture — this
# fixture doubles as the STALE half of the ABSENT-vs-present contrast below.
STALE_CAPTURE_AND_LAYERS='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-01","freshness_hours":1000,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"layers":{"universal-memory":{"last_capture_at":"2026-08-04T09:00:00.000Z","last_summary_at":"2026-07-30T08:00:00.000Z","last_state_at":null,"pending_bytes":7000,"stale":true,"lag_hours":121.0}}}'

# Already-STALE capture verdict (freshness_hours 1000) PLUS malformed layers
# — T27 proves the layers ERROR override fires even when the base verdict is
# ALREADY non-zero, not just when it would otherwise be FRESH.
STALE_CAPTURE_MALFORMED_LAYERS='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-01","freshness_hours":1000,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"layers":[]}'

# Review round 1, IMPORTANT 2 fixtures — P1: layers-unavailable (the whole
# captures/ dir was unreadable; layers is a well-shaped but EMPTY object).
LAYERS_P1_UNAVAILABLE='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{},"degraded":["layers-unavailable"]}'

# P2: layers-partial — one project succeeded (and is itself fresh, so the
# STALE/OK taxonomy alone would say "OK") while the degraded flag names the
# omitted one.
LAYERS_P2_PARTIAL='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{"edge-catcher":{"last_capture_at":"2026-08-15T09:00:00.000Z","last_summary_at":"2026-08-15T08:00:00.000Z","last_state_at":"2026-08-15T08:00:00.000Z","pending_bytes":0,"stale":false,"lag_hours":1.0}},"degraded":["layers-partial"]}'

# P2b: layers-partial COMBINED with a real stale project — proves the
# breadcrumb and the STALE escalation are orthogonal (both fire together).
LAYERS_P2_PARTIAL_PLUS_STALE='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{"universal-memory":{"last_capture_at":"2026-08-04T09:00:00.000Z","last_summary_at":"2026-07-30T08:00:00.000Z","last_state_at":null,"pending_bytes":7000,"stale":true,"lag_hours":121.0}},"degraded":["layers-partial"]}'

# MINOR 7: a never-checkpointed project's lag_hours is the JSON STRING
# "Infinity" (layers.mjs's sentinel — JSON has no Infinity literal).
LAYERS_INFINITE_LAG='{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"claude-code-plugin":{"last_day_seen":"2026-08-15","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":1,"superseded":0,"error":0}}},"layers":{"tmp-project":{"last_capture_at":"2026-08-04T09:00:00.000Z","last_summary_at":null,"last_state_at":null,"pending_bytes":999999,"stale":true,"lag_hours":"Infinity"}}}'

# ─── T21: layers block names a stale project ⇒ FRESH capture verdict is ESCALATED to exit 1 ──
echo ""
echo "=== T21: FRESH capture + layers stale ⇒ escalated to exit 1 ==="
mock="$TMPDIR_ROOT/t21"; _make_mock_curl "$mock" 200 "$LAYERS_STALE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T21-exit-1"
else
  fail "T21-exit-1 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "LAYERS-STALE" && echo "$output" | grep -q "universal-memory" \
  && echo "$output" | grep -q "121" && echo "$output" | grep -q "7000"; then
  pass "T21-message-content (project + lag + pending_bytes)"
else
  fail "T21-message-content: $output"
fi

# ─── T22: layers block present with no stale project ⇒ no escalation ────────
echo ""
echo "=== T22: FRESH capture + layers all-fresh ⇒ exit 0, unescalated ==="
mock="$TMPDIR_ROOT/t22"; _make_mock_curl "$mock" 200 "$LAYERS_ALL_FRESH"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T22-exit-0"
else
  fail "T22-exit-0 (rc=$rc, out=$output)"
fi

# ─── T23: layers:{} (zero projects with captures yet) ⇒ no escalation ───────
echo ""
echo "=== T23: layers:{} (no projects yet) ⇒ exit 0, unescalated ==="
mock="$TMPDIR_ROOT/t23"; _make_mock_curl "$mock" 200 "$LAYERS_EMPTY"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T23-exit-0"
else
  fail "T23-exit-0 (rc=$rc, out=$output)"
fi

# ─── T24: layers key ABSENT (old server) ⇒ breadcrumb + exit code UNCHANGED ──
echo ""
echo "=== T24a: layers key absent, capture FRESH ⇒ breadcrumb + exit 0 (unchanged) ==="
mock="$TMPDIR_ROOT/t24a"; _make_mock_curl "$mock" 200 "$FRESH_CAPTURE"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T24a-exit-0-unchanged"
else
  fail "T24a-exit-0-unchanged (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "layers key absent" && echo "$output" | grep -q "v1.16"; then
  pass "T24a-breadcrumb"
else
  fail "T24a-breadcrumb: $output"
fi

echo ""
echo "=== T24b: layers key absent, capture ALREADY STALE ⇒ breadcrumb + exit 1 (unchanged) ==="
mock="$TMPDIR_ROOT/t24b"; _make_mock_curl "$mock" 200 "$ALL_STALE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T24b-exit-1-unchanged"
else
  fail "T24b-exit-1-unchanged (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "layers key absent"; then
  pass "T24b-breadcrumb"
else
  fail "T24b-breadcrumb: $output"
fi

# ─── T25: layers PRESENT but malformed (not an object) ⇒ exit 2 CHECK-FAILED ─
echo ""
echo "=== T25: layers: [] (wrong type) ⇒ exit 2, unconditionally ==="
mock="$TMPDIR_ROOT/t25"; _make_mock_curl "$mock" 200 "$LAYERS_MALFORMED_NOT_OBJECT"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T25-exit-2"
else
  fail "T25-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -qi "CHECK FAILED"; then
  pass "T25-message"
else
  fail "T25-message: $output"
fi

# ─── T26: a layers project entry with a malformed `stale` field ⇒ exit 2 ────
echo ""
echo "=== T26: a project's stale field is not a bool ⇒ exit 2, loud, never silently dropped ==="
mock="$TMPDIR_ROOT/t26"; _make_mock_curl "$mock" 200 "$LAYERS_MALFORMED_STALE_FIELD"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T26-exit-2"
else
  fail "T26-exit-2 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "broken-project"; then
  pass "T26-names-project"
else
  fail "T26-names-project: $output"
fi

# ─── T27: malformed layers OVERRIDES an otherwise-STALE capture verdict ─────
# (the capture verdict alone would already be exit 1; layers ERROR must still
# win with exit 2 — a malformed monitor deserves its own loud failure class,
# not to be silently absorbed into "yep, still stale").
echo ""
echo "=== T27: malformed layers overrides an already-STALE capture verdict ⇒ exit 2, not 1 ==="
mock="$TMPDIR_ROOT/t27"; _make_mock_curl "$mock" 200 "$STALE_CAPTURE_MALFORMED_LAYERS"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then
  pass "T27-exit-2-overrides-stale"
else
  fail "T27-exit-2-overrides-stale (rc=$rc, out=$output)"
fi

# ─── T28: capture ALREADY stale + layers ALSO stale ⇒ exit 1, both named ────
echo ""
echo "=== T28: capture stale + layers stale ⇒ exit 1, message names both ==="
mock="$TMPDIR_ROOT/t28"; _make_mock_curl "$mock" 200 "$STALE_CAPTURE_AND_LAYERS"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T28-exit-1"
else
  fail "T28-exit-1 (rc=$rc, out=$output)"
fi
# #267 print-all re-contract (deliberate, review-logged — NOT a relaxation):
# the old inline "; also layers stale: X" combined string became a separate
# "um-alert: LAYERS-STALE — X" escalation line when the STALE arm went
# print-all. Same semantic content pinned: both sections named, exit 1.
if echo "$output" | grep -q "STALE —" && echo "$output" | grep -q "LAYERS-STALE" \
  && echo "$output" | grep -q "universal-memory"; then
  pass "T28-message-names-both"
else
  fail "T28-message-names-both: $output"
fi

# ─── T29 (IMPORTANT 2, P1): layers-unavailable ⇒ breadcrumb present, exit UNCHANGED ──
echo ""
echo "=== T29: degraded=[layers-unavailable] (layers:{}) ⇒ breadcrumb printed, exit 0 unchanged ==="
mock="$TMPDIR_ROOT/t29"; _make_mock_curl "$mock" 200 "$LAYERS_P1_UNAVAILABLE"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T29-exit-0-unchanged"
else
  fail "T29-exit-0-unchanged (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "layers check degraded" && echo "$output" | grep -q "layers-unavailable" \
  && echo "$output" | grep -qi "INCOMPLETE"; then
  pass "T29-breadcrumb"
else
  fail "T29-breadcrumb: $output"
fi

# ─── T30 (IMPORTANT 2, P2): layers-partial (no stale project) ⇒ breadcrumb present, exit UNCHANGED ──
echo ""
echo "=== T30: degraded=[layers-partial], no stale project in the partial data ⇒ breadcrumb printed, exit 0 unchanged ==="
mock="$TMPDIR_ROOT/t30"; _make_mock_curl "$mock" 200 "$LAYERS_P2_PARTIAL"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then
  pass "T30-exit-0-unchanged"
else
  fail "T30-exit-0-unchanged (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "layers check degraded" && echo "$output" | grep -q "layers-partial"; then
  pass "T30-breadcrumb"
else
  fail "T30-breadcrumb: $output"
fi

# ─── T31: layers-partial breadcrumb AND a real stale escalation fire TOGETHER (orthogonal) ──
echo ""
echo "=== T31: degraded=[layers-partial] PLUS a real stale project ⇒ both the breadcrumb and the exit-1 escalation fire ==="
mock="$TMPDIR_ROOT/t31"; _make_mock_curl "$mock" 200 "$LAYERS_P2_PARTIAL_PLUS_STALE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T31-exit-1-still-escalates"
else
  fail "T31-exit-1-still-escalates (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "layers check degraded" && echo "$output" | grep -q "layers-partial" \
  && echo "$output" | grep -q "LAYERS-STALE" && echo "$output" | grep -q "universal-memory"; then
  pass "T31-both-signals-present"
else
  fail "T31-both-signals-present: $output"
fi

# ─── T32 (MINOR 7): an infinite lag renders as "never", never the literal "Infinityh" ──
echo ""
echo '=== T32: lag_hours:"Infinity" renders as "never", not "Infinityh" ==='
mock="$TMPDIR_ROOT/t32"; _make_mock_curl "$mock" 200 "$LAYERS_INFINITE_LAG"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then
  pass "T32-exit-1"
else
  fail "T32-exit-1 (rc=$rc, out=$output)"
fi
if echo "$output" | grep -q "lag never" && echo "$output" | grep -q "tmp-project"; then
  pass "T32-never-rendered"
else
  fail "T32-never-rendered: $output"
fi
if echo "$output" | grep -q "Infinityh"; then
  fail "T32-no-literal-infinityh: the raw JSON sentinel leaked into the operator-facing message: $output"
else
  pass "T32-no-literal-infinityh"
fi

# ─── #267 SIGNALS section fixtures ──────────────────────────────────────────
# Fresh capture base reused; signals grafted per-case. The existing fixtures
# above carry NO `signals` key and take the ABSENT branch — that is the
# pass-2 FCP "safety fact": the pre-#267 matrix stays green untouched.
FRESH_CAPTURE_ONLY='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'
SIG_OK='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"signals":{"capture_anomaly":{}}}'
SIG_ALERT_FRESH='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"signals":{"capture_anomaly":{"claude-code-plugin":{"last_day_seen":"2026-07-17","count_7d":3,"reasons_7d":{"no-transcript":0,"empty-delta-stalled":0,"empty-delta-filtered":2,"nothing-extracted":0,"bad-stdin":0,"empty-stdin":0,"no-python":0,"other":1}}}}}'
SIG_ALERT_STALE='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-10","freshness_hours":150.5,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"signals":{"capture_anomaly":{"claude-code-plugin":{"last_day_seen":"2026-07-17","count_7d":1,"reasons_7d":{"empty-delta-stalled":1}}}}}'
SIG_MALFORMED='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"signals":"garbage"}'
SIG_NULL_CAPTURE_PRESENT='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"signals":null}'
SIG_MISSING_FAMILY_KEY='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"signals":{}}'
SIG_NULL_CAPTURE_NULL='{"schema_version":1,"capture":null,"degraded":["counters-unavailable"],"signals":null}'
SIG_ALERT_PLUS_LAYERS_STALE='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"layers":{"universal-memory":{"stale":true,"lag_hours":40.2,"pending_bytes":9000}},"signals":{"capture_anomaly":{"claude-code-plugin":{"last_day_seen":"2026-07-17","count_7d":2,"reasons_7d":{"no-transcript":2}}}}}'
LAYERS_MALFORMED_SIG_ALERT='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"layers":"garbage","signals":{"capture_anomaly":{"claude-code-plugin":{"last_day_seen":"2026-07-17","count_7d":1,"reasons_7d":{"no-python":1}}}}}'
SIG_MALFORMED_LAYERS_STALE='{"schema_version":1,"capture":{"claude-code-plugin":{"last_day_seen":"2026-07-17","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}},"layers":{"universal-memory":{"stale":true,"lag_hours":40.2,"pending_bytes":9000}},"signals":"garbage"}'

# ─── T33: signals ALERT on a FRESH capture verdict ⇒ exit 1, SIGNALS text ───
echo ""
echo "=== T33: signals count_7d>0 + fresh capture ⇒ exit 1, SIGNALS line names surface+reason ==="
mock="$TMPDIR_ROOT/t33"; _make_mock_curl "$mock" 200 "$SIG_ALERT_FRESH"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then pass "T33-exit-1"; else fail "T33-exit-1 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "SIGNALS" && echo "$output" | grep -q "claude-code-plugin" \
  && echo "$output" | grep -q "empty-delta-filtered"; then
  pass "T33-signals-text"
else
  fail "T33-signals-text: $output"
fi

# ─── T34: signals empty ⇒ exit 0 unchanged ──────────────────────────────────
echo ""
echo "=== T34: signals {capture_anomaly:{}} + fresh ⇒ exit 0, OK ==="
mock="$TMPDIR_ROOT/t34"; _make_mock_curl "$mock" 200 "$SIG_OK"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then pass "T34-exit-0"; else fail "T34-exit-0 (rc=$rc, out=$output)"; fi

# ─── T35: signals key ABSENT (old server) ⇒ breadcrumb, verdict untouched ───
echo ""
echo "=== T35: no signals key ⇒ ABSENT breadcrumb, exit 0 unchanged ==="
mock="$TMPDIR_ROOT/t35"; _make_mock_curl "$mock" 200 "$FRESH_CAPTURE_ONLY"
run_alert "$mock"
if [ "$rc" -eq 0 ]; then pass "T35-exit-0-unchanged"; else fail "T35-exit-0-unchanged (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "signals key absent"; then
  pass "T35-breadcrumb"
else
  fail "T35-breadcrumb: $output"
fi

# ─── T36: malformed signals ⇒ CHECK FAILED exit 2 ───────────────────────────
echo ""
echo "=== T36: signals garbage string ⇒ exit 2 CHECK FAILED ==="
mock="$TMPDIR_ROOT/t36"; _make_mock_curl "$mock" 200 "$SIG_MALFORMED"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then pass "T36-exit-2"; else fail "T36-exit-2 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "CHECK FAILED"; then pass "T36-check-failed-text"; else fail "T36-check-failed-text: $output"; fi

# ─── T37: signals null while capture present ⇒ exit 2 (drift tripwire) ──────
echo ""
echo "=== T37: signals:null + capture present ⇒ exit 2 ==="
mock="$TMPDIR_ROOT/t37"; _make_mock_curl "$mock" 200 "$SIG_NULL_CAPTURE_PRESENT"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then pass "T37-exit-2"; else fail "T37-exit-2 (rc=$rc, out=$output)"; fi

# ─── T38: signals present but missing capture_anomaly key ⇒ exit 2 ──────────
echo ""
echo "=== T38: signals:{} (no capture_anomaly key) ⇒ exit 2 (D9 drift tripwire) ==="
mock="$TMPDIR_ROOT/t38"; _make_mock_curl "$mock" 200 "$SIG_MISSING_FAMILY_KEY"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then pass "T38-exit-2"; else fail "T38-exit-2 (rc=$rc, out=$output)"; fi

# ─── T39: signals null + capture null ⇒ counters-degraded path ──────────────
echo ""
echo "=== T39: signals:null + capture:null ⇒ exit 2 via the capture verdict ==="
mock="$TMPDIR_ROOT/t39"; _make_mock_curl "$mock" 200 "$SIG_NULL_CAPTURE_NULL"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then pass "T39-exit-2"; else fail "T39-exit-2 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "freshness cannot be assessed"; then
  pass "T39-capture-verdict-carries-it"
else
  fail "T39-capture-verdict-carries-it: $output"
fi

# ─── T40: PRINT-ALL — signals alert + layers stale both named, one exit 1 ───
echo ""
echo "=== T40: signals alert + layers stale on FRESH capture ⇒ exit 1, BOTH lines present ==="
mock="$TMPDIR_ROOT/t40"; _make_mock_curl "$mock" 200 "$SIG_ALERT_PLUS_LAYERS_STALE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then pass "T40-exit-1"; else fail "T40-exit-1 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "SIGNALS" && echo "$output" | grep -q "LAYERS-STALE"; then
  pass "T40-both-sections-named"
else
  fail "T40-both-sections-named: $output"
fi

# ─── T41: STALE capture + signals alert ⇒ exit 1, both named ────────────────
echo ""
echo "=== T41: stale capture + signals alert ⇒ exit 1, STALE and SIGNALS both present ==="
mock="$TMPDIR_ROOT/t41"; _make_mock_curl "$mock" 200 "$SIG_ALERT_STALE"
run_alert "$mock"
if [ "$rc" -eq 1 ]; then pass "T41-exit-1"; else fail "T41-exit-1 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "STALE" && echo "$output" | grep -q "SIGNALS"; then
  pass "T41-both-present"
else
  fail "T41-both-present: $output"
fi

# ─── T42: exit-2 paths still echo live alert text ───────────────────────────
echo ""
echo "=== T42a: layers malformed + signals alert ⇒ exit 2 AND the SIGNALS line echoed ==="
mock="$TMPDIR_ROOT/t42a"; _make_mock_curl "$mock" 200 "$LAYERS_MALFORMED_SIG_ALERT"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then pass "T42a-exit-2"; else fail "T42a-exit-2 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "SIGNALS" && echo "$output" | grep -q "no-python"; then
  pass "T42a-signals-echoed"
else
  fail "T42a-signals-echoed: $output"
fi
echo ""
echo "=== T42b: signals malformed + layers stale ⇒ exit 2 AND the LAYERS-STALE line echoed (mirror) ==="
mock="$TMPDIR_ROOT/t42b"; _make_mock_curl "$mock" 200 "$SIG_MALFORMED_LAYERS_STALE"
run_alert "$mock"
if [ "$rc" -eq 2 ]; then pass "T42b-exit-2"; else fail "T42b-exit-2 (rc=$rc, out=$output)"; fi
if echo "$output" | grep -q "LAYERS-STALE"; then
  pass "T42b-layers-echoed"
else
  fail "T42b-layers-echoed: $output"
fi

# ─── T43: --surface does NOT suppress SIGNALS (health sections are global) ──
echo ""
echo "=== T43: --surface names a fresh surface, signals alert present ⇒ still exit 1 ==="
mock="$TMPDIR_ROOT/t43"; _make_mock_curl "$mock" 200 "$SIG_ALERT_FRESH"
run_alert "$mock" --surface claude-code-plugin
if [ "$rc" -eq 1 ]; then pass "T43-exit-1"; else fail "T43-exit-1 (rc=$rc, out=$output)"; fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-alert.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
