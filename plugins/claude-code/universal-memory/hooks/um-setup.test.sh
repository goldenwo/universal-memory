#!/bin/bash
# hooks/um-setup.test.sh — T8 plugin-bundled first-run setup (#159, spec §7).
#
# Covers um-setup.sh end-to-end with a stubbed curl + throwaway HOME:
#   - success ⇒ ~/.um/endpoint + ~/.um/auth-token written, mode 600,
#     endpoint file is EXACTLY one line with the URL (trailing slash stripped)
#   - 403 writes-disabled / 000 unreachable / 404 server-too-old ⇒ correct
#     taxonomy message + non-zero (the helper's distinct rc) + NO files
#   - empty token ⇒ endpoint written, no auth-token file created; a
#     pre-existing auth-token survives
#   - non-interactive config via --endpoint/--token flags AND
#     UM_SETUP_ENDPOINT/UM_SETUP_TOKEN env
#   - no endpoint, non-TTY ⇒ loopback default http://localhost:6335
#   - UM_SERVER_URL env export differing from the written endpoint ⇒
#     shadowing warning (§4 precedence)
#
# CI-safe: no network — curl is a PATH stub driven by UM_TEST_HEALTH_CODE /
# UM_TEST_PROBE_CODE (same contract as installer/install-remote.test.sh).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP="$SCRIPT_DIR/um-setup.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# chmod permission bits are a no-op on Windows NTFS — skip mode assertions
# there; CI (ubuntu/macos) still enforces them.
IS_WINDOWS=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;; esac
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

# make_curl_stub <bindir> — /health answers $UM_TEST_HEALTH_CODE (default
# 200), /api/append-turn answers $UM_TEST_PROBE_CODE (default 400 = healthy
# write path), 000 otherwise. Mirrors real curl's `-w '%{http_code}'`
# contract: prints 000 + exits non-zero on transport failure.
make_curl_stub() {
  local bindir="$1"
  mkdir -p "$bindir"
  cat > "$bindir/curl" <<'STUB'
#!/bin/bash
url=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a" ;; esac
done
case "$url" in
  */health)          code="${UM_TEST_HEALTH_CODE:-200}" ;;
  */api/append-turn) code="${UM_TEST_PROBE_CODE:-400}" ;;
  *)                 code="000" ;;
esac
printf '%s' "$code"
if [ "$code" = "000" ]; then exit 7; fi
exit 0
STUB
  chmod +x "$bindir/curl"
}

# run_setup <tmpdir> [env VAR=... ...] -- <args...>
# Runs um-setup.sh with stub curl + throwaway HOME=$tmpdir/home under a clean
# env (env -i — the dev box may export UM_SERVER_URL/UM_SETUP_*). stdin is
# /dev/null (non-TTY). Output → $ST_OUT, rc → $ST_RC.
run_setup() {
  local tmp="$1"; shift
  local -a extra_env=()
  while [ "$1" != "--" ]; do extra_env+=("$1"); shift; done
  shift
  make_curl_stub "$tmp/bin"
  mkdir -p "$tmp/home"
  ST_RC=0
  ST_OUT=$(env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/home" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$SETUP" "$@" 2>&1 </dev/null) || ST_RC=$?
}

no_config_written() { # <home> <label>
  local home="$1" label="$2"
  if [ ! -e "$home/.um/endpoint" ] && [ ! -e "$home/.um/auth-token" ]; then
    pass "$label: no config written"
  else
    fail "$label: config file(s) written despite failure"
  fi
}

# ─── S1: success via flags ⇒ both files written, 600, single-line ────────────
echo "=== S1: --endpoint + --token, healthy server → config written 600 ==="
T=$(mktemp -d)
run_setup "$T" -- --endpoint 'http://pi:6337/' --token tok-setup-test
if [ "$ST_RC" -eq 0 ]; then pass "S1: exit 0"; else fail "S1: exit $ST_RC (out: $ST_OUT)"; fi
if [ "$(cat "$T/home/.um/endpoint" 2>/dev/null)" = "http://pi:6337" ]; then pass "S1: endpoint file has URL (trailing slash stripped)"; else fail "S1: endpoint wrong/missing ($(cat "$T/home/.um/endpoint" 2>/dev/null))"; fi
if [ "$(wc -l < "$T/home/.um/endpoint")" -eq 1 ]; then pass "S1: endpoint file is a single line"; else fail "S1: endpoint file not single-line"; fi
if [ "$(cat "$T/home/.um/auth-token" 2>/dev/null)" = "tok-setup-test" ]; then pass "S1: auth-token file has the token"; else fail "S1: auth-token wrong/missing"; fi
if [ "$IS_WINDOWS" -eq 1 ]; then
  pass "S1: mode check skipped on Windows (chmod no-op on NTFS)"
else
  if [ "$(file_mode "$T/home/.um/endpoint")" = "600" ]; then pass "S1: endpoint mode 600"; else fail "S1: endpoint mode $(file_mode "$T/home/.um/endpoint")"; fi
  if [ "$(file_mode "$T/home/.um/auth-token")" = "600" ]; then pass "S1: auth-token mode 600"; else fail "S1: auth-token mode $(file_mode "$T/home/.um/auth-token")"; fi
fi
if echo "$ST_OUT" | grep -q "verified"; then pass "S1: prints verification result"; else fail "S1: no verified line (out: $ST_OUT)"; fi
if echo "$ST_OUT" | grep -qi "next steps"; then pass "S1: prints next steps"; else fail "S1: no next steps (out: $ST_OUT)"; fi
rm -rf "$T"

# ─── S2: 403 writes-disabled ⇒ flag message + rc 2 + no files ────────────────
echo ""
echo "=== S2: 403 probe → UM_MCP_WRITE_ENABLED message, non-zero, no config ==="
T=$(mktemp -d)
run_setup "$T" UM_TEST_PROBE_CODE=403 -- --endpoint http://pi:6337 --token tok
if [ "$ST_RC" -eq 2 ]; then pass "S2: exit 2 (writes-disabled taxonomy rc)"; else fail "S2: exit $ST_RC (out: $ST_OUT)"; fi
if echo "$ST_OUT" | grep -q "UM_MCP_WRITE_ENABLED"; then pass "S2: message names the flag"; else fail "S2: flag not named (out: $ST_OUT)"; fi
no_config_written "$T/home" "S2"
rm -rf "$T"

# ─── S3: unreachable (000) ⇒ message + rc 1 + no files ───────────────────────
echo ""
echo "=== S3: dead endpoint → unreachable message, non-zero, no config ==="
T=$(mktemp -d)
run_setup "$T" UM_TEST_HEALTH_CODE=000 -- --endpoint http://dead:6335 --token tok
if [ "$ST_RC" -eq 1 ]; then pass "S3: exit 1 (unreachable taxonomy rc)"; else fail "S3: exit $ST_RC (out: $ST_OUT)"; fi
if echo "$ST_OUT" | grep -qi "unreachable"; then pass "S3: unreachable message"; else fail "S3: no unreachable message (out: $ST_OUT)"; fi
no_config_written "$T/home" "S3"
rm -rf "$T"

# ─── S4: 404 server-too-old ⇒ distinct upgrade message + rc 4 + no files ─────
echo ""
echo "=== S4: 404 probe → server-too-old upgrade message, non-zero, no config ==="
T=$(mktemp -d)
run_setup "$T" UM_TEST_PROBE_CODE=404 -- --endpoint http://pi:6337 --token tok
if [ "$ST_RC" -eq 4 ]; then pass "S4: exit 4 (server-too-old taxonomy rc)"; else fail "S4: exit $ST_RC (out: $ST_OUT)"; fi
if echo "$ST_OUT" | grep -qi "too old" && echo "$ST_OUT" | grep -qi "upgrade"; then pass "S4: distinct upgrade message"; else fail "S4: wrong message (out: $ST_OUT)"; fi
if ! echo "$ST_OUT" | grep -q "UM_MCP_WRITE_ENABLED"; then pass "S4: NOT conflated with writes-disabled"; else fail "S4: conflated with 403 branch"; fi
no_config_written "$T/home" "S4"
rm -rf "$T"

# ─── S5: empty token ⇒ endpoint written, no token file; existing kept ────────
echo ""
echo "=== S5: empty token → endpoint only; pre-existing auth-token survives ==="
T=$(mktemp -d)
run_setup "$T" -- --endpoint http://localhost:6335 --token ''
if [ "$ST_RC" -eq 0 ]; then pass "S5: exit 0"; else fail "S5: exit $ST_RC (out: $ST_OUT)"; fi
if [ -f "$T/home/.um/endpoint" ] && [ ! -e "$T/home/.um/auth-token" ]; then pass "S5: endpoint written, no auth-token created"; else fail "S5: unexpected config state"; fi
rm -rf "$T"
T=$(mktemp -d)
mkdir -p "$T/home/.um"
echo "old-token" > "$T/home/.um/auth-token"
run_setup "$T" -- --endpoint http://localhost:6335 --token ''
if [ "$(cat "$T/home/.um/auth-token" 2>/dev/null)" = "old-token" ]; then pass "S5b: pre-existing auth-token preserved on empty-token run"; else fail "S5b: auth-token clobbered"; fi
if echo "$ST_OUT" | grep -qi "kept"; then pass "S5b: kept-note printed"; else fail "S5b: no kept-note (out: $ST_OUT)"; fi
rm -rf "$T"

# ─── S6: env-driven non-interactive config ───────────────────────────────────
echo ""
echo "=== S6: UM_SETUP_ENDPOINT/UM_SETUP_TOKEN env → same flow, config written ==="
T=$(mktemp -d)
run_setup "$T" UM_SETUP_ENDPOINT=http://pi:6337 UM_SETUP_TOKEN=tok-env --
if [ "$ST_RC" -eq 0 ]; then pass "S6: exit 0"; else fail "S6: exit $ST_RC (out: $ST_OUT)"; fi
if [ "$(cat "$T/home/.um/endpoint" 2>/dev/null)" = "http://pi:6337" ]; then pass "S6: endpoint from env"; else fail "S6: endpoint wrong/missing"; fi
if [ "$(cat "$T/home/.um/auth-token" 2>/dev/null)" = "tok-env" ]; then pass "S6: token from env"; else fail "S6: token wrong/missing"; fi
rm -rf "$T"

# ─── S7: no endpoint, non-TTY ⇒ loopback default ─────────────────────────────
echo ""
echo "=== S7: no endpoint, non-TTY → defaults to http://localhost:6335 ==="
T=$(mktemp -d)
run_setup "$T" --
if [ "$ST_RC" -eq 0 ]; then pass "S7: exit 0"; else fail "S7: exit $ST_RC (out: $ST_OUT)"; fi
if [ "$(cat "$T/home/.um/endpoint" 2>/dev/null)" = "http://localhost:6335" ]; then pass "S7: loopback default written"; else fail "S7: endpoint wrong/missing ($(cat "$T/home/.um/endpoint" 2>/dev/null))"; fi
rm -rf "$T"

# ─── S8: env export shadowing warning (§4 precedence) ────────────────────────
echo ""
echo "=== S8: UM_SERVER_URL env differs → shadowing warning; matching → none ==="
T=$(mktemp -d)
run_setup "$T" UM_SERVER_URL=http://old-local:6335 -- --endpoint http://pi:6337 --token tok
if [ "$ST_RC" -eq 0 ]; then pass "S8: exit 0 (warning does not block)"; else fail "S8: exit $ST_RC (out: $ST_OUT)"; fi
if echo "$ST_OUT" | grep -qi "shadow"; then pass "S8: shadowing warning printed"; else fail "S8: no shadowing warning (out: $ST_OUT)"; fi
rm -rf "$T"
T=$(mktemp -d)
run_setup "$T" UM_SERVER_URL=http://pi:6337 -- --endpoint http://pi:6337 --token tok
if ! echo "$ST_OUT" | grep -qi "shadow"; then pass "S8b: no warning when env matches written endpoint"; else fail "S8b: spurious shadowing warning (out: $ST_OUT)"; fi
rm -rf "$T"

# ─── S9: bad flag / missing value ⇒ usage error, no config ───────────────────
echo ""
echo "=== S9: unknown arg → error + non-zero + no config ==="
T=$(mktemp -d)
run_setup "$T" -- --bogus
if [ "$ST_RC" -ne 0 ]; then pass "S9: non-zero exit"; else fail "S9: expected non-zero"; fi
if echo "$ST_OUT" | grep -qi "unknown argument"; then pass "S9: names the bad argument"; else fail "S9: no error message (out: $ST_OUT)"; fi
no_config_written "$T/home" "S9"
rm -rf "$T"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
