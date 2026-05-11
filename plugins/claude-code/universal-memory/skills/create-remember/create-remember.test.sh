#!/usr/bin/env bash
# create-remember.test.sh — unit + integration tests for the /remember
# skill helper.
#
# Run from repo root:
#   bash plugins/claude-code/universal-memory/skills/create-remember/create-remember.test.sh
#
# Pattern matches create-adr.test.sh: PASS/FAIL counters, exits non-zero
# on any failure, sets up tmp dirs per test.
#
# shellcheck disable=SC2015
# Same intentional `<test> && pass || fail` pattern as create-adr.test.sh.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/create-remember.sh"

# Source the helper for unit-level access. Dispatcher gates on
# `${BASH_SOURCE[0]} == ${0}` so sourcing is safe.
# shellcheck source=create-remember.sh
source "$HELPER"

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
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$name"
  else
    fail "$name" "want='$expected' got='$actual'"
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) pass "$name" ;;
    *) fail "$name" "expected to contain '$needle', got: $haystack" ;;
  esac
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) fail "$name" "expected NOT to contain '$needle', got: $haystack" ;;
    *) pass "$name" ;;
  esac
}

assert_rc() {
  local name="$1" expected_rc="$2" actual_rc="$3"
  if [ "$expected_rc" = "$actual_rc" ]; then
    pass "$name"
  else
    fail "$name" "want rc=$expected_rc got rc=$actual_rc"
  fi
}

# ─── Unit tests: _sanitize_text ──────────────────────────────────────────
echo ""
echo "=== unit: _sanitize_text ==="

t1=$(_sanitize_text "$(printf 'foo\x00bar')")
assert_eq "_sanitize_text strips NUL" "foobar" "$t1"

t2=$(_sanitize_text "$(printf 'foo\x07bar')")
assert_eq "_sanitize_text strips BEL" "foobar" "$t2"

t3=$(_sanitize_text "$(printf 'foo\x7Fbar')")
assert_eq "_sanitize_text strips DEL" "foobar" "$t3"

# Bidi U+202E (RLO) — must REJECT.
out=$(_sanitize_text "$(printf 'foo\xE2\x80\xAEbar')" 2>/dev/null)
rc=$?
assert_rc "_sanitize_text rejects U+202E rc=1" "1" "$rc"

# Bidi U+2066 (LRI) — must REJECT.
out=$(_sanitize_text "$(printf 'foo\xE2\x81\xA6bar')" 2>/dev/null)
rc=$?
assert_rc "_sanitize_text rejects U+2066 rc=1" "1" "$rc"

t4=$(_sanitize_text $'foo\nbar')
assert_eq "_sanitize_text newline-to-space" "foo bar" "$t4"

t5=$(_sanitize_text "foo   bar")
assert_eq "_sanitize_text collapses whitespace" "foo bar" "$t5"

t6=$(_sanitize_text "  trimmed  ")
assert_eq "_sanitize_text trims ends" "trimmed" "$t6"

# ─── Unit tests: _json_escape ────────────────────────────────────────────
echo ""
echo "=== unit: _json_escape ==="

assert_eq "_json_escape plain"      "hello"          "$(_json_escape 'hello')"
assert_eq "_json_escape quote"      'hello \"world'  "$(_json_escape 'hello "world')"
assert_eq "_json_escape backslash"  'a\\b'           "$(_json_escape 'a\b')"
assert_eq "_json_escape newline"    'line1\nline2'   "$(_json_escape $'line1\nline2')"
assert_eq "_json_escape tab"        'a\tb'           "$(_json_escape $'a\tb')"

# ─── Unit tests: _codepoint_length ───────────────────────────────────────
echo ""
echo "=== unit: _codepoint_length ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not available — codepoint tests assume primary path"
else
  l1=$(_codepoint_length "abc")
  assert_eq "_codepoint_length ascii" "3" "$l1"
  # 4 emoji codepoints — each is a single codepoint but 4 bytes in UTF-8.
  # Python codepoint count: 4. Bash ${#var} in LC_ALL=C: 16. We must report 4.
  l2=$(_codepoint_length "$(printf '\xF0\x9F\x98\x80\xF0\x9F\x98\x81\xF0\x9F\x98\x82\xF0\x9F\x98\x83')")
  assert_eq "_codepoint_length emoji codepoint-count" "4" "$l2"
  # CJK: "日本語" — 3 codepoints, 9 UTF-8 bytes.
  l3=$(_codepoint_length "$(printf '\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E')")
  assert_eq "_codepoint_length CJK codepoint-count" "3" "$l3"
fi

# ─── Unit tests: _build_remember_payload ─────────────────────────────────
echo ""
echo "=== unit: _build_remember_payload ==="

payload=$(_build_remember_payload "Hello fact")
assert_contains "payload has text"           "$payload" '"text":"Hello fact"'
assert_contains "payload has schema_version" "$payload" '"schema_version":1'
assert_contains "payload has type=note"      "$payload" '"type":"note"'
assert_contains "payload has captured_at"    "$payload" '"captured_at":'
# Critical F1 contract: project MUST be absent so server soft-default applies.
assert_not_contains "payload omits project"  "$payload" '"project":'

# Escaped text round-trip.
esc_payload=$(_build_remember_payload 'with "quote" and \backslash')
assert_contains "payload escapes quote"      "$esc_payload" '\"quote\"'
# Bash single-quote `'\\backslash'` is the 2-char literal `\\backslash`
# (one escaped backslash + "backslash"). That's what JSON escaping
# produces for an input containing one literal `\` followed by "backslash".
assert_contains "payload escapes backslash"  "$esc_payload" '\\backslash'

# ─── Unit tests: _resolve_auth_token ─────────────────────────────────────
echo ""
echo "=== unit: _resolve_auth_token ==="

TEST_HOME=$(mktemp -d)
trap 'rm -rf "$TEST_HOME"' EXIT
mkdir -p "$TEST_HOME/.claude/skills/create-remember"
printf '{"auth_token":"from-config"}\n' > "$TEST_HOME/.claude/skills/create-remember/config.json"

got=$(HOME="$TEST_HOME" UM_AUTH_TOKEN="from-env" _resolve_auth_token)
assert_eq "_resolve_auth_token env precedence" "from-env" "$got"

got=$(HOME="$TEST_HOME" UM_AUTH_TOKEN="" _resolve_auth_token)
assert_eq "_resolve_auth_token config fallback" "from-config" "$got"

EMPTY_HOME=$(mktemp -d)
got=$(HOME="$EMPTY_HOME" UM_AUTH_TOKEN="" _resolve_auth_token)
assert_eq "_resolve_auth_token empty default" "" "$got"
rm -rf "$EMPTY_HOME"

# ─── Unit tests: _resolve_default_project_for_display ────────────────────
echo ""
echo "=== unit: _resolve_default_project_for_display ==="

got=$(UM_DEFAULT_PROJECT="alpha" _resolve_default_project_for_display)
assert_eq "project display reads env" "alpha" "$got"

got=$(UM_DEFAULT_PROJECT="" _resolve_default_project_for_display)
assert_eq "project display falls back to 'default'" "default" "$got"

# ─── Unit tests: _parse_event ────────────────────────────────────────────
echo ""
echo "=== unit: _parse_event ==="

if command -v python3 >/dev/null 2>&1; then
  e1=$(_parse_event '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}')
  assert_eq "_parse_event ADD" "add" "$e1"

  e2=$(_parse_event '{"results":[{"id":"u1","memory":"m","event":"ADD"},{"id":"u2","memory":"m2","event":"DEDUP_MERGED"}]}')
  assert_eq "_parse_event any DEDUP wins" "dedup" "$e2"

  e3=$(_parse_event '{"results":[]}')
  assert_eq "_parse_event empty results" "empty" "$e3"

  e4=$(_parse_event '{}')
  assert_eq "_parse_event no results key" "unknown" "$e4"

  e5=$(_parse_event '')
  assert_eq "_parse_event empty body" "unknown" "$e5"

  e6=$(_parse_event 'not-json')
  assert_eq "_parse_event malformed JSON" "unknown" "$e6"
else
  echo "  SKIP: python3 not available — _parse_event tests skipped"
fi

# ─── Integration tests ───────────────────────────────────────────────────
echo ""
echo "=== integration: stub-server-backed tests ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not available — integration tests skipped"
else
  PYTHON=$(command -v python3)
  TMPDIR_INT=$(mktemp -d)

  # Enhanced stub: supports STUB_RESPONSE_BODIES_FILE for round-robin
  # per-request response bodies. When unset, falls back to legacy b'{}'.
  # This is the B2 spec §"Stub-server enhancement required" addition.
  STUB_SCRIPT="$TMPDIR_INT/stub-server.py"
  cat > "$STUB_SCRIPT" <<'PYEOF'
import http.server, os, sys
BODY_FILE = os.environ['STUB_BODY']
AUTH_FILE = os.environ['STUB_AUTH']
PATH_FILE = os.environ['STUB_PATH']
PORT_FILE = os.environ['STUB_PORT_FILE']
STATUS = int(os.environ.get('STUB_STATUS', '200'))
BODIES_FILE = os.environ.get('STUB_RESPONSE_BODIES_FILE', '')
# Load round-robin response bodies, if configured.
BODIES = []
if BODIES_FILE and os.path.exists(BODIES_FILE):
    with open(BODIES_FILE) as f:
        BODIES = [line.rstrip('\n') for line in f if line.strip()]

class H(http.server.BaseHTTPRequestHandler):
    # Class-level counter so all request instances share state.
    counter = 0
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n).decode('utf-8') if n else ''
        with open(BODY_FILE, 'a') as f:
            f.write(body + '\n')
        with open(AUTH_FILE, 'a') as f:
            f.write(self.headers.get('Authorization', '') + '\n')
        with open(PATH_FILE, 'a') as f:
            f.write(self.path + '\n')
        self.send_response(STATUS)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        if BODIES:
            response = BODIES[H.counter % len(BODIES)]
            H.counter += 1
            self.wfile.write(response.encode('utf-8'))
        else:
            self.wfile.write(b'{}')
    def log_message(self, *a, **k): pass

s = http.server.HTTPServer(('127.0.0.1', 0), H)
with open(PORT_FILE, 'w') as f:
    f.write(str(s.server_port))
s.serve_forever()
PYEOF

  STUB_URL=""; STUB_BODYF=""; STUB_AUTHF=""; STUB_PATHF=""; STUB_PID=""
  STUB_BODIES_FILE=""

  start_stub() {
    local status="${1:-200}"
    local bodies_file="${2:-}"
    STUB_BODYF=$(mktemp)
    STUB_AUTHF=$(mktemp)
    STUB_PATHF=$(mktemp)
    : > "$STUB_BODYF"; : > "$STUB_AUTHF"; : > "$STUB_PATHF"
    STUB_BODIES_FILE="$bodies_file"
    local portf
    portf=$(mktemp); rm -f "$portf"
    STUB_BODY="$STUB_BODYF" STUB_AUTH="$STUB_AUTHF" STUB_PATH="$STUB_PATHF" \
      STUB_PORT_FILE="$portf" STUB_STATUS="$status" \
      STUB_RESPONSE_BODIES_FILE="$bodies_file" \
      "$PYTHON" "$STUB_SCRIPT" &
    STUB_PID=$!
    local i=0
    while [ ! -s "$portf" ] && [ "$i" -lt 50 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    if [ ! -s "$portf" ]; then
      kill "$STUB_PID" 2>/dev/null
      STUB_URL=""
      return 1
    fi
    STUB_URL="http://127.0.0.1:$(cat "$portf")"
    rm -f "$portf"
    return 0
  }

  stop_stub() {
    if [ -n "$STUB_PID" ]; then
      kill "$STUB_PID" 2>/dev/null
      wait "$STUB_PID" 2>/dev/null || true
      STUB_PID=""
    fi
    rm -f "$STUB_BODYF" "$STUB_AUTHF" "$STUB_PATHF"
    if [ -n "$STUB_BODIES_FILE" ] && [ -f "$STUB_BODIES_FILE" ]; then
      rm -f "$STUB_BODIES_FILE"
    fi
    STUB_BODYF=""; STUB_AUTHF=""; STUB_PATHF=""; STUB_BODIES_FILE=""
    STUB_URL=""
  }

  # ─── INT1: cmd_help exits 0 ───────────────────────────────────────────
  echo ""
  echo "--- INT1: help ---"
  out=$(bash "$HELPER" help 2>&1)
  rc=$?
  assert_rc "INT1 help rc=0" "0" "$rc"
  assert_contains "INT1 help text contains Usage" "$out" "Usage:"
  assert_contains "INT1 help text contains /remember" "$out" "/remember"
  assert_contains "INT1 help text contains --help" "$out" "--help"

  # ─── INT2: happy path — ADD event surfaced as plain success ───────────
  echo ""
  echo "--- INT2: cmd_remember happy path (ADD event) ---"
  bodies=$(mktemp)
  printf '%s\n' '{"results":[{"id":"u1","memory":"Test fact","event":"ADD"}]}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" HOME="$TMPDIR_INT/empty-home" \
            UM_DEFAULT_PROJECT="" \
            bash "$HELPER" remember --text "Test fact" 2>&1)
    rc=$?
    assert_rc "INT2 cmd_remember rc=0" "0" "$rc"
    assert_contains "INT2 line 1 Remembered" "$out" "Remembered: Test fact"
    assert_contains "INT2 line 2 registered" "$out" "Registered with universal-memory"
    assert_contains "INT2 line 2 project field" "$out" "project=default"
    assert_not_contains "INT2 no dedup suffix" "$out" "dedup match"
    line_count=$(printf '%s' "$out" | grep -c '^')
    assert_eq "INT2 success has exactly 2 lines" "2" "$line_count"
    [ -s "$STUB_BODYF" ] && pass "INT2 stub captured POST" \
      || fail "INT2 stub captured POST" "body file empty"
    [ "$(head -1 "$STUB_PATHF")" = "/api/add" ] && pass "INT2 path is /api/add" \
      || fail "INT2 path is /api/add" "got: $(head -1 "$STUB_PATHF")"
    body=$(head -1 "$STUB_BODYF")
    assert_contains "INT2 payload type=note"     "$body" '"type":"note"'
    assert_contains "INT2 payload schema_version" "$body" '"schema_version":1'
    assert_not_contains "INT2 payload omits project" "$body" '"project":'
    stop_stub
  else
    fail "INT2 stub start" "could not start"
  fi

  # ─── INT3: bearer header forwarded when UM_AUTH_TOKEN set ─────────────
  echo ""
  echo "--- INT3: bearer header ---"
  bodies=$(mktemp)
  printf '%s\n' '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="secret-xyz" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "Bearer test" 2>&1)
    rc=$?
    assert_rc "INT3 cmd_remember rc=0" "0" "$rc"
    auth=$(head -1 "$STUB_AUTHF")
    assert_eq "INT3 bearer header" "Bearer secret-xyz" "$auth"
    stop_stub
  else
    fail "INT3 stub start" "could not start"
  fi

  # ─── INT4: empty text after sanitization → exit 65 ────────────────────
  echo ""
  echo "--- INT4: empty after sanitization ---"
  # Pass control-chars only (DEL + BEL); after strip nothing remains.
  text=$(printf '\x7F\x07\x7F')
  out=$(bash "$HELPER" remember --text "$text" 2>&1)
  rc=$?
  assert_rc "INT4 rc=65" "65" "$rc"
  assert_contains "INT4 message" "$out" "empty after sanitization"

  # ─── INT5: bidi-override → exit 65 ────────────────────────────────────
  echo ""
  echo "--- INT5: bidi-override reject ---"
  text=$(printf 'foo\xE2\x80\xAEbar')
  out=$(bash "$HELPER" remember --text "$text" 2>&1)
  rc=$?
  assert_rc "INT5 rc=65" "65" "$rc"
  assert_contains "INT5 message" "$out" "disallowed bidi-override"

  # ─── INT6: 401 → exit 0, single WARNING with token pointer ────────────
  echo ""
  echo "--- INT6: 401 warn-only ---"
  if start_stub 401; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "401 test" 2>&1)
    rc=$?
    assert_rc "INT6 rc=0 (warn-only)" "0" "$rc"
    assert_contains "INT6 WARNING text" "$out" "WARNING: not saved"
    assert_contains "INT6 auth failed text" "$out" "auth failed"
    assert_contains "INT6 token pointer" "$out" "UM_AUTH_TOKEN"
    assert_contains "INT6 preview included" "$out" "401 test"
    stop_stub
  else
    fail "INT6 stub start" "could not start"
  fi

  # ─── INT7: 503 → exit 0, single WARNING ───────────────────────────────
  echo ""
  echo "--- INT7: 503 warn-only ---"
  if start_stub 503; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "503 test" 2>&1)
    rc=$?
    assert_rc "INT7 rc=0 (warn-only)" "0" "$rc"
    assert_contains "INT7 WARNING text" "$out" "WARNING: not saved"
    assert_contains "INT7 HTTP 503" "$out" "HTTP 503"
    assert_contains "INT7 transient text" "$out" "transient"
    assert_contains "INT7 preview included" "$out" "503 test"
    stop_stub
  else
    fail "INT7 stub start" "could not start"
  fi

  # ─── INT8: 422 → exit 65 (NOT warn) ───────────────────────────────────
  echo ""
  echo "--- INT8: 422 hard-fail ---"
  if start_stub 422; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "422 test" 2>&1)
    rc=$?
    assert_rc "INT8 rc=65" "65" "$rc"
    assert_contains "INT8 not retryable hint" "$out" "not retryable"
    assert_contains "INT8 issue pointer" "$out" "file an issue"
    stop_stub
  else
    fail "INT8 stub start" "could not start"
  fi

  # ─── INT9: 000 (server unreachable) → exit 0, WARNING ─────────────────
  echo ""
  echo "--- INT9: 000 unreachable ---"
  out=$(UM_SERVER_URL="http://127.0.0.1:1" UM_AUTH_TOKEN="" \
          HOME="$TMPDIR_INT/empty-home" \
          bash "$HELPER" remember --text "000 test" 2>&1)
  rc=$?
  assert_rc "INT9 rc=0 (warn-only)" "0" "$rc"
  assert_contains "INT9 WARNING text" "$out" "WARNING: not saved"
  assert_contains "INT9 unreachable text" "$out" "server unreachable"
  assert_contains "INT9 preview included" "$out" "000 test"

  # ─── INT10: oversize text → exit 64 ───────────────────────────────────
  echo ""
  echo "--- INT10: oversize text ---"
  # Build a 4097-codepoint ASCII string. Bash bytes==codepoints for ASCII.
  big=$(printf 'a%.0s' {1..4097})
  out=$(bash "$HELPER" remember --text "$big" 2>&1)
  rc=$?
  assert_rc "INT10 rc=64 (oversize ASCII)" "64" "$rc"
  assert_contains "INT10 oversize message" "$out" "exceeds 4096-codepoint"

  # Now: 4096-emoji input (codepoint-counted): 4096 codepoints, 16384 UTF-8
  # bytes. If the helper byte-counts, this would be rejected (>4096 bytes).
  # If codepoint-counts (correct), this passes.
  #
  # IMPORTANT: write the emoji string via PYTHONIOENCODING=utf-8 because
  # Python 3 on Windows defaults stdout encoding to cp1252 which cannot
  # represent emoji (raises UnicodeEncodeError). Forcing UTF-8 makes the
  # test deterministic across platforms.
  if command -v python3 >/dev/null 2>&1; then
    emoji_4096_file=$(mktemp)
    PYTHONIOENCODING=utf-8 python3 -c 'import sys; sys.stdout.write("\U0001F600" * 4096)' \
      > "$emoji_4096_file"
    emoji_4096=$(cat "$emoji_4096_file")
    rm -f "$emoji_4096_file"
    bodies=$(mktemp)
    printf '%s\n' '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}' > "$bodies"
    if start_stub 200 "$bodies"; then
      out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
              HOME="$TMPDIR_INT/empty-home" \
              bash "$HELPER" remember --text "$emoji_4096" 2>&1)
      rc=$?
      assert_rc "INT10 rc=0 (4096 emoji codepoints OK)" "0" "$rc"
      stop_stub
    fi
    # And: 4097-emoji input rejected.
    emoji_4097_file=$(mktemp)
    PYTHONIOENCODING=utf-8 python3 -c 'import sys; sys.stdout.write("\U0001F600" * 4097)' \
      > "$emoji_4097_file"
    emoji_4097=$(cat "$emoji_4097_file")
    rm -f "$emoji_4097_file"
    out=$(bash "$HELPER" remember --text "$emoji_4097" 2>&1)
    rc=$?
    assert_rc "INT10 rc=64 (4097 emoji codepoints rejected)" "64" "$rc"
  fi

  # ─── INT11: shell metacharacters preserved literally ──────────────────
  echo ""
  echo "--- INT11: shell metachar in text ---"
  if start_stub 200; then
    # shellcheck disable=SC2016
    metachar_text='Title with $(echo HACK) and `id` and ; rm /'
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "$metachar_text" 2>&1)
    rc=$?
    assert_rc "INT11 cmd_remember rc=0" "0" "$rc"
    case "$out" in
      *HACK*)
        # `HACK` may appear in the WARNING/preview line as literal text — OK.
        # But if it appears as the RESULT of command-substitution, we'd see
        # output like "HACK appeared in shell context". We check by ensuring
        # the literal `$(echo HACK)` shape is preserved in the payload.
        ;;
    esac
    body=$(head -1 "$STUB_BODYF" 2>/dev/null)
    # shellcheck disable=SC2016
    case "$body" in
      *'$(echo HACK)'*) pass "INT11 metachar preserved in payload" ;;
      *) fail "INT11 metachar preserved in payload" "got: $body" ;;
    esac
    stop_stub
  else
    fail "INT11 stub start" "could not start"
  fi

  # ─── INT12: YAML-significant chars preserved ──────────────────────────
  echo ""
  echo "--- INT12: YAML chars in text ---"
  bodies=$(mktemp)
  printf '%s\n' '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text 'colon: in middle and "quotes"' 2>&1)
    rc=$?
    assert_rc "INT12 cmd_remember rc=0" "0" "$rc"
    body=$(head -1 "$STUB_BODYF")
    assert_contains "INT12 colon preserved" "$body" 'colon: in middle'
    assert_contains "INT12 quotes escaped" "$body" '\"quotes\"'
    stop_stub
  else
    fail "INT12 stub start" "could not start"
  fi

  # ─── INT13: helper-direct `remember` without --text → exit 64 ─────────
  echo ""
  echo "--- INT13: missing --text ---"
  out=$(bash "$HELPER" remember 2>&1)
  rc=$?
  assert_rc "INT13 rc=64" "64" "$rc"
  assert_contains "INT13 message" "$out" "missing required: --text"

  # ─── INT13b: `--text=value` equals form (POSIX --opt=val convention) ──
  echo ""
  echo "--- INT13b: --text=value form ---"
  bodies=$(mktemp)
  printf '%s\n' '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text=equals-form 2>&1)
    rc=$?
    assert_rc "INT13b --text=value rc=0" "0" "$rc"
    body=$(head -1 "$STUB_BODYF")
    assert_contains "INT13b equals-form preserved in payload" "$body" '"text":"equals-form"'
    stop_stub
  else
    fail "INT13b stub start" "could not start"
  fi

  # ─── INT13c: unknown helper subcommand → exit 64, help to stdout ──────
  echo ""
  echo "--- INT13c: unknown subcommand ---"
  out=$(bash "$HELPER" not-a-subcommand 2>/dev/null)
  rc=$?
  assert_rc "INT13c rc=64" "64" "$rc"
  # Help text must reach stdout (the LLM-surfaceable channel) even on the
  # typo branch; "unknown subcommand" diagnostic goes to stderr.
  assert_contains "INT13c help body on stdout" "$out" "Usage:"
  err=$(bash "$HELPER" not-a-subcommand 2>&1 >/dev/null)
  assert_contains "INT13c diagnostic on stderr" "$err" "unknown subcommand"

  # ─── INT13d: response-shape-unknown graceful-degrade w/ note suffix ───
  echo ""
  echo "--- INT13d: unknown response shape note suffix ---"
  bodies=$(mktemp)
  # Body without a `results` key (server response drift simulation).
  printf '%s\n' '{"unexpected":"shape"}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            UM_DEFAULT_PROJECT="" \
            bash "$HELPER" remember --text "drift sim" 2>&1)
    rc=$?
    assert_rc "INT13d rc=0" "0" "$rc"
    assert_contains "INT13d response-shape-unknown suffix" "$out" "response shape unknown"
    assert_not_contains "INT13d no false dedup suffix" "$out" "dedup match"
    stop_stub
  else
    fail "INT13d stub start" "could not start"
  fi

  # ─── INT14: skill.md frontmatter sanity ───────────────────────────────
  echo ""
  echo "--- INT14: skill.md frontmatter ---"
  skill_md="$SCRIPT_DIR/skill.md"
  [ -f "$skill_md" ] && pass "INT14 skill.md exists" \
    || fail "INT14 skill.md exists" "missing"
  fm_block=$(awk '/^---$/{c++; next} c==1{print}' "$skill_md")
  assert_contains "INT14 frontmatter has name" "$fm_block" "name: create-remember"
  assert_contains "INT14 frontmatter has description" "$fm_block" "description:"

  # ─── INT15: dedup-event surfacing via round-robin stub ────────────────
  echo ""
  echo "--- INT15: dedup-event surfacing ---"
  bodies=$(mktemp)
  printf '%s\n%s\n' \
    '{"results":[{"id":"u1","memory":"X","event":"ADD"}]}' \
    '{"results":[{"id":"u1","memory":"X","event":"DEDUP_MERGED"}]}' \
    > "$bodies"
  if start_stub 200 "$bodies"; then
    # First call — ADD.
    out1=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
             HOME="$TMPDIR_INT/empty-home" \
             bash "$HELPER" remember --text "Dedup fixture" 2>&1)
    rc1=$?
    assert_rc "INT15 first call rc=0" "0" "$rc1"
    assert_not_contains "INT15 first call no dedup" "$out1" "dedup match"
    # Second call — DEDUP_MERGED.
    out2=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
             HOME="$TMPDIR_INT/empty-home" \
             bash "$HELPER" remember --text "Dedup fixture" 2>&1)
    rc2=$?
    assert_rc "INT15 second call rc=0" "0" "$rc2"
    assert_contains "INT15 second call dedup match" "$out2" "dedup match"
    stop_stub
  else
    fail "INT15 stub start" "could not start"
  fi

  # ─── INT16: empty-token vs loopback success ───────────────────────────
  echo ""
  echo "--- INT16: empty-token loopback success ---"
  bodies=$(mktemp)
  printf '%s\n' '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "anon" 2>&1)
    rc=$?
    assert_rc "INT16 rc=0 (anon loopback)" "0" "$rc"
    assert_contains "INT16 success line 2" "$out" "Registered with universal-memory"
    auth=$(head -1 "$STUB_AUTHF")
    assert_eq "INT16 no bearer header" "" "$auth"
    stop_stub
  else
    fail "INT16 stub start" "could not start"
  fi

  # ─── INT17: F1 project display via UM_DEFAULT_PROJECT ─────────────────
  echo ""
  echo "--- INT17: F1 project display ---"
  bodies=$(mktemp)
  printf '%s\n' '{"results":[{"id":"u1","memory":"m","event":"ADD"}]}' > "$bodies"
  if start_stub 200 "$bodies"; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            UM_DEFAULT_PROJECT="alpha" \
            HOME="$TMPDIR_INT/empty-home" \
            bash "$HELPER" remember --text "proj test" 2>&1)
    rc=$?
    assert_rc "INT17 rc=0" "0" "$rc"
    assert_contains "INT17 project=alpha in line 2" "$out" "project=alpha"
    stop_stub
  else
    fail "INT17 stub start" "could not start"
  fi

  # ─── INT18: graceful-degrade on `{}` envelope (no results key) ────────
  echo ""
  echo "--- INT18: graceful-degrade ---"
  # Stub returns hardcoded b'{}' (default behavior when bodies file absent).
  # _parse_event returns "unknown"; success line carries the new
  # "response shape unknown" suffix (review followup, replaces silent
  # collapse-to-add behavior).
  if start_stub 200; then
    out=$(UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" \
            HOME="$TMPDIR_INT/empty-home" \
            UM_DEFAULT_PROJECT="" \
            bash "$HELPER" remember --text "graceful degrade" 2>&1)
    rc=$?
    assert_rc "INT18 rc=0" "0" "$rc"
    assert_contains "INT18 line 1 Remembered" "$out" "Remembered: graceful degrade"
    assert_contains "INT18 line 2 registered" "$out" "Registered with universal-memory"
    assert_contains "INT18 response-shape-unknown suffix" "$out" "response shape unknown"
    assert_not_contains "INT18 no dedup suffix" "$out" "dedup match"
    assert_not_contains "INT18 no zero-facts note" "$out" "zero facts"
    # 2 lines, not crashing on missing results key.
    line_count=$(printf '%s' "$out" | grep -c '^')
    assert_eq "INT18 still 2 lines" "2" "$line_count"
    stop_stub
  else
    fail "INT18 stub start" "could not start"
  fi

  # Cleanup integration tmpdir.
  rm -rf "$TMPDIR_INT"
fi

# ─── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All create-remember.sh tests pass."
