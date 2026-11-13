#!/usr/bin/env bash
# hooks/agy-hooks.test.sh — tests for the Antigravity entry scripts
# agy-session-start.sh and agy-stop.sh (#410), and for the commands in the
# plugin-root hooks.json as a POSIX shell runs them.
#
# Run: bash agy-hooks.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   H1.  Session start, healthy server: ONE injectSteps message holding the
#        state body, the routing rubric and the first-prompt search hits.
#   H2.  Server unreachable: still one message, with the captures-OFF banner.
#   H3.  No endpoint configured: rubric only, no network call.
#   H4.  Empty stdin, bad JSON, no workspace: {} + one skip= line, no network.
#   H5.  A prompt shorter than five characters: state and rubric, no search.
#   H6.  No usable prompt (absent, empty, blank): NO call to /api/search. The
#        search hook falls back to its raw stdin when it finds no prompt, so
#        without the guard the hook input itself would be sent as the query.
#   H7.  The same conversation fired twice: the search runs once.
#   H8.  The search call fails: the state is still injected.
#   H9.  An inner hook that exits 1, or is killed: the entry script still
#        exits 0 and prints one line of valid JSON (on Windows a non-zero exit
#        would run the command's second half, the WSL launcher).
#   H10. Stop: the translated input reaches stop.sh (one POST per turn of the
#        fixture transcript), stdout is exactly {}, exit 0 even on a 500.
#   P1.  Each command in the plugin-root hooks.json, run by `sh -c` from the
#        plugin root: the first half is not found, the second half runs, and
#        stdin reaches the script.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"

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

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

PYBIN=""
for _c in py python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c '' >/dev/null 2>&1; then
    PYBIN="$_c"; break
  fi
done
if [ -z "$PYBIN" ]; then
  echo "SKIP: no working python interpreter — these tests need one" >&2
  exit 1
fi

native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"
  else printf '%s' "$1"; fi
}

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
CAP_DIR="$TMPDIR_ROOT/captured"
mkdir -p "$MOCK_BIN" "$CAP_DIR"

# Mock curl. Records the URL and -d body of every call, then answers by URL:
#   /api/state/…        the canned state response
#   /api/search         the canned search response
#   /api/append-turn    400 for the {} write-path probe (what a healthy server
#                       answers), else the code in $CAP_DIR/post_code (200)
# $CAP_DIR/mode: "unreachable" fails every call; "search-down" fails only the
# search.
cat > "$MOCK_BIN/curl" <<MOCK_EOF
#!/usr/bin/env bash
CAP_DIR="$CAP_DIR"
MOCK_EOF
cat >> "$MOCK_BIN/curl" <<'MOCK_EOF'
count=$(cat "$CAP_DIR/count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$CAP_DIR/count"
url=""; body=""; prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then body="$arg"; fi
  case "$arg" in http://*|https://*) url="$arg" ;; esac
  prev="$arg"
done
printf '%s' "$url"  > "$CAP_DIR/url_$count"
printf '%s' "$body" > "$CAP_DIR/body_$count"
mode=$(cat "$CAP_DIR/mode" 2>/dev/null || echo ok)
if [ "$mode" = "unreachable" ]; then exit 7; fi
case "$url" in
  */api/search)
    if [ "$mode" = "search-down" ]; then exit 7; fi
    cat "$CAP_DIR/search.json"; printf '\n__UM_HTTP_CODE__200' ;;
  */api/state/*)
    cat "$CAP_DIR/state.json"; printf '\n__UM_HTTP_CODE__200' ;;
  */api/append-turn)
    if [ "$body" = "{}" ]; then
      printf '{"error":{"code":"INPUT_INVALID","message":"probe"}}\n__UM_HTTP_CODE__400'
    else
      code=$(cat "$CAP_DIR/post_code" 2>/dev/null || echo 200)
      printf '{"ok":true}\n__UM_HTTP_CODE__%s' "$code"
    fi ;;
  *) printf '{"ok":true}\n__UM_HTTP_CODE__200' ;;
esac
exit 0
MOCK_EOF
chmod +x "$MOCK_BIN/curl"

"$PYBIN" -c '
import json, sys
from datetime import datetime, timezone
vf = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
body = "# State of play\n\n## Current focus\nSTATE-BODY-MARKER the loader guard is in review."
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as fh:
    json.dump({"ok": True, "project": "example-project", "valid_from": vf,
               "state": {"frontmatter": {"valid_from": vf}, "body": body, "valid_from": vf}}, fh)
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as fh:
    json.dump({"results": [{"id": "fact-loader-guard", "title": "Loader guard",
                            "snippet": "Loader guard -- SEARCH-HIT-MARKER it returns defaults",
                            "score": 0.91}]}, fh)
' "$(native_path "$CAP_DIR/state.json")" "$(native_path "$CAP_DIR/search.json")"

reset_calls() {
  rm -f "$CAP_DIR"/url_* "$CAP_DIR"/body_* "$CAP_DIR/count" "$CAP_DIR/mode" "$CAP_DIR/post_code"
  [ -z "${1:-}" ] || printf '%s' "$1" > "$CAP_DIR/mode"
}
call_count() { cat "$CAP_DIR/count" 2>/dev/null || echo 0; }
url_count() {
  local needle="$1" n=0 f
  for f in "$CAP_DIR"/url_*; do
    [ -f "$f" ] || continue
    case "$(cat "$f")" in *"$needle"*) n=$((n+1)) ;; esac
  done
  printf '%s' "$n"
}
# append_count — real turn POSTs, not the {} probe.
append_count() {
  local n=0 f
  for f in "$CAP_DIR"/url_*; do
    [ -f "$f" ] || continue
    case "$(cat "$f")" in */api/append-turn)
      [ "$(cat "${f/url_/body_}")" = "{}" ] || n=$((n+1)) ;;
    esac
  done
  printf '%s' "$n"
}

# search_query — the "query" field of the one /api/search request body.
search_query() {
  local f
  for f in "$CAP_DIR"/url_*; do
    [ -f "$f" ] || continue
    case "$(cat "$f")" in */api/search)
      "$PYBIN" -c '
import json, sys
sys.stdout.reconfigure(newline=chr(10))
with open(sys.argv[1], encoding="utf-8") as fh:
    sys.stdout.write(json.load(fh).get("query", "<no query field>"))' "$(native_path "${f/url_/body_}")"
      return 0 ;;
    esac
  done
  printf '<no search request>'
}

fresh_home() {
  local d="$TMPDIR_ROOT/home_$1"
  mkdir -p "$d"
  printf '%s' "$d"
}

WORKSPACE="$TMPDIR_ROOT/example-project"
mkdir -p "$WORKSPACE/.git"

# agy_stdin <fixture> <transcript(native)> [lastUserInput | --no-prompt]
# The fixture with its two path fields pointed at this run's temp folders.
agy_stdin() {
  "$PYBIN" -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    d = json.load(fh)
d["workspacePaths"] = [sys.argv[2]]
d["transcriptPath"] = sys.argv[3]
if len(sys.argv) > 4:
    if sys.argv[4] == "--no-prompt":
        d.pop("lastUserInput", None)
    else:
        d["lastUserInput"] = sys.argv[4]
print(json.dumps(d), end="")' "$(native_path "$1")" "$(native_path "$WORKSPACE")" "$2" "${@:3}"
}

# run_entry <script> <home> <stdin> [configured=1] — stdout → $RUN_OUT, exit
# code → $RUN_EXIT. configured=0 runs with no endpoint at all.
run_entry() {
  local script="$1" home="$2" stdin_json="$3" configured="${4:-1}"
  RUN_EXIT=0
  if [ "$configured" = 1 ]; then
    RUN_OUT=$(env -u CLAUDE_CWD -u UM_ENDPOINT -u UM_COMPOSE_DIR HOME="$home" PATH="$MOCK_BIN:$PATH" \
      UM_SERVER_URL="http://mock.example:6335" UM_TOKEN_FILE="$home/.um/auth-token" \
      bash "$script" <<< "$stdin_json" 2>/dev/null) || RUN_EXIT=$?
  else
    RUN_OUT=$(env -u CLAUDE_CWD -u UM_ENDPOINT -u UM_SERVER_URL -u UM_COMPOSE_DIR HOME="$home" \
      PATH="$MOCK_BIN:$PATH" UM_TOKEN_FILE="$home/.um/auth-token" \
      bash "$script" <<< "$stdin_json" 2>/dev/null) || RUN_EXIT=$?
  fi
}

# injected <json> — the one injected message; '<none>' for {}; '<bad>' when
# stdout is not one line of the expected shape.
injected() {
  printf '%s' "$1" | "$PYBIN" -c '
import json, sys
sys.stdout.reconfigure(newline=chr(10))
raw = sys.stdin.buffer.read().decode("utf-8")
try:
    assert "\n" not in raw.strip() and "\r" not in raw
    d = json.loads(raw)
    if d == {}:
        sys.stdout.write("<none>")
    else:
        assert list(d) == ["injectSteps"] and len(d["injectSteps"]) == 1
        step = d["injectSteps"][0]
        assert list(step) == ["systemMessage"] and list(step["systemMessage"]) == ["systemMessage"]
        sys.stdout.write(step["systemMessage"]["systemMessage"])
except Exception:
    sys.stdout.write("<bad>")'
}

SS="$SCRIPT_DIR/agy-session-start.sh"
ST="$SCRIPT_DIR/agy-stop.sh"
SS_FIX="$FIXTURES/agy-session-start-stdin.json"
ST_FIX="$FIXTURES/agy-stop-stdin.json"
SID="0b9d3f6e-1111-4222-8333-444455556666"
NO_TRANSCRIPT="$(native_path "$TMPDIR_ROOT/none.jsonl")"

echo "=== H1: session start, healthy server ==="
H=$(fresh_home h1)
reset_calls
run_entry "$SS" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT")"
MSG=$(injected "$RUN_OUT")
LOG=$(cat "$H/.um/hook.log" 2>/dev/null)
assert_eq "H1: exit 0" "$RUN_EXIT" "0"
assert_contains "H1: the state body is injected" "$MSG" "STATE-BODY-MARKER"
assert_contains "H1: the rubric is injected" "$MSG" "Memory routing"
assert_contains "H1: the search section is injected" "$MSG" "Relevant from your memory"
assert_contains "H1: the search hit is injected" "$MSG" "SEARCH-HIT-MARKER"
assert_eq "H1: one state fetch" "$(url_count /api/state/example-project)" "1"
assert_eq "H1: one search" "$(url_count /api/search)" "1"
assert_eq "H1: the search query is exactly the prompt, nothing of the hook input around it" \
  "$(search_query)" "What did we decide about the config loader guard?"
assert_contains "H1: own log line" "$LOG" "agy-session-start ok sid=$SID"
assert_contains "H1: the inner state line" "$LOG" "session-start state project=example-project"
assert_contains "H1: the inner search line" "$LOG" "user-prompt-submit search rc=0 results=1 injected=1"

echo "=== H2: server unreachable ==="
H=$(fresh_home h2)
reset_calls unreachable
run_entry "$SS" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT")"
MSG=$(injected "$RUN_OUT")
assert_eq "H2: exit 0" "$RUN_EXIT" "0"
assert_contains "H2: the captures-OFF banner is injected" "$MSG" "captures are OFF"
assert_contains "H2: the rubric is injected" "$MSG" "Memory routing"
assert_not_contains "H2: no state body" "$MSG" "STATE-BODY-MARKER"

echo "=== H3: no endpoint configured ==="
H=$(fresh_home h3)
reset_calls
run_entry "$SS" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT")" 0
MSG=$(injected "$RUN_OUT")
assert_eq "H3: exit 0" "$RUN_EXIT" "0"
assert_contains "H3: the rubric is injected" "$MSG" "Memory routing"
assert_not_contains "H3: no state body" "$MSG" "STATE-BODY-MARKER"
assert_eq "H3: no network call" "$(call_count)" "0"

echo "=== H4: unusable input ==="
H=$(fresh_home h4)
for script in "$SS" "$ST"; do
  name=$(basename "$script" .sh)
  for case_ in "empty-stdin|" "empty-stdin|   	  " "bad-stdin|this is not json" "bad-stdin|[1,2]" \
               'no-workspace|{"conversationId":"c1","workspacePaths":[]}'; do
    reason="${case_%%|*}"; input="${case_#*|}"
    rm -f "$H/.um/hook.log"
    reset_calls
    run_entry "$script" "$H" "$input"
    # A here-string adds a newline, so "empty" stdin is one blank line.
    assert_eq "H4: $name $reason exit 0" "$RUN_EXIT" "0"
    assert_eq "H4: $name $reason prints {}" "$RUN_OUT" "{}"
    assert_eq "H4: $name $reason logs one skip line" "$(grep -c "$name skip=$reason" "$H/.um/hook.log" 2>/dev/null)" "1"
    assert_eq "H4: $name $reason makes no network call" "$(call_count)" "0"
  done
done

echo "=== H5: a prompt too short to search ==="
H=$(fresh_home h5)
reset_calls
run_entry "$SS" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT" "hey")"
MSG=$(injected "$RUN_OUT")
assert_contains "H5: the state body is injected" "$MSG" "STATE-BODY-MARKER"
assert_contains "H5: the rubric is injected" "$MSG" "Memory routing"
assert_eq "H5: no search call" "$(url_count /api/search)" "0"

echo "=== H6: no usable prompt ==="
for p in --no-prompt "" "   "; do
  H=$(fresh_home "h6_$RANDOM")
  reset_calls
  run_entry "$SS" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT" "$p")"
  MSG=$(injected "$RUN_OUT")
  assert_contains "H6: state injected for prompt '${p}'" "$MSG" "STATE-BODY-MARKER"
  assert_eq "H6: NO call to /api/search for prompt '${p}'" "$(url_count /api/search)" "0"
  assert_eq "H6: the state fetch still ran for prompt '${p}'" "$(url_count /api/state/)" "1"
done

echo "=== H7: the same conversation fired twice ==="
H=$(fresh_home h7)
reset_calls
STDIN=$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT")
run_entry "$SS" "$H" "$STDIN"
run_entry "$SS" "$H" "$STDIN"
MSG=$(injected "$RUN_OUT")
assert_eq "H7: the search ran once across two fires" "$(url_count /api/search)" "1"
assert_contains "H7: the second fire still injects the state" "$MSG" "STATE-BODY-MARKER"
assert_not_contains "H7: the second fire injects no search section" "$MSG" "Relevant from your memory"

echo "=== H8: the search call fails ==="
H=$(fresh_home h8)
reset_calls search-down
run_entry "$SS" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT")"
MSG=$(injected "$RUN_OUT")
assert_eq "H8: exit 0" "$RUN_EXIT" "0"
assert_eq "H8: the search was attempted" "$(url_count /api/search)" "1"
assert_contains "H8: the state body is still injected" "$MSG" "STATE-BODY-MARKER"
assert_not_contains "H8: no search section" "$MSG" "Relevant from your memory"

echo "=== H9: an inner hook that fails ==="
for how in "exit 1" 'kill -9 $$'; do
  TREE="$TMPDIR_ROOT/tree_$RANDOM"
  mkdir -p "$TREE"
  cp -R "$PLUGIN_ROOT/hooks" "$TREE/hooks"
  cp "$PLUGIN_ROOT/rubric.md" "$TREE/rubric.md" 2>/dev/null || true
  for inner in session-start.sh user-prompt-submit.sh stop.sh; do
    printf '#!/usr/bin/env bash\ncat >/dev/null\nprintf "partial-not-json"\n%s\n' "$how" > "$TREE/hooks/$inner"
  done
  H=$(fresh_home "h9_$RANDOM")
  reset_calls
  run_entry "$TREE/hooks/agy-session-start.sh" "$H" "$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT")"
  assert_eq "H9: session start exits 0 when the inner hooks '$how'" "$RUN_EXIT" "0"
  assert_eq "H9: session start prints {} when the inner hooks '$how'" "$RUN_OUT" "{}"
  run_entry "$TREE/hooks/agy-stop.sh" "$H" "$(agy_stdin "$ST_FIX" "$NO_TRANSCRIPT")"
  assert_eq "H9: stop exits 0 when stop.sh '$how'" "$RUN_EXIT" "0"
  assert_eq "H9: stop prints {} when stop.sh '$how'" "$RUN_OUT" "{}"
done

echo "=== H10: stop ==="
H=$(fresh_home h10)
TP="$TMPDIR_ROOT/h10-agy.jsonl"
cp "$FIXTURES/agy-transcript-sample.jsonl" "$TP"
reset_calls
run_entry "$ST" "$H" "$(agy_stdin "$ST_FIX" "$(native_path "$TP")")"
LOG=$(cat "$H/.um/hook.log" 2>/dev/null)
assert_eq "H10: exit 0" "$RUN_EXIT" "0"
assert_eq "H10: stdout is exactly {}" "$RUN_OUT" "{}"
assert_eq "H10: one POST per turn of the fixture transcript" "$(append_count)" "6"
assert_contains "H10: the turns carry the workspace's project" "$(cat "$CAP_DIR/body_1" 2>/dev/null)" '"project": "example-project"'
assert_contains "H10: own log line" "$LOG" "agy-stop ok sid=$SID"
assert_contains "H10: the inner posted line" "$LOG" "stop posted http=200 n=6 project=example-project"
assert_eq "H10: the cursor file is named for the conversation" "$(cat "$H/.um/state/stop-cursor-$SID" 2>/dev/null)" "12"

H=$(fresh_home h10b)
reset_calls
printf '500' > "$CAP_DIR/post_code"
run_entry "$ST" "$H" "$(agy_stdin "$ST_FIX" "$(native_path "$TP")")"
assert_eq "H10: exit 0 when the server answers 500" "$RUN_EXIT" "0"
assert_eq "H10: stdout is {} when the server answers 500" "$RUN_OUT" "{}"
assert_contains "H10: the failure is in the log" "$(cat "$H/.um/hook.log" 2>/dev/null)" "stop error=http-500"

echo "=== P1: the hooks.json commands under a POSIX shell ==="
ROOT_HOOKS="$PLUGIN_ROOT/hooks.json"
if [ ! -f "$ROOT_HOOKS" ]; then
  fail "P1: plugin-root hooks.json exists" "not found: $ROOT_HOOKS"
else
  # event<TAB>command, one per line.
  COMMANDS=$("$PYBIN" -c '
import json, sys
sys.stdout.reconfigure(newline=chr(10))
with open(sys.argv[1], encoding="utf-8") as fh:
    d = json.load(fh)
for group in d.values():
    for event, handlers in group.items():
        for h in handlers:
            print(event + "\t" + h["command"])' "$(native_path "$ROOT_HOOKS")")
  assert_eq "P1: two commands found" "$(printf '%s\n' "$COMMANDS" | grep -c .)" "2"
  while IFS=$'\t' read -r event cmd; do
    [ -n "$event" ] || continue
    H=$(fresh_home "p1_$event")
    reset_calls
    if [ "$event" = "Stop" ]; then STDIN=$(agy_stdin "$ST_FIX" "$(native_path "$TP")")
    else STDIN=$(agy_stdin "$SS_FIX" "$NO_TRANSCRIPT"); fi
    RUN_EXIT=0
    RUN_OUT=$(cd "$PLUGIN_ROOT" && env -u CLAUDE_CWD -u UM_ENDPOINT -u UM_COMPOSE_DIR HOME="$H" \
      PATH="$MOCK_BIN:$PATH" UM_SERVER_URL="http://mock.example:6335" \
      UM_TOKEN_FILE="$H/.um/auth-token" sh -c "$cmd" <<< "$STDIN" 2>"$TMPDIR_ROOT/p1-stderr") || RUN_EXIT=$?
    assert_eq "P1: $event exits 0" "$RUN_EXIT" "0"
    assert_contains "P1: $event first half is not found by the shell" "$(cat "$TMPDIR_ROOT/p1-stderr")" "not found"
    assert_contains "P1: $event stdin reached the script (its conversation id is logged)" \
      "$(cat "$H/.um/hook.log" 2>/dev/null)" "ok sid=$SID"
    if [ "$event" = "Stop" ]; then
      assert_eq "P1: Stop prints {}" "$RUN_OUT" "{}"
      assert_eq "P1: Stop posted the turns" "$(append_count)" "6"
    else
      assert_contains "P1: SessionStart injects the state" "$(injected "$RUN_OUT")" "STATE-BODY-MARKER"
    fi
  done <<< "$COMMANDS"
fi

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
