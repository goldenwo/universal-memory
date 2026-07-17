#!/usr/bin/env bash
# hooks/stop.test.sh — tests for stop.sh v2 (#159 T3: transcript delta cursor
# → one POST per message to /api/append-turn).
#
# Run: bash stop.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios (spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §5):
#   S1.  Happy path — fixture stdin + fixture transcript ⇒ one POST per eligible
#        message with exact {project, content, role, timestamp} bodies; cursor
#        advances to the transcript's full line count.
#   S2.  A2 happy half — second fire on the same transcript ⇒ ZERO new POSTs.
#   S3.  A2 failure half — 5xx on POST #2 of 3 ⇒ cursor at last-acked (#1);
#        next fire against a healthy server sends exactly #2 and #3.
#   S4.  Delta-cap — >6 new eligible messages ⇒ exactly 6 POSTs +
#        skip=delta-capped; next fire sends the remainder.
#   S5.  Truncation — content >8192 bytes ⇒ POSTed content ≤8192 bytes,
#        skip=truncated logged, POST still made.
#   S6.  403 ⇒ no cursor advance, skip=writes-disabled logged, G7 stderr, exit 0.
#   S7.  Unreachable (curl transport failure) ⇒ error=http-000, G7 stderr, exit 0.
#   S8.  Skip rules — isMeta / isSidechain / system-reminder / tool_result /
#        thinking-only / type:system / synthetic isApiErrorMessage lines are
#        never POSTed (fixture lines 1,3,4,5,7,9,10,11).
#   S9.  Invalid session_id ⇒ skip=bad-session-id, no POSTs, no cursor file.
#   S10. Cursor age sweep — >7d-old cursor removed; fresh cursor kept;
#        invalid-named old file left alone (glob guard).
#   S11. stop_hook_active=true ⇒ exit 0, zero POSTs (loop guard).
#   S12. UM_IN_SUMMARIZER_SUBPROCESS=1 ⇒ exit 0, zero POSTs (recursion guard).

unset UM_IN_SUMMARIZER_SUBPROCESS

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP="$SCRIPT_DIR/stop.sh"
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

assert_file_exists() {
  local name="$1" path="$2"
  if [ -f "$path" ]; then pass "$name"
  else fail "$name" "file not found: $path"; fi
}

assert_file_missing() {
  local name="$1" path="$2"
  if [ ! -f "$path" ]; then pass "$name"
  else fail "$name" "file should not exist: $path"; fi
}

# ---------------------------------------------------------------------------
# Environment probes + isolation setup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Resolve the same interpreter the hook will (py → python3 → python). Needed
# to build stdin JSON / synthetic transcripts with correct escaping.
PYBIN=""
for _c in py python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c '' >/dev/null 2>&1; then
    PYBIN="$_c"; break
  fi
done
if [ -z "$PYBIN" ]; then
  echo "SKIP: no working python interpreter — stop.sh tests need one" >&2
  exit 1
fi

# Convert a bash path to the platform-native shape (what Claude Code actually
# puts in transcript_path on Windows). No-op on Linux CI.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"
  else printf '%s' "$1"; fi
}

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
CAP_DIR="$TMPDIR_ROOT/captured"
mkdir -p "$MOCK_BIN" "$CAP_DIR"

# Mock curl: captures the URL and -d body of every call to $CAP_DIR/url_N +
# $CAP_DIR/body_N, then answers with the HTTP code from line N of
# $CAP_DIR/codes (default 200). Code 000 simulates a transport failure
# (exit 7, no output). Counter at $CAP_DIR/count.
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

code=$(sed -n "${count}p" "$CAP_DIR/codes" 2>/dev/null)
[ -n "$code" ] || code=200
if [ "$code" = "000" ]; then
  exit 7
fi
printf '{"ok":true}\n__UM_HTTP_CODE__%s' "$code"
case "$code" in
  2[0-9][0-9]) exit 0 ;;
  *) exit 0 ;;  # real curl exits 0 on HTTP errors without -f
esac
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

# reset_calls [codes...] — clear captured calls and set the per-call HTTP
# code sequence (one code per line; calls past the list get 200).
reset_calls() {
  rm -f "$CAP_DIR"/url_* "$CAP_DIR"/body_* "$CAP_DIR/count" "$CAP_DIR/codes"
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

# make_stdin <session_id> <transcript_path(native)> <cwd(native)> [stop_hook_active]
make_stdin() {
  "$PYBIN" -c '
import json, sys
print(json.dumps({
    "session_id": sys.argv[1],
    "transcript_path": sys.argv[2],
    "cwd": sys.argv[3],
    "permission_mode": "default",
    "hook_event_name": "Stop",
    "stop_hook_active": sys.argv[4] == "true",
}))' "$1" "$2" "$3" "${4:-false}"
}

# run_stop <home> <stdin_json> — run stop.sh isolated; mock curl first on
# PATH, deterministic endpoint, no token file. stdout+stderr → $RUN_OUT,
# exit code → $RUN_EXIT.
run_stop() {
  local home="$1" stdin_json="$2"
  RUN_EXIT=0
  RUN_OUT=$(HOME="$home" PATH="$MOCK_BIN:$PATH" \
    UM_SERVER_URL="http://mock.example:6335" \
    UM_TOKEN_FILE="$home/.um/auth-token" \
    bash "$STOP" <<< "$stdin_json" 2>&1) || RUN_EXIT=$?
}

# body_field <n> <field> — extract a field from captured body N as text.
body_field() {
  "$PYBIN" -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    b = json.load(fh)
v = b.get(sys.argv[2])
sys.stdout.write("" if v is None else str(v))' "$CAP_DIR/body_$1" "$2"
}

# write_transcript <path> <n_eligible> [content_prefix] — synthesize a
# transcript with n alternating user/assistant eligible messages (one JSONL
# line each, no filler lines).
write_transcript() {
  "$PYBIN" -c '
import json, sys
path, n = sys.argv[1], int(sys.argv[2])
prefix = sys.argv[3] if len(sys.argv) > 3 else "msg"
with open(path, "w", encoding="utf-8") as fh:
    for i in range(1, n + 1):
        role = "user" if i % 2 == 1 else "assistant"
        e = {
            "parentUuid": None, "isSidechain": False, "type": role,
            "message": {"role": role, "content": f"{prefix}-{i} content"},
            "uuid": f"u-{i}", "timestamp": f"2026-07-17T14:{i:02d}:00.000Z",
            "sessionId": "s", "version": "2.1.193", "cwd": "/tmp/p",
        }
        fh.write(json.dumps(e) + "\n")' "$1" "$2" "${3:-msg}"
}

FIXTURE_TRANSCRIPT="$FIXTURES/transcript-sample.jsonl"
SID="e5f1a2b3-0000-4000-8000-000000000001"

# ===========================================================================
# S1: Happy path — fixture transcript ⇒ 4 POSTs with exact bodies + cursor
# ===========================================================================
echo "=== S1: happy path (fixture transcript) ==="
H=$(fresh_home s1)
TP="$TMPDIR_ROOT/s1-transcript.jsonl"
cp "$FIXTURE_TRANSCRIPT" "$TP"
CWD_N="$TMPDIR_ROOT/example-project"; mkdir -p "$CWD_N"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")

reset_calls
run_stop "$H" "$STDIN"

assert_eq "S1: exit 0" "$RUN_EXIT" "0"
assert_eq "S1: exactly 4 POSTs (fixture eligible lines 2,6,8,12)" "$(call_count)" "4"
assert_contains "S1: POSTs target /api/append-turn" "$(cat "$CAP_DIR/url_1" 2>/dev/null)" "http://mock.example:6335/api/append-turn"

assert_eq "S1: body1 role=user"       "$(body_field 1 role)" "user"
assert_eq "S1: body1 project"         "$(body_field 1 project)" "example-project"
assert_eq "S1: body1 content"         "$(body_field 1 content)" "Please review the config loader and fix the failing test in server/test."
assert_eq "S1: body1 timestamp"       "$(body_field 1 timestamp)" "2026-07-17T14:00:00.100Z"
assert_eq "S1: body2 role=assistant"  "$(body_field 2 role)" "assistant"
assert_eq "S1: body2 content (text block only, no tool_use)" "$(body_field 2 content)" "Let me read the config loader first."
assert_eq "S1: body3 role=assistant"  "$(body_field 3 role)" "assistant"
assert_contains "S1: body3 content"   "$(body_field 3 content)" "The config loader does not handle a missing file."
assert_eq "S1: body4 role=user"       "$(body_field 4 role)" "user"
assert_eq "S1: body4 content (blocks-array user text)" "$(body_field 4 content)" "Great, now also add a unit test for the missing-file guard."

CURSOR_FILE="$H/.um/state/stop-cursor-$SID"
assert_file_exists "S1: cursor file created" "$CURSOR_FILE"
assert_eq "S1: cursor at transcript end (12 lines)" "$(cat "$CURSOR_FILE" 2>/dev/null)" "12"
assert_contains "S1: hook.log records posted" "$(cat "$H/.um/hook.log" 2>/dev/null)" "posted http=200 n=4"

# ===========================================================================
# S2: A2 happy half — second fire, same transcript ⇒ zero new POSTs
# ===========================================================================
echo "=== S2: A2 happy half (no dup across fires) ==="
reset_calls
run_stop "$H" "$STDIN"
assert_eq "S2: exit 0" "$RUN_EXIT" "0"
assert_eq "S2: zero POSTs on unchanged transcript" "$(call_count)" "0"
assert_eq "S2: cursor unchanged" "$(cat "$CURSOR_FILE" 2>/dev/null)" "12"

# ===========================================================================
# S3: A2 failure half — 5xx on POST #2 of 3 ⇒ resend exactly the remainder
# ===========================================================================
echo "=== S3: A2 failure half (mid-delta 5xx) ==="
H=$(fresh_home s3)
TP="$TMPDIR_ROOT/s3-transcript.jsonl"
write_transcript "$TP" 3 "s3"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")
CURSOR_FILE="$H/.um/state/stop-cursor-$SID"
mkdir -p "$H/.um/state"
printf '0' > "$CURSOR_FILE"   # delta mode from the start of the file

reset_calls 200 500
run_stop "$H" "$STDIN"
assert_eq "S3: exit 0 despite mid-delta failure" "$RUN_EXIT" "0"
assert_eq "S3: stops on first failure (2 calls, not 3)" "$(call_count)" "2"
assert_eq "S3: cursor at last-acked message (#1 = line 1)" "$(cat "$CURSOR_FILE" 2>/dev/null)" "1"
assert_contains "S3: hook.log records error=http-500" "$(cat "$H/.um/hook.log" 2>/dev/null)" "error=http-500"

# next fire, healthy server ⇒ exactly #2 and #3, no dup of #1
reset_calls
run_stop "$H" "$STDIN"
assert_eq "S3: retry fire exit 0" "$RUN_EXIT" "0"
assert_eq "S3: retry sends exactly the 2 unacked messages" "$(call_count)" "2"
assert_eq "S3: retry body1 = message #2" "$(body_field 1 content)" "s3-2 content"
assert_eq "S3: retry body2 = message #3" "$(body_field 2 content)" "s3-3 content"
assert_eq "S3: cursor at transcript end after retry" "$(cat "$CURSOR_FILE" 2>/dev/null)" "3"

# ===========================================================================
# S4: Delta-cap — 8 new eligible messages ⇒ 6 POSTs + remainder next fire
# ===========================================================================
echo "=== S4: delta-cap (max 6 per fire) ==="
H=$(fresh_home s4)
TP="$TMPDIR_ROOT/s4-transcript.jsonl"
write_transcript "$TP" 8 "s4"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")
CURSOR_FILE="$H/.um/state/stop-cursor-$SID"
mkdir -p "$H/.um/state"
printf '0' > "$CURSOR_FILE"

reset_calls
run_stop "$H" "$STDIN"
assert_eq "S4: exit 0" "$RUN_EXIT" "0"
assert_eq "S4: exactly 6 POSTs" "$(call_count)" "6"
assert_eq "S4: oldest-first (body1 = msg 1)" "$(body_field 1 content)" "s4-1 content"
assert_eq "S4: body6 = msg 6" "$(body_field 6 content)" "s4-6 content"
assert_contains "S4: skip=delta-capped logged with dropped count" "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=delta-capped dropped=2"
assert_eq "S4: cursor at last acked (line 6), not transcript end" "$(cat "$CURSOR_FILE" 2>/dev/null)" "6"

reset_calls
run_stop "$H" "$STDIN"
assert_eq "S4: next fire sends the 2-remainder" "$(call_count)" "2"
assert_eq "S4: remainder body1 = msg 7" "$(body_field 1 content)" "s4-7 content"
assert_eq "S4: remainder body2 = msg 8" "$(body_field 2 content)" "s4-8 content"
assert_eq "S4: cursor at transcript end" "$(cat "$CURSOR_FILE" 2>/dev/null)" "8"

# ===========================================================================
# S5: Truncation — >8192-byte content POSTed at ≤8192 bytes + skip=truncated
# ===========================================================================
echo "=== S5: truncation (>8192 bytes) ==="
H=$(fresh_home s5)
TP="$TMPDIR_ROOT/s5-transcript.jsonl"
"$PYBIN" -c '
import json, sys
e = {"isSidechain": False, "type": "user",
     "message": {"role": "user", "content": "X" * 9000},
     "timestamp": "2026-07-17T14:00:00.000Z"}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write(json.dumps(e) + "\n")' "$TP"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")

reset_calls
run_stop "$H" "$STDIN"
assert_eq "S5: exit 0" "$RUN_EXIT" "0"
assert_eq "S5: still POSTs the truncated message" "$(call_count)" "1"
S5_LEN=$("$PYBIN" -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    b = json.load(fh)
print(len(b["content"].encode("utf-8")))' "$CAP_DIR/body_1")
if [ "$S5_LEN" -le 8192 ] && [ "$S5_LEN" -gt 8000 ]; then
  pass "S5: content truncated to ≤8192 bytes (got $S5_LEN)"
else
  fail "S5: content truncated to ≤8192 bytes" "got $S5_LEN"
fi
assert_contains "S5: skip=truncated logged" "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=truncated"

# ===========================================================================
# S6: 403 ⇒ no cursor advance, skip=writes-disabled, G7 stderr, exit 0
# ===========================================================================
echo "=== S6: 403 writes-disabled ==="
H=$(fresh_home s6)
TP="$TMPDIR_ROOT/s6-transcript.jsonl"
write_transcript "$TP" 2 "s6"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")
CURSOR_FILE="$H/.um/state/stop-cursor-$SID"
mkdir -p "$H/.um/state"
printf '0' > "$CURSOR_FILE"

reset_calls 403
run_stop "$H" "$STDIN"
assert_eq "S6: exit 0" "$RUN_EXIT" "0"
assert_eq "S6: stops after the 403 (1 call)" "$(call_count)" "1"
assert_eq "S6: cursor NOT advanced" "$(cat "$CURSOR_FILE" 2>/dev/null)" "0"
assert_contains "S6: skip=writes-disabled logged" "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=writes-disabled"
assert_contains "S6: G7 writes-disabled message on stderr" "$RUN_OUT" "captures are OFF"

# ===========================================================================
# S7: Unreachable ⇒ error=http-000, G7 stderr, exit 0
# ===========================================================================
echo "=== S7: unreachable (transport failure) ==="
H=$(fresh_home s7)
TP="$TMPDIR_ROOT/s7-transcript.jsonl"
write_transcript "$TP" 1 "s7"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")
CURSOR_FILE="$H/.um/state/stop-cursor-$SID"
mkdir -p "$H/.um/state"
printf '0' > "$CURSOR_FILE"

reset_calls 000
run_stop "$H" "$STDIN"
assert_eq "S7: exit 0" "$RUN_EXIT" "0"
assert_eq "S7: cursor NOT advanced" "$(cat "$CURSOR_FILE" 2>/dev/null)" "0"
assert_contains "S7: error=http-000 logged" "$(cat "$H/.um/hook.log" 2>/dev/null)" "error=http-000"
assert_contains "S7: G7 unreachable message on stderr" "$RUN_OUT" "server unreachable at"

# ===========================================================================
# S8: Skip rules — ineligible fixture lines never POSTed
# ===========================================================================
echo "=== S8: skip rules (fixture ineligible lines) ==="
H=$(fresh_home s8)
TP="$TMPDIR_ROOT/s8-transcript.jsonl"
cp "$FIXTURE_TRANSCRIPT" "$TP"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")

reset_calls
run_stop "$H" "$STDIN"
S8_ALL=$(cat "$CAP_DIR"/body_* 2>/dev/null)
assert_eq "S8: exactly 4 POSTs (nothing ineligible leaks)" "$(call_count)" "4"
assert_not_contains "S8: isMeta skill injection skipped (line 3)" "$S8_ALL" "Injected skill body text"
assert_not_contains "S8: system-reminder content skipped (line 4)" "$S8_ALL" "injected reminder about context state"
assert_not_contains "S8: thinking-only assistant skipped (line 5)" "$S8_ALL" "Scrubbed thinking text"
assert_not_contains "S8: tool_result user line skipped (line 7)" "$S8_ALL" "loadConfig"
assert_not_contains "S8: isSidechain skipped (line 9)" "$S8_ALL" "Subagent task prompt text"
assert_not_contains "S8: synthetic api-error assistant skipped (line 11)" "$S8_ALL" "API Error: 529"

# ===========================================================================
# S9: Invalid session_id ⇒ skip=bad-session-id, no POSTs, no path use
# ===========================================================================
echo "=== S9: invalid session_id ==="
H=$(fresh_home s9)
TP="$TMPDIR_ROOT/s9-transcript.jsonl"
write_transcript "$TP" 1 "s9"
STDIN=$(make_stdin "../../evil path" "$(native_path "$TP")" "$(native_path "$CWD_N")")

reset_calls
run_stop "$H" "$STDIN"
assert_eq "S9: exit 0" "$RUN_EXIT" "0"
assert_eq "S9: zero POSTs" "$(call_count)" "0"
S9_CURSORS=$(find "$H/.um/state" -type f 2>/dev/null | wc -l | tr -d ' ')
assert_eq "S9: no cursor file written anywhere" "$S9_CURSORS" "0"
assert_contains "S9: skip=bad-session-id logged" "$(cat "$H/.um/hook.log" 2>/dev/null)" "skip=bad-session-id"

# ===========================================================================
# S10: Cursor age sweep — old removed, fresh kept, invalid-named left alone
# ===========================================================================
echo "=== S10: cursor age sweep (>7d) ==="
H=$(fresh_home s10)
mkdir -p "$H/.um/state"
OLD_TS=$(( $(date +%s) - 8 * 86400 ))
OLD_CURSOR="$H/.um/state/stop-cursor-old-session-1234"
FRESH_CURSOR="$H/.um/state/stop-cursor-fresh-session-5678"
INVALID_OLD="$H/.um/state/stop-cursor-bad name!"
printf '5' > "$OLD_CURSOR";   touch -d "@$OLD_TS" "$OLD_CURSOR"
printf '5' > "$FRESH_CURSOR"
printf '5' > "$INVALID_OLD";  touch -d "@$OLD_TS" "$INVALID_OLD"

TP="$TMPDIR_ROOT/s10-transcript.jsonl"
write_transcript "$TP" 1 "s10"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")
reset_calls
run_stop "$H" "$STDIN"

assert_file_missing "S10: >7d-old cursor swept" "$OLD_CURSOR"
assert_file_exists  "S10: fresh cursor kept" "$FRESH_CURSOR"
assert_file_exists  "S10: invalid-named old file untouched (glob guard)" "$INVALID_OLD"

# ===========================================================================
# S11: stop_hook_active=true ⇒ exit 0, zero POSTs
# ===========================================================================
echo "=== S11: stop_hook_active loop guard ==="
H=$(fresh_home s11)
TP="$TMPDIR_ROOT/s11-transcript.jsonl"
write_transcript "$TP" 2 "s11"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")" "true")

reset_calls
run_stop "$H" "$STDIN"
assert_eq "S11: exit 0" "$RUN_EXIT" "0"
assert_eq "S11: zero POSTs when stop_hook_active" "$(call_count)" "0"

# ===========================================================================
# S12: UM_IN_SUMMARIZER_SUBPROCESS=1 ⇒ exit 0, zero POSTs
# ===========================================================================
echo "=== S12: summarizer-subprocess recursion guard ==="
H=$(fresh_home s12)
TP="$TMPDIR_ROOT/s12-transcript.jsonl"
write_transcript "$TP" 2 "s12"
STDIN=$(make_stdin "$SID" "$(native_path "$TP")" "$(native_path "$CWD_N")")

reset_calls
S12_EXIT=0
S12_OUT=$(HOME="$H" PATH="$MOCK_BIN:$PATH" \
  UM_SERVER_URL="http://mock.example:6335" \
  UM_IN_SUMMARIZER_SUBPROCESS=1 \
  bash "$STOP" <<< "$STDIN" 2>&1) || S12_EXIT=$?
assert_eq "S12: exit 0" "$S12_EXIT" "0"
assert_eq "S12: zero POSTs under guard" "$(call_count)" "0"
assert_eq "S12: no output under guard" "$S12_OUT" ""

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
