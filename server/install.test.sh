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

# ─── T1b: canonical-superset vars in managed block ───────────────────────────
# Verifies that the shared marker-block helper writes all six managed vars plus
# the PATH guard — not just UM_OPENAI_API_KEY + UM_SUMMARIZER (old format).
echo ""
echo "=== T1b: canonical-superset managed block contains all required vars ==="
T1B_BASHRC="$(cat "$T1/home/.bashrc")"
assert_contains "T1b: UM_OPENAI_API_KEY in block"  "$T1B_BASHRC" "UM_OPENAI_API_KEY"
assert_contains "T1b: UM_SUMMARIZER in block"       "$T1B_BASHRC" "UM_SUMMARIZER"
assert_contains "T1b: UM_SERVER_URL in block"       "$T1B_BASHRC" "UM_SERVER_URL"
assert_contains "T1b: UM_LIB_DIR in block"          "$T1B_BASHRC" "UM_LIB_DIR"
assert_contains "T1b: UM_CLI_DIR in block"          "$T1B_BASHRC" "UM_CLI_DIR"
assert_contains "T1b: PATH guard in block"          "$T1B_BASHRC" '.local/bin'
assert_contains "T1b: block start marker"           "$T1B_BASHRC" "universal-memory (auto-added"
assert_contains "T1b: block end marker"             "$T1B_BASHRC" "end universal-memory"

# ─── T1c: install-cli.sh first (empty key) → install.sh later (real key) ───────
# Regression for CRIT-1 / plan RH6: when install-cli.sh runs first it writes a
# marker block with an empty UM_OPENAI_API_KEY. A subsequent server install.sh
# with a real UM_OPENAI_API_KEY in env MUST overwrite the block and land the real
# key — it must not warn-and-return because the stored key is different.
echo ""
echo "=== T1c: install-cli then install.sh — real key lands in block ==="
T1C="$TMPROOT/t1c"
mkdir -p "$T1C/vault" "$T1C/plugins" "$T1C/home"
make_fakebin "$T1C/bin" 200
T1C_SH=$(make_isolated_server "$T1C/server")

# Simulate what install-cli.sh writes: marker block with empty UM_OPENAI_API_KEY
printf '\n# --- universal-memory (auto-added by install.sh) ---\nexport UM_OPENAI_API_KEY=%s\nexport UM_SUMMARIZER=%sopenai%s\n# --- end universal-memory ---\n' \
  "''" "'" "'" >> "$T1C/home/.bashrc"

T1C_EXIT=0
T1C_OUT=$(run_install "$T1C/bin" "$T1C_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-real-key999 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T1C/vault" \
  UM_OPENAI_API_KEY=sk-real-key999 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T1C/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T1C/home") || T1C_EXIT=$?

assert_exit_zero "T1c: server install exits 0 after cli install" "$T1C_EXIT"
assert_contains "T1c: real key lands in profile" "$(cat "$T1C/home/.bashrc")" "sk-real-key999"
# Exactly one block (no duplicates after rewrite)
T1C_START_COUNT=$(grep -cF "# --- universal-memory (auto-added by install.sh) ---" "$T1C/home/.bashrc")
assert_eq "T1c: exactly one marker-start line" "$T1C_START_COUNT" "1"

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
assert_contains "T2: profile block rewritten with current env" "$T2_OUT" "Managed block found in"

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

# ─── T11: picking 'skip' at install prompt preserves pre-existing plugin ──────
# Regression: previously, _install_plugin rm'd the target BEFORE the case that
# picked the action, so picking (s)kip deleted the user's installed plugin
# without installing anything. Skip must be non-destructive.
echo ""
echo "=== T11: picking 'skip' at install prompt preserves pre-existing plugin ==="
T11="$TMPROOT/t11"
mkdir -p "$T11/vault" "$T11/plugins" "$T11/home"
touch "$T11/home/.bashrc"
make_fakebin "$T11/bin" 200
T11_SH=$(make_isolated_server "$T11/server")

# Pre-install a plugin dir WITHOUT plugin.json so the version-compare block
# (needs both src_ver and target_ver non-empty) is skipped and execution
# reaches the copy/link/skip prompt directly.
mkdir -p "$T11/plugins/universal-memory"
echo "user-customized content" > "$T11/plugins/universal-memory/CUSTOM.txt"

# Run interactively (no UM_NONINTERACTIVE), feeding two lines on stdin:
#   's'  -> skip at the plugin copy/link/skip prompt
#   'N'  -> decline profile-append prompt (orthogonal to this test)
T11_EXIT=0
T11_OUT=$(printf 's\nN\n' | env PATH="$T11/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T11/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T11/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T11/home" \
  bash "$T11_SH" 2>&1) || T11_EXIT=$?

assert_exit_zero "T11: install exits 0 when user picks skip" "$T11_EXIT"
assert_contains "T11: skip message shown at plugin prompt" "$T11_OUT" "install manually"
# The bug: without the fix, the unconditional rm at lines 465-469 deletes the
# existing target before the case chooses 'skip', so CUSTOM.txt is gone.
assert_file_exists "T11: pre-existing plugin content preserved on skip" "$T11/plugins/universal-memory/CUSTOM.txt"

# ─── T14: plugin install copies rubric to target ─────────────────────────────
echo ""
echo "=== T14: plugin install copies rubric.md to target ==="
T14="$TMPROOT/t14"
mkdir -p "$T14/vault" "$T14/plugins" "$T14/home"
touch "$T14/home/.bashrc"
make_fakebin "$T14/bin" 200
T14_SH=$(make_isolated_server "$T14/server")

T14_EXIT=0
T14_OUT=$(env PATH="$T14/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T14/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T14/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T14/home" \
  UM_NONINTERACTIVE=1 \
  bash "$T14_SH" 2>&1) || T14_EXIT=$?

assert_exit_zero "T14: install exits 0" "$T14_EXIT"
assert_file_exists "T14: rubric.md copied to installed plugin" "$T14/plugins/universal-memory/rubric.md"

# ─── T15: symlink mode must not pollute repo source tree with rubric.md ──────
# Review fix: previously _install_plugin called _copy_rubric_to_target after
# a successful ln -s, which resolved through the symlink and wrote
# rubric.md into the repo source tree (appearing as untracked in git status
# for every dev running install.sh --link). The fix skips that copy in the
# symlink success branch because session-start.sh's canonical-path lookup
# resolves correctly through the symlink anyway.
echo ""
echo "=== T15: symlink mode does not create rubric.md in the repo source tree ==="
T15="$TMPROOT/t15"
mkdir -p "$T15/vault" "$T15/plugins" "$T15/home"
touch "$T15/home/.bashrc"
make_fakebin "$T15/bin" 200

# We must NOT modify the real repo, so copy the plugin source into an
# isolated location and point _UM_REPO_ROOT at a fake repo root whose
# plugins/claude-code/universal-memory mirrors the real one. We also need
# a docs/ dir with the rubric so _copy_rubric_to_target would find source.
T15_REPO="$T15/repo"
mkdir -p "$T15_REPO/docs" "$T15_REPO/plugins/claude-code" "$T15_REPO/installer/lib"
cp "$REPO_ROOT/docs/memory-routing-rubric.md" "$T15_REPO/docs/memory-routing-rubric.md"
cp -r "$PLUGIN_SRC" "$T15_REPO/plugins/claude-code/universal-memory"
cp "$REPO_ROOT/installer/lib/marker-block.sh" "$T15_REPO/installer/lib/marker-block.sh"
T15_SRC_PLUGIN="$T15_REPO/plugins/claude-code/universal-memory"

# Copy install.sh + helpers into isolated server dir, but REPO_ROOT points
# at the fake repo so symlink resolution ends up at $T15_SRC_PLUGIN.
T15_SH=$(make_isolated_server "$T15/server")

T15_EXIT=0
# Feed 'l' to select link at the copy/link/skip prompt, then 'N' to decline
# the profile append prompt (orthogonal to this test).
T15_OUT=$(printf 'l\nN\n' | env PATH="$T15/bin:$PATH" \
  _UM_REPO_ROOT="$T15_REPO" \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T15/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T15/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T15/home" \
  bash "$T15_SH" 2>&1) || T15_EXIT=$?

assert_exit_zero "T15: install exits 0 in link mode" "$T15_EXIT"

# Core invariant: the repo source tree must NEVER contain rubric.md after
# a --link install, regardless of whether ln -s creates a real symlink
# (Unix / Windows Developer Mode) or silently falls back to a plain copy
# (Windows Git Bash emulates ln -s differently on different versions).
# Before the fix, the symlink-success branch wrote rubric.md into $target,
# which resolved through the symlink into $T15_SRC_PLUGIN. After the fix,
# only the cp -r fallback branch copies — and that branch writes into the
# real directory at $target, never into the source tree.
if [ -f "$T15_SRC_PLUGIN/rubric.md" ]; then
  fail_test "T15: repo source tree clean after --link install" \
    "$T15_SRC_PLUGIN/rubric.md exists — symlink mode polluted the repo"
else
  pass "T15: repo source tree has no stray rubric.md after --link"
fi

# ─── T16: UM_SUMMARIZER auto-detect — claude absent → openai ────────────────
# A4: when `claude` CLI is not in PATH, install.sh writes UM_SUMMARIZER=openai
# to the profile alongside UM_OPENAI_API_KEY in the same marker block.
echo ""
echo "=== T16: UM_SUMMARIZER=openai written when claude CLI absent ==="
T16="$TMPROOT/t16"
mkdir -p "$T16/vault" "$T16/plugins" "$T16/home"
touch "$T16/home/.bashrc"
# make_fakebin deliberately does NOT include a fake `claude` → PATH has no claude.
make_fakebin "$T16/bin" 200
T16_SH=$(make_isolated_server "$T16/server")

T16_EXIT=0
# Build a PATH that contains ONLY our fakebin (so real `claude` on the host
# cannot leak in and flip the detection branch). Include a minimal set of
# coreutils paths so `bash`, `python3`, `mkdir`, etc. still resolve.
T16_PATH="$T16/bin:/usr/bin:/bin"
T16_OUT=$(env -i PATH="$T16_PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T16/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T16/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T16/home" \
  bash "$T16_SH" 2>&1) || T16_EXIT=$?

assert_exit_zero "T16: install exits 0 with claude absent" "$T16_EXIT"
assert_contains "T16: detection message for claude absent" "$T16_OUT" "Claude CLI not detected"
assert_contains "T16: UM_SUMMARIZER=openai in profile" "$(cat "$T16/home/.bashrc")" "export UM_SUMMARIZER='openai'"
assert_contains "T16: UM_OPENAI_API_KEY also in profile" "$(cat "$T16/home/.bashrc")" "export UM_OPENAI_API_KEY"
assert_contains "T16: UM_SUMMARIZER inside marker block" "$(cat "$T16/home/.bashrc")" "universal-memory (auto-added"

# ─── T17: UM_SUMMARIZER auto-detect — claude present → claude-agent-sdk ─────
# A4: when a `claude` CLI is in PATH, install.sh writes UM_SUMMARIZER=claude-agent-sdk.
echo ""
echo "=== T17: UM_SUMMARIZER=claude-agent-sdk written when claude CLI present ==="
T17="$TMPROOT/t17"
mkdir -p "$T17/vault" "$T17/plugins" "$T17/home"
touch "$T17/home/.bashrc"
make_fakebin "$T17/bin" 200
# Add a fake `claude` to the fakebin so `command -v claude` succeeds.
cat > "$T17/bin/claude" <<'FAKE'
#!/usr/bin/env bash
# fake claude CLI for T17 — detection-only, never invoked during install.
exit 0
FAKE
chmod +x "$T17/bin/claude"
T17_SH=$(make_isolated_server "$T17/server")

T17_EXIT=0
# Pin PATH to fakebin + minimal coreutils so detection sees our fake claude.
T17_PATH="$T17/bin:/usr/bin:/bin"
T17_OUT=$(env -i PATH="$T17_PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T17/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T17/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T17/home" \
  bash "$T17_SH" 2>&1) || T17_EXIT=$?

assert_exit_zero "T17: install exits 0 with fake claude in PATH" "$T17_EXIT"
assert_contains "T17: detection message for claude present" "$T17_OUT" "Claude CLI detected"
assert_contains "T17: UM_SUMMARIZER=claude-agent-sdk in profile" "$(cat "$T17/home/.bashrc")" "export UM_SUMMARIZER='claude-agent-sdk'"

# ─── T18: v0.2.0-alpha → v0.2.1 re-install backfills UM_SUMMARIZER ──────────
# Cross-cutting review C1: a user upgrading from v0.2.0-alpha has a marker
# block that pre-dates UM_SUMMARIZER. Re-running install.sh must backfill
# the missing var, not silently skip it. The fix declaratively rewrites
# the whole managed block on every run when the key matches.
echo ""
echo "=== T18: re-install backfills UM_SUMMARIZER into legacy marker block ==="
T18="$TMPROOT/t18"
mkdir -p "$T18/vault" "$T18/plugins" "$T18/home"
make_fakebin "$T18/bin" 200
# Add a fake `claude` so install.sh auto-detects claude-agent-sdk.
cat > "$T18/bin/claude" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$T18/bin/claude"
T18_SH=$(make_isolated_server "$T18/server")

# Pre-populate profile with a legacy v0.2.0-alpha marker block containing
# ONLY UM_OPENAI_API_KEY (no UM_SUMMARIZER) — this is what an existing
# alpha user's .bashrc looks like before they upgrade.
{
  printf 'export PATH=/usr/local/bin:$PATH\n'
  printf '\n'
  printf '# --- universal-memory (auto-added by install.sh) ---\n'
  printf "export UM_OPENAI_API_KEY='sk-testkey12345'\n"
  printf '# --- end universal-memory ---\n'
  printf '\n'
  printf '# user-added content below\n'
  printf 'alias ll="ls -la"\n'
} > "$T18/home/.bashrc"

T18_EXIT=0
# Pin PATH so detection sees our fake claude.
T18_PATH="$T18/bin:/usr/bin:/bin"
T18_OUT=$(env -i PATH="$T18_PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T18/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T18/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T18/home" \
  bash "$T18_SH" 2>&1) || T18_EXIT=$?

assert_exit_zero "T18: upgrade re-install exits 0" "$T18_EXIT"
T18_BASHRC=$(cat "$T18/home/.bashrc")
# Block was refreshed, so both managed vars must now be present.
assert_contains "T18: UM_OPENAI_API_KEY still present after upgrade" "$T18_BASHRC" "export UM_OPENAI_API_KEY='sk-testkey12345'"
assert_contains "T18: UM_SUMMARIZER backfilled after upgrade" "$T18_BASHRC" "export UM_SUMMARIZER='claude-agent-sdk'"
# Exactly one marker block (no duplicates).
T18_START_COUNT=$(grep -cF "# --- universal-memory (auto-added by install.sh) ---" "$T18/home/.bashrc")
T18_END_COUNT=$(grep -cF "# --- end universal-memory ---" "$T18/home/.bashrc")
assert_eq "T18: exactly one marker-start line" "$T18_START_COUNT" "1"
assert_eq "T18: exactly one marker-end line" "$T18_END_COUNT" "1"
# User-added content (outside the block) survives the rewrite.
assert_contains "T18: user-added PATH line preserved" "$T18_BASHRC" "export PATH=/usr/local/bin:\$PATH"
assert_contains "T18: user-added alias preserved" "$T18_BASHRC" 'alias ll="ls -la"'
# Running install a THIRD time must remain idempotent — no duplicate blocks.
T18B_EXIT=0
T18B_OUT=$(env -i PATH="$T18_PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T18/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T18/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T18/home" \
  bash "$T18_SH" 2>&1) || T18B_EXIT=$?
assert_exit_zero "T18: third run (idempotency) exits 0" "$T18B_EXIT"
T18_START_COUNT2=$(grep -cF "# --- universal-memory (auto-added by install.sh) ---" "$T18/home/.bashrc")
T18_END_COUNT2=$(grep -cF "# --- end universal-memory ---" "$T18/home/.bashrc")
assert_eq "T18: still exactly one marker-start after third run" "$T18_START_COUNT2" "1"
assert_eq "T18: still exactly one marker-end after third run" "$T18_END_COUNT2" "1"
# Regression: v0.4.0-alpha marker-block.sh prepended '\n' on every run without
# stripping the preceding blank line from prior runs → unbounded bashrc growth.
# Run a fourth time and assert no line-count growth between runs 3 and 4.
T18_LINES_3=$(wc -l < "$T18/home/.bashrc")
T18C_EXIT=0
T18C_OUT=$(env -i PATH="$T18_PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T18/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T18/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T18/home" \
  bash "$T18_SH" 2>&1) || T18C_EXIT=$?
assert_exit_zero "T18: fourth run (idempotency) exits 0" "$T18C_EXIT"
T18_LINES_4=$(wc -l < "$T18/home/.bashrc")
assert_eq "T18: bashrc line count stable between run 3 and run 4" "$T18_LINES_4" "$T18_LINES_3"

# ─── T12: --yes non-interactive with all defaults ─────────────────────────────
# B3: a single `--yes`/`-y` flag should accept every default (vault path,
# plugin copy, shell profile append) without prompting and without requiring
# UM_NONINTERACTIVE=1 to be set manually.
echo ""
echo "=== T12: --yes accepts all defaults ==="
T12="$TMPROOT/t12"
mkdir -p "$T12/vault" "$T12/plugins" "$T12/home"
touch "$T12/home/.bashrc"
make_fakebin "$T12/bin" 200
T12_SH=$(make_isolated_server "$T12/server")

T12_EXIT=0
T12_OUT=$(env PATH="$T12/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T12/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T12/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T12/home" \
  bash "$T12_SH" --yes 2>&1) || T12_EXIT=$?

assert_exit_zero "T12: --yes exits 0" "$T12_EXIT"
assert_contains "T12: plugin copied message" "$T12_OUT" "Plugin copied"
assert_file_exists "T12: plugin installed to default target" "$T12/plugins/universal-memory/.claude-plugin/plugin.json"
if grep -q "UM_OPENAI_API_KEY" "$T12/home/.bashrc" 2>/dev/null; then
  pass "T12: UM_OPENAI_API_KEY written to .bashrc"
else
  fail_test "T12: .bashrc missing UM_OPENAI_API_KEY" ".bashrc content: $(cat "$T12/home/.bashrc" 2>/dev/null)"
fi
if grep -q "UM_SUMMARIZER" "$T12/home/.bashrc" 2>/dev/null; then
  pass "T12: UM_SUMMARIZER written to .bashrc"
else
  fail_test "T12: .bashrc missing UM_SUMMARIZER" ".bashrc content: $(cat "$T12/home/.bashrc" 2>/dev/null)"
fi

# ─── T12b: --yes with NO key and NO claude CLI — proceeds with warning ─────────
# B3: when OPENAI_API_KEY is absent and `claude` is not on PATH, --yes must
# still complete (exit 0), warn the user that summaries are disabled, and
# write UM_SUMMARIZER=openai as the fallback default so a later key-set can
# re-enable summaries without re-running install.sh.
echo ""
echo "=== T12b: --yes without key still completes with warning ==="
T12B="$TMPROOT/t12b"
mkdir -p "$T12B/vault" "$T12B/plugins" "$T12B/home" "$T12B/empty-bin"
touch "$T12B/home/.bashrc"
# Pin PATH to empty-bin + minimal sys so `claude` is NOT findable.
# We still need fake tools (docker, python3, curl), so populate empty-bin
# with the standard fakebin — make_fakebin does NOT install a fake `claude`.
make_fakebin "$T12B/empty-bin" 200
# Belt-and-suspenders: ensure no `claude` snuck in.
rm -f "$T12B/empty-bin/claude"
T12B_SH=$(make_isolated_server "$T12B/server")

T12B_EXIT=0
# env -i scrubs inherited env (no host PATH, no host OPENAI_API_KEY leakage).
T12B_OUT=$(env -i PATH="$T12B/empty-bin:/usr/bin:/bin" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T12B/vault" \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T12B/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T12B/home" \
  bash "$T12B_SH" --yes 2>&1) || T12B_EXIT=$?

assert_exit_zero "T12b: --yes without key exits 0" "$T12B_EXIT"
assert_contains "T12b: warning about skipped summaries" "$T12B_OUT" "summaries will be skipped"
if grep -q "UM_SUMMARIZER='openai'" "$T12B/home/.bashrc" 2>/dev/null \
   || grep -q "UM_SUMMARIZER=openai" "$T12B/home/.bashrc" 2>/dev/null; then
  pass "T12b: UM_SUMMARIZER=openai written (no claude CLI)"
else
  fail_test "T12b: .bashrc missing UM_SUMMARIZER=openai" ".bashrc content: $(cat "$T12B/home/.bashrc" 2>/dev/null)"
fi

# ─── T13: Codex detected → Codex plugin installed ────────────────────────────
# v0.3 Phase E: install.sh auto-detects a Codex CLI install by the presence of
# ~/.codex and drops plugins/codex/universal-memory into ~/.codex/plugins/.
# Install is idempotent and config-only (no hooks — v0.4 boundary).
echo ""
echo "=== T13: Codex detected → Codex plugin installed ==="
T13="$TMPROOT/t13"
mkdir -p "$T13/vault" "$T13/plugins" "$T13/home" "$T13/home/.codex"
touch "$T13/home/.bashrc"
make_fakebin "$T13/bin" 200
T13_SH=$(make_isolated_server "$T13/server")

T13_EXIT=0
T13_OUT=$(run_install "$T13/bin" "$T13_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T13/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T13/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T13/home") || T13_EXIT=$?

assert_exit_zero "T13: install exits 0 when Codex present" "$T13_EXIT"
assert_contains "T13: Codex detection message in output" "$T13_OUT" "Codex CLI detected"
assert_file_exists "T13: Codex plugin dir created" "$T13/home/.codex/plugins/universal-memory"
assert_file_exists "T13: Codex plugin manifest landed" "$T13/home/.codex/plugins/universal-memory/.codex-plugin/plugin.json"
assert_file_exists "T13: Codex .mcp.json landed" "$T13/home/.codex/plugins/universal-memory/.mcp.json"
assert_file_exists "T13: Codex plugin README landed" "$T13/home/.codex/plugins/universal-memory/README.md"
# Idempotency: a second run with the same version should report "already installed".
T13B_EXIT=0
T13B_OUT=$(run_install "$T13/bin" "$T13_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T13/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T13/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T13/home") || T13B_EXIT=$?
assert_exit_zero "T13: second run (idempotency) exits 0" "$T13B_EXIT"
assert_contains "T13: second run reports already installed" "$T13B_OUT" "already installed"

# ─── T19: Codex absent → Codex plugin skipped (silent, does not fail install) ─
# Original spec called this T14, but T14 is already used for the CC rubric copy.
# Using T19 (next available) to preserve the unrelated T14 semantics.
echo ""
echo "=== T19: Codex absent → Codex plugin skip path (does not fail install) ==="
T19="$TMPROOT/t19"
mkdir -p "$T19/vault" "$T19/plugins" "$T19/home"  # no .codex dir
touch "$T19/home/.bashrc"
make_fakebin "$T19/bin" 200
T19_SH=$(make_isolated_server "$T19/server")

T19_EXIT=0
T19_OUT=$(run_install "$T19/bin" "$T19_SH" \
  UM_NONINTERACTIVE=1 \
  OPENAI_API_KEY=sk-testkey12345 \
  MEM0_USER_ID=testuser \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T19/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  UM_SUMMARY_ENABLED=true \
  UM_TEMPORAL_DECAY=false \
  CLAUDE_PLUGINS_DIR="$T19/plugins" \
  UM_SKIP_KEY_VALIDATION=1 \
  SHELL=/bin/bash \
  HOME="$T19/home") || T19_EXIT=$?

assert_exit_zero "T19: install exits 0 when Codex absent" "$T19_EXIT"
assert_contains "T19: skip message for absent Codex" "$T19_OUT" "Codex CLI not detected"
# The Codex plugin dir must NOT have been created — the whole point of the skip.
if [ ! -e "$T19/home/.codex" ]; then
  pass "T19: ~/.codex not created when Codex absent"
else
  fail_test "T19: ~/.codex unexpectedly created" "$(ls -la "$T19/home/.codex" 2>/dev/null)"
fi

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
