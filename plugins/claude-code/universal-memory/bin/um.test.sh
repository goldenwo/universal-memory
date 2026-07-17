#!/usr/bin/env bash
# bin/um.test.sh — integration tests for the bin/um dispatcher
# Run: bash plugins/claude-code/universal-memory/bin/um.test.sh
set -uo pipefail

REAL_SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REAL_UM="$REAL_SCRIPT_DIR/um"
REAL_LIB_DIR="$REAL_SCRIPT_DIR/../hooks/lib"
REAL_PLUGIN_DIR="$REAL_SCRIPT_DIR/.."

PASS=0; FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# ─── Setup: isolated temp tree ───────────────────────────────────────────────
# We copy the dispatcher into a temp dir and write stubs there.
# This ensures cleanup NEVER touches real subcommand scripts in the real bin/.
#
# Tree:
#   $UM_TEST_DIR/            ← PLUGIN_DIR as seen by copied dispatcher
#   $UM_TEST_DIR/bin/um      ← copy of real dispatcher
#   $UM_TEST_DIR/bin/um-*.sh ← stubs (temp dir only)
#   $UM_TEST_DIR/.claude-plugin → symlink to real .claude-plugin (for --version)
#
# UM_LIB_DIR is set to the real lib path so the dispatcher can source config.sh.
UM_TEST_DIR=$(mktemp -d)
mkdir -p "$UM_TEST_DIR/bin"
cp "$REAL_UM" "$UM_TEST_DIR/bin/um"
chmod +x "$UM_TEST_DIR/bin/um"
# Symlink .claude-plugin for --version test
ln -s "$REAL_PLUGIN_DIR/.claude-plugin" "$UM_TEST_DIR/.claude-plugin" 2>/dev/null || true

UM="$UM_TEST_DIR/bin/um"

cleanup() {
  rm -rf "$UM_TEST_DIR"
  for d in "${FAKE_HOME_DIRS[@]:-}"; do
    rm -rf "$d"
  done
}
trap cleanup EXIT

# Write a stub .sh subcommand to the TEMP bin dir (NOT the real bin/)
create_stub_sh() {
  local cmd="$1"
  local target="$UM_TEST_DIR/bin/um-${cmd}.sh"
  cat > "$target" <<'STUBEOF'
#!/usr/bin/env bash
echo "um-CMDNAME stub called with: $*"
echo "UM_SERVER_URL=${UM_SERVER_URL:-UNSET}"
STUBEOF
  sed "s/CMDNAME/$cmd/" "$target" > "$target.tmp" && mv "$target.tmp" "$target"
  chmod +x "$target"
}

# Create stubs for all .sh-suffix subcommands
for cmd in search state recent list capture tail; do
  create_stub_sh "$cmd"
done

# Copy real um-forget and um-supersede binaries into temp tree (so T2 works)
for bin in forget supersede; do
  if [ -x "$REAL_SCRIPT_DIR/um-$bin" ]; then
    cp "$REAL_SCRIPT_DIR/um-$bin" "$UM_TEST_DIR/bin/um-$bin"
    chmod +x "$UM_TEST_DIR/bin/um-$bin"
  fi
done

# fake home (isolates usage log + .um/config)
fake_home=$(mktemp -d)
FAKE_HOME_DIRS=("$fake_home")

# Helper: run dispatcher from isolated temp dir; UM_LIB_DIR points to real lib
run_um() {
  HOME="$fake_home" UM_NO_USAGE_LOG=1 UM_LIB_DIR="$REAL_LIB_DIR" bash "$UM" "$@"
}

# ─── T1: um search foo bar → um-search.sh called with "foo bar" ──────────────
echo "=== T1: um search foo bar ==="
out=$(run_um search foo bar 2>&1) && rc=$? || rc=$?
if [ "$rc" = "0" ] && echo "$out" | grep -q "um-search stub called with: foo bar"; then
  pass "T1: search delegates to um-search.sh with correct args"
else
  fail "T1: expected stub output (rc=$rc, out=$out)"
fi

# ─── T2: um forget abc → um-forget called with "abc" ─────────────────────────
echo "=== T2: um forget abc ==="
out=$(run_um forget abc 2>&1) && rc=$? || rc=$?
# um-forget is a real binary; it will fail if env not set — we just check delegation
# by verifying it was invoked (it will error about missing UM_ vars, not "unknown subcommand")
if [ "$rc" != "2" ] || ! echo "$out" | grep -q "unknown subcommand"; then
  pass "T2: forget delegated to um-forget (not 'unknown subcommand' error)"
else
  fail "T2: got 'unknown subcommand' — forget not dispatched (rc=$rc, out=$out)"
fi

# ─── T3: um --help → exit 0, mentions key subcommands ────────────────────────
echo "=== T3: um --help ==="
out=$(run_um --help 2>&1) && rc=$? || rc=$?
if [ "$rc" = "0" ] \
    && echo "$out" | grep -q "search" \
    && echo "$out" | grep -q "capture"; then
  pass "T3: --help exits 0 and lists subcommands"
else
  fail "T3: --help output wrong (rc=$rc, out=$out)"
fi

# ─── T4: um --version → exit 0, output matches plugin.json ──────────────────
echo "=== T4: um --version ==="
out=$(run_um --version 2>&1) && rc=$? || rc=$?
PLUGIN_JSON="$REAL_PLUGIN_DIR/.claude-plugin/plugin.json"
if command -v jq >/dev/null 2>&1; then
  expected_ver=$(jq -r '.version // .plugin_version // "unknown"' "$PLUGIN_JSON")
else
  expected_ver=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$PLUGIN_JSON" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi
if [ "$rc" = "0" ] && [ "$out" = "$expected_ver" ]; then
  pass "T4: --version exits 0 and outputs '$expected_ver'"
else
  fail "T4: --version wrong (rc=$rc, out='$out', expected='$expected_ver')"
fi

# ─── T5: um xyz → exit 2, stderr contains "unknown subcommand" ───────────────
echo "=== T5: um xyz ==="
out=$(run_um xyz 2>&1) || rc=$?
rc=${rc:-0}
if [ "$rc" = "2" ] && echo "$out" | grep -q "unknown subcommand"; then
  pass "T5: unknown subcommand exits 2 with error"
else
  fail "T5: expected exit 2 + error message (rc=$rc, out=$out)"
fi

# ─── T6a: usage log appended when UM_NO_USAGE_LOG unset ─────────────────────
echo "=== T6: usage log ==="
fake_home6=$(mktemp -d)
FAKE_HOME_DIRS+=("$fake_home6")
HOME="$fake_home6" UM_LIB_DIR="$REAL_LIB_DIR" bash "$UM" search logtest 2>/dev/null || true
logfile="$fake_home6/.local/share/um/usage.log"
# Log format: {iso8601_timestamp}\t{subcommand}\t{arg_count} — no query text (spec §11.3)
if [ -f "$logfile" ] && grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$logfile" && grep -q "$(printf '\tsearch\t')" "$logfile"; then
  pass "T6a: usage log appended with subcommand+argcount format (no query text)"
else
  fail "T6a: usage log not written or wrong format (logfile='$logfile', exists=$([ -f "$logfile" ] && echo yes || echo no), content=$(cat "$logfile" 2>/dev/null || echo MISSING))"
fi

# Also verify query text NOT present in log (PII check)
if ! grep -q "logtest" "$logfile" 2>/dev/null; then
  pass "T6a-pii: query text absent from usage log"
else
  fail "T6a-pii: query text found in usage log (PII leak)"
fi

# ─── T6b: usage log skipped when UM_NO_USAGE_LOG=1 ──────────────────────────
fake_home6b=$(mktemp -d)
FAKE_HOME_DIRS+=("$fake_home6b")
HOME="$fake_home6b" UM_NO_USAGE_LOG=1 UM_LIB_DIR="$REAL_LIB_DIR" bash "$UM" search logtest 2>/dev/null || true
logfile6b="$fake_home6b/.local/share/um/usage.log"
if [ ! -f "$logfile6b" ]; then
  pass "T6b: usage log skipped when UM_NO_USAGE_LOG=1"
else
  fail "T6b: usage log unexpectedly written"
fi

# ─── T7: usage log skipped when .no-log sentinel exists ─────────────────────
echo "=== T7: .no-log sentinel ==="
fake_home7=$(mktemp -d)
FAKE_HOME_DIRS+=("$fake_home7")
mkdir -p "$fake_home7/.local/share/um"
touch "$fake_home7/.local/share/um/.no-log"
HOME="$fake_home7" UM_LIB_DIR="$REAL_LIB_DIR" bash "$UM" search sentinel-test 2>/dev/null || true
logfile7="$fake_home7/.local/share/um/usage.log"
if [ ! -f "$logfile7" ]; then
  pass "T7: usage log skipped when .no-log sentinel present"
else
  fail "T7: usage log written despite .no-log sentinel"
fi

# ─── T8: env > config precedence ─────────────────────────────────────────────
echo "=== T8: env > config precedence ==="
fake_wd8=$(mktemp -d)
mkdir -p "$fake_wd8/.um"
printf 'UM_SERVER_URL=config-value\n' > "$fake_wd8/.um/config"
out8=$(cd "$fake_wd8" && HOME="$fake_home" UM_NO_USAGE_LOG=1 UM_LIB_DIR="$REAL_LIB_DIR" UM_SERVER_URL=env-value bash "$UM" search foo 2>&1) && rc8=$? || rc8=$?
if [ "$rc8" = "0" ] && echo "$out8" | grep -q "UM_SERVER_URL=env-value"; then
  pass "T8: env wins over .um/config (UM_SERVER_URL=env-value preserved)"
else
  fail "T8: precedence wrong (rc=$rc8, out=$out8)"
fi
rm -rf "$fake_wd8"

# ─── T9: UM_LIB_DIR health check — nonexistent dir → exits non-zero ──────────
echo "=== T9: UM_LIB_DIR=/nonexistent → --version exits non-zero with clear error ==="
UM_TEST_DIR9=$(mktemp -d)
cp "$REAL_UM" "$UM_TEST_DIR9/um"
chmod +x "$UM_TEST_DIR9/um"
out9=$(HOME="$fake_home" UM_NO_USAGE_LOG=1 UM_LIB_DIR=/nonexistent/path bash "$UM_TEST_DIR9/um" --version 2>&1) && rc9=0 || rc9=$?
if [ "$rc9" -ne 0 ]; then
  pass "T9: UM_LIB_DIR=/nonexistent/path → --version exits $rc9 (expected non-zero)"
else
  fail "T9: expected non-zero exit, got 0 (output: $out9)"
fi
if echo "$out9" | grep -qi "missing\|not found\|library"; then
  pass "T9: error message mentions missing libraries"
else
  fail "T9: error message unclear: $out9"
fi
rm -rf "$UM_TEST_DIR9"

# ─── T10: partial UM_LIB_DIR (missing frontmatter.sh) → health check fails ──
echo "=== T10: partial UM_LIB_DIR missing frontmatter.sh → health check fails clearly ==="
UM_TEST_DIR10=$(mktemp -d)
cp "$REAL_UM" "$UM_TEST_DIR10/um"
chmod +x "$UM_TEST_DIR10/um"
# Create a partial lib dir with all files except frontmatter.sh
PARTIAL_LIB="$UM_TEST_DIR10/lib"
mkdir -p "$PARTIAL_LIB"
for f in config.sh resolve-project.sh vault.sh summarize.sh update-state.sh; do
  touch "$PARTIAL_LIB/$f"
done
# frontmatter.sh intentionally absent
out10=$(HOME="$fake_home" UM_NO_USAGE_LOG=1 UM_LIB_DIR="$PARTIAL_LIB" bash "$UM_TEST_DIR10/um" --version 2>&1) && rc10=0 || rc10=$?
if [ "$rc10" -ne 0 ]; then
  pass "T10: partial lib (missing frontmatter.sh) → exits non-zero"
else
  fail "T10: expected non-zero exit, got 0 (output: $out10)"
fi
if echo "$out10" | grep -q "frontmatter.sh"; then
  pass "T10: error message names the missing file (frontmatter.sh)"
else
  fail "T10: error message does not name missing file: $out10"
fi
rm -rf "$UM_TEST_DIR10"

# ─── T11: standalone-install fallback — UM_LIB_DIR unset, $HOME/.local/share/um/lib exists ─
# Regression: the dispatcher's lib-path fallback used to be
# `$PLUGIN_DIR/hooks/lib`, which is wrong when the dispatcher is a standalone
# install at `$HOME/.local/bin/um` and libs live at `$HOME/.local/share/um/lib`.
# Previously `um --version` would fail whenever the user ran it without first
# sourcing ~/.bashrc (e.g. in a non-interactive shell, or CI). Fix: a two-tier
# fallback tries the standalone layout before the plugin-context layout.
echo "=== T11: standalone-install fallback without UM_LIB_DIR ==="
UM_TEST_DIR11=$(mktemp -d)
# Lay out a standalone install matching what installer/install-cli.sh produces:
#   dispatcher at ~/.local/bin/um
#   libs at   ~/.local/share/um/lib
#   plugin.json at ~/.local/.claude-plugin/plugin.json
T11_HOME="$UM_TEST_DIR11/home"
T11_BIN="$T11_HOME/.local/bin"
T11_LIB="$T11_HOME/.local/share/um/lib"
T11_PLUG="$T11_HOME/.local/.claude-plugin"
mkdir -p "$T11_BIN" "$T11_LIB" "$T11_PLUG"
cp "$UM" "$T11_BIN/um"
chmod +x "$T11_BIN/um"
# install-cli.sh glob-copies hooks/lib/*.sh, so mirror the FULL lib dir here
# (a hand-enumerated subset went stale when the dispatcher's health check
# grew endpoint.sh in #159 — pre-existing T11 red fixed alongside the
# whole-branch review pass).
for f in "$REAL_LIB_DIR"/*.sh; do
  case "$f" in *.test.sh) continue ;; esac
  cp "$f" "$T11_LIB/$(basename "$f")"
done
cp "$REAL_PLUGIN_DIR/.claude-plugin/plugin.json" "$T11_PLUG/plugin.json"
# Run WITHOUT setting UM_LIB_DIR — the dispatcher must find libs at the standalone path
out11=$(HOME="$T11_HOME" UM_NO_USAGE_LOG=1 env -u UM_LIB_DIR bash "$T11_BIN/um" --version 2>&1) && rc11=0 || rc11=$?
if [ "$rc11" -eq 0 ]; then
  pass "T11: um --version exits 0 without UM_LIB_DIR (standalone fallback)"
else
  fail "T11: um --version failed ($rc11): $out11"
fi
if echo "$out11" | grep -qE "[0-9]+\.[0-9]+\.[0-9]+"; then
  pass "T11: um --version prints version via standalone fallback"
else
  fail "T11: version string not printed: $out11"
fi
rm -rf "$UM_TEST_DIR11"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
