#!/bin/bash
# installer/install-remote.test.sh — T7 remote install flow (#159, spec §7)
#
# Covers:
#   - um_verify_endpoint taxonomy (unit, stubbed curl): healthy 400/2xx,
#     unreachable 000, unhealthy /health, 403 writes-disabled, 401 auth,
#     404 server-too-old, 429 transient, 5xx server-side
#   - install.sh --remote flow (integration, stubbed curl): dead endpoint ⇒
#     message + non-zero + NO config written (A5); writes-disabled ⇒ 403
#     message; server-too-old ⇒ upgrade message; live loopback ⇒ config
#     written 600; local orphan captures ⇒ repoint warning; pre-existing
#     UM_SERVER_URL marker block ⇒ updated; bare export ⇒ shadowing warning
#
# CI-safe: no network — curl is a PATH stub driven by UM_TEST_HEALTH_CODE /
# UM_TEST_PROBE_CODE. Runs against a throwaway HOME; never touches the real
# ~/.um or shell profiles.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"
VERIFY_LIB="$REPO_ROOT/plugins/claude-code/universal-memory/hooks/lib/verify-endpoint.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# chmod permission bits are a no-op on Windows NTFS (cf. install-token.test.sh)
# — skip the mode assertions there; CI (ubuntu/macos) still enforces them.
IS_WINDOWS=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;; esac

# Portable mode read: GNU stat -c, BSD stat -f (same dual-idiom as vault.sh).
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

# make_curl_stub <bindir> — a curl that answers /health with
# $UM_TEST_HEALTH_CODE (default 200) and /api/append-turn with
# $UM_TEST_PROBE_CODE (default 400 = healthy write path), 000 otherwise.
# Mirrors real curl's `-w '%{http_code}'` contract: prints 000 + exits
# non-zero on transport failure, prints the code + exits 0 on any HTTP reply.
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

# run_verify <health_code> <probe_code> [token] — source the helper in a
# subshell with the stub curl and run um_verify_endpoint. Output (stdout+
# stderr) → $VERIFY_OUT, rc → $VERIFY_RC.
run_verify() {
  local health="$1" probe="$2" token="${3:-}"
  local tmp
  tmp=$(mktemp -d)
  make_curl_stub "$tmp/bin"
  VERIFY_RC=0
  VERIFY_OUT=$(
    UM_TEST_HEALTH_CODE="$health" UM_TEST_PROBE_CODE="$probe" \
    PATH="$tmp/bin:/usr/bin:/bin" \
    bash -c "source '$VERIFY_LIB' && um_verify_endpoint 'http://stub:6335' '$token'" 2>&1
  ) || VERIFY_RC=$?
  rm -rf "$tmp"
}

# ─── Unit: um_verify_endpoint taxonomy ───────────────────────────────────────
echo "=== UT: um_verify_endpoint taxonomy (stubbed curl) ==="

run_verify 200 400
if [ "$VERIFY_RC" -eq 0 ]; then pass "UT-healthy: health 200 + probe 400 → rc 0"; else fail "UT-healthy: rc $VERIFY_RC (out: $VERIFY_OUT)"; fi

run_verify 200 201
if [ "$VERIFY_RC" -eq 0 ]; then pass "UT-2xx: probe 201 → rc 0"; else fail "UT-2xx: rc $VERIFY_RC (out: $VERIFY_OUT)"; fi

run_verify 000 400
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-unreachable: health 000 → non-zero"; else fail "UT-unreachable: rc 0"; fi
if echo "$VERIFY_OUT" | grep -qi "unreachable"; then pass "UT-unreachable: message names unreachable"; else fail "UT-unreachable: no message (out: $VERIFY_OUT)"; fi

run_verify 500 400
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-unhealthy: /health 500 → non-zero"; else fail "UT-unhealthy: rc 0"; fi
if echo "$VERIFY_OUT" | grep -q "/health"; then pass "UT-unhealthy: message names /health"; else fail "UT-unhealthy: no /health in message (out: $VERIFY_OUT)"; fi

run_verify 200 403
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-403: non-zero"; else fail "UT-403: rc 0"; fi
if echo "$VERIFY_OUT" | grep -q "UM_MCP_WRITE_ENABLED"; then pass "UT-403: message names UM_MCP_WRITE_ENABLED"; else fail "UT-403: flag not named (out: $VERIFY_OUT)"; fi

run_verify 200 401 sometoken
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-401: non-zero"; else fail "UT-401: rc 0"; fi
if echo "$VERIFY_OUT" | grep -qi "token"; then pass "UT-401: message names the token"; else fail "UT-401: token not named (out: $VERIFY_OUT)"; fi

run_verify 200 404
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-404: non-zero"; else fail "UT-404: rc 0"; fi
if echo "$VERIFY_OUT" | grep -qi "too old" && echo "$VERIFY_OUT" | grep -qi "upgrade"; then pass "UT-404: server-too-old upgrade message"; else fail "UT-404: wrong message (out: $VERIFY_OUT)"; fi

run_verify 200 429
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-429: non-zero"; else fail "UT-429: rc 0"; fi
if echo "$VERIFY_OUT" | grep -qi "rate"; then pass "UT-429: transient rate-limit message"; else fail "UT-429: wrong message (out: $VERIFY_OUT)"; fi

run_verify 200 500
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-5xx: non-zero"; else fail "UT-5xx: rc 0"; fi
if echo "$VERIFY_OUT" | grep -qi "mount" && echo "$VERIFY_OUT" | grep -qi "logs"; then pass "UT-5xx: mount/logs message"; else fail "UT-5xx: wrong message (out: $VERIFY_OUT)"; fi

run_verify 200 000
if [ "$VERIFY_RC" -ne 0 ]; then pass "UT-probe-000: probe transport failure → non-zero"; else fail "UT-probe-000: rc 0"; fi

run_verify 200 301
if [ "$VERIFY_RC" -eq 7 ]; then pass "UT-3xx: probe 301 → rc 7 (distinct redirect rc)"; else fail "UT-3xx: rc $VERIFY_RC (out: $VERIFY_OUT)"; fi
if echo "$VERIFY_OUT" | grep -qi "redirect"; then pass "UT-3xx: message names the redirect"; else fail "UT-3xx: redirect not named (out: $VERIFY_OUT)"; fi
if echo "$VERIFY_OUT" | grep -qi "final URL"; then pass "UT-3xx: message says configure the final URL"; else fail "UT-3xx: final-URL hint missing (out: $VERIFY_OUT)"; fi

# ─── Integration harness for install.sh --remote ─────────────────────────────
# run_remote <tmpdir> [env VAR=... ...] -- <installer args...>
# Runs the installer with stub curl + throwaway HOME=$tmpdir/home under a
# clean env (env -i — the dev box may export UM_SERVER_URL/UM_AUTH_TOKEN).
# Output → $RT_OUT, rc → $RT_RC.
run_remote() {
  local tmp="$1"; shift
  local -a extra_env=()
  while [ "$1" != "--" ]; do extra_env+=("$1"); shift; done
  shift
  make_curl_stub "$tmp/bin"
  mkdir -p "$tmp/home"
  RT_RC=0
  RT_OUT=$(env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/home" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$INSTALLER" "$@" 2>&1 </dev/null) || RT_RC=$?
}

no_config_written() { # <home> <label>
  local home="$1" label="$2"
  if [ ! -e "$home/.um/endpoint" ] && [ ! -e "$home/.um/auth-token" ]; then
    pass "$label: no config written"
  else
    fail "$label: config file(s) written despite failure"
  fi
}

# ─── RT1: dead endpoint ⇒ message + non-zero + no config (A5) ────────────────
echo ""
echo "=== RT1: --remote against dead endpoint → actionable message, non-zero, no config ==="
T=$(mktemp -d)
run_remote "$T" UM_TEST_HEALTH_CODE=000 -- --remote http://dead:6335 --yes
if [ "$RT_RC" -ne 0 ]; then pass "RT1: non-zero exit"; else fail "RT1: expected non-zero (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -qi "unreachable"; then pass "RT1: unreachable message printed"; else fail "RT1: no unreachable message (out: $RT_OUT)"; fi
no_config_written "$T/home" "RT1"
rm -rf "$T"

# ─── RT2: writes-disabled server (403 probe) ⇒ flag message + no config ──────
echo ""
echo "=== RT2: writes-disabled server → UM_MCP_WRITE_ENABLED message, non-zero, no config ==="
T=$(mktemp -d)
run_remote "$T" UM_TEST_PROBE_CODE=403 -- --remote http://pi:6337 --yes
if [ "$RT_RC" -ne 0 ]; then pass "RT2: non-zero exit"; else fail "RT2: expected non-zero (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -q "UM_MCP_WRITE_ENABLED"; then pass "RT2: writes-disabled message names the flag"; else fail "RT2: flag not named (out: $RT_OUT)"; fi
no_config_written "$T/home" "RT2"
rm -rf "$T"

# ─── RT3: server-too-old (404 probe) ⇒ distinct upgrade message ──────────────
echo ""
echo "=== RT3: server-too-old (404 probe) → upgrade message, non-zero, no config ==="
T=$(mktemp -d)
run_remote "$T" UM_TEST_PROBE_CODE=404 -- --remote http://pi:6337 --yes
if [ "$RT_RC" -ne 0 ]; then pass "RT3: non-zero exit"; else fail "RT3: expected non-zero (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -qi "too old" && echo "$RT_OUT" | grep -qi "upgrade"; then pass "RT3: distinct upgrade message"; else fail "RT3: wrong message (out: $RT_OUT)"; fi
if ! echo "$RT_OUT" | grep -q "UM_MCP_WRITE_ENABLED"; then pass "RT3: NOT conflated with writes-disabled"; else fail "RT3: conflated with 403 branch (out: $RT_OUT)"; fi
no_config_written "$T/home" "RT3"
rm -rf "$T"

# ─── RT4: live loopback ⇒ config written, mode 600 ───────────────────────────
echo ""
echo "=== RT4: live loopback → ~/.um/endpoint + ~/.um/auth-token written 600 ==="
T=$(mktemp -d)
run_remote "$T" UM_AUTH_TOKEN=tok-remote-test -- --remote http://localhost:6335 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT4: exit 0"; else fail "RT4: exit $RT_RC (out: $RT_OUT)"; fi
if [ "$(cat "$T/home/.um/endpoint" 2>/dev/null)" = "http://localhost:6335" ]; then pass "RT4: endpoint file has the URL"; else fail "RT4: endpoint file wrong/missing"; fi
if [ "$(cat "$T/home/.um/auth-token" 2>/dev/null)" = "tok-remote-test" ]; then pass "RT4: auth-token file has the token"; else fail "RT4: auth-token wrong/missing"; fi
if [ "$IS_WINDOWS" -eq 1 ]; then
  pass "RT4: mode check skipped on Windows (chmod no-op on NTFS)"
else
  if [ "$(file_mode "$T/home/.um/endpoint")" = "600" ]; then pass "RT4: endpoint mode 600"; else fail "RT4: endpoint mode $(file_mode "$T/home/.um/endpoint")"; fi
  if [ "$(file_mode "$T/home/.um/auth-token")" = "600" ]; then pass "RT4: auth-token mode 600"; else fail "RT4: auth-token mode $(file_mode "$T/home/.um/auth-token")"; fi
fi
rm -rf "$T"

# ─── RT5: local orphan captures ⇒ repoint warning (does not block) ───────────
echo ""
echo "=== RT5: local vault with raw captures → repoint warning, still succeeds ==="
T=$(mktemp -d)
mkdir -p "$T/home/.um/vault/myproj/captures"
echo "orphan raw capture" > "$T/home/.um/vault/myproj/captures/2026-07-17-raw.md"
run_remote "$T" UM_AUTH_TOKEN=tok -- --remote http://pi:6337 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT5: exit 0 (warning does not block)"; else fail "RT5: exit $RT_RC (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -qi "captures" && echo "$RT_OUT" | grep -qi "checkpoint"; then pass "RT5: repoint warning printed"; else fail "RT5: no repoint warning (out: $RT_OUT)"; fi
rm -rf "$T"

# RT5b: no orphans ⇒ no repoint warning noise
T=$(mktemp -d)
run_remote "$T" -- --remote http://pi:6337 --yes
if ! echo "$RT_OUT" | grep -qi "strand"; then pass "RT5b: no repoint warning without orphans"; else fail "RT5b: spurious repoint warning (out: $RT_OUT)"; fi
rm -rf "$T"

# ─── RT6: pre-existing UM_SERVER_URL marker block ⇒ updated in place ─────────
echo ""
echo "=== RT6: existing marker block → UM_SERVER_URL updated via marker-block.sh ==="
T=$(mktemp -d)
mkdir -p "$T/home"
cat > "$T/home/.bashrc" <<'RC'
# user content stays
# --- universal-memory (auto-added by install.sh) ---
export UM_SERVER_URL='http://old-local:6335'
# --- end universal-memory ---
RC
run_remote "$T" -- --remote http://pi:6337 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT6: exit 0"; else fail "RT6: exit $RT_RC (out: $RT_OUT)"; fi
if grep -q "export UM_SERVER_URL='http://pi:6337'" "$T/home/.bashrc"; then pass "RT6: marker block updated to new URL"; else fail "RT6: block not updated ($(cat "$T/home/.bashrc"))"; fi
if ! grep -q "old-local" "$T/home/.bashrc"; then pass "RT6: old URL removed"; else fail "RT6: old URL still present"; fi
if [ "$(grep -cF '# --- universal-memory (auto-added by install.sh) ---' "$T/home/.bashrc")" = "1" ]; then pass "RT6: exactly one marker block"; else fail "RT6: marker block duplicated"; fi
if grep -q "user content stays" "$T/home/.bashrc"; then pass "RT6: user content preserved"; else fail "RT6: user content lost"; fi
if ! echo "$RT_OUT" | grep -qi "marker-block values"; then pass "RT6: no reset notice when block held no key/summarizer"; else fail "RT6: spurious reset notice (out: $RT_OUT)"; fi
rm -rf "$T"

# ─── RT6b: marker block holds key/summarizer the current env lacks ⇒ notice ──
# Regenerating the block from a non-hydrated shell silently wipes stored
# UM_OPENAI_API_KEY / UM_SUMMARIZER — the flow must at least SAY so.
echo ""
echo "=== RT6b: marker block with stored key + summarizer → reset notice printed ==="
T=$(mktemp -d)
mkdir -p "$T/home"
cat > "$T/home/.bashrc" <<'RC'
# --- universal-memory (auto-added by install.sh) ---
export UM_OPENAI_API_KEY='XXX-stored-key-not-in-env'
export UM_SUMMARIZER='ollama'
export UM_SERVER_URL='http://old-local:6335'
# --- end universal-memory ---
RC
run_remote "$T" -- --remote http://pi:6337 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT6b: exit 0 (notice does not block)"; else fail "RT6b: exit $RT_RC (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -qi "marker-block values" && echo "$RT_OUT" | grep -qi "re-run the full installer"; then
  pass "RT6b: reset notice printed"
else
  fail "RT6b: no reset notice (out: $RT_OUT)"
fi
if grep -q "export UM_SERVER_URL='http://pi:6337'" "$T/home/.bashrc"; then pass "RT6b: block still regenerated (notice-only, no behavior change)"; else fail "RT6b: block not updated"; fi
rm -rf "$T"

# ─── RT7: bare UM_SERVER_URL export (no marker) ⇒ shadowing warning ──────────
echo ""
echo "=== RT7: bare UM_SERVER_URL export in profile → shadowing warning ==="
T=$(mktemp -d)
mkdir -p "$T/home"
echo "export UM_SERVER_URL='http://old-local:6335'" > "$T/home/.bashrc"
run_remote "$T" -- --remote http://pi:6337 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT7: exit 0"; else fail "RT7: exit $RT_RC (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -qi "shadow"; then pass "RT7: shadowing warning printed"; else fail "RT7: no shadowing warning (out: $RT_OUT)"; fi
if grep -q "old-local" "$T/home/.bashrc"; then pass "RT7: user's own export left untouched"; else fail "RT7: user export was modified"; fi
rm -rf "$T"

# ─── RT8: --remote reconciles with --server-url ──────────────────────────────
echo ""
echo "=== RT8: --remote + --server-url URL → same flow, config written ==="
T=$(mktemp -d)
run_remote "$T" -- --remote --server-url http://pi:6337 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT8: exit 0"; else fail "RT8: exit $RT_RC (out: $RT_OUT)"; fi
if [ "$(cat "$T/home/.um/endpoint" 2>/dev/null)" = "http://pi:6337" ]; then pass "RT8: endpoint written from --server-url"; else fail "RT8: endpoint wrong/missing"; fi
rm -rf "$T"

# ─── RT9: --remote --dry-run ⇒ intent only, nothing written ──────────────────
echo ""
echo "=== RT9: --remote --dry-run → prints intent, writes nothing ==="
T=$(mktemp -d)
run_remote "$T" -- --remote http://pi:6337 --dry-run --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT9: exit 0"; else fail "RT9: exit $RT_RC (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -qi "dry-run"; then pass "RT9: dry-run intent printed"; else fail "RT9: no dry-run intent (out: $RT_OUT)"; fi
no_config_written "$T/home" "RT9"
rm -rf "$T"

# ─── RT10: --remote with no URL, non-TTY ⇒ actionable error, no config ───────
echo ""
echo "=== RT10: --remote, no URL, non-TTY → error names --remote/--server-url ==="
T=$(mktemp -d)
run_remote "$T" -- --remote --yes
if [ "$RT_RC" -ne 0 ]; then pass "RT10: non-zero exit"; else fail "RT10: expected non-zero (out: $RT_OUT)"; fi
if echo "$RT_OUT" | grep -q -- "--server-url"; then pass "RT10: error names the flag"; else fail "RT10: flag not named (out: $RT_OUT)"; fi
no_config_written "$T/home" "RT10"
rm -rf "$T"

# ─── RT11: empty token ⇒ endpoint written, auth-token untouched ──────────────
echo ""
echo "=== RT11: empty token (loopback no-auth) → endpoint written, no auth-token; existing token file kept ==="
T=$(mktemp -d)
run_remote "$T" -- --remote http://localhost:6335 --yes
if [ "$RT_RC" -eq 0 ]; then pass "RT11: exit 0"; else fail "RT11: exit $RT_RC (out: $RT_OUT)"; fi
if [ -f "$T/home/.um/endpoint" ] && [ ! -e "$T/home/.um/auth-token" ]; then pass "RT11: endpoint written, no auth-token created"; else fail "RT11: unexpected config state"; fi
rm -rf "$T"
# existing token file survives an empty-token re-run
T=$(mktemp -d)
mkdir -p "$T/home/.um"
echo "old-token" > "$T/home/.um/auth-token"
run_remote "$T" -- --remote http://localhost:6335 --yes
if [ "$(cat "$T/home/.um/auth-token" 2>/dev/null)" = "old-token" ]; then pass "RT11b: pre-existing auth-token preserved on empty-token run"; else fail "RT11b: auth-token clobbered"; fi
rm -rf "$T"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
