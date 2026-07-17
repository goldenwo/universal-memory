#!/usr/bin/env bash
# hooks/session-end.test.sh — tests for session-end.sh v2 (#159 T4: detached
# POST /api/checkpoint {project}; client summarizer retired).
#
# Run: bash session-end.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios (spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §5):
#   E1. Happy path — fixture-shaped stdin ⇒ ONE POST to /api/checkpoint with
#       body exactly {"project":"<cwd-basename>"} and --max-time 120 (the
#       checkpoint override, not the shared 10s); parent exits 0; the
#       DETACHED child logs `posted http=200` to hook.log.
#   E2. 403 (writes disabled) ⇒ skip=writes-disabled + G7 banner text logged.
#   E3. 5xx (500) ⇒ error=http-500 logged.
#   E4. 000 (unreachable/transport failure) ⇒ error=http-000 + G7
#       "server unreachable at <endpoint>" logged.
#   E5. Detach — mock curl sleeps 3s; the hook returns in <2s (does NOT wait
#       for the child), and the child's log line lands afterwards.
#   E6. Project sanitization — cwd basename with invalid chars ⇒
#       [^A-Za-z0-9._-] mapped to '-' (server hard-fails unsanitized slugs).
#   E7. Empty stdin ⇒ skip=empty-stdin, zero POSTs.
#   E8. 502 (checkpoint UPSTREAM_FAILURE: state.md WAS written, reindex
#       failed) ⇒ error=http-502 with the partial-success note.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_END="$SCRIPT_DIR/session-end.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

# ---------------------------------------------------------------------------
# Test harness (house style: inline helpers)
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s — %s\n' "$1" "${2:-}"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name" "got='$got', want='$want'"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name" "expected to contain '$needle', got '${haystack:0:200}'"; fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"
  else fail "$name" "expected NOT to contain '$needle'"; fi
}

# ---------------------------------------------------------------------------
# Environment probes + isolation setup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Resolve the same interpreter the hook will (py → python3 → python).
PYBIN=""
for _c in py python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c '' >/dev/null 2>&1; then
    PYBIN="$_c"; break
  fi
done
if [ -z "$PYBIN" ]; then
  echo "SKIP: no working python interpreter — session-end.sh tests need one" >&2
  exit 1
fi

# Convert a bash path to the platform-native shape (what Claude Code actually
# puts in cwd/transcript_path on Windows). No-op on Linux CI.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"
  else printf '%s' "$1"; fi
}

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
CAP_DIR="$TMPDIR_ROOT/captured"
mkdir -p "$MOCK_BIN" "$CAP_DIR"

# Mock curl: captures the URL, -d body, and FULL argv of every call to
# $CAP_DIR/{url,body,args}_N, then answers with the HTTP code from line N of
# $CAP_DIR/codes (default 200). Code 000 simulates a transport failure
# (exit 7, no output). Optional $CAP_DIR/sleep makes each call sleep that
# many seconds BEFORE responding (detach test). Counter at $CAP_DIR/count.
cat > "$MOCK_BIN/curl" <<MOCK_EOF
#!/usr/bin/env bash
CAP_DIR="$CAP_DIR"
MOCK_EOF
cat >> "$MOCK_BIN/curl" <<'MOCK_EOF'
count=$(cat "$CAP_DIR/count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$CAP_DIR/count"

url=""; body=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then body="$arg"; fi
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
  prev="$arg"
done
printf '%s' "$url"  > "$CAP_DIR/url_$count"
printf '%s' "$body" > "$CAP_DIR/body_$count"
printf '%s\n' "$@"  > "$CAP_DIR/args_$count"

naptime=$(cat "$CAP_DIR/sleep" 2>/dev/null)
if [ -n "$naptime" ]; then sleep "$naptime"; fi

code=$(sed -n "${count}p" "$CAP_DIR/codes" 2>/dev/null)
[ -n "$code" ] || code=200
if [ "$code" = "000" ]; then
  exit 7
fi
printf '{"ok":true}\n__UM_HTTP_CODE__%s' "$code"
exit 0
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

# reset_calls [codes...] — clear captured calls and set the per-call HTTP
# code sequence (one code per line; calls past the list get 200).
reset_calls() {
  rm -f "$CAP_DIR"/url_* "$CAP_DIR"/body_* "$CAP_DIR"/args_* \
        "$CAP_DIR/count" "$CAP_DIR/codes" "$CAP_DIR/sleep"
  local c
  for c in "$@"; do echo "$c" >> "$CAP_DIR/codes"; done
}

call_count() { cat "$CAP_DIR/count" 2>/dev/null || echo 0; }

# fresh_home <name> → prints a new isolated HOME path
fresh_home() {
  local d="$TMPDIR_ROOT/home_$1"
  mkdir -p "$d"
  printf '%s' "$d"
}

# make_stdin <session_id> <cwd(native)> — SessionEnd metadata JSON
# (fixtures/session-end-stdin.json shape).
make_stdin() {
  "$PYBIN" -c '
import json, sys
print(json.dumps({
    "session_id": sys.argv[1],
    "transcript_path": "C:\\Users\\x\\.claude\\projects\\p\\t.jsonl",
    "cwd": sys.argv[2],
    "hook_event_name": "SessionEnd",
    "reason": "other",
}))' "$1" "$2"
}

# run_session_end <home> <stdin_json> — run the hook isolated; mock curl
# first on PATH, deterministic endpoint, no token file. stdout+stderr →
# $RUN_OUT, exit code → $RUN_EXIT. The DETACHED child keeps running after
# this returns — use wait_for_log to observe its outcome.
run_session_end() {
  local home="$1" stdin_json="$2"
  RUN_EXIT=0
  RUN_OUT=$(HOME="$home" PATH="$MOCK_BIN:$PATH" \
    UM_SERVER_URL="http://mock.example:6335" \
    UM_TOKEN_FILE="$home/.um/auth-token" \
    bash "$SESSION_END" <<< "$stdin_json" 2>&1) || RUN_EXIT=$?
}

# wait_for_log <home> <needle> [timeout_s] — poll hook.log for the detached
# child's line. Returns 0 when found, 1 on timeout.
wait_for_log() {
  local home="$1" needle="$2" timeout="${3:-10}" i=0
  while [ "$i" -lt $((timeout * 10)) ]; do
    if grep -qF "$needle" "$home/.um/hook.log" 2>/dev/null; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

SID="e5f1a2b3-0000-4000-8000-000000000001"
CWD_N="$TMPDIR_ROOT/example-project"; mkdir -p "$CWD_N"

# Sanity: the checked-in stdin fixture stays in the shape make_stdin mirrors.
if [ -f "$FIXTURES/session-end-stdin.json" ]; then
  FIX_KEYS=$("$PYBIN" -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(",".join(sorted(k for k in ("session_id", "cwd", "hook_event_name") if k in d)))' \
    "$FIXTURES/session-end-stdin.json")
  assert_eq "fixture: session-end-stdin.json carries the contract fields" \
    "$FIX_KEYS" "cwd,hook_event_name,session_id"
fi

# ===========================================================================
# E1: Happy path — one POST /api/checkpoint, exact body, max-time 120
# ===========================================================================
echo "=== E1: happy path (detached checkpoint POST) ==="
H=$(fresh_home e1)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls
run_session_end "$H" "$STDIN"
assert_eq "E1: parent exits 0" "$RUN_EXIT" "0"
assert_eq "E1: parent produces no output" "$RUN_OUT" ""

if wait_for_log "$H" "posted http=200"; then
  pass "E1: child logs posted http=200"
else
  fail "E1: child logs posted http=200" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_eq "E1: exactly one POST" "$(call_count)" "1"
assert_eq "E1: POST targets /api/checkpoint" \
  "$(cat "$CAP_DIR/url_1" 2>/dev/null)" "http://mock.example:6335/api/checkpoint"
assert_eq "E1: body is exactly {\"project\":...}" \
  "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"example-project"}'
E1_ARGS=$(tr '\n' ' ' 2>/dev/null < "$CAP_DIR/args_1")
assert_contains "E1: curl uses the 120s checkpoint timeout" "$E1_ARGS" "--max-time 120 "
assert_not_contains "E1: NOT the shared 10s timeout" "$E1_ARGS" "--max-time 10 "
assert_contains "E1: log line attributed to session-end" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" " session-end "

# ===========================================================================
# E2: 403 writes-disabled ⇒ skip=writes-disabled + G7 banner in hook.log
# ===========================================================================
echo "=== E2: 403 writes-disabled ==="
H=$(fresh_home e2)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 403
run_session_end "$H" "$STDIN"
assert_eq "E2: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "skip=writes-disabled"; then
  pass "E2: skip=writes-disabled logged"
else
  fail "E2: skip=writes-disabled logged" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
if wait_for_log "$H" "captures are OFF"; then
  pass "E2: G7 writes-disabled banner in hook.log"
else
  fail "E2: G7 writes-disabled banner in hook.log" \
    "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_not_contains "E2: NOT misfiled as server-too-old" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" "server-too-old"

# ===========================================================================
# E3: 5xx ⇒ error=http-<code>
# ===========================================================================
echo "=== E3: 500 server error ==="
H=$(fresh_home e3)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 500
run_session_end "$H" "$STDIN"
assert_eq "E3: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "error=http-500"; then
  pass "E3: error=http-500 logged"
else
  fail "E3: error=http-500 logged" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

# ===========================================================================
# E4: unreachable (000) ⇒ error=http-000 + G7 unreachable banner
# ===========================================================================
echo "=== E4: unreachable (transport failure) ==="
H=$(fresh_home e4)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 000
run_session_end "$H" "$STDIN"
assert_eq "E4: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "error=http-000"; then
  pass "E4: error=http-000 logged"
else
  fail "E4: error=http-000 logged" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
if wait_for_log "$H" "server unreachable at http://mock.example:6335"; then
  pass "E4: G7 unreachable banner names the endpoint"
else
  fail "E4: G7 unreachable banner names the endpoint" \
    "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

# ===========================================================================
# E5: Detach — hook returns immediately while the child is still in-flight
# ===========================================================================
echo "=== E5: detach (parent does not wait for the child) ==="
H=$(fresh_home e5)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls
echo 3 > "$CAP_DIR/sleep"   # curl takes 3s — parent must not wait for it
E5_START=$(date +%s)
run_session_end "$H" "$STDIN"
E5_ELAPSED=$(( $(date +%s) - E5_START ))
assert_eq "E5: parent exits 0" "$RUN_EXIT" "0"
if [ "$E5_ELAPSED" -lt 2 ]; then
  pass "E5: parent returned in <2s while curl sleeps 3s (detached)"
else
  fail "E5: parent returned in <2s while curl sleeps 3s (detached)" "took ${E5_ELAPSED}s"
fi
E5_LOG_AT_EXIT=$(cat "$H/.um/hook.log" 2>/dev/null)
assert_not_contains "E5: child had NOT logged yet at parent exit" \
  "$E5_LOG_AT_EXIT" "posted http="
if wait_for_log "$H" "posted http=200"; then
  pass "E5: child completes and logs after the parent exited"
else
  fail "E5: child completes and logs after the parent exited" \
    "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

# ===========================================================================
# E6: Project sanitization — invalid cwd-basename chars mapped to '-'
# ===========================================================================
echo "=== E6: project sanitization ==="
H=$(fresh_home e6)
CWD_SPACE="$TMPDIR_ROOT/my project"; mkdir -p "$CWD_SPACE"
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_SPACE")")

reset_calls
run_session_end "$H" "$STDIN"
assert_eq "E6: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "posted http=200"; then
  pass "E6: child posted"
else
  fail "E6: child posted" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_eq "E6: project slug sanitized ('my project' -> 'my-project')" \
  "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"my-project"}'

# ===========================================================================
# E7: Empty stdin ⇒ skip=empty-stdin, zero POSTs
# ===========================================================================
echo "=== E7: empty stdin ==="
H=$(fresh_home e7)

reset_calls
RUN_EXIT=0
RUN_OUT=$(HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  bash "$SESSION_END" </dev/null 2>&1) || RUN_EXIT=$?
assert_eq "E7: exit 0" "$RUN_EXIT" "0"
assert_eq "E7: zero POSTs" "$(call_count)" "0"
assert_contains "E7: skip=empty-stdin logged" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=empty-stdin"

# ===========================================================================
# E8: 502 UPSTREAM_FAILURE ⇒ error=http-502 + partial-success note
# (state.md WAS written server-side; only the vector index is stale)
# ===========================================================================
echo "=== E8: 502 checkpoint upstream failure (partial success) ==="
H=$(fresh_home e8)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 502
run_session_end "$H" "$STDIN"
assert_eq "E8: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "error=http-502"; then
  pass "E8: error=http-502 logged"
else
  fail "E8: error=http-502 logged" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
if wait_for_log "$H" "state-written-index-stale"; then
  pass "E8: partial-success note (state written, index stale)"
else
  fail "E8: partial-success note (state written, index stale)" \
    "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

# ===========================================================================
# Summary
# ===========================================================================
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
