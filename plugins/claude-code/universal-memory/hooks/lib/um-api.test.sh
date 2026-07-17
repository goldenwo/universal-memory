#!/usr/bin/env bash
# hooks/lib/um-api.test.sh — unit tests for um-api.sh (#159 T2).
#
# Run: bash um-api.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   E1. A7 precedence — UM_SERVER_URL set ⇒ wins over ~/.um/endpoint file + default
#   E2. UM_ENDPOINT deprecated alias tier honored (endpoint.sh semantics intact)
#   E3. File tier — ~/.um/endpoint used when no env vars set (trimmed)
#   E4. Default tier — http://localhost:6335 when nothing configured
#   E5. Empty/whitespace-only file falls through to default
#   E6. Multi-line file — first line trimmed, later lines ignored
#   T1. Token from default ~/.um/auth-token (trimmed)
#   T2. Token file override via UM_TOKEN_FILE env
#   T3. Absent token file ⇒ empty token, rc 0
#   P1. um_api_post happy path — timeouts, headers, Bearer, body out, code 200
#   P2. um_api_post without token ⇒ NO Authorization header
#   P3. um_api_post never prints the token to stdout
#   P4. um_api_post surfaces 403 (rc non-zero, code=403)
#   P5. um_api_post transport failure ⇒ code=000, rc non-zero
#   P6. um_api_post max-time override (3rd arg)
#   Y1-Y3. um_find_python probe order (py → python3 → python; none ⇒ rc 1)
#   L1. um_log appends "<ts> <hook> <msg>" to ~/.um/hook.log (dir auto-created)
#   G1. G7 message variants (unreachable / writes-disabled)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UM_API="$SCRIPT_DIR/um-api.sh"

# ---------------------------------------------------------------------------
# Test harness (house style: inline helpers, no shared lib)
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
# Temp dir + isolation setup — never touch the real ~/.um
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

MOCK_BIN="$TMPDIR_ROOT/mock_bin"
mkdir -p "$MOCK_BIN"

# run_api <home_dir> [ENV=val ...] -- <bash -c script>
# Runs the given script in a clean env (env -i) with HOME pointed at an
# isolated dir and the lib pre-sourced. PATH keeps MOCK_BIN first so fake
# curl/interpreters win. Prints the script's stdout.
run_api() {
  local home_dir="$1"; shift
  local -a envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env -i PATH="$MOCK_BIN:$PATH" HOME="$home_dir" "${envs[@]}" \
    bash -c "source '$UM_API'; $1"
}

# fresh_home <name> → prints a new isolated HOME path
fresh_home() {
  local d="$TMPDIR_ROOT/home_$1"
  mkdir -p "$d"
  printf '%s' "$d"
}

# ===========================================================================
# Endpoint resolution tiers
# ===========================================================================
echo "=== E1: A7 — UM_SERVER_URL wins over file + default ==="
H=$(fresh_home e1)
mkdir -p "$H/.um"
printf 'http://file-tier.example:6335\n' > "$H/.um/endpoint"
GOT=$(run_api "$H" UM_SERVER_URL="http://remote.example:6337" -- "um_api_endpoint" 2>/dev/null)
assert_eq "E1: env UM_SERVER_URL beats file tier" "$GOT" "http://remote.example:6337"

echo "=== E2: UM_ENDPOINT deprecated alias tier ==="
H=$(fresh_home e2)
mkdir -p "$H/.um"
printf 'http://file-tier.example:6335\n' > "$H/.um/endpoint"
ERR_FILE="$TMPDIR_ROOT/e2_err"
GOT=$(run_api "$H" UM_ENDPOINT="http://legacy.example:6335" -- "um_api_endpoint" 2>"$ERR_FILE")
assert_eq "E2: UM_ENDPOINT honored (beats file tier)" "$GOT" "http://legacy.example:6335"
assert_contains "E2: deprecation warn preserved on stderr" "$(cat "$ERR_FILE")" "UM_ENDPOINT is deprecated"

echo "=== E3: file tier when no env configured ==="
H=$(fresh_home e3)
mkdir -p "$H/.um"
printf '  http://pi.example:6337  \n' > "$H/.um/endpoint"   # whitespace to trim
GOT=$(run_api "$H" -- "um_api_endpoint" 2>/dev/null)
assert_eq "E3: ~/.um/endpoint honored + trimmed" "$GOT" "http://pi.example:6337"

echo "=== E4: default tier (nothing configured) ==="
H=$(fresh_home e4)
GOT=$(run_api "$H" -- "um_api_endpoint" 2>/dev/null)
assert_eq "E4: default is http://localhost:6335" "$GOT" "http://localhost:6335"

echo "=== E5: empty file falls through to default ==="
H=$(fresh_home e5)
mkdir -p "$H/.um"
printf '   \n' > "$H/.um/endpoint"
GOT=$(run_api "$H" -- "um_api_endpoint" 2>/dev/null)
assert_eq "E5: whitespace-only file ignored" "$GOT" "http://localhost:6335"

echo "=== E6: multi-line file uses first line only ==="
H=$(fresh_home e6)
mkdir -p "$H/.um"
printf ' http://first.example:6337 \n# a stray comment line\nhttp://second.example:9\n' > "$H/.um/endpoint"
GOT=$(run_api "$H" -- "um_api_endpoint" 2>/dev/null)
assert_eq "E6: first line trimmed, later lines ignored" "$GOT" "http://first.example:6337"

# ===========================================================================
# Token resolution
# ===========================================================================
echo "=== T1: token from default ~/.um/auth-token ==="
H=$(fresh_home t1)
mkdir -p "$H/.um"
printf 'sekret-token-123\n' > "$H/.um/auth-token"
GOT=$(run_api "$H" -- "um_api_token")
assert_eq "T1: default token file read + trimmed" "$GOT" "sekret-token-123"

echo "=== T2: UM_TOKEN_FILE override ==="
H=$(fresh_home t2)
printf ' override-token-456 \n' > "$TMPDIR_ROOT/alt-token"
GOT=$(run_api "$H" UM_TOKEN_FILE="$TMPDIR_ROOT/alt-token" -- "um_api_token")
assert_eq "T2: UM_TOKEN_FILE override honored + trimmed" "$GOT" "override-token-456"

echo "=== T3: absent token file ⇒ empty, rc 0 ==="
H=$(fresh_home t3)
RC=0
GOT=$(run_api "$H" -- "um_api_token") || RC=$?
assert_eq "T3: empty token when no file" "$GOT" ""
assert_eq "T3: rc 0 when no file (loopback dev is valid)" "$RC" "0"

# ===========================================================================
# um_api_post — mock curl via MOCK_BIN PATH shim
# ===========================================================================
# write_mock_curl <http_code> [curl_exit]
# Fake curl: records its argv (one per line) to $TMPDIR_ROOT/curl_args,
# then prints a body + the -w sentinel (house __UM_HTTP_CODE__ convention),
# or exits non-zero with code 000 for transport failure.
write_mock_curl() {
  local http_code="$1" curl_exit="${2:-0}"
  cat > "$MOCK_BIN/curl" <<MOCK_EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$TMPDIR_ROOT/curl_args"
if [ "$curl_exit" -ne 0 ]; then
  printf '\n__UM_HTTP_CODE__000'
  exit "$curl_exit"
fi
printf '{"ok":true}'
printf '\n__UM_HTTP_CODE__$http_code'
MOCK_EOF
  chmod +x "$MOCK_BIN/curl"
}

echo "=== P1: um_api_post happy path (200) ==="
H=$(fresh_home p1)
mkdir -p "$H/.um"
printf 'sekret-token-123\n' > "$H/.um/auth-token"
write_mock_curl 200
RC=0
# shellcheck disable=SC2016  # single quotes deliberate: $UM_API_HTTP_CODE expands in the INNER bash
OUT=$(run_api "$H" UM_SERVER_URL="http://remote.example:6337" -- \
  'um_api_post /api/append-turn "{\"project\":\"p\"}"; echo "CODE=$UM_API_HTTP_CODE RC_INNER=$?"') || RC=$?
ARGS=$(cat "$TMPDIR_ROOT/curl_args")
assert_contains "P1: response body on stdout" "$OUT" '{"ok":true}'
assert_contains "P1: http code surfaced (200)" "$OUT" "CODE=200"
assert_contains "P1: connect timeout 3s" "$ARGS" "--connect-timeout"$'\n'"3"
assert_contains "P1: total timeout 10s" "$ARGS" "--max-time"$'\n'"10"
assert_contains "P1: X-UM-Source header" "$ARGS" "X-UM-Source: claude-code-plugin"
assert_contains "P1: Content-Type json" "$ARGS" "Content-Type: application/json"
assert_contains "P1: Bearer auth when token present" "$ARGS" "Authorization: Bearer sekret-token-123"
assert_contains "P1: URL composed endpoint+path" "$ARGS" "http://remote.example:6337/api/append-turn"
assert_contains "P1: body passed through" "$ARGS" '{"project":"p"}'
assert_not_contains "P1: no sentinel leaked to stdout" "$OUT" "__UM_HTTP_CODE__"

echo "=== P2: no Authorization header when token absent ==="
H=$(fresh_home p2)
write_mock_curl 200
OUT=$(run_api "$H" UM_SERVER_URL="http://remote.example:6337" -- \
  'um_api_post /api/append-turn "{}"' )
ARGS=$(cat "$TMPDIR_ROOT/curl_args")
assert_not_contains "P2: no Authorization header without token" "$ARGS" "Authorization"

echo "=== P3: token never printed to stdout/stderr ==="
H=$(fresh_home p3)
mkdir -p "$H/.um"
printf 'sekret-token-123\n' > "$H/.um/auth-token"
write_mock_curl 200
OUT=$(run_api "$H" UM_SERVER_URL="http://remote.example:6337" -- \
  'um_api_post /api/append-turn "{}"' 2>&1)
assert_not_contains "P3: token not in combined output" "$OUT" "sekret-token-123"

echo "=== P4: 403 surfaced (writes disabled) ==="
H=$(fresh_home p4)
write_mock_curl 403
# shellcheck disable=SC2016  # single quotes deliberate: $UM_API_HTTP_CODE expands in the INNER bash
OUT=$(run_api "$H" UM_SERVER_URL="http://remote.example:6337" -- \
  'if um_api_post /api/append-turn "{}" >/dev/null; then echo "RC=0"; else echo "RC=1"; fi; echo "CODE=$UM_API_HTTP_CODE"')
assert_contains "P4: non-zero rc on 403" "$OUT" "RC=1"
assert_contains "P4: code 403 surfaced" "$OUT" "CODE=403"

echo "=== P5: transport failure ⇒ code 000 ==="
H=$(fresh_home p5)
write_mock_curl 000 7
# shellcheck disable=SC2016  # single quotes deliberate: $UM_API_HTTP_CODE expands in the INNER bash
OUT=$(run_api "$H" UM_SERVER_URL="http://unreachable.example:6337" -- \
  'if um_api_post /api/append-turn "{}" >/dev/null; then echo "RC=0"; else echo "RC=1"; fi; echo "CODE=$UM_API_HTTP_CODE"')
assert_contains "P5: non-zero rc on transport failure" "$OUT" "RC=1"
assert_contains "P5: code 000 on transport failure" "$OUT" "CODE=000"

echo "=== P6: max-time override (checkpoint 120s case) ==="
H=$(fresh_home p6)
write_mock_curl 200
OUT=$(run_api "$H" UM_SERVER_URL="http://remote.example:6337" -- \
  'um_api_post /api/checkpoint "{}" 120')
ARGS=$(cat "$TMPDIR_ROOT/curl_args")
assert_contains "P6: max-time overridden to 120" "$ARGS" "--max-time"$'\n'"120"
assert_contains "P6: connect timeout still 3" "$ARGS" "--connect-timeout"$'\n'"3"

# ===========================================================================
# um_find_python — probe order via PATH-shim fake interpreters
# ===========================================================================
# write_fake_interp <name> <exit_code>
write_fake_interp() {
  printf '#!/usr/bin/env bash\nexit %s\n' "$2" > "$MOCK_BIN/$1"
  chmod +x "$MOCK_BIN/$1"
}
clear_fake_interps() { rm -f "$MOCK_BIN/py" "$MOCK_BIN/python3" "$MOCK_BIN/python"; }

echo "=== Y1: all three work ⇒ picks py ==="
H=$(fresh_home y1)
write_fake_interp py 0; write_fake_interp python3 0; write_fake_interp python 0
GOT=$(run_api "$H" -- "um_find_python")
assert_eq "Y1: py wins when all work" "$GOT" "py"

echo "=== Y2: py broken ⇒ falls to python3 ==="
write_fake_interp py 1; write_fake_interp python3 0; write_fake_interp python 0
GOT=$(run_api "$H" -- "um_find_python")
assert_eq "Y2: python3 when py fails" "$GOT" "python3"

echo "=== Y3: none work ⇒ rc 1, empty output ==="
write_fake_interp py 1; write_fake_interp python3 1; write_fake_interp python 1
RC=0
GOT=$(run_api "$H" -- "um_find_python") || RC=$?
assert_eq "Y3: rc 1 when no interpreter works" "$RC" "1"
assert_eq "Y3: empty output" "$GOT" ""
clear_fake_interps

# ===========================================================================
# um_log — line format + dir auto-creation
# ===========================================================================
echo "=== L1: um_log appends '<ts> <hook> <msg>' ==="
H=$(fresh_home l1)   # note: no .um dir — must be auto-created
run_api "$H" UM_HOOK_NAME="stop" -- 'um_log "posted http=200 chars=42"' >/dev/null
LOG_LINE=$(cat "$H/.um/hook.log" 2>/dev/null || echo "MISSING")
assert_contains "L1: hook name in line" "$LOG_LINE" " stop "
assert_contains "L1: message in line" "$LOG_LINE" "posted http=200 chars=42"
if [[ "$LOG_LINE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\ stop\ posted ]]; then
  pass "L1: ISO-ish timestamp prefix"
else
  fail "L1: ISO-ish timestamp prefix" "got '$LOG_LINE'"
fi

echo "=== L2: um_log appends (does not truncate) ==="
run_api "$H" UM_HOOK_NAME="stop" -- 'um_log "second line"' >/dev/null
LINE_COUNT=$(wc -l < "$H/.um/hook.log" | tr -d ' ')
assert_eq "L2: two lines after two calls" "$LINE_COUNT" "2"

# ===========================================================================
# G7 message
# ===========================================================================
echo "=== G1: G7 message variants ==="
H=$(fresh_home g1)
GOT=$(run_api "$H" -- 'um_g7_message unreachable "http://pi.example:6337"')
assert_contains "G1: unreachable names endpoint" "$GOT" "server unreachable at http://pi.example:6337"
assert_contains "G1: unreachable has captures-OFF prefix" "$GOT" "UM: captures are OFF"
assert_contains "G1: unreachable carries docs link" "$GOT" "https://"
GOT=$(run_api "$H" -- 'um_g7_message writes-disabled')
assert_contains "G1: writes-disabled variant" "$GOT" "writes disabled"
assert_contains "G1: writes-disabled has captures-OFF prefix" "$GOT" "UM: captures are OFF"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All um-api lib tests pass."
