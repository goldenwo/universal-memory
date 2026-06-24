#!/usr/bin/env bash
# create-adr.test.sh — unit + integration tests for the /adr skill helper.
#
# Run from repo root:
#   bash plugins/claude-code/universal-memory/skills/create-adr/create-adr.test.sh
#
# Pattern matches plugins/claude-code/universal-memory/hooks/lib/endpoint.test.sh:
# PASS/FAIL counters, exits non-zero on any failure, sets up tmp dirs per test.
#
# shellcheck disable=SC2015
# Rationale: the `<test> && pass "name" || fail "name" "msg"` pattern is
# intentional and safe here. `pass` is `PASS=$((PASS+1)); printf ...` which
# only exits non-zero in the rare-impossible case of printf failing on a
# TTY/pipe; the SC2015 trap (B failing → C runs anyway) does not apply.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/create-adr.sh"

# Source the helper for unit-level access to helper functions. The helper's
# dispatcher gates on `${BASH_SOURCE[0]} == ${0}` so sourcing is safe.
# shellcheck source=create-adr.sh
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

assert_rc() {
  local name="$1" expected_rc="$2" actual_rc="$3"
  if [ "$expected_rc" = "$actual_rc" ]; then
    pass "$name"
  else
    fail "$name" "want rc=$expected_rc got rc=$actual_rc"
  fi
}

# ─── Unit tests: _sanitize_title ────────────────────────────────────────────
echo ""
echo "=== unit: _sanitize_title ==="

t1=$(_sanitize_title "$(printf 'foo\x00bar')")
assert_eq "_sanitize_title strips NUL" "foobar" "$t1"

t2=$(_sanitize_title "$(printf 'foo\x07bar')")
assert_eq "_sanitize_title strips BEL" "foobar" "$t2"

t3=$(_sanitize_title "$(printf 'foo\x7Fbar')")
assert_eq "_sanitize_title strips DEL" "foobar" "$t3"

t4=$(_sanitize_title "$(printf 'foo\xC2\x85bar')")
assert_eq "_sanitize_title strips C1 NEL" "foobar" "$t4"

# Bidi U+202E (RLO) — \xE2\x80\xAE.
out=$(_sanitize_title "$(printf 'foo\xE2\x80\xAEbar')" 2>/dev/null)
rc=$?
assert_rc "_sanitize_title rejects U+202E rc=1" "1" "$rc"

# Bidi U+2066 (LRI) — \xE2\x81\xA6.
out=$(_sanitize_title "$(printf 'foo\xE2\x81\xA6bar')" 2>/dev/null)
rc=$?
assert_rc "_sanitize_title rejects U+2066 rc=1" "1" "$rc"

# LRM U+200E (\xE2\x80\x8E) is benign — should pass through.
t5=$(_sanitize_title "$(printf 'foo\xE2\x80\x8Ebar')")
# After sanitization, the LRM byte sequence is preserved (we strip only
# C0/C1/DEL + bidi-override). Length-3 + 3-byte LRM + length-3 = 9 bytes.
[ "${#t5}" -ge 6 ] && pass "_sanitize_title keeps LRM" \
  || fail "_sanitize_title keeps LRM" "got='$t5' (len=${#t5})"

t6=$(_sanitize_title $'foo\nbar')
assert_eq "_sanitize_title newline-to-space" "foo bar" "$t6"

t7=$(_sanitize_title "foo   bar")
assert_eq "_sanitize_title collapses whitespace" "foo bar" "$t7"

t8=$(_sanitize_title "  trimmed  ")
assert_eq "_sanitize_title trims ends" "trimmed" "$t8"

# ─── Unit tests: _slug ──────────────────────────────────────────────────────
echo ""
echo "=== unit: _slug ==="

assert_eq "_slug basic"           "hello-world"   "$(_slug 'Hello, World!')"
assert_eq "_slug numbers"         "v2-feature"    "$(_slug 'v2 feature')"
assert_eq "_slug emoji fallback"  "untitled"      "$(_slug '😀😀😀')"
assert_eq "_slug octal-trap"      "0042"          "$(_slug '0042')"
assert_eq "_slug trim leading/trailing hyphens" "a-b" "$(_slug '---a-b---')"
assert_eq "_slug collapses non-alphanum runs"   "a-b" "$(_slug 'a   b')"

long_input=$(printf 'a%.0s' {1..80})
got=$(_slug "$long_input")
[ "${#got}" -le 60 ] && pass "_slug clamps to <=60 chars (got ${#got})" \
  || fail "_slug clamps" "len=${#got}"

# ─── Unit tests: _auto_number ───────────────────────────────────────────────
echo ""
echo "=== unit: _auto_number ==="

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/empty"
assert_eq "_auto_number empty dir" "1" "$(_auto_number "$tmp/empty")"

mkdir -p "$tmp/gap"
touch "$tmp/gap/0001-x.md" "$tmp/gap/0003-y.md"
assert_eq "_auto_number gap-preserving" "4" "$(_auto_number "$tmp/gap")"

mkdir -p "$tmp/octal"
touch "$tmp/octal/0042-foo.md"
assert_eq "_auto_number octal-trap regression" "43" "$(_auto_number "$tmp/octal")"

mkdir -p "$tmp/mixed"
touch "$tmp/mixed/README.md" "$tmp/mixed/.gitkeep" "$tmp/mixed/0001-x.md" "$tmp/mixed/notes.txt"
assert_eq "_auto_number ignores non-matching" "2" "$(_auto_number "$tmp/mixed")"

mkdir -p "$tmp/big"
touch "$tmp/big/9999-x.md"
assert_eq "_auto_number 4-digit ceiling" "10000" "$(_auto_number "$tmp/big")"

# ─── Unit tests: _safe_write_file ───────────────────────────────────────────
echo ""
echo "=== unit: _safe_write_file ==="

target="$tmp/safe1.md"
_safe_write_file "$target" "hello world"
rc=$?
assert_rc "_safe_write_file new path rc=0" "0" "$rc"
[ "$(cat "$target" 2>/dev/null)" = "hello world" ] && pass "_safe_write_file body" \
  || fail "_safe_write_file body" "want='hello world' got='$(cat "$target" 2>/dev/null)'"

# Existing file → return 17 (EEXIST).
_safe_write_file "$target" "should not overwrite" 2>/dev/null
rc=$?
assert_rc "_safe_write_file rejects existing rc=17" "17" "$rc"
[ "$(cat "$target")" = "hello world" ] && pass "_safe_write_file no overwrite" \
  || fail "_safe_write_file no overwrite" "got='$(cat "$target")'"

# Symlink → return 73. Skipped on Windows when `ln -s` either fails outright
# or silently produces a regular file copy (no dev-mode / not running as
# admin); the symlink defense is documented as best-effort and exercised on
# POSIX CI runners where the kernel honors symlink semantics.
sym_target="$tmp/sym.md"
if ln -s "$tmp/safe1.md" "$sym_target" 2>/dev/null && [ -L "$sym_target" ]; then
  _safe_write_file "$sym_target" "should refuse" 2>/dev/null
  rc=$?
  assert_rc "_safe_write_file rejects symlink rc=73" "73" "$rc"
else
  echo "  SKIP: real symlinks unavailable (Windows without dev-mode); symlink defense covered on POSIX CI"
fi

# ─── Unit tests: _resolve_auth_token ────────────────────────────────────────
echo ""
echo "=== unit: _resolve_auth_token ==="

# Env precedence: env wins over config.
TEST_HOME=$(mktemp -d)
trap 'rm -rf "$tmp" "$TEST_HOME"' EXIT
mkdir -p "$TEST_HOME/.claude/skills/create-adr"
printf '{"auth_token":"from-config"}\n' > "$TEST_HOME/.claude/skills/create-adr/config.json"

got=$(HOME="$TEST_HOME" UM_AUTH_TOKEN="from-env" _resolve_auth_token)
assert_eq "_resolve_auth_token env precedence" "from-env" "$got"

got=$(HOME="$TEST_HOME" UM_AUTH_TOKEN="" _resolve_auth_token)
assert_eq "_resolve_auth_token config fallback" "from-config" "$got"

EMPTY_HOME=$(mktemp -d)
got=$(HOME="$EMPTY_HOME" UM_AUTH_TOKEN="" _resolve_auth_token)
assert_eq "_resolve_auth_token empty default" "" "$got"
rm -rf "$EMPTY_HOME"

# ─── Unit tests: _detect_self_application ───────────────────────────────────
echo ""
echo "=== unit: _detect_self_application ==="

setup_tmp_repo() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d" && git init -q && git config user.email t@t && git config user.name t )
}

# Sentinel match.
sentinel_repo="$tmp/sentinel"
setup_tmp_repo "$sentinel_repo"
touch "$sentinel_repo/.um-self-host"
( cd "$sentinel_repo" && _detect_self_application )
rc=$?
assert_rc "_detect_self_application sentinel rc=0" "0" "$rc"

# package.json match.
pkg_repo="$tmp/pkg"
setup_tmp_repo "$pkg_repo"
printf '{"name":"universal-memory-server","version":"1.0.0"}\n' > "$pkg_repo/package.json"
( cd "$pkg_repo" && _detect_self_application )
rc=$?
assert_rc "_detect_self_application package.json match rc=0" "0" "$rc"

# Foreign repo (different name, no sentinel).
foreign_repo="$tmp/foreign"
setup_tmp_repo "$foreign_repo"
printf '{"name":"some-other-thing","version":"0.1.0"}\n' > "$foreign_repo/package.json"
( cd "$foreign_repo" && _detect_self_application )
rc=$?
assert_rc "_detect_self_application foreign repo rc=1" "1" "$rc"

# From subdir (sentinel at root, cwd=subdir/).
sub_repo="$tmp/subrepo"
setup_tmp_repo "$sub_repo"
touch "$sub_repo/.um-self-host"
mkdir -p "$sub_repo/docs"
( cd "$sub_repo/docs" && _detect_self_application )
rc=$?
assert_rc "_detect_self_application from subdir rc=0" "0" "$rc"

# Not-in-git-repo (no .git) → return 1, no error.
nongit="$tmp/nongit"
mkdir -p "$nongit"
( cd "$nongit" && _detect_self_application 2>/dev/null )
rc=$?
assert_rc "_detect_self_application non-git rc=1" "1" "$rc"

# ─── Unit tests: _render_frontmatter ────────────────────────────────────────
echo ""
echo "=== unit: _render_frontmatter ==="

cd "$tmp" && git init -q ./fm_repo >/dev/null && cd fm_repo \
  && git config user.email t@t && git config user.name "Test User"
fm=$(_render_frontmatter 42 foo-bar "Foo Bar")
assert_contains "_render_frontmatter has schema_version" "$fm" "schema_version: 1"
assert_contains "_render_frontmatter has id"             "$fm" "id: 0042-foo-bar"
assert_contains "_render_frontmatter has quoted title"   "$fm" 'title: "Foo Bar"'
assert_contains "_render_frontmatter has status"         "$fm" "status: Proposed"
assert_contains "_render_frontmatter has supersedes"     "$fm" "supersedes: []"
assert_contains "_render_frontmatter has superseded_by"  "$fm" "superseded_by: null"
assert_contains "_render_frontmatter has decided_at"     "$fm" "decided_at: "
assert_contains "_render_frontmatter has quoted decided_by" "$fm" 'decided_by: "Test User"'
assert_contains "_render_frontmatter has open delim"     "$fm" "---"
assert_contains "_render_frontmatter has body header"    "$fm" "## Context"

cd "$SCRIPT_DIR" >/dev/null || exit 1

# ─── Unit tests: _yaml_dq + _fm_value round-trip ───────────────────────────
echo ""
echo "=== unit: _yaml_dq + _fm_value round-trip ==="

assert_eq "_yaml_dq plain"     '"hello"'       "$(_yaml_dq 'hello')"
assert_eq "_yaml_dq quote"     '"a\"b"'        "$(_yaml_dq 'a"b')"
assert_eq "_yaml_dq backslash" '"a\\\\b"'      "$(_yaml_dq 'a\\b')"
assert_eq "_yaml_dq colon"     '"foo: bar"'    "$(_yaml_dq 'foo: bar')"

# Round-trip via _fm_value (parser unwraps + unescapes).
for raw in 'plain' 'with "quote"' 'with \backslash' 'colon: in middle' 'mixed "x" \\ y'; do
  q=$(_yaml_dq "$raw")
  back=$(_fm_value " $q ")
  assert_eq "round-trip <$raw>" "$raw" "$back"
done

# Unquoted plain values pass through unchanged.
assert_eq "_fm_value unquoted plain"  "Proposed"  "$(_fm_value " Proposed ")"
assert_eq "_fm_value trims whitespace"  "x"         "$(_fm_value "    x   ")"

# ─── Unit tests: _json_escape ───────────────────────────────────────────────
echo ""
echo "=== unit: _json_escape ==="

assert_eq "_json_escape plain"      "hello"          "$(_json_escape 'hello')"
# Quote: input `hello "world`, output `hello \"world` (one backslash + quote)
assert_eq "_json_escape quote"      'hello \"world'  "$(_json_escape 'hello "world')"
# Backslash: input `a\b` (3 chars: a, \, b), output `a\\b` (4 chars: a, \, \, b)
assert_eq "_json_escape backslash"  'a\\b'           "$(_json_escape 'a\b')"
# Newline: input contains LF, output contains literal `\n`
assert_eq "_json_escape newline"    'line1\nline2'   "$(_json_escape $'line1\nline2')"
# Tab: input contains tab, output contains literal `\t`
assert_eq "_json_escape tab"        'a\tb'           "$(_json_escape $'a\tb')"

# ─── Integration tests ──────────────────────────────────────────────────────
echo ""
echo "=== integration: stub-server-backed tests ==="

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "  SKIP: python not available — skipping integration tests"
else
  PYTHON=$(command -v python3 || command -v python)

  # Write the stub server script once. It writes:
  #   STUB_BODY    — the raw request body (JSON), one request per line
  #   STUB_AUTH    — the Authorization header value, one request per line
  #   STUB_PATH    — the request path, one per line
  # Splitting these avoids quoting headaches when shell-grepping the body.
  STUB_SCRIPT="$tmp/stub-server.py"
  cat > "$STUB_SCRIPT" <<'PYEOF'
import http.server, os, socketserver
BODY_FILE = os.environ['STUB_BODY']
AUTH_FILE = os.environ['STUB_AUTH']
PATH_FILE = os.environ['STUB_PATH']
PORT_FILE = os.environ['STUB_PORT_FILE']
STATUS = int(os.environ.get('STUB_STATUS', '200'))

class H(http.server.BaseHTTPRequestHandler):
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
        self.wfile.write(b'{}')
    def log_message(self, *a, **k): pass

# The stdlib http.server.HTTPServer.server_bind() calls socket.getfqdn() on
# the bind host and sets server_port only AFTER that lookup. A reverse-DNS
# lookup of 127.0.0.1 can block for seconds on macOS CI (mDNSResponder),
# delaying the port-file write past start_stub's startup poll and surfacing
# as "stub start — could not start". This stub never reads server_name, so
# bind without the lookup and record the OS-assigned port directly.
class Stub(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = self.server_address[0]
        self.server_port = self.server_address[1]

s = Stub(('127.0.0.1', 0), H)
with open(PORT_FILE, 'w') as f:
    f.write(str(s.server_port))
s.serve_forever()
PYEOF

  # start_stub <status> → sets STUB_URL, STUB_BODYF, STUB_AUTHF, STUB_PID
  # globals. Runs in main shell (NOT a subshell capture) so the background
  # python process inherits the main shell's lifecycle, not a subshell that
  # exits immediately after capture.
  STUB_URL=""; STUB_BODYF=""; STUB_AUTHF=""; STUB_PATHF=""; STUB_PID=""; STUB_ERRF=""
  start_stub() {
    local status="${1:-200}"
    STUB_BODYF=$(mktemp)
    STUB_AUTHF=$(mktemp)
    STUB_PATHF=$(mktemp)
    STUB_ERRF=$(mktemp)
    : > "$STUB_BODYF"; : > "$STUB_AUTHF"; : > "$STUB_PATHF"; : > "$STUB_ERRF"
    local portf
    portf=$(mktemp)
    rm -f "$portf"
    STUB_BODY="$STUB_BODYF" STUB_AUTH="$STUB_AUTHF" STUB_PATH="$STUB_PATHF" \
      STUB_PORT_FILE="$portf" STUB_STATUS="$status" \
      "$PYTHON" "$STUB_SCRIPT" 2>"$STUB_ERRF" &
    STUB_PID=$!
    # Condition-based wait for the OS-assigned port (bounded ~10s). Break out
    # early if the python process exits before writing the port, so a crash is
    # reported immediately with its stderr instead of after the full timeout.
    local i=0
    while [ ! -s "$portf" ] && [ "$i" -lt 100 ]; do
      kill -0 "$STUB_PID" 2>/dev/null || break
      sleep 0.1
      i=$((i + 1))
    done
    if [ ! -s "$portf" ]; then
      kill "$STUB_PID" 2>/dev/null
      wait "$STUB_PID" 2>/dev/null || true
      # Surface why the stub never came up so a future flake is diagnosable in
      # the CI log rather than a bare "could not start".
      printf '  stub start failed (status=%s): %s\n' \
        "$status" "$(tr '\n' ' ' < "$STUB_ERRF" 2>/dev/null)" >&2
      rm -f "$portf" "$STUB_ERRF"
      STUB_ERRF=""
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
    rm -f "$STUB_BODYF" "$STUB_AUTHF" "$STUB_PATHF" "$STUB_ERRF"
    STUB_BODYF=""; STUB_AUTHF=""; STUB_PATHF=""; STUB_ERRF=""
    STUB_URL=""
  }

  setup_consumer_repo() {
    local d="$1"
    mkdir -p "$d"
    ( cd "$d" \
        && git init -q \
        && git config user.email tester@example.com \
        && git config user.name "Tester" \
        && git config commit.gpgsign false )
  }

  # ─── INT1: cmd_help exits 0 ───────────────────────────────────────────────
  echo ""
  echo "--- INT1: help ---"
  out=$(bash "$HELPER" help 2>&1)
  rc=$?
  assert_rc "INT1 help rc=0" "0" "$rc"
  assert_contains "INT1 help text contains Usage" "$out" "Usage:"
  assert_contains "INT1 help text contains sync" "$out" "sync"
  assert_contains "INT1 help text contains --commit" "$out" "--commit"

  # ─── INT2: happy path with stub server ────────────────────────────────────
  echo ""
  echo "--- INT2: cmd_create happy path ---"
  if start_stub 200; then
    crepo="$tmp/int2-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="" HOME="$tmp/empty-home" \
            bash "$HELPER" create --title "Adopt mem0 OSS" 2>&1)
    rc=$?
    assert_rc "INT2 cmd_create rc=0" "0" "$rc"
    assert_contains "INT2 success line 1" "$out" "ADR-0001 written:"
    assert_contains "INT2 success line 2" "$out" "Committed:"
    assert_contains "INT2 success line 3" "$out" "Registered with universal-memory"
    [ -f "$crepo/docs/decisions/0001-adopt-mem0-oss.md" ] \
      && pass "INT2 file written" \
      || fail "INT2 file written" "missing 0001-adopt-mem0-oss.md"
    commit_subject=$(cd "$crepo" && git log -1 --format='%s' 2>/dev/null)
    assert_eq "INT2 commit subject" "docs(adr): 0001 Adopt mem0 OSS" "$commit_subject"
    [ -s "$STUB_BODYF" ] && pass "INT2 stub captured POST" \
      || fail "INT2 stub captured POST" "body file empty"
    [ "$(head -1 "$STUB_PATHF")" = "/api/add" ] && pass "INT2 path is /api/add" \
      || fail "INT2 path is /api/add" "got: $(head -1 "$STUB_PATHF")"
    body=$(head -1 "$STUB_BODYF")
    assert_contains "INT2 payload type=adr"     "$body" '"type":"adr"'
    assert_contains "INT2 payload adr_id=0001"  "$body" '"adr_id":"0001"'
    assert_contains "INT2 payload status field" "$body" '"adr_status":"Proposed"'
    case "$body" in
      *'"scope":'*) fail "INT2 no top-level scope" "found scope in: $body" ;;
      *) pass "INT2 no top-level scope" ;;
    esac
    case "$body" in
      *'"metadata":'*'"schema_version":1'*'"type":"adr"'*'"adr_status":"Proposed"'*)
        pass "INT2 metadata field order" ;;
      *) fail "INT2 metadata field order" "got: $body" ;;
    esac
    stop_stub
  else
    fail "INT2 stub start" "could not start"
  fi

  # ─── INT3: bearer header when UM_AUTH_TOKEN set ───────────────────────────
  echo ""
  echo "--- INT3: bearer header ---"
  if start_stub 200; then
    crepo="$tmp/int3-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" UM_AUTH_TOKEN="secret-token-xyz" \
            HOME="$tmp/empty-home" \
            bash "$HELPER" create --title "Bearer test" 2>&1)
    rc=$?
    assert_rc "INT3 cmd_create rc=0" "0" "$rc"
    auth=$(head -1 "$STUB_AUTHF")
    assert_eq "INT3 bearer header" "Bearer secret-token-xyz" "$auth"
    stop_stub
  else
    fail "INT3 stub start" "could not start"
  fi

  # ─── INT4: not-in-git-repo ────────────────────────────────────────────────
  echo ""
  echo "--- INT4: not-in-git-repo ---"
  nongit="$tmp/int4-nongit"
  mkdir -p "$nongit"
  out=$(cd "$nongit" && UM_SERVER_URL="http://127.0.0.1:1" \
          bash "$HELPER" create --title "should fail" 2>&1)
  rc=$?
  assert_rc "INT4 rc=65" "65" "$rc"
  assert_contains "INT4 error text" "$out" "requires a git repository"

  # ─── INT5: unknown flag ───────────────────────────────────────────────────
  echo ""
  echo "--- INT5: unknown flag ---"
  out=$(bash "$HELPER" create --foo bar 2>&1)
  rc=$?
  assert_rc "INT5 rc=64" "64" "$rc"
  assert_contains "INT5 error text" "$out" "unknown flag: --foo"

  # ─── INT6: self-application via sentinel skips commit + POST ──────────────
  echo ""
  echo "--- INT6: self-application skip ---"
  if start_stub 200; then
    self_repo="$tmp/int6-self"
    setup_consumer_repo "$self_repo"
    touch "$self_repo/.um-self-host"
    out=$(cd "$self_repo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "self test" 2>&1)
    rc=$?
    assert_rc "INT6 cmd_create rc=0" "0" "$rc"
    assert_contains "INT6 self-host third line" "$out" "Skipped registration (universal-memory self-host)"
    assert_contains "INT6 commit line skipped"  "$out" "(skipped — self-host)"
    [ -f "$self_repo/docs/decisions/0001-self-test.md" ] \
      && pass "INT6 file written" \
      || fail "INT6 file written" "missing"
    [ ! -s "$STUB_BODYF" ] && pass "INT6 no POST" \
      || fail "INT6 no POST" "body not empty: $(cat "$STUB_BODYF")"
    commit_count=$(cd "$self_repo" && git rev-list --count HEAD 2>/dev/null || echo 0)
    assert_eq "INT6 no commit" "0" "$commit_count"
    stop_stub
  else
    fail "INT6 stub start" "could not start"
  fi

  # ─── INT7: --commit overrides self-application ────────────────────────────
  echo ""
  echo "--- INT7: --commit override ---"
  if start_stub 200; then
    self_repo="$tmp/int7-self"
    setup_consumer_repo "$self_repo"
    touch "$self_repo/.um-self-host"
    out=$(cd "$self_repo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "force commit" --commit 2>&1)
    rc=$?
    assert_rc "INT7 cmd_create rc=0" "0" "$rc"
    assert_contains "INT7 third line registered" "$out" "Registered with universal-memory"
    commit_count=$(cd "$self_repo" && git rev-list --count HEAD 2>/dev/null || echo 0)
    assert_eq "INT7 has commit" "1" "$commit_count"
    [ -s "$STUB_BODYF" ] && pass "INT7 POST captured" || fail "INT7 POST captured" "body empty"
    stop_stub
  else
    fail "INT7 stub start" "could not start"
  fi

  # ─── INT8: --no-path omits repo_path ──────────────────────────────────────
  echo ""
  echo "--- INT8: --no-path ---"
  if start_stub 200; then
    crepo="$tmp/int8-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "no path test" --no-path 2>&1)
    rc=$?
    assert_rc "INT8 cmd_create rc=0" "0" "$rc"
    body=$(head -1 "$STUB_BODYF")
    case "$body" in
      *'"repo_path":'*) fail "INT8 omits repo_path" "found repo_path in: $body" ;;
      *) pass "INT8 omits repo_path" ;;
    esac
    stop_stub
  else
    fail "INT8 stub start" "could not start"
  fi

  # ─── INT9: 401 → warn-only for cmd_create ─────────────────────────────────
  echo ""
  echo "--- INT9: 401 warn-only ---"
  if start_stub 401; then
    crepo="$tmp/int9-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "401 test" 2>&1)
    rc=$?
    assert_rc "INT9 cmd_create rc=0 (warn-only)" "0" "$rc"
    assert_contains "INT9 WARNING text" "$out" "WARNING: not registered"
    assert_contains "INT9 token pointer" "$out" "UM_AUTH_TOKEN"
    [ -f "$crepo/docs/decisions/0001-401-test.md" ] \
      && pass "INT9 file written" \
      || fail "INT9 file written" "missing"
    commit_count=$(cd "$crepo" && git rev-list --count HEAD 2>/dev/null || echo 0)
    assert_eq "INT9 commit landed" "1" "$commit_count"
    stop_stub
  else
    fail "INT9 stub start" "could not start"
  fi

  # ─── INT10: 503 → warn-only for cmd_create ────────────────────────────────
  echo ""
  echo "--- INT10: 503 warn-only ---"
  if start_stub 503; then
    crepo="$tmp/int10-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "503 test" 2>&1)
    rc=$?
    assert_rc "INT10 cmd_create rc=0 (warn-only)" "0" "$rc"
    assert_contains "INT10 WARNING text" "$out" "WARNING: not registered"
    assert_contains "INT10 HTTP 503"      "$out" "HTTP 503"
    stop_stub
  else
    fail "INT10 stub start" "could not start"
  fi

  # ─── INT11: cmd_sync happy path ───────────────────────────────────────────
  echo ""
  echo "--- INT11: cmd_sync happy path ---"
  if start_stub 200; then
    crepo="$tmp/int11-repo"
    setup_consumer_repo "$crepo"
    ( cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
        bash "$HELPER" create --title "Sync me" >/dev/null 2>&1 )
    : > "$STUB_BODYF"; : > "$STUB_AUTHF"; : > "$STUB_PATHF"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" sync 1 2>&1)
    rc=$?
    assert_rc "INT11 cmd_sync rc=0" "0" "$rc"
    assert_contains "INT11 sync output" "$out" "Re-registered ADR-0001"
    [ -s "$STUB_BODYF" ] && pass "INT11 sync POST captured" \
      || fail "INT11 sync POST captured" "body empty"
    body=$(head -1 "$STUB_BODYF")
    # Sync sends just NNNN (matching cmd_create's shape), NOT NNNN-slug.
    # Server-side reconciliation between create + sync rounds depends on
    # the same adr_id key.
    assert_contains "INT11 payload adr_id (NNNN-only shape)" "$body" '"adr_id":"0001"'
    stop_stub
  else
    fail "INT11 stub start" "could not start"
  fi

  # ─── INT12: cmd_sync 401 LOUD-fail (asymmetry) ────────────────────────────
  echo ""
  echo "--- INT12: cmd_sync 401 LOUD ---"
  if start_stub 200; then
    crepo="$tmp/int12-repo"
    setup_consumer_repo "$crepo"
    ( cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
        bash "$HELPER" create --title "Loud sync 401" >/dev/null 2>&1 )
    stop_stub
    if start_stub 401; then
      out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
              bash "$HELPER" sync 1 2>&1)
      rc=$?
      [ "$rc" != "0" ] && pass "INT12 sync 401 non-zero exit (rc=$rc)" \
        || fail "INT12 sync 401 non-zero exit" "rc=0 (expected non-zero)"
      assert_contains "INT12 sync 401 message" "$out" "auth failed"
      stop_stub
    else
      fail "INT12 stub-sync start" "could not start"
    fi
  else
    fail "INT12 stub-create start" "could not start"
  fi

  # ─── INT13: cmd_sync invalid frontmatter ──────────────────────────────────
  echo ""
  echo "--- INT13: cmd_sync invalid frontmatter ---"
  crepo="$tmp/int13-repo"
  setup_consumer_repo "$crepo"
  mkdir -p "$crepo/docs/decisions"
  cat > "$crepo/docs/decisions/0001-bad.md" <<'EOF'
---
schema_version: 1
title: Missing id field
---

Body
EOF
  out=$(cd "$crepo" && UM_SERVER_URL="http://127.0.0.1:1" \
          bash "$HELPER" sync 1 2>&1)
  rc=$?
  [ "$rc" != "0" ] && pass "INT13 invalid frontmatter rc!=0 (rc=$rc)" \
    || fail "INT13 invalid frontmatter rc!=0" "rc=0"
  assert_contains "INT13 missing-field message" "$out" "missing required field: id"

  # ─── INT15: YAML colon in title round-trips through PyYAML ──────────────
  echo ""
  echo "--- INT15: title with colon round-trips through PyYAML ---"
  if start_stub 200; then
    crepo="$tmp/int15-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "Adopt mem0: a vector store" 2>&1)
    rc=$?
    assert_rc "INT15 cmd_create rc=0" "0" "$rc"
    adr_file="$crepo/docs/decisions/0001-adopt-mem0-a-vector-store.md"
    [ -f "$adr_file" ] && pass "INT15 file written" \
      || fail "INT15 file written" "missing $adr_file"
    if [ -f "$adr_file" ]; then
      # Validate YAML frontmatter parses cleanly via PyYAML. Captures
      # the BLOCKER class (unquoted `:` in plain scalar).
      yaml_out=$("$PYTHON" -c "
import sys, yaml
with open(sys.argv[1]) as f:
    text = f.read()
parts = text.split('---', 2)
fm = yaml.safe_load(parts[1])
print(fm['title'])
" "$adr_file" 2>&1)
      yaml_rc=$?
      assert_rc "INT15 PyYAML parse rc=0" "0" "$yaml_rc"
      assert_eq "INT15 title round-trips" "Adopt mem0: a vector store" "$yaml_out"
    fi
    stop_stub
  else
    fail "INT15 stub start" "could not start"
  fi

  # ─── INT16: title with shell metacharacters preserved literally ──────────
  echo ""
  echo "--- INT16: shell metachar in title ---"
  if start_stub 200; then
    crepo="$tmp/int16-repo"
    setup_consumer_repo "$crepo"
    # Backticks, $(...), pipe, semicolon — must not execute, must round-trip.
    # shellcheck disable=SC2016
    # Single quotes are deliberate: we want the literal command-substitution
    # syntax in the title, NOT the expanded result. The whole point of this
    # test is that the helper passes them through without executing.
    metachar_title='Title with $(echo HACK) and `id` and ; rm /'
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "$metachar_title" 2>&1)
    rc=$?
    assert_rc "INT16 cmd_create rc=0" "0" "$rc"
    case "$out" in
      *HACK*) fail "INT16 no command-substitution leak" "HACK appeared in output: $out" ;;
      *) pass "INT16 no command-substitution leak" ;;
    esac
    body=$(head -1 "$STUB_BODYF" 2>/dev/null)
    # shellcheck disable=SC2016
    # Single quotes deliberate: we're searching for the literal characters
    # `$(echo HACK)` in the captured payload — NOT expanding them.
    case "$body" in
      *'$(echo HACK)'*) pass "INT16 metachar preserved in payload" ;;
      *) fail "INT16 metachar preserved in payload" "got: $body" ;;
    esac
    stop_stub
  else
    fail "INT16 stub start" "could not start"
  fi

  # ─── INT17: cmd_sync --no-path omits repo_path ──────────────────────────
  echo ""
  echo "--- INT17: cmd_sync --no-path ---"
  if start_stub 200; then
    crepo="$tmp/int17-repo"
    setup_consumer_repo "$crepo"
    ( cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
        bash "$HELPER" create --title "Sync no-path" >/dev/null 2>&1 )
    : > "$STUB_BODYF"; : > "$STUB_AUTHF"; : > "$STUB_PATHF"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" sync 1 --no-path 2>&1)
    rc=$?
    assert_rc "INT17 cmd_sync rc=0" "0" "$rc"
    body=$(head -1 "$STUB_BODYF")
    case "$body" in
      *'"repo_path":'*) fail "INT17 sync omits repo_path" "found repo_path in: $body" ;;
      *) pass "INT17 sync omits repo_path" ;;
    esac
    stop_stub
  else
    fail "INT17 stub start" "could not start"
  fi

  # ─── INT18: cmd_sync rejects extra positional + invalid flag ─────────────
  echo ""
  echo "--- INT18: cmd_sync rejects bad args ---"
  crepo="$tmp/int18-repo"
  setup_consumer_repo "$crepo"
  out=$(cd "$crepo" && bash "$HELPER" sync 1 extra-junk 2>&1); rc=$?
  assert_rc "INT18 sync extra-arg rc=64" "64" "$rc"
  assert_contains "INT18 extra-arg message" "$out" "unexpected extra argument"

  out=$(cd "$crepo" && bash "$HELPER" sync 1 --commit 2>&1); rc=$?
  assert_rc "INT18 sync --commit rc=64" "64" "$rc"
  assert_contains "INT18 --commit-rejected message" "$out" "unknown flag for sync"

  # ─── INT19: 403 buckets with auth-class warn (cmd_create) ────────────────
  echo ""
  echo "--- INT19: 403 → auth-class warn ---"
  if start_stub 403; then
    crepo="$tmp/int19-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "403 test" 2>&1)
    rc=$?
    assert_rc "INT19 cmd_create rc=0 (warn-only)" "0" "$rc"
    assert_contains "INT19 auth-class WARNING" "$out" "auth failed"
    assert_contains "INT19 token pointer"     "$out" "UM_AUTH_TOKEN"
    stop_stub
  else
    fail "INT19 stub start" "could not start"
  fi

  # ─── INT20: 422 buckets with not-retryable warn (cmd_create) ─────────────
  echo ""
  echo "--- INT20: 422 → not-retryable warn ---"
  if start_stub 422; then
    crepo="$tmp/int20-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "422 test" 2>&1)
    rc=$?
    assert_rc "INT20 cmd_create rc=0 (warn-only)" "0" "$rc"
    assert_contains "INT20 payload-rejected text" "$out" "payload rejected"
    case "$out" in
      *"Re-running will not help"*) pass "INT20 not-retryable hint" ;;
      *) fail "INT20 not-retryable hint" "got: $out" ;;
    esac
    stop_stub
  else
    fail "INT20 stub start" "could not start"
  fi

  # ─── INT21: success output is exactly 3 lines ──────────────────────────
  echo ""
  echo "--- INT21: success output is exactly 3 lines ---"
  if start_stub 200; then
    crepo="$tmp/int21-repo"
    setup_consumer_repo "$crepo"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" create --title "line count" 2>&1)
    rc=$?
    assert_rc "INT21 cmd_create rc=0" "0" "$rc"
    line_count=$(printf '%s' "$out" | grep -c '^')
    assert_eq "INT21 success has exactly 3 lines" "3" "$line_count"
    stop_stub
  else
    fail "INT21 stub start" "could not start"
  fi

  # ─── INT22: empty git config user.name ───────────────────────────────────
  # Goal: assert _render_frontmatter falls back to `decided_by: ""` when
  # `git config user.name` returns nothing. Use the self-host sentinel
  # path so we skip git commit (which requires user.name/email on some
  # git builds — particularly Linux CI runners). The frontmatter is
  # written before any commit, so the assertion is unaffected.
  echo ""
  echo "--- INT22: empty user.name fallback ---"
  crepo="$tmp/int22-repo"
  isolated_home="$tmp/int22-home"
  mkdir -p "$crepo" "$isolated_home"
  ( cd "$crepo" && HOME="$isolated_home" GIT_CONFIG_NOSYSTEM=1 git init -q )
  touch "$crepo/.um-self-host"  # triggers self-app skip → no commit
  out=$(cd "$crepo" && HOME="$isolated_home" GIT_CONFIG_NOSYSTEM=1 \
          bash "$HELPER" create --title "no name test" 2>&1)
  rc=$?
  assert_rc "INT22 cmd_create rc=0 (empty name)" "0" "$rc"
  if [ -f "$crepo/docs/decisions/0001-no-name-test.md" ]; then
    if grep -qE 'decided_by: ""' "$crepo/docs/decisions/0001-no-name-test.md"; then
      pass "INT22 empty decided_by quoted"
    else
      fail "INT22 empty decided_by quoted" "got: $(grep decided_by "$crepo/docs/decisions/0001-no-name-test.md")"
    fi
  else
    fail "INT22 file written" "missing"
  fi

  # ─── INT23: cmd_sync padded NNNN ─────────────────────────────────────────
  echo ""
  echo "--- INT23: cmd_sync padded NNNN ---"
  if start_stub 200; then
    crepo="$tmp/int23-repo"
    setup_consumer_repo "$crepo"
    ( cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
        bash "$HELPER" create --title "Padded sync" >/dev/null 2>&1 )
    : > "$STUB_BODYF"; : > "$STUB_AUTHF"; : > "$STUB_PATHF"
    out=$(cd "$crepo" && UM_SERVER_URL="$STUB_URL" \
            bash "$HELPER" sync 0001 2>&1)
    rc=$?
    assert_rc "INT23 cmd_sync 0001 rc=0" "0" "$rc"
    assert_contains "INT23 sync output" "$out" "Re-registered ADR-0001"
    stop_stub
  else
    fail "INT23 stub start" "could not start"
  fi

  # ─── INT14: skill.md frontmatter sanity ───────────────────────────────────
  echo ""
  echo "--- INT14: skill.md frontmatter sanity ---"
  skill_md="$SCRIPT_DIR/skill.md"
  [ -f "$skill_md" ] && pass "INT14 skill.md exists" \
    || fail "INT14 skill.md exists" "missing"
  fm_block=$(awk '/^---$/{c++; next} c==1{print}' "$skill_md")
  assert_contains "INT14 frontmatter has name" "$fm_block" "name: create-adr"
  assert_contains "INT14 frontmatter has description" "$fm_block" "description:"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All create-adr.sh tests pass."
