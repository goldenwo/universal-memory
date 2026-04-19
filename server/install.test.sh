#!/usr/bin/env bash
# install.test.sh — unit/integration tests for install.sh helpers
# Run: bash server/install.test.sh
#
# Uses PATH-override pattern: fake binaries (docker, curl, python3) are placed
# in a temp dir ahead of real PATH so tests run offline with no side-effects.
# Each test gets an isolated copy of install.sh + required server files so the
# real server/.env is never touched.
#
# Tests exercise:
#   - Fresh-install path (no plugin, no profile entry, new env)
#   - Re-install path (plugin already exists; profile entry present)
#   - Non-interactive path (UM_NONINTERACTIVE=1)
#   - --verify path on a healthy install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")"
INSTALL_SH="$SCRIPT_DIR/install.sh"
PLUGIN_SRC="$REPO_ROOT/plugins/claude-code/universal-memory"

# ─── Test harness ─────────────────────────────────────────────────────────────
PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail_test() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s — %s\n' "$1" "${2:-}"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"; else fail_test "$name" "got='$got', want='$want'"; fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"; else fail_test "$name" "expected to contain '$needle'"; fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$name"; else fail_test "$name" "should NOT contain '$needle'"; fi
}

assert_file_exists() {
  local name="$1" file="$2"
  if [ -e "$file" ]; then pass "$name"; else fail_test "$name" "file not found: $file"; fi
}

assert_exit_zero() {
  local name="$1" code="$2"
  if [ "$code" -eq 0 ]; then pass "$name"; else fail_test "$name" "exit code $code (expected 0)"; fi
}

assert_exit_nonzero() {
  local name="$1" code="$2"
  if [ "$code" -ne 0 ]; then pass "$name"; else fail_test "$name" "exit code 0 (expected non-zero)"; fi
}

# ─── Temp root ───────────────────────────────────────────────────────────────
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# ─── Helpers ─────────────────────────────────────────────────────────────────

# make_fakebin <dest_dir> <openai_http_status>
# Creates docker/curl/python3 fakes that work offline.
make_fakebin() {
  local dest="$1"
  local openai_status="${2:-200}"
  mkdir -p "$dest"

  # fake docker — matches regardless of -f flag position
  cat > "$dest/docker" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"compose version"* ]]; then echo "Docker Compose version v2.27.0"; exit 0; fi
if [[ "$args" == "info"* ]] || [[ "$args" == *" info"* ]]; then echo "{}"; exit 0; fi
if [[ "$args" == *"ps"* ]]; then
  echo "NAME            STATUS"
  echo "memory-server   Up 2 hours"
  exit 0
fi
exit 0
FAKE
  chmod +x "$dest/docker"

  # fake curl — handles: OpenAI probe (with -w for http_code), health endpoint, other calls
  cat > "$dest/curl" <<FAKE
#!/usr/bin/env bash
args="\$*"
if [[ "\$args" == *"openai.com"* ]]; then
  if [[ "\$args" == *"-w"* ]]; then printf '${openai_status}'; fi
  exit 0
fi
if [[ "\$args" == *"/health"* ]]; then
  printf '{"status":"ok"}'
  exit 0
fi
exit 0
FAKE
  chmod +x "$dest/curl"

  # fake python3 — succeeds for 'import yaml'
  cat > "$dest/python3" <<'FAKE'
#!/usr/bin/env bash
[[ "$*" == *"import yaml"* ]] && exit 0
exec /usr/bin/python3 "$@" 2>/dev/null || exit 0
FAKE
  chmod +x "$dest/python3"
}

# make_isolated_server <dest_dir>
# Copies install.sh + required server files to an isolated dir so the real
# server/.env is never touched by tests.
make_isolated_server() {
  local dest="$1"
  mkdir -p "$dest"
  cp "$INSTALL_SH" "$dest/install.sh"
  cp "$SCRIPT_DIR/.env.example" "$dest/.env.example" 2>/dev/null || true
  cp "$SCRIPT_DIR/docker-compose.yml" "$dest/docker-compose.yml" 2>/dev/null || true
  echo "$dest/install.sh"
}

# run_install <fakebin_dir> <isolated_sh> [env_var=val ...]
# Run the isolated install.sh with fake PATH injected and REPO_ROOT pinned.
run_install() {
  local fakebin="$1" isolated_sh="$2"; shift 2
  env PATH="$fakebin:$PATH" _UM_REPO_ROOT="$REPO_ROOT" "$@" bash "$isolated_sh" 2>&1
}

# ─── T1: Fresh install — plugin copy, profile append ─────────────────────────
echo ""
echo "=== T1: Fresh install (no plugin, no profile entry) ==="
T1="$TMPROOT/t1"
mkdir -p "$T1/vault" "$T1/plugins" "$T1/home"
touch "$T1/home/.bashrc"
make_fakebin "$T1/bin" 200
T1_SH=$(make_isolated_server "$T1/server")

T1_EXIT=0
T1_OUT=$(run_install "$T1/bin" "$T1_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T1/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T1/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T1/home") || T1_EXIT=$?

assert_exit_zero "T1: install exits 0" "$T1_EXIT"
assert_file_exists "T1: plugin directory created" "$T1/plugins/universal-memory"
assert_file_exists "T1: plugin.json present inside install" "$T1/plugins/universal-memory/.claude-plugin/plugin.json"
assert_contains "T1: plugin install message in output" "$T1_OUT" "Plugin copied"
assert_file_exists "T1: vault dir created" "$T1/vault"
assert_contains "T1: UM_OPENAI_API_KEY appended to profile" "$(cat "$T1/home/.bashrc")" "UM_OPENAI_API_KEY"
assert_contains "T1: marker block present in profile" "$(cat "$T1/home/.bashrc")" "universal-memory (auto-added"
assert_contains "T1: banner says restart CC" "$T1_OUT" "Restart Claude Code"
assert_contains "T1: banner says source profile" "$T1_OUT" "source"

# ─── T2: Re-install — same version plugin already installed ───────────────────
echo ""
echo "=== T2: Re-install (plugin same version, profile entry already present) ==="
T2="$TMPROOT/t2"
mkdir -p "$T2/vault" "$T2/plugins" "$T2/home"
touch "$T2/home/.bashrc"
make_fakebin "$T2/bin" 200
T2_SH=$(make_isolated_server "$T2/server")

# Pre-install: copy plugin once
cp -r "$PLUGIN_SRC" "$T2/plugins/universal-memory"

# Pre-populate profile with matching key
printf '\n# --- universal-memory (auto-added by install.sh) ---\nexport UM_OPENAI_API_KEY='"'"'sk-testkey12345'"'"'\n# --- end universal-memory ---\n' >> "$T2/home/.bashrc"

T2_EXIT=0
T2_OUT=$(run_install "$T2/bin" "$T2_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T2/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T2/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T2/home") || T2_EXIT=$?

assert_exit_zero "T2: re-install exits 0" "$T2_EXIT"
assert_contains "T2: skip message for same-version plugin" "$T2_OUT" "already installed"
assert_contains "T2: skip message for matching profile key" "$T2_OUT" "matching value"

# ─── T3: Non-interactive mode ─────────────────────────────────────────────────
echo ""
echo "=== T3: Non-interactive mode (UM_NONINTERACTIVE=1) ==="
T3="$TMPROOT/t3"
mkdir -p "$T3/vault" "$T3/plugins" "$T3/home"
touch "$T3/home/.bashrc"
make_fakebin "$T3/bin" 200
T3_SH=$(make_isolated_server "$T3/server")

T3_EXIT=0
T3_OUT=$(run_install "$T3/bin" "$T3_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T3/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T3/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T3/home") || T3_EXIT=$?

assert_exit_zero "T3: non-interactive exits 0" "$T3_EXIT"
assert_contains "T3: non-interactive mode message" "$T3_OUT" "Non-interactive mode"
assert_file_exists "T3: plugin installed non-interactively" "$T3/plugins/universal-memory"
assert_contains "T3: profile updated non-interactively" "$(cat "$T3/home/.bashrc")" "UM_OPENAI_API_KEY"

# ─── T4: Bad API key → fail in non-interactive mode ──────────────────────────
echo ""
echo "=== T4: Bad API key (401) fails in UM_NONINTERACTIVE mode ==="
T4="$TMPROOT/t4"
mkdir -p "$T4/vault" "$T4/plugins" "$T4/home"
touch "$T4/home/.bashrc"
make_fakebin "$T4/bin" 401  # simulate 401
T4_SH=$(make_isolated_server "$T4/server")

T4_EXIT=0
T4_OUT=$(run_install "$T4/bin" "$T4_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-badkey \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T4/vault" \
  UM_OPENAI_API_KEY=sk-badkey \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T4/plugins" \
  SHELL=/bin/bash \
  HOME="$T4/home") || T4_EXIT=$?

assert_exit_nonzero "T4: non-interactive fails on 401" "$T4_EXIT"
assert_contains "T4: 401 error message shown" "$T4_OUT" "401"

# ─── T5: Key validation skipped when UM_SKIP_KEY_VALIDATION=1 ────────────────
echo ""
echo "=== T5: Key validation skipped via UM_SKIP_KEY_VALIDATION=1 ==="
T5="$TMPROOT/t5"
mkdir -p "$T5/vault" "$T5/plugins" "$T5/home"
touch "$T5/home/.bashrc"
make_fakebin "$T5/bin" 401  # would fail if validation ran
T5_SH=$(make_isolated_server "$T5/server")

T5_EXIT=0
T5_OUT=$(run_install "$T5/bin" "$T5_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T5/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T5/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T5/home") || T5_EXIT=$?

assert_exit_zero "T5: install succeeds when validation skipped" "$T5_EXIT"
assert_contains "T5: skip-validation message shown" "$T5_OUT" "UM_SKIP_KEY_VALIDATION=1"

# ─── T6: --verify on a healthy install ───────────────────────────────────────
echo ""
echo "=== T6: --verify on a healthy install ==="
T6="$TMPROOT/t6"
mkdir -p "$T6/vault" "$T6/plugins" "$T6/home"
touch "$T6/home/.bashrc"
make_fakebin "$T6/bin" 200
T6_SH=$(make_isolated_server "$T6/server")

# Pre-install plugin
cp -r "$PLUGIN_SRC" "$T6/plugins/universal-memory"

T6_EXIT=0
T6_OUT=$(env PATH="$T6/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T6/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T6/plugins" \
  HOME="$T6/home" \
  bash "$T6_SH" --verify 2>&1) || T6_EXIT=$?

assert_exit_zero "T6: --verify exits 0 on healthy install" "$T6_EXIT"
assert_contains "T6: docker-up check passes" "$T6_OUT" "docker-up"
assert_contains "T6: plugin-registered check passes" "$T6_OUT" "plugin-registered"
assert_contains "T6: hook-smoke check passes" "$T6_OUT" "hook-smoke"
assert_contains "T6: session-end-dry-run check passes" "$T6_OUT" "session-end-dry-run"
assert_contains "T6: cleanup passes" "$T6_OUT" "cleanup"
assert_contains "T6: all checks passed message" "$T6_OUT" "All checks passed"

# ─── T7: --verify fails when plugin missing ───────────────────────────────────
echo ""
echo "=== T7: --verify fails when plugin not installed ==="
T7="$TMPROOT/t7"
mkdir -p "$T7/vault" "$T7/plugins" "$T7/home"
make_fakebin "$T7/bin" 200
T7_SH=$(make_isolated_server "$T7/server")

T7_EXIT=0
T7_OUT=$(env PATH="$T7/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T7/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T7/plugins" \
  HOME="$T7/home" \
  bash "$T7_SH" --verify 2>&1) || T7_EXIT=$?

assert_exit_nonzero "T7: --verify exits non-zero when plugin missing" "$T7_EXIT"
assert_contains "T7: plugin-registered failure shown" "$T7_OUT" "plugin-registered"

# ─── T8: Profile with different value → warns, does not overwrite ─────────────
echo ""
echo "=== T8: Profile already has different UM_OPENAI_API_KEY value ==="
T8="$TMPROOT/t8"
mkdir -p "$T8/vault" "$T8/plugins" "$T8/home"
make_fakebin "$T8/bin" 200
T8_SH=$(make_isolated_server "$T8/server")

# Write a profile with a DIFFERENT key
printf 'export UM_OPENAI_API_KEY=sk-different-key\n' > "$T8/home/.bashrc"

T8_EXIT=0
T8_OUT=$(run_install "$T8/bin" "$T8_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T8/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T8/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T8/home") || T8_EXIT=$?

assert_exit_zero "T8: install still exits 0 despite profile conflict" "$T8_EXIT"
assert_contains "T8: warn about different value" "$T8_OUT" "different value"
# Profile should still contain only the original key (not appended with new one)
assert_not_contains "T8: profile not overwritten" "$(cat "$T8/home/.bashrc")" "sk-testkey12345"

# ─── T9: C1 — stale symlink at plugin target is replaced, not corrupted ───────
echo ""
echo "=== T9: C1 — stale symlink replaced (not written into symlink target) ==="
T9="$TMPROOT/t9"
mkdir -p "$T9/vault" "$T9/plugins" "$T9/home" "$T9/elsewhere"
touch "$T9/home/.bashrc"
make_fakebin "$T9/bin" 200
T9_SH=$(make_isolated_server "$T9/server")

# Create a stale symlink pointing at $T9/elsewhere (not the plugin src)
ln -s "$T9/elsewhere" "$T9/plugins/universal-memory"

T9_EXIT=0
T9_OUT=$(run_install "$T9/bin" "$T9_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T9/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T9/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T9/home") || T9_EXIT=$?

assert_exit_zero "T9: install exits 0 over stale symlink" "$T9_EXIT"
# Plugin should now be a real directory (or symlink to correct src), not a symlink to $T9/elsewhere
T9_LINK_DEST=$(readlink "$T9/plugins/universal-memory" 2>/dev/null || true)
if [ -L "$T9/plugins/universal-memory" ]; then
  # It's a symlink — must point at plugin src, NOT the old stale target
  assert_not_contains "T9: stale symlink target not written into" "$T9_LINK_DEST" "$T9/elsewhere"
else
  # It's a real directory — also correct
  assert_file_exists "T9: plugin installed as directory over stale symlink" "$T9/plugins/universal-memory"
fi
# $T9/elsewhere must be empty — no files were written into it
T9_ELSEWHERE_COUNT=$(ls "$T9/elsewhere" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "T9: stale symlink target not corrupted" "$T9_ELSEWHERE_COUNT" "0"

# ─── T10: C2 — malformed .env line does not crash --verify ────────────────────
echo ""
echo "=== T10: C2 — malformed .env key is skipped, --verify continues ==="
T10="$TMPROOT/t10"
mkdir -p "$T10/vault" "$T10/plugins" "$T10/home"
make_fakebin "$T10/bin" 200
T10_SH=$(make_isolated_server "$T10/server")

# Pre-install plugin so plugin-registered passes
cp -r "$PLUGIN_SRC" "$T10/plugins/universal-memory"

# Write a .env file with one malformed line (key with a space)
{
  printf 'UM_VAULT_DIR=%s\n' "$T10/vault"
  printf 'INVALID KEY=should-be-skipped\n'
  printf 'UM_OPENAI_API_KEY=sk-testkey12345\n'
} > "$T10/server/.env"

T10_EXIT=0
T10_OUT=$(env PATH="$T10/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T10/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T10/plugins" \
  HOME="$T10/home" \
  bash "$T10_SH" --verify 2>&1) || T10_EXIT=$?

assert_exit_zero "T10: --verify exits 0 despite malformed .env line" "$T10_EXIT"
assert_contains "T10: malformed key warning shown" "$T10_OUT" "malformed .env line"
assert_contains "T10: all checks still pass" "$T10_OUT" "All checks passed"

# ─── Summary ──────────────────────────────────────────────────────────────────
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
