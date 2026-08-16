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
if echo "$output" | grep -q "STALE" && echo "$output" | grep -q "also layers stale" \
  && echo "$output" | grep -q "universal-memory"; then
  pass "T28-message-names-both"
else
  fail "T28-message-names-both: $output"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "um-alert.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
