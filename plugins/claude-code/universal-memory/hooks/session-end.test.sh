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
# Response body override (Task 11: stage-keyed 502 note tests need control
# over the JSON body, not just the HTTP code) — default stays exactly
# {"ok":true} so every pre-existing test's mock behavior is unchanged.
resp_body=$(cat "$CAP_DIR/response_body" 2>/dev/null)
[ -n "$resp_body" ] || resp_body='{"ok":true}'
printf '%s\n__UM_HTTP_CODE__%s' "$resp_body" "$code"
exit 0
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

# reset_calls [codes...] — clear captured calls and set the per-call HTTP
# code sequence (one code per line; calls past the list get 200).
reset_calls() {
  rm -f "$CAP_DIR"/url_* "$CAP_DIR"/body_* "$CAP_DIR"/args_* \
        "$CAP_DIR/count" "$CAP_DIR/codes" "$CAP_DIR/sleep" "$CAP_DIR/response_body"
  local c
  for c in "$@"; do echo "$c" >> "$CAP_DIR/codes"; done
}

# set_response_body <json> — override the response body every mock curl call
# in this test case serves (until the next reset_calls). Task 11: the
# stage-keyed 502 note tests need to control error.stage in the body.
set_response_body() {
  printf '%s' "$1" > "$CAP_DIR/response_body"
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
# #186: project dirs in fixtures carry a .git marker — the non-project guard
# skips marker-less cwds by design; these fixtures test POSTing mechanics.
CWD_N="$TMPDIR_ROOT/example-project"; mkdir -p "$CWD_N/.git"

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
CWD_SPACE="$TMPDIR_ROOT/my project"; mkdir -p "$CWD_SPACE/.git"
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
# E9/E10/E11 (Task 11, checkpoint chunked summarization spec §4.7): the 502
# note is now keyed off the response body's additive error.stage field, not
# blanket-printed on every 502. E8 above (default mock body {"ok":true}, no
# error object at all) already covers the THIRD case — legacy server, no
# stage field — and still gets the note; these three make the other two
# explicit and prove stage="summarize" suppresses it.
# ===========================================================================
echo "=== E9: 502 error.stage=reindex ⇒ note PRESENT (state written, index stale) ==="
H=$(fresh_home e9)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 502
set_response_body '{"ok":false,"error":{"code":"UPSTREAM_FAILURE","stage":"reindex","message":"reindex retries exhausted"}}'
run_session_end "$H" "$STDIN"
assert_eq "E9: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "error=http-502"; then
  pass "E9: error=http-502 logged"
else
  fail "E9: error=http-502 logged" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
if wait_for_log "$H" "state-written-index-stale"; then
  pass "E9: note present for stage=reindex"
else
  fail "E9: note present for stage=reindex" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

echo "=== E10: 502 error.stage=summarize ⇒ note ABSENT (nothing was written) ==="
H=$(fresh_home e10)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 502
set_response_body '{"ok":false,"error":{"code":"UPSTREAM_FAILURE","stage":"summarize","provider_class":"ratelimit","message":"rate limited"}}'
run_session_end "$H" "$STDIN"
assert_eq "E10: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "error=http-502"; then
  pass "E10: error=http-502 logged"
else
  fail "E10: error=http-502 logged" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
if wait_for_log "$H" "stage=summarize"; then
  pass "E10: stage=summarize logged plainly"
else
  fail "E10: stage=summarize logged plainly" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_not_contains "E10: NOT the partial-success note (nothing was written)" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" "state-written-index-stale"

echo "=== E11: 502 with an unparseable body ⇒ still degrades to the note (fail toward the safe legacy reading) ==="
H=$(fresh_home e11)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")

reset_calls 502
set_response_body 'not valid json {'
run_session_end "$H" "$STDIN"
assert_eq "E11: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "state-written-index-stale"; then
  pass "E11: unparseable body degrades to the note (same as absent stage)"
else
  fail "E11: unparseable body degrades to the note (same as absent stage)" \
    "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

# ===========================================================================
# G1 (#186 follow-up): cwd == $HOME ⇒ routed to the catch-all 'desktop'
# project — general desktop-app chats carry real content; the server's
# thin-transcript gate independently kills the zero-turn auxiliary sessions.
# Never a home-basename slug.
# ===========================================================================
echo "=== G1 (#186): home cwd routes to the desktop catch-all ==="
H=$(fresh_home g1)
STDIN=$(make_stdin "$SID" "$(native_path "$H")")

reset_calls
run_session_end "$H" "$STDIN"
assert_eq "G1: parent exits 0" "$RUN_EXIT" "0"
if wait_for_log "$H" "posted http=200"; then
  pass "G1: child posted"
else
  fail "G1: child posted" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_eq "G1: slug is the desktop catch-all, not the home basename" \
  "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"desktop"}'

# G1b: UM_HOME_PROJECT= (explicit empty) reverts to skipping home sessions.
H=$(fresh_home g1b)
STDIN=$(make_stdin "$SID" "$(native_path "$H")")
reset_calls
RUN_EXIT=0
RUN_OUT=$(HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  UM_HOME_PROJECT="" \
  bash "$SESSION_END" <<< "$STDIN" 2>&1) || RUN_EXIT=$?
assert_eq "G1b: zero POSTs with UM_HOME_PROJECT= (opt-out)" "$(call_count)" "0"
assert_contains "G1b: skip=home-cwd logged" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=home-cwd"

# G1c: UM_HOME_PROJECT=chats overrides the catch-all name (sanitized slug).
H=$(fresh_home g1c)
STDIN=$(make_stdin "$SID" "$(native_path "$H")")
reset_calls
RUN_EXIT=0
RUN_OUT=$(HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  UM_HOME_PROJECT="chats" \
  bash "$SESSION_END" <<< "$STDIN" 2>&1) || RUN_EXIT=$?
if wait_for_log "$H" "posted http=200"; then
  pass "G1c: child posted under the override name"
else
  fail "G1c: child posted under the override name" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_eq "G1c: slug honors UM_HOME_PROJECT" \
  "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"chats"}'

# ===========================================================================
# G2 (#186): marker-less cwd ⇒ skip=non-project-cwd, ZERO POSTs
# ===========================================================================
echo "=== G2 (#186): marker-less cwd skips ==="
H=$(fresh_home g2)
CWD_BARE="$TMPDIR_ROOT/scratch-no-markers"; mkdir -p "$CWD_BARE"
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_BARE")")

reset_calls
run_session_end "$H" "$STDIN"
assert_eq "G2: parent exits 0" "$RUN_EXIT" "0"
assert_eq "G2: zero POSTs" "$(call_count)" "0"
assert_contains "G2: skip=non-project-cwd logged" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=non-project-cwd"

# ===========================================================================
# G3 (#186): subdir of a project (marker at the root) ⇒ walk-up finds it,
# POSTs with the SUBDIR basename (slug behavior unchanged from pre-guard).
# ===========================================================================
echo "=== G3 (#186): project subdir posts via marker walk-up ==="
H=$(fresh_home g3)
CWD_SUB="$CWD_N/src/deep"; mkdir -p "$CWD_SUB"
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_SUB")")

reset_calls
run_session_end "$H" "$STDIN"
if wait_for_log "$H" "posted http=200"; then
  pass "G3: child posted"
else
  fail "G3: child posted" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_eq "G3: slug is the cwd basename (not the project root)" \
  "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"deep"}'

# ===========================================================================
# G4 (#186): MSYS-form home cwd (/c/Users/<u>) must normalize and route to
# the desktop catch-all like the native form (Windows only; skipped on CI).
# ===========================================================================
echo "=== G4 (#186): MSYS-form home cwd routes to desktop (Windows only) ==="
if command -v cygpath >/dev/null 2>&1; then
  H=$(fresh_home g4)
  MSYS_HOME=$(cygpath -u "$H")
  STDIN=$(make_stdin "$SID" "$MSYS_HOME")

  reset_calls
  run_session_end "$H" "$STDIN"
  if wait_for_log "$H" "posted http=200"; then
    pass "G4: MSYS-form home posted"
  else
    fail "G4: MSYS-form home posted" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
  fi
  assert_eq "G4: MSYS-form home routes to the desktop catch-all" \
    "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"desktop"}'
else
  pass "G4: skipped (no cygpath — POSIX platform has no MSYS forms)"
fi

# ===========================================================================
# G5 (#186): UM_PROJECT_MARKERS override — custom marker qualifies, and the
# default list no longer applies when overridden.
# ===========================================================================
echo "=== G5 (#186): UM_PROJECT_MARKERS override ==="
H=$(fresh_home g5)
CWD_CUSTOM="$TMPDIR_ROOT/custom-marker-proj"; mkdir -p "$CWD_CUSTOM"
touch "$CWD_CUSTOM/.myproj"
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_CUSTOM")")

reset_calls
RUN_EXIT=0
RUN_OUT=$(HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  UM_TOKEN_FILE="$H/.um/auth-token" \
  UM_PROJECT_MARKERS=".myproj" \
  bash "$SESSION_END" <<< "$STDIN" 2>&1) || RUN_EXIT=$?
if wait_for_log "$H" "posted http=200"; then
  pass "G5: custom marker qualifies the dir"
else
  fail "G5: custom marker qualifies the dir" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi

# Same override, .git-only dir: default markers must NOT apply when overridden.
H=$(fresh_home g5b)
STDIN=$(make_stdin "$SID" "$(native_path "$CWD_N")")
reset_calls
RUN_EXIT=0
RUN_OUT=$(HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  UM_TOKEN_FILE="$H/.um/auth-token" \
  UM_PROJECT_MARKERS=".myproj" \
  bash "$SESSION_END" <<< "$STDIN" 2>&1) || RUN_EXIT=$?
assert_eq "G5b: .git dir skips under an override that excludes it" "$(call_count)" "0"

# ===========================================================================
# G6 (#186): empty meta.cwd ⇒ fallback leg is guarded too. Fallback resolves
# to the hook process pwd: marker-less pwd skips, project pwd posts.
# ===========================================================================
echo "=== G6 (#186): guarded fallback leg (empty meta.cwd) ==="
H=$(fresh_home g6)
STDIN_NOCWD=$("$PYBIN" -c '
import json
print(json.dumps({
    "session_id": "e5f1a2b3-0000-4000-8000-000000000001",
    "transcript_path": "C:\\Users\\x\\.claude\\projects\\p\\t.jsonl",
    "cwd": "",
    "hook_event_name": "SessionEnd",
    "reason": "other",
}))')

reset_calls
RUN_EXIT=0
RUN_OUT=$(cd "$CWD_BARE" && HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  bash "$SESSION_END" <<< "$STDIN_NOCWD" 2>&1) || RUN_EXIT=$?
assert_eq "G6: marker-less pwd fallback skips (fail closed)" "$(call_count)" "0"
assert_contains "G6: skip=non-project-cwd logged" \
  "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=non-project-cwd"

H=$(fresh_home g6b)
reset_calls
RUN_EXIT=0
RUN_OUT=$(cd "$CWD_N" && HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  bash "$SESSION_END" <<< "$STDIN_NOCWD" 2>&1) || RUN_EXIT=$?
if wait_for_log "$H" "posted http=200"; then
  pass "G6b: project pwd fallback still posts"
else
  fail "G6b: project pwd fallback still posts" "hook.log: $(cat "$H/.um/hook.log" 2>/dev/null)"
fi
assert_eq "G6b: slug from fallback pwd" \
  "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '{"project":"example-project"}'

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
