#!/usr/bin/env bash
# um-tunnel.test.sh — unit tests for the um-tunnel CLI
# Run: bash um-tunnel.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Strategy: stub out `cloudflared` / `tailscale` / `ngrok` binaries in a
# per-test PATH and assert on the output of `um-tunnel` under
# UM_TUNNEL_DRY_RUN=1 (which skips the blocking wait loop).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/um-tunnel"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s\n' "$1"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name (got='$got', want='$want')"; fi
}

assert_ne() {
  local name="$1" got="$2" unwant="$3"
  if [ "$got" != "$unwant" ]; then pass "$name"
  else fail "$name (got='$got' but expected ≠'$unwant')"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got: '${haystack:0:400}')"; fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"
  else fail "$name (expected NOT to contain '$needle')"; fi
}

# ---------------------------------------------------------------------------
# Temp dir root + cleanup
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ---------------------------------------------------------------------------
# Helper: write a stub `cloudflared` that prints a fake trycloudflare URL
# and blocks on stdin until killed. Its invocation is recorded to CALLS_FILE.
# ---------------------------------------------------------------------------
write_stub_cloudflared() {
  local bindir="$1"
  local calls_file="${2:-}"
  local url="${3:-https://stub-abc-123.trycloudflare.com}"
  mkdir -p "$bindir"
  cat > "$bindir/cloudflared" <<STUB
#!/usr/bin/env bash
# Stub cloudflared — prints a fake URL then blocks on stdin.
if [ -n "${calls_file}" ]; then
  printf 'cloudflared %s\n' "\$*" >> "${calls_file}"
fi
# Cloudflared logs the public URL to stderr in real life; mirror that.
printf '%s\n' "INF +--------------------------------------------------------------------------------------------+" >&2
printf '%s\n' "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):   |" >&2
printf '%s\n' "INF |  ${url}                                                                                     |" >&2
printf '%s\n' "INF +--------------------------------------------------------------------------------------------+" >&2
# Stay alive long enough for um-tunnel's liveness check + URL extraction,
# then exit so its trailing 'wait \$TUNNEL_PID' returns and the test ends.
# NOT 'exec cat >/dev/null': under CI a step's stdin is /dev/null, so cat
# EOFs and exits within milliseconds — losing the race against the
# kill -0 liveness check in um-tunnel's extraction loop (the 2026-06-12
# macos-latest CI failure; passes locally only because a TTY stdin keeps
# cat blocked).
exec sleep 5
STUB
  chmod +x "$bindir/cloudflared"
}

# ---------------------------------------------------------------------------
# Helper: write a stub `tailscale` that prints a fake ts.net URL and blocks.
# ---------------------------------------------------------------------------
write_stub_tailscale() {
  local bindir="$1"
  local calls_file="${2:-}"
  local url="${3:-https://test-device.foo-tailnet.ts.net}"
  mkdir -p "$bindir"
  cat > "$bindir/tailscale" <<STUB
#!/usr/bin/env bash
if [ -n "${calls_file}" ]; then
  printf 'tailscale %s\n' "\$*" >> "${calls_file}"
fi
printf 'Available on the internet:\n\n${url}\n' >&2
# Deterministic lifetime, not stdin-dependent — see the cloudflared stub note.
exec sleep 5
STUB
  chmod +x "$bindir/tailscale"
}

# ---------------------------------------------------------------------------
# Helper: write a stub `curl` controlling the write-mode live probe.
# With a body argument, prints that body (a fake tools/list response) and
# exits 0; with an empty body, exits 7 (connection refused) so um-tunnel
# falls through to the env-file / shell-env detection tiers.
# ---------------------------------------------------------------------------
write_stub_curl() {
  local bindir="$1"
  local body="${2:-}"
  mkdir -p "$bindir"
  if [ -n "$body" ]; then
    cat > "$bindir/curl" <<STUB
#!/usr/bin/env bash
printf '%s' '${body}'
STUB
  else
    printf '#!/usr/bin/env bash\nexit 7\n' > "$bindir/curl"
  fi
  chmod +x "$bindir/curl"
}

# Fake tools/list responses for the curl stub (server emits compact JSON).
TOOLS_WRITE_ON='{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"memory_search"},{"name":"memory_capture"},{"name":"memory_add"}]}}'
TOOLS_WRITE_OFF='{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"memory_search"},{"name":"memory_recent"}]}}'

# ---------------------------------------------------------------------------
# Helper: build a PATH string that only contains the stub bin and basic utils.
# We need at least the dirname of standard utilities (bash, sed, grep, sleep,
# cat, kill, date, ps) for the script to run. Preserve the real PATH after
# the stub so those all resolve.
# ---------------------------------------------------------------------------
stubbed_path() {
  local stub_bin="$1"
  printf '%s' "$stub_bin:$PATH"
}

# ---------------------------------------------------------------------------
# Test 1: URL extraction from stubbed cloudflared (happy path)
# ---------------------------------------------------------------------------
echo "=== Test 1: URL extraction + rubric + paste instruction (cloudflared) ==="

T1_DIR="$TMPDIR_ROOT/t1"
T1_BIN="$T1_DIR/bin"
T1_LOG="$T1_DIR/tunnel.log"
T1_URL="https://t1-abc-123.trycloudflare.com"
write_stub_cloudflared "$T1_BIN" "" "$T1_URL"

T1_OUT=$(UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T1_LOG" \
  PATH="$(stubbed_path "$T1_BIN")" bash "$BIN" 2>&1) || T1_EXIT=$?
T1_EXIT=${T1_EXIT:-0}

assert_eq "T1: exit code 0 on success" "$T1_EXIT" "0"
assert_contains "T1: output contains stubbed URL" "$T1_OUT" "$T1_URL"
assert_contains "T1: output has rubric header ('Memory routing')" "$T1_OUT" "Memory routing"
assert_contains "T1: output has paste-here instruction ('MCP connector URL')" "$T1_OUT" "MCP connector URL"

# ---------------------------------------------------------------------------
# Test 2: Rubric body text appears (path-resolution sanity)
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 2: Rubric body text appears in output ==="

T2_DIR="$TMPDIR_ROOT/t2"
T2_BIN="$T2_DIR/bin"
T2_LOG="$T2_DIR/tunnel.log"
write_stub_cloudflared "$T2_BIN"

T2_OUT=$(UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T2_LOG" \
  PATH="$(stubbed_path "$T2_BIN")" bash "$BIN" 2>&1) || T2_EXIT=$?
T2_EXIT=${T2_EXIT:-0}

assert_eq "T2: exit code 0" "$T2_EXIT" "0"
# `memory_capture` is the tool name in the rubric body — verifies we
# actually resolved & printed the rubric file contents, not just the header.
assert_contains "T2: rubric body contains 'memory_capture'" "$T2_OUT" "memory_capture"

# ---------------------------------------------------------------------------
# Test 3: No tunnel CLI detected → non-zero exit + install hint
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 3: No tunnel CLI in PATH → error + install hints ==="

T3_DIR="$TMPDIR_ROOT/t3"
T3_BIN="$T3_DIR/bin"
mkdir -p "$T3_BIN"
# Build a minimal PATH that keeps basic utils but has NONE of the tunnel CLIs.
# Strategy: include only /usr/bin /bin (typical Unix). On Git Bash (Windows)
# these are mapped to the Git install dirs and sufficient for bash builtins.
MIN_PATH="/usr/bin:/bin"
# Explicitly check: none of cloudflared/tailscale/ngrok should resolve in MIN_PATH.
# If they happen to be installed system-wide under /usr/bin, we skip this test.
SKIP_T3=0
for cli in cloudflared tailscale ngrok; do
  if PATH="$MIN_PATH" command -v "$cli" >/dev/null 2>&1; then
    SKIP_T3=1
    break
  fi
done

if [ "$SKIP_T3" -eq 1 ]; then
  echo "  SKIP: T3 — a tunnel CLI exists in /usr/bin or /bin on this host."
else
  T3_OUT=$(UM_TUNNEL_DRY_RUN=1 PATH="$MIN_PATH" bash "$BIN" 2>&1) || T3_EXIT=$?
  T3_EXIT=${T3_EXIT:-0}
  assert_ne       "T3: non-zero exit when no CLI found" "$T3_EXIT" "0"
  assert_contains "T3: stderr mentions cloudflared"      "$T3_OUT"  "cloudflared"
fi

# ---------------------------------------------------------------------------
# Test 4: UM_MCP_WRITE_ENABLED=true → prominent security warning
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 4: UM_MCP_WRITE_ENABLED=true → SECURITY WARNING ==="

T4_DIR="$TMPDIR_ROOT/t4"
T4_BIN="$T4_DIR/bin"
T4_LOG="$T4_DIR/tunnel.log"
write_stub_cloudflared "$T4_BIN"
# Isolate the shell-env detection tier: live probe fails, no env file.
write_stub_curl "$T4_BIN" ""

T4_OUT=$(UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T4_LOG" UM_MCP_WRITE_ENABLED=true \
  UM_SERVER_ENV_FILE="$T4_DIR/nonexistent.env" \
  PATH="$(stubbed_path "$T4_BIN")" bash "$BIN" 2>&1) || T4_EXIT=$?
T4_EXIT=${T4_EXIT:-0}

assert_eq       "T4: exit code 0"                         "$T4_EXIT" "0"
assert_contains "T4: output has 'SECURITY WARNING'"       "$T4_OUT"  "SECURITY WARNING"
assert_contains "T4: output mentions 'world-writable'"    "$T4_OUT"  "world-writable"

# ---------------------------------------------------------------------------
# Test 5: writes disabled (default) → writes-disabled note
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 5: UM_MCP_WRITE_ENABLED unset → writes-disabled note ==="

T5_DIR="$TMPDIR_ROOT/t5"
T5_BIN="$T5_DIR/bin"
T5_LOG="$T5_DIR/tunnel.log"
write_stub_cloudflared "$T5_BIN"
# Isolate the shell-env detection tier: live probe fails, no env file.
write_stub_curl "$T5_BIN" ""

T5_OUT=$(env -u UM_MCP_WRITE_ENABLED \
  UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T5_LOG" \
  UM_SERVER_ENV_FILE="$T5_DIR/nonexistent.env" \
  PATH="$(stubbed_path "$T5_BIN")" bash "$BIN" 2>&1) || T5_EXIT=$?
T5_EXIT=${T5_EXIT:-0}

assert_eq "T5: exit code 0" "$T5_EXIT" "0"
# Accept either phrasing — "UM_MCP_WRITE_ENABLED=false" or "writes are disabled"
if [[ "$T5_OUT" == *"UM_MCP_WRITE_ENABLED=false"* ]] || \
   [[ "$T5_OUT" == *"writes are disabled"* ]]; then
  pass "T5: output mentions writes-disabled note"
else
  fail "T5: no writes-disabled note (got: '${T5_OUT:0:400}')"
fi

# ---------------------------------------------------------------------------
# Test 6: UM_TUNNEL_CLI=tailscale override picks tailscale even when
# cloudflared is first on PATH.
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 6: UM_TUNNEL_CLI=tailscale overrides auto-detection ==="

T6_DIR="$TMPDIR_ROOT/t6"
T6_BIN="$T6_DIR/bin"
T6_LOG="$T6_DIR/tunnel.log"
T6_CALLS="$T6_DIR/calls.log"
# Both stubs present in PATH — cloudflared appears first alphabetically in listing,
# but we want tailscale to be picked due to env override.
write_stub_cloudflared "$T6_BIN" "$T6_CALLS"
write_stub_tailscale   "$T6_BIN" "$T6_CALLS"

T6_OUT=$(UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T6_LOG" UM_TUNNEL_CLI=tailscale \
  PATH="$(stubbed_path "$T6_BIN")" bash "$BIN" 2>&1) || T6_EXIT=$?
T6_EXIT=${T6_EXIT:-0}

assert_eq "T6: exit code 0" "$T6_EXIT" "0"
# Verify tailscale got invoked (and cloudflared did not, for this run) by
# inspecting the shared calls.log:
T6_CALLS_CONTENT=$(cat "$T6_CALLS" 2>/dev/null || echo "")
assert_contains "T6: tailscale was invoked" "$T6_CALLS_CONTENT" "tailscale "
if [[ "$T6_CALLS_CONTENT" == *"cloudflared "* ]]; then
  fail "T6: cloudflared should NOT have been called when UM_TUNNEL_CLI=tailscale (calls: $T6_CALLS_CONTENT)"
else
  pass "T6: cloudflared not invoked (correctly overridden)"
fi
# The tailscale stub prints a ts.net URL; confirm it made it into the panel.
assert_contains "T6: output contains ts.net URL" "$T6_OUT" "ts.net"

# ---------------------------------------------------------------------------
# Test 7: trailing-slash URL (tailscale funnel idiom) → joins normalized,
# no '//mcp' in the panel. Regression: https://host.ts.net//mcp (2026-06-11).
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 7: trailing-slash URL is normalized before /mcp join ==="

T7_DIR="$TMPDIR_ROOT/t7"
T7_BIN="$T7_DIR/bin"
T7_LOG="$T7_DIR/tunnel.log"
write_stub_tailscale "$T7_BIN" "" "https://t7-device.stub-tailnet.ts.net/"
write_stub_curl "$T7_BIN" ""

T7_OUT=$(UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T7_LOG" UM_TUNNEL_CLI=tailscale \
  UM_SERVER_ENV_FILE="$T7_DIR/nonexistent.env" \
  PATH="$(stubbed_path "$T7_BIN")" bash "$BIN" 2>&1) || T7_EXIT=$?
T7_EXIT=${T7_EXIT:-0}

assert_eq           "T7: exit code 0"                       "$T7_EXIT" "0"
assert_contains     "T7: connector URL joined with single slash" \
  "$T7_OUT" "https://t7-device.stub-tailnet.ts.net/mcp"
assert_not_contains "T7: no doubled slash before /mcp"      "$T7_OUT" "//mcp"
assert_not_contains "T7: no doubled slash before /openapi"  "$T7_OUT" "//openapi.yaml"

# ---------------------------------------------------------------------------
# Test 8: live probe says writes ON → SECURITY WARNING even though this
# shell's UM_MCP_WRITE_ENABLED is unset. Regression: banner reported the
# shell env while the running container served all 11 tools (2026-06-11).
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 8: live tools/list with write tool → WARNING (shell env unset) ==="

T8_DIR="$TMPDIR_ROOT/t8"
T8_BIN="$T8_DIR/bin"
T8_LOG="$T8_DIR/tunnel.log"
write_stub_cloudflared "$T8_BIN"
write_stub_curl "$T8_BIN" "$TOOLS_WRITE_ON"

T8_OUT=$(env -u UM_MCP_WRITE_ENABLED \
  UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T8_LOG" \
  PATH="$(stubbed_path "$T8_BIN")" bash "$BIN" 2>&1) || T8_EXIT=$?
T8_EXIT=${T8_EXIT:-0}

assert_eq       "T8: exit code 0"                          "$T8_EXIT" "0"
assert_contains "T8: live write-mode wins → SECURITY WARNING" "$T8_OUT" "SECURITY WARNING"
assert_contains "T8: detection source is live-server"      "$T8_OUT" "live-server"

# ---------------------------------------------------------------------------
# Test 9: live probe says writes OFF → writes-disabled note even though this
# shell's UM_MCP_WRITE_ENABLED=true (the inverse staleness direction).
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 9: live tools/list read-only → disabled note (shell env =true) ==="

T9_DIR="$TMPDIR_ROOT/t9"
T9_BIN="$T9_DIR/bin"
T9_LOG="$T9_DIR/tunnel.log"
write_stub_cloudflared "$T9_BIN"
write_stub_curl "$T9_BIN" "$TOOLS_WRITE_OFF"

T9_OUT=$(UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T9_LOG" UM_MCP_WRITE_ENABLED=true \
  PATH="$(stubbed_path "$T9_BIN")" bash "$BIN" 2>&1) || T9_EXIT=$?
T9_EXIT=${T9_EXIT:-0}

assert_eq           "T9: exit code 0"                      "$T9_EXIT" "0"
assert_not_contains "T9: no SECURITY WARNING"              "$T9_OUT" "SECURITY WARNING"
assert_contains     "T9: writes-disabled note shown"       "$T9_OUT" "writes are disabled"

# ---------------------------------------------------------------------------
# Test 10: live probe fails → server/.env tier answers (UM_SERVER_ENV_FILE).
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 10: probe fails → env-file fallback drives the banner ==="

T10_DIR="$TMPDIR_ROOT/t10"
T10_BIN="$T10_DIR/bin"
T10_LOG="$T10_DIR/tunnel.log"
write_stub_cloudflared "$T10_BIN"
write_stub_curl "$T10_BIN" ""
mkdir -p "$T10_DIR"
printf 'UM_AUTH_TOKEN=stub\nUM_MCP_WRITE_ENABLED=true\nUM_MOUNT_MODE=rw\n' \
  > "$T10_DIR/server.env"

T10_OUT=$(env -u UM_MCP_WRITE_ENABLED \
  UM_TUNNEL_DRY_RUN=1 UM_TUNNEL_LOG="$T10_LOG" \
  UM_SERVER_ENV_FILE="$T10_DIR/server.env" \
  PATH="$(stubbed_path "$T10_BIN")" bash "$BIN" 2>&1) || T10_EXIT=$?
T10_EXIT=${T10_EXIT:-0}

assert_eq       "T10: exit code 0"                         "$T10_EXIT" "0"
assert_contains "T10: env-file write=true → SECURITY WARNING" "$T10_OUT" "SECURITY WARNING"
assert_contains "T10: detection source is env-file"        "$T10_OUT" "env-file"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
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
