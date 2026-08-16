#!/usr/bin/env bash
# bin/um-drain.test.sh — tests for um-drain.sh's spec §5 response taxonomy
# (checkpoint chunked summarization arc, PR-4/Task 11).
#
# Strategy: house MOCK_BIN style (see um-alert.test.sh) extended to THREE
# endpoints (checkpoint POST, stats GET, reindex POST) instead of one — a
# fake `curl` on PATH dispatches by URL suffix to a per-endpoint, per-call
# scripted response queue (extracted-python-not-jq + scripted-curl-stub
# pattern, per the task brief). A fake `sleep` on PATH makes every taxonomy
# branch's wait instant, so tests assert BRANCH=<marker> output tokens and
# call counts, never wall-clock (the sleep durations are exercised for real
# only by a human reading the source).
#
# Run: bash bin/um-drain.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-drain.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name — expected to contain '$needle', got: ${haystack:0:400}"; fi
}
assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"
  else fail "$name — expected NOT to contain '$needle'"; fi
}
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name — got='$got', want='$want'"; fi
}
count_occurrences() {
  # count_occurrences <haystack> <needle> — non-overlapping literal count.
  local haystack="$1" needle="$2" n=0 rest="$1"
  while [[ "$rest" == *"$needle"* ]]; do
    n=$((n + 1))
    rest="${rest#*"$needle"}"
  done
  echo "$n"
}

TMPDIR_ROOT=$(mktemp -d)
trap 'cd / && rm -rf "$TMPDIR_ROOT"' EXIT

# Throwaway cwd — never the repo (mirrors um-alert.test.sh's rationale: a
# Windows `py` first-run bootstrap can drop files into cwd).
WORK_DIR="$TMPDIR_ROOT/cwd"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR" || exit 1

HOME_DIR="$TMPDIR_ROOT/home"
mkdir -p "$HOME_DIR"

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
CAP_DIR="$TMPDIR_ROOT/captured"
mkdir -p "$MOCK_BIN" "$CAP_DIR"

# ─── Mock curl: dispatches by URL suffix to a per-endpoint response queue ───
cat > "$MOCK_BIN/curl" <<MOCK_EOF
#!/usr/bin/env bash
CAP_DIR="$CAP_DIR"
MOCK_EOF
cat >> "$MOCK_BIN/curl" <<'MOCK_EOF'
url=""
for arg in "$@"; do
  case "$arg" in http://*|https://*) url="$arg" ;; esac
done
case "$url" in
  */api/checkpoint) ep="checkpoint" ;;
  */api/stats)       ep="stats" ;;
  */api/reindex)     ep="reindex" ;;
  *) echo "mock curl: unrecognized URL: $url" >&2; exit 1 ;;
esac
count=$(cat "$CAP_DIR/${ep}_count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$CAP_DIR/${ep}_count"
printf '%s\n' "$@" > "$CAP_DIR/${ep}_args_$count"

file="$CAP_DIR/${ep}_q/$count"
if [ ! -f "$file" ]; then
  # Safety net for a test that under-queues — never hit by a correctly
  # written test, so no test asserts on this shape.
  printf '{}\n__UM_HTTP_CODE__200'
  exit 0
fi
if grep -q '^TRANSPORT_FAIL$' "$file" 2>/dev/null; then
  exit 7
fi
cat "$file"
exit 0
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

# Mock sleep: instant no-op — every taxonomy branch's wait resolves through
# this stub, so a test exercising 10 retries of a 60s wait still finishes
# immediately.
cat > "$MOCK_BIN/sleep" <<'MOCK_EOF'
#!/usr/bin/env bash
exit 0
MOCK_EOF
chmod +x "$MOCK_BIN/sleep"

# reset_endpoints — clear every queue + counter before each test case.
reset_endpoints() {
  rm -rf "$CAP_DIR/checkpoint_q" "$CAP_DIR/stats_q" "$CAP_DIR/reindex_q"
  rm -f "$CAP_DIR"/checkpoint_count "$CAP_DIR"/stats_count "$CAP_DIR"/reindex_count
  rm -f "$CAP_DIR"/checkpoint_args_* "$CAP_DIR"/stats_args_* "$CAP_DIR"/reindex_args_*
  mkdir -p "$CAP_DIR/checkpoint_q" "$CAP_DIR/stats_q" "$CAP_DIR/reindex_q"
  CKPT_PUSH_N=0
  STATS_PUSH_N=0
  REINDEX_PUSH_N=0
}

# q_ckpt <http_code> <json_body> — enqueue the next /api/checkpoint response.
q_ckpt() {
  CKPT_PUSH_N=$((CKPT_PUSH_N + 1))
  printf '%s\n__UM_HTTP_CODE__%s' "$2" "$1" > "$CAP_DIR/checkpoint_q/$CKPT_PUSH_N"
}
# q_ckpt_transport_fail — enqueue a transport failure (curl exit 7, UM_API_HTTP_CODE=000).
q_ckpt_transport_fail() {
  CKPT_PUSH_N=$((CKPT_PUSH_N + 1))
  printf 'TRANSPORT_FAIL\n' > "$CAP_DIR/checkpoint_q/$CKPT_PUSH_N"
}
# q_stats <http_code> <json_body> — enqueue the next /api/stats response
# (the FIRST enqueued response always serves the script's own pre-loop
# preflight-print GET — every test must queue at least one).
q_stats() {
  STATS_PUSH_N=$((STATS_PUSH_N + 1))
  printf '%s\n__UM_HTTP_CODE__%s' "$2" "$1" > "$CAP_DIR/stats_q/$STATS_PUSH_N"
}
# q_reindex <http_code> <json_body> — enqueue the next /api/reindex response.
q_reindex() {
  REINDEX_PUSH_N=$((REINDEX_PUSH_N + 1))
  printf '%s\n__UM_HTTP_CODE__%s' "$2" "$1" > "$CAP_DIR/reindex_q/$REINDEX_PUSH_N"
}

# run_drain [args...] — invokes um-drain.sh under the mock PATH + isolated
# HOME; captures combined output in $output, exit code in $rc. stdin is
# /dev/null (harmless when --yes is passed; exercises the decline path when
# it isn't).
run_drain() {
  output=$(PATH="$MOCK_BIN:$PATH" HOME="$HOME_DIR" UM_SERVER_URL="http://mock.example:6335" \
    UM_TOKEN_FILE="$HOME_DIR/.um/auth-token" \
    bash "$BIN" "$@" </dev/null 2>&1) && rc=0 || rc=$?
}

# A generic layers-block /api/stats body naming one project — reused by
# every test as the preflight-print GET (call #1 on the stats queue). The
# specific pending_bytes value is not asserted by most tests; it only
# matters for the 000-poll shrink tests, which queue their own values.
stats_body() {
  # stats_body <project> [pending_bytes]
  local p="$1" pb="${2:-5000}"
  printf '{"schema_version":1,"layers":{"%s":{"last_capture_at":"2026-08-15T00:00:00Z","last_summary_at":null,"last_state_at":null,"pending_bytes":%s,"stale":true,"lag_hours":10}}}' "$p" "$pb"
}

CKPT_OK_CONTINUE='{"ok":true,"chunks_done":1,"backlog_remaining":true}'
ckpt_complete() { printf '{"ok":true,"chunks_done":1,"backlog_remaining":false,"summary_path":"sessions/%s/session-x.md"}' "$1"; }

# ═══════════════════════════════════════════════════════════════════════════
# Preflight: server-version gate (spec §5)
# ═══════════════════════════════════════════════════════════════════════════

echo "=== T1: legacy 200 (no backlog_remaining, not abstention) => loud ABORT, exit 2 ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"summary_id":"x","summary_path":"sessions/proj-a/x.md"}'
run_drain --yes proj-a
assert_eq "T1: exit 2" "$rc" "2"
assert_contains "T1: ABORT message" "$output" "server predates chunked checkpoint"
assert_contains "T1: names v1.16" "$output" "v1.16"

echo ""
echo "=== T2: abstention envelope (skipped=thin_transcript) as FIRST response => NOT an abort ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"skipped":"thin_transcript","transcript_bytes":10,"transcript_turns":1}'
run_drain --yes proj-a
assert_eq "T2: exit 0 (complete, not aborted)" "$rc" "0"
assert_not_contains "T2: no ABORT" "$output" "ABORT"
assert_contains "T2: complete_thin_transcript branch" "$output" "BRANCH=complete_thin_transcript"

# ═══════════════════════════════════════════════════════════════════════════
# Every 200 taxonomy branch, first-match-wins (spec §5)
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T3: provider_ratelimit => sleep 65 (stubbed), continue ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"chunks_done":1,"backlog_remaining":true,"stopped":{"reason":"provider_ratelimit"}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T3: exit 0" "$rc" "0"
assert_contains "T3: BRANCH=provider_ratelimit" "$output" "BRANCH=provider_ratelimit"
assert_eq "T3: 2 checkpoint calls" "$(cat "$CAP_DIR/checkpoint_count")" "2"

echo ""
echo "=== T4: cost_cap => park until UTC midnight, exit 1 (incomplete) ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"chunks_done":1,"backlog_remaining":true,"stopped":{"reason":"cost_cap"}}'
run_drain --yes proj-a
assert_eq "T4: exit 1" "$rc" "1"
assert_contains "T4: BRANCH=cost_cap" "$output" "BRANCH=cost_cap"
assert_contains "T4: parking language" "$output" "parking proj-a until"
assert_contains "T4: report shows parked" "$output" "parked"
assert_eq "T4: exactly 1 checkpoint call (parked, does not loop)" "$(cat "$CAP_DIR/checkpoint_count")" "1"

echo ""
echo "=== T5: raw_lock => wait 30 (stubbed), continue ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"chunks_done":1,"backlog_remaining":true,"stopped":{"reason":"raw_lock"}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T5: exit 0" "$rc" "0"
assert_contains "T5: BRANCH=raw_lock" "$output" "BRANCH=raw_lock"

echo ""
echo "=== T6: chunk_cap => continue immediately (normal progress) ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"chunks_done":3,"backlog_remaining":true,"stopped":{"reason":"chunk_cap"}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T6: exit 0" "$rc" "0"
assert_contains "T6: BRANCH=chunk_cap" "$output" "BRANCH=chunk_cap"

echo ""
echo "=== T7: unrecognized stopped.reason => logged verbatim, wait 30, continue ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"chunks_done":1,"backlog_remaining":true,"stopped":{"reason":"some_future_reason"}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T7: exit 0" "$rc" "0"
assert_contains "T7: BRANCH=unrecognized_stopped_reason" "$output" "BRANCH=unrecognized_stopped_reason"
assert_contains "T7: reason logged verbatim" "$output" "reason=some_future_reason"

echo ""
echo "=== T8: backlog_remaining true, no stopped key => continue immediately ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 "$CKPT_OK_CONTINUE"
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T8: exit 0" "$rc" "0"
assert_contains "T8: BRANCH=continue_backlog_remaining" "$output" "BRANCH=continue_backlog_remaining"

echo ""
echo "=== T9: backlog_remaining false => complete, summary path collected ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T9: exit 0" "$rc" "0"
assert_contains "T9: BRANCH=complete" "$output" "BRANCH=complete"
assert_contains "T9: report shows complete" "$output" "proj-a: complete"

echo ""
echo "=== T10: thin_tail:true + backlog_remaining false => complete, thin_tail noted ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 '{"ok":true,"chunks_done":1,"backlog_remaining":false,"thin_tail":true,"summary_path":"sessions/proj-a/session-x.md"}'
run_drain --yes proj-a
assert_eq "T10: exit 0" "$rc" "0"
assert_contains "T10: thin_tail noted" "$output" "(thin_tail)"

echo ""
echo "=== T11: unexpected 200 shape (after version already confirmed) => stop + report ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 "$CKPT_OK_CONTINUE"
q_ckpt 200 '{"ok":true}'
run_drain --yes proj-a
assert_eq "T11: exit 1" "$rc" "1"
assert_contains "T11: BRANCH=unexpected_200_shape" "$output" "BRANCH=unexpected_200_shape"

# ═══════════════════════════════════════════════════════════════════════════
# Zero-progress guard: fires at EXACTLY 5 consecutive chunks_done=0 iterations
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T12: zero-progress guard fires at exactly 5 (raw_lock, chunks_done=0 each time) ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
for _i in 1 2 3 4 5; do
  q_ckpt 200 '{"ok":true,"chunks_done":0,"backlog_remaining":true,"stopped":{"reason":"raw_lock"}}'
done
run_drain --yes proj-a
assert_eq "T12: exit 1" "$rc" "1"
assert_eq "T12: exactly 5 checkpoint calls (stops before a 6th)" "$(cat "$CAP_DIR/checkpoint_count")" "5"
assert_eq "T12: exactly 5 raw_lock branch hits" "$(count_occurrences "$output" "BRANCH=raw_lock")" "5"
assert_eq "T12: exactly 1 zero_progress_guard hit" "$(count_occurrences "$output" "BRANCH=zero_progress_guard")" "1"
assert_contains "T12: report shows stopped/zero-progress" "$output" "zero-progress guard"

echo ""
echo "=== T12b: zero-progress guard does NOT fire on chunks_done>0 (real progress each time) ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
for _i in 1 2 3 4 5; do
  q_ckpt 200 '{"ok":true,"chunks_done":1,"backlog_remaining":true,"stopped":{"reason":"raw_lock"}}'
done
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T12b: exit 0 (guard never trips)" "$rc" "0"
assert_not_contains "T12b: no zero_progress_guard" "$output" "BRANCH=zero_progress_guard"

# ═══════════════════════════════════════════════════════════════════════════
# 502 branches
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T13: 502 stage=summarize provider_class=ratelimit => sleep 65, continue ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 "$CKPT_OK_CONTINUE"
q_ckpt 502 '{"ok":false,"error":{"code":"UPSTREAM_FAILURE","stage":"summarize","provider_class":"ratelimit","message":"rate limited"}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T13: exit 0" "$rc" "0"
assert_contains "T13: BRANCH=502_summarize_ratelimit" "$output" "BRANCH=502_summarize_ratelimit"

echo ""
echo "=== T14: 502 stage=reindex => POST /api/reindex {path}, succeeds, continue ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 "$CKPT_OK_CONTINUE"
q_ckpt 502 '{"ok":false,"error":{"code":"UPSTREAM_FAILURE","stage":"reindex","message":"reindex failed","summary_path":"sessions/proj-a/session-repair.md"}}'
q_reindex 200 '{"ok":true,"path":"sessions/proj-a/session-repair.md","id":"session-repair","indexed":true}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T14: exit 0" "$rc" "0"
assert_contains "T14: BRANCH=502_reindex_repair" "$output" "BRANCH=502_reindex_repair"
assert_contains "T14: repair success branch" "$output" "BRANCH=502_reindex_repair_success"
assert_eq "T14: exactly 1 reindex POST" "$(cat "$CAP_DIR/reindex_count")" "1"
assert_contains "T14: reindex body carries the envelope's summary_path" \
  "$(cat "$CAP_DIR/reindex_args_1" 2>/dev/null)" "session-repair.md"

echo ""
echo "=== T15: 502 stage=reindex => both repair attempts fail => stop project, report ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 502 '{"ok":false,"error":{"code":"UPSTREAM_FAILURE","stage":"reindex","message":"reindex failed","summary_path":"sessions/proj-a/session-repair.md"}}'
q_reindex 500 '{"ok":false,"error":{"code":"SERVER_INTERNAL","message":"boom"}}'
q_reindex 500 '{"ok":false,"error":{"code":"SERVER_INTERNAL","message":"boom again"}}'
run_drain --yes proj-a
assert_eq "T15: exit 1" "$rc" "1"
assert_contains "T15: repair exhausted branch" "$output" "BRANCH=502_reindex_repair_exhausted"
assert_eq "T15: exactly 2 reindex POST attempts (retry x2)" "$(cat "$CAP_DIR/reindex_count")" "2"
assert_eq "T15: no further checkpoint POST after exhaustion" "$(cat "$CAP_DIR/checkpoint_count")" "1"

echo ""
echo "=== T16: 502 with no recognized stage => stop project (anything-else fallback) ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 502 '{"ok":false,"error":{"code":"UPSTREAM_FAILURE","message":"some other upstream failure"}}'
run_drain --yes proj-a
assert_eq "T16: exit 1" "$rc" "1"
assert_contains "T16: BRANCH=502_other" "$output" "BRANCH=502_other"

# ═══════════════════════════════════════════════════════════════════════════
# 400 branches (body-string routed, not status-code routed)
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T17: 400 checkpoint_in_progress => wait 60, retry, then succeed ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 400 '{"ok":false,"error":{"code":"INPUT_INVALID","message":"checkpoint_in_progress"}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T17: exit 0" "$rc" "0"
assert_contains "T17: BRANCH=400_checkpoint_in_progress" "$output" "BRANCH=400_checkpoint_in_progress attempt=1"

echo ""
echo "=== T18: 400 checkpoint_in_progress exceeding 10 retries => stop project ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
for _i in $(seq 1 11); do
  q_ckpt 400 '{"ok":false,"error":{"code":"INPUT_INVALID","message":"checkpoint_in_progress"}}'
done
run_drain --yes proj-a
assert_eq "T18: exit 1" "$rc" "1"
assert_eq "T18: exactly 11 checkpoint calls (10 retries + the exhausting one)" \
  "$(cat "$CAP_DIR/checkpoint_count")" "11"
assert_contains "T18: exhausted branch" "$output" "BRANCH=400_checkpoint_in_progress_exhausted"

echo ""
echo "=== T19: 400 'cost cap hit' (run-start) => park until UTC midnight ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 400 '{"ok":false,"error":{"code":"INPUT_INVALID","message":"cost cap hit"}}'
run_drain --yes proj-a
assert_eq "T19: exit 1" "$rc" "1"
assert_contains "T19: BRANCH=400_cost_cap_hit" "$output" "BRANCH=400_cost_cap_hit"

echo ""
echo "=== T20: 400 other (real input error) => stop project ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 400 '{"ok":false,"error":{"code":"INPUT_INVALID","message":"invalid project name"}}'
run_drain --yes proj-a
assert_eq "T20: exit 1" "$rc" "1"
assert_contains "T20: BRANCH=400_other" "$output" "BRANCH=400_other"
assert_contains "T20: message surfaced" "$output" "invalid project name"

# ═══════════════════════════════════════════════════════════════════════════
# 000 (transport failure) => pending_bytes poll flow, max 3 consecutive
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T21: 000 with shrinking pending_bytes => keeps polling, eventually succeeds ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a 5000)"   # preflight print
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 4000)"   # 1st poll: baseline 4000
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 2000)"   # 2nd poll: shrank 4000 -> 2000
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T21: exit 0" "$rc" "0"
assert_contains "T21: first-poll branch" "$output" "BRANCH=000_first_poll"
assert_contains "T21: shrinking branch" "$output" "BRANCH=000_shrinking"
assert_eq "T21: 3 checkpoint calls" "$(cat "$CAP_DIR/checkpoint_count")" "3"

echo ""
echo "=== T22: 000 with non-shrinking pending_bytes => stops (server may be stuck) ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a 5000)"   # preflight print
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 4000)"   # 1st poll: baseline 4000
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 4000)"   # 2nd poll: unchanged (not shrunk)
run_drain --yes proj-a
assert_eq "T22: exit 1" "$rc" "1"
assert_contains "T22: not-shrinking branch" "$output" "BRANCH=000_not_shrinking"
assert_eq "T22: exactly 2 checkpoint calls (stopped, did not retry a 3rd)" \
  "$(cat "$CAP_DIR/checkpoint_count")" "2"

echo ""
echo "=== T23: 000 exceeds max 3 consecutive (kept shrinking, but capped) => stops ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a 5000)"   # preflight print
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 4000)"   # 1st poll: baseline
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 3000)"   # 2nd poll: shrank
q_ckpt_transport_fail
q_stats 200 "$(stats_body proj-a 2000)"   # 3rd poll: shrank
q_ckpt_transport_fail                     # 4th consecutive 000 => streak > 3, stop
run_drain --yes proj-a
assert_eq "T23: exit 1" "$rc" "1"
assert_contains "T23: exhausted branch" "$output" "BRANCH=000_exhausted"
assert_eq "T23: exactly 4 checkpoint calls" "$(cat "$CAP_DIR/checkpoint_count")" "4"

echo ""
echo "=== T24: anything-else HTTP status (e.g. 401) => stop project ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 401 '{"ok":false,"error":{"code":"AUTH_INVALID","message":"unauthorized"}}'
run_drain --yes proj-a
assert_eq "T24: exit 1" "$rc" "1"
assert_contains "T24: BRANCH=anything_else" "$output" "BRANCH=anything_else http=401"

# ═══════════════════════════════════════════════════════════════════════════
# --probe mode
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T25: --probe drains exactly one project, exits with paths + instruction ==="
reset_endpoints
q_stats 200 "$(stats_body proj-b)"
q_ckpt 200 "$(ckpt_complete proj-b)"
run_drain --yes --probe proj-b
assert_eq "T25: exit 0" "$rc" "0"
assert_contains "T25: probe complete banner" "$output" "Probe complete"
assert_contains "T25: produced summary path listed" "$output" "sessions/proj-b/session-x.md"
assert_contains "T25: re-run instruction" "$output" "review these, then re-run without --probe"
assert_not_contains "T25: no full verification checklist in probe mode" "$output" "Verification checklist"

echo ""
echo "=== T25b: --probe together with a positional list is rejected ==="
run_drain --probe proj-b proj-c
assert_eq "T25b: exit 2" "$rc" "2"
assert_contains "T25b: mutual-exclusion message" "$output" "drains exactly one project"

# ═══════════════════════════════════════════════════════════════════════════
# Confirm gate + argument validation
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T26: no --yes, closed stdin => declines, exit 2, ZERO POSTs ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
run_drain proj-a
assert_eq "T26: exit 2" "$rc" "2"
assert_contains "T26: aborted message" "$output" "aborted"
assert_eq "T26: zero checkpoint POSTs (never got past the gate)" \
  "$(cat "$CAP_DIR/checkpoint_count" 2>/dev/null || echo 0)" "0"

echo ""
echo "=== T27: --yes skips the confirm gate entirely ==="
reset_endpoints
q_stats 200 "$(stats_body proj-a)"
q_ckpt 200 "$(ckpt_complete proj-a)"
run_drain --yes proj-a
assert_eq "T27: exit 0" "$rc" "0"
assert_not_contains "T27: no confirm prompt text" "$output" "Proceed draining"

echo ""
echo "=== T28: no projects and no --probe => exit 2, usage shown ==="
run_drain
assert_eq "T28: exit 2" "$rc" "2"
assert_contains "T28: usage shown" "$output" "Usage:"

echo ""
echo "=== T29: --probe missing its value => exit 2 ==="
run_drain --probe
assert_eq "T29: exit 2" "$rc" "2"

echo ""
echo "=== T30: --help => exit 0, usage text ==="
run_drain --help
assert_eq "T30: exit 0" "$rc" "0"
assert_contains "T30: usage shown" "$output" "Usage:"

# ═══════════════════════════════════════════════════════════════════════════
# Multi-project worklist + verification checklist
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== T31: two-project worklist, both complete => exit 0, checklist printed ==="
reset_endpoints
q_stats 200 '{"schema_version":1,"layers":{"proj-a":{"last_capture_at":"2026-08-15T00:00:00Z","last_summary_at":null,"last_state_at":null,"pending_bytes":100,"stale":true,"lag_hours":1},"proj-c":{"last_capture_at":"2026-08-15T00:00:00Z","last_summary_at":null,"last_state_at":null,"pending_bytes":200,"stale":true,"lag_hours":1}}}'
q_ckpt 200 "$(ckpt_complete proj-a)"
q_ckpt 200 "$(ckpt_complete proj-c)"
run_drain --yes proj-a proj-c
assert_eq "T31: exit 0" "$rc" "0"
assert_contains "T31: verification checklist printed" "$output" "Verification checklist"
assert_contains "T31: both projects in report" "$output" "proj-a: complete"
assert_contains "T31: both projects in report (2)" "$output" "proj-c: complete"
assert_eq "T31: 2 checkpoint calls total" "$(cat "$CAP_DIR/checkpoint_count")" "2"

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "um-drain.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
