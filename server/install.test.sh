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

# Pre-push hooks (and similar git-invoked contexts) export GIT_DIR/GIT_WORK_TREE
# pointing at the parent repo's .git, which makes `git rev-parse --show-toplevel`
# resolve to the parent worktree root rather than THIS worktree's root —
# breaking PLUGIN_SRC path (gets server/plugins/... instead of plugins/...).
# Unset so git computes paths from CWD only. Caught by v0.7 FIN gate.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"
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
# v2 hook wire contract (#159): the hooks call /api/* with
# -w '\n__UM_HTTP_CODE__%{http_code}' and parse the sentinel out of stdout.
# A healthy fake server answers 200 in that shape.
if [[ "\$args" == *"/api/"* ]]; then
  printf '{"ok":true}\n__UM_HTTP_CODE__200'
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
run_install "$T1C/bin" "$T1C_SH" \
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
  HOME="$T1C/home" >/dev/null || T1C_EXIT=$?

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

# ─── T6b: --verify fails with flag-naming hint when server has writes disabled ─
echo ""
echo "=== T6b: --verify names UM_MCP_WRITE_ENABLED when writes are disabled ==="
T6B="$TMPROOT/t6b"
mkdir -p "$T6B/vault" "$T6B/plugins" "$T6B/home"
touch "$T6B/home/.bashrc"
make_fakebin "$T6B/bin" 200
T6B_SH=$(make_isolated_server "$T6B/server")
cp -r "$PLUGIN_SRC" "$T6B/plugins/universal-memory"

# Stock read-only server: /api/* answers 403 (writes disabled); /health still 200.
cat > "$T6B/bin/curl" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/health"* ]]; then
  printf '{"status":"ok"}'
  exit 0
fi
if [[ "$args" == *"/api/"* ]]; then
  printf '{"error":"WRITES_DISABLED"}\n__UM_HTTP_CODE__403'
  exit 0
fi
exit 0
FAKE
chmod +x "$T6B/bin/curl"

T6B_EXIT=0
T6B_OUT=$(env PATH="$T6B/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T6B/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T6B/plugins" \
  HOME="$T6B/home" \
  bash "$T6B_SH" --verify 2>&1) || T6B_EXIT=$?

assert_exit_nonzero "T6b: --verify exits non-zero when writes disabled" "$T6B_EXIT"
assert_contains "T6b: hint names the write flags" "$T6B_OUT" "UM_MCP_WRITE_ENABLED=true + UM_MOUNT_MODE=rw"
assert_not_contains "T6b: no wrong token prescription" "$T6B_OUT" "Check server/token."

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
run_install "$T9/bin" "$T9_SH" \
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
  HOME="$T9/home" >/dev/null || T9_EXIT=$?

assert_exit_zero "T9: install exits 0 over stale symlink" "$T9_EXIT"
# v0.5 contract: server/install.sh no longer handles plugin copy (delegated
# to installer/install-plugin-cc.sh post-commit 881f229), so the plugin
# symlink at $T9/plugins/universal-memory is untouched by this script. The
# invariant we still enforce here is that install.sh did not write anything
# into the stale symlink's target directory ($T9/elsewhere) — i.e. no code
# path in server-only install accidentally traverses a plugin-dir symlink.
# The stale-symlink replacement behavior moved to install-plugin-cc.sh and
# is tracked as an install-plugin-cc.test.sh coverage gap for v0.6.
T9_ELSEWHERE_COUNT=$(find "$T9/elsewhere" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
assert_eq "T9: stale symlink target not corrupted by server install" "$T9_ELSEWHERE_COUNT" "0"

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
printf 'l\nN\n' | env PATH="$T15/bin:$PATH" \
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
  bash "$T15_SH" >/dev/null 2>&1 || T15_EXIT=$?

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
  # shellcheck disable=SC2016  # literal $PATH is the point — this writes a PATH-guard line into the fake rc file
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
env -i PATH="$T18_PATH" \
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
  bash "$T18_SH" >/dev/null 2>&1 || T18_EXIT=$?

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
env -i PATH="$T18_PATH" \
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
  bash "$T18_SH" >/dev/null 2>&1 || T18B_EXIT=$?
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
env -i PATH="$T18_PATH" \
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
  bash "$T18_SH" >/dev/null 2>&1 || T18C_EXIT=$?
assert_exit_zero "T18: fourth run (idempotency) exits 0" "$T18C_EXIT"
T18_LINES_4=$(wc -l < "$T18/home/.bashrc")
assert_eq "T18: bashrc line count stable between run 3 and run 4" "$T18_LINES_4" "$T18_LINES_3"

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

# ─── --upgrade harness ────────────────────────────────────────────────────────
# The upgrade tests assert on what install.sh ACTUALLY DID to the stack, not
# just on what it printed — "pre-flight failed but it swapped anyway" and
# "rolled back to the wrong image ref" are both silent-in-stdout failures.
# So this fake docker records every invocation, plus the UM_IMAGE / UM_VERSION
# it saw, to $FAKE_DOCKER_LOG. No real container is ever touched.
#
# Knobs (env, read at invocation time):
#   FAKE_DOCKER_LOG    file to append invocations to
#   FAKE_PREFLIGHT_RC  non-zero ⇒ `docker run` (the pre-flight) fails
#   FAKE_NO_CONTAINER  1 ⇒ `compose ps -q` returns nothing (stack is down)
#   FAKE_OLD_ID        image ID reported for the running container
#   FAKE_OLD_TAG       image tag reported for the running container
make_fake_docker_upgrade() {
  local dest="$1"
  mkdir -p "$dest"
  cat > "$dest/docker" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [ -n "${FAKE_DOCKER_LOG:-}" ]; then
  printf 'ARGS=%s UM_IMAGE=%s UM_VERSION=%s\n' \
    "$args" "${UM_IMAGE:-}" "${UM_VERSION:-}" >> "$FAKE_DOCKER_LOG"
fi
case "$args" in
  *"compose version"*) echo "Docker Compose version v2.27.0"; exit 0 ;;
  info|*" info"*)      echo "{}"; exit 0 ;;
esac
# Pre-flight: `docker run --rm --entrypoint node <image> ...`
if [[ "$args" == run* ]]; then
  if [ "${FAKE_PREFLIGHT_RC:-0}" != "0" ]; then
    echo "node:internal/modules/esm/resolve:283" >&2
    echo "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'mem0ai' imported from /app/" >&2
    exit "${FAKE_PREFLIGHT_RC}"
  fi
  exit 0
fi
if [[ "$args" == *"config"* ]]; then
  # Mimic `docker compose config` normalized YAML. qdrant is emitted FIRST on
  # purpose: memory-server `depends_on` it, and a resolver that just takes the
  # first image it sees picks up qdrant instead of the server. That is a real
  # trap — `config --images memory-server` emits dependency images too, in
  # unspecified order, which is how the first implementation of this resolver
  # was caught pre-flighting qdrant.
  echo "name: universal-memory"
  echo "services:"
  echo "  qdrant:"
  echo "    image: qdrant/qdrant:v1.13.0"
  echo "    restart: unless-stopped"
  echo "  memory-server:"
  if [ -n "${UM_IMAGE:-}" ]; then
    echo "    image: $UM_IMAGE"
  else
    echo "    image: ghcr.io/goldenwo/universal-memory-server:${UM_VERSION:-latest}"
  fi
  echo "    restart: unless-stopped"
  exit 0
fi
if [[ "$args" == *"image inspect"* ]]; then
  # Resolving the TARGET image's ID for the post-swap identity check.
  echo "${FAKE_TARGET_ID:-sha256:newimage}"
  exit 0
fi
if [[ "$args" == *"inspect"* ]]; then
  if [[ "$args" == *".RestartCount"* ]]; then
    echo "${FAKE_RESTART_COUNT:-0}"
    exit 0
  fi
  if [[ "$args" == *".Config.Image"* ]]; then
    echo "${FAKE_OLD_TAG:-ghcr.io/goldenwo/universal-memory-server:1.8.0}"
    exit 0
  fi
  # `inspect -f {{.Image}} <cid>` is asked twice with identical argv: once
  # before the swap (the rollback target) and once after (what is actually
  # serving). Model the timeline by call count so the post-swap identity check
  # has something real to compare.
  _n_file="${FAKE_DOCKER_LOG:-/tmp/fake-docker}.imgcalls"
  _n=$(cat "$_n_file" 2>/dev/null || echo 0)
  _n=$((_n + 1))
  echo "$_n" > "$_n_file"
  if [ "$_n" -le 1 ]; then
    echo "${FAKE_OLD_ID:-sha256:0ldc0ffee}"
  else
    echo "${FAKE_RUNNING_ID:-${FAKE_TARGET_ID:-sha256:newimage}}"
  fi
  exit 0
fi
if [[ "$args" == *" port memory-server"* ]]; then
  [ "${FAKE_NO_PORT:-0}" = "1" ] && exit 1
  echo "${FAKE_PORT_OUT:-127.0.0.1:6335}"
  exit 0
fi
if [[ "$args" == *"ps -q"* ]]; then
  [ "${FAKE_NO_CONTAINER:-0}" = "1" ] && exit 0
  echo "c0ffee1234ab"
  exit 0
fi
if [[ "$args" == *"logs"* ]]; then
  echo "memory-server | Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'mem0ai'"
  exit 0
fi
exit 0
FAKE
  chmod +x "$dest/docker"
}

# Fake curl whose /health answer is conditioned on UM_IMAGE being exported.
# That models the incident exactly: the NEW image is unhealthy, and the health
# check only starts passing once install.sh has exported the recorded rollback
# image and recreated the container.
make_fake_curl_unhealthy_until_rollback() {
  cat > "$1/curl" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/health"* ]]; then
  # UM_IMAGE is only exported by install.sh's rollback path.
  if [ -n "${UM_IMAGE:-}" ]; then printf '{"ok":true,"memories":42}'; exit 0; fi
  exit 7
fi
exit 0
FAKE
  chmod +x "$1/curl"
}

# run_upgrade <fakebin> <isolated_sh> <log> [extra env...] -- [args...]
# Scrubs the environment (env -i) so a host UM_IMAGE/UM_VERSION can't leak in.
run_upgrade() {
  local fakebin="$1" isolated_sh="$2" log="$3"; shift 3
  local envs=() ; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  env -i PATH="$fakebin:/usr/bin:/bin" \
    _UM_REPO_ROOT="$REPO_ROOT" \
    HOME="$(dirname "$isolated_sh")" \
    FAKE_DOCKER_LOG="$log" \
    _UM_UPGRADE_POLL_ATTEMPTS=1 \
    MEM0_MCP_PORT=6335 \
    ${envs[@]+"${envs[@]}"} \
    bash "$isolated_sh" "$@" 2>&1
}

# ─── T20: --upgrade happy path — pull → preflight → up -d → health ───────────
echo ""
echo "=== T20: --upgrade happy path (pull, pre-flight, swap, health OK) ==="
T20="$TMPROOT/t20"
mkdir -p "$T20/server"
make_fakebin "$T20/bin" 200
make_fake_docker_upgrade "$T20/bin"
T20_SH=$(make_isolated_server "$T20/server")
T20_LOG="$T20/docker.log"

T20_EXIT=0
T20_OUT=$(run_upgrade "$T20/bin" "$T20_SH" "$T20_LOG" -- --upgrade) || T20_EXIT=$?

assert_exit_zero "T20: --upgrade exits 0 on a healthy upgrade" "$T20_EXIT"
assert_contains "T20: records the rollback target first" "$T20_OUT" "Rollback target:"
# Resolve the SERVER's image, not the image of a service it depends_on.
assert_contains "T20: resolves the memory-server image" "$T20_OUT" "Target image: ghcr.io/goldenwo/universal-memory-server:latest"
assert_not_contains "T20: does not mistake qdrant for the target" "$T20_OUT" "Target image: qdrant"
assert_contains "T20: pre-flight ran and passed" "$T20_OUT" "Pre-flight passed"
assert_contains "T20: reports completion" "$T20_OUT" "Upgrade complete"
assert_contains "T20: prints the manual revert command" "$T20_OUT" "UM_IMAGE=um-rollback:previous"
# The revert command must be copy-pasteable into the same file set _compose
# uses — a bare `docker compose` scoped to server/, not an explicit -f that
# would suppress the host's docker-compose.override.yml.
assert_not_contains "T20: revert command carries no -f" "$T20_OUT" "docker compose -f"
assert_contains "T20: points at CHANGELOG" "$T20_OUT" "CHANGELOG.md"
T20_LOGTXT=$(cat "$T20_LOG")
assert_contains "T20: pulled the image" "$T20_LOGTXT" "pull memory-server"
assert_contains "T20: pre-flighted via docker run" "$T20_LOGTXT" "--entrypoint node"
assert_contains "T20: swapped via compose up -d" "$T20_LOGTXT" "up -d"
# Order is the contract: the pre-flight must precede the swap.
T20_PREFLIGHT_LINE=$(grep -n -- "--entrypoint node" "$T20_LOG" | head -1 | cut -d: -f1)
T20_UP_LINE=$(grep -n -- "up -d" "$T20_LOG" | head -1 | cut -d: -f1)
if [ "$T20_PREFLIGHT_LINE" -lt "$T20_UP_LINE" ]; then
  pass "T20: pre-flight runs BEFORE the swap"
else
  fail_test "T20: pre-flight runs BEFORE the swap" "preflight@$T20_PREFLIGHT_LINE up@$T20_UP_LINE"
fi

# ─── T21: pre-flight failure ⇒ no swap, non-zero, running server untouched ───
echo ""
echo "=== T21: --upgrade aborts on pre-flight failure without swapping ==="
T21="$TMPROOT/t21"
mkdir -p "$T21/server"
make_fakebin "$T21/bin" 200
make_fake_docker_upgrade "$T21/bin"
T21_SH=$(make_isolated_server "$T21/server")
T21_LOG="$T21/docker.log"

T21_EXIT=0
T21_OUT=$(run_upgrade "$T21/bin" "$T21_SH" "$T21_LOG" FAKE_PREFLIGHT_RC=1 -- --upgrade) || T21_EXIT=$?

assert_exit_nonzero "T21: exits non-zero when pre-flight fails" "$T21_EXIT"
assert_contains "T21: says pre-flight failed" "$T21_OUT" "Pre-flight FAILED"
assert_contains "T21: states nothing was swapped" "$T21_OUT" "NOTHING WAS SWAPPED"
assert_contains "T21: surfaces the underlying node error" "$T21_OUT" "ERR_MODULE_NOT_FOUND"
T21_LOGTXT=$(cat "$T21_LOG")
# THE load-bearing assertion: the running container was never touched.
assert_not_contains "T21: never ran compose up -d" "$T21_LOGTXT" "up -d"

# ─── T22: unhealthy after swap ⇒ auto-rollback to the ORIGINAL image ─────────
echo ""
echo "=== T22: --upgrade auto-rolls-back when the new container is unhealthy ==="
T22="$TMPROOT/t22"
mkdir -p "$T22/server"
make_fakebin "$T22/bin" 200
make_fake_docker_upgrade "$T22/bin"
make_fake_curl_unhealthy_until_rollback "$T22/bin"
T22_SH=$(make_isolated_server "$T22/server")
T22_LOG="$T22/docker.log"

T22_EXIT=0
T22_OUT=$(run_upgrade "$T22/bin" "$T22_SH" "$T22_LOG" FAKE_OLD_ID=sha256:deadbeef -- --upgrade) || T22_EXIT=$?

assert_exit_nonzero "T22: exits non-zero when the upgrade did not take" "$T22_EXIT"
assert_contains "T22: announces the auto-rollback" "$T22_OUT" "AUTO-ROLLBACK"
assert_contains "T22: dumps container logs for diagnosis" "$T22_OUT" "ERR_MODULE_NOT_FOUND"
assert_contains "T22: reports the rollback outcome" "$T22_OUT" "ROLLBACK SUCCEEDED"
assert_contains "T22: names the image it restored" "$T22_OUT" "sha256:deadbeef"
# LOAD-BEARING 1: the protective tag is applied to the ORIGINAL image ID, not
# to its tag — on a latest→latest upgrade the tag now points at the bad image.
if grep -q "ARGS=tag sha256:deadbeef um-rollback:previous" "$T22_LOG"; then
  pass "T22: protective tag applied to the ORIGINAL recorded image ID"
else
  fail_test "T22: protective tag applied to the ORIGINAL recorded image ID" \
    "docker log: $(cat "$T22_LOG")"
fi
# LOAD-BEARING 2: the rollback recreate goes through that durable tag, not the
# raw ID — under UM_BUILD_LOCAL the ID can be destroyed by step 2's rebuild
# (containerd image store), and `UM_IMAGE=sha256:<id>` would then be parsed as
# repo "sha256" / tag "<id>" and sent to a registry that never had it.
if grep -- "up -d" "$T22_LOG" | grep -q "UM_IMAGE=um-rollback:previous"; then
  pass "T22: rollback up -d used the durable rollback tag"
else
  fail_test "T22: rollback up -d used the durable rollback tag" \
    "docker log: $(cat "$T22_LOG")"
fi
# The printed manual recovery must also be durable and override-safe.
assert_contains "T22: manual recovery uses the durable tag" "$T22_OUT" "UM_IMAGE=um-rollback:previous"
assert_contains "T22: rollback durability is called out" "$T22_OUT" "Rollback is NOT durable yet"

# ─── T23: --upgrade refuses to be combined with --yes (either order) ─────────
echo ""
echo "=== T23: --upgrade rejects being combined with --yes ==="
T23="$TMPROOT/t23"
mkdir -p "$T23/server"
make_fakebin "$T23/bin" 200
make_fake_docker_upgrade "$T23/bin"
T23_SH=$(make_isolated_server "$T23/server")
T23_LOG="$T23/docker.log"

T23A_EXIT=0
T23A_OUT=$(run_upgrade "$T23/bin" "$T23_SH" "$T23_LOG" -- --upgrade --yes) || T23A_EXIT=$?
assert_exit_nonzero "T23: '--upgrade --yes' exits non-zero" "$T23A_EXIT"
assert_contains "T23: '--upgrade --yes' names the sole-argument rule" "$T23A_OUT" "sole argument"

T23B_EXIT=0
T23B_OUT=$(run_upgrade "$T23/bin" "$T23_SH" "$T23_LOG" -- --yes --upgrade) || T23B_EXIT=$?
assert_exit_nonzero "T23: '--yes --upgrade' exits non-zero" "$T23B_EXIT"
assert_contains "T23: '--yes --upgrade' names the sole-argument rule" "$T23B_OUT" "sole argument"

# Extra args are rejected too, rather than silently ignored.
T23C_EXIT=0
T23C_OUT=$(run_upgrade "$T23/bin" "$T23_SH" "$T23_LOG" -- --upgrade 1.8.1 extra) || T23C_EXIT=$?
assert_exit_nonzero "T23: trailing junk argument is rejected" "$T23C_EXIT"
assert_contains "T23: names the at-most-one-argument rule" "$T23C_OUT" "at most one argument"

# ─── T24: --upgrade <version> passes UM_VERSION through to compose ──────────
echo ""
echo "=== T24: --upgrade 1.8.1 resolves the pinned version ==="
T24="$TMPROOT/t24"
mkdir -p "$T24/server"
make_fakebin "$T24/bin" 200
make_fake_docker_upgrade "$T24/bin"
T24_SH=$(make_isolated_server "$T24/server")
T24_LOG="$T24/docker.log"

T24_EXIT=0
T24_OUT=$(run_upgrade "$T24/bin" "$T24_SH" "$T24_LOG" -- --upgrade 1.8.1) || T24_EXIT=$?

assert_exit_zero "T24: --upgrade 1.8.1 exits 0" "$T24_EXIT"
assert_contains "T24: resolves the pinned tag" "$T24_OUT" "Target image: ghcr.io/goldenwo/universal-memory-server:1.8.1"
assert_contains "T24: hints how to make the pin durable" "$T24_OUT" "UM_VERSION=1.8.1"
assert_contains "T24: UM_VERSION reached the docker invocations" "$(cat "$T24_LOG")" "UM_VERSION=1.8.1"

# Operators type the git tag (v1.8.1); published image tags are bare semver.
T24B_LOG="$T24/docker-v.log"
T24B_EXIT=0
T24B_OUT=$(run_upgrade "$T24/bin" "$T24_SH" "$T24B_LOG" -- --upgrade v1.8.1) || T24B_EXIT=$?
assert_exit_zero "T24: --upgrade v1.8.1 exits 0" "$T24B_EXIT"
assert_contains "T24: strips the leading v from a git-style tag" "$T24B_OUT" "Target image: ghcr.io/goldenwo/universal-memory-server:1.8.1"

# A pinned UM_IMAGE would silently win over the requested version — refuse.
T24C_LOG="$T24/docker-img.log"
T24C_EXIT=0
T24C_OUT=$(run_upgrade "$T24/bin" "$T24_SH" "$T24C_LOG" UM_IMAGE=ghcr.io/other/img:9 -- --upgrade 1.8.1) || T24C_EXIT=$?
assert_exit_nonzero "T24: refuses --upgrade <version> when UM_IMAGE is pinned" "$T24C_EXIT"
assert_contains "T24: explains the UM_IMAGE precedence" "$T24C_OUT" "takes precedence"

# ─── T25: --upgrade with no running container aborts (no rollback target) ────
echo ""
echo "=== T25: --upgrade refuses when nothing is running ==="
T25="$TMPROOT/t25"
mkdir -p "$T25/server"
make_fakebin "$T25/bin" 200
make_fake_docker_upgrade "$T25/bin"
T25_SH=$(make_isolated_server "$T25/server")
T25_LOG="$T25/docker.log"

T25_EXIT=0
T25_OUT=$(run_upgrade "$T25/bin" "$T25_SH" "$T25_LOG" FAKE_NO_CONTAINER=1 -- --upgrade) || T25_EXIT=$?

assert_exit_nonzero "T25: exits non-zero with no running container" "$T25_EXIT"
assert_contains "T25: explains there is no rollback target" "$T25_OUT" "no image to roll back to"
assert_not_contains "T25: pulled nothing" "$(cat "$T25_LOG")" "pull memory-server"

# ─── T29: crash-loop is detected by STATE, not by waiting out the clock ──────
# A clock-only check cannot tell "dead" from "booting slowly", so it has to
# pick one and be wrong half the time. Watching container state lets the
# ceiling stay generous (180s, matching the install path's ARM-Pi rationale)
# while a container docker reports as restarting rolls back immediately.
echo ""
echo "=== T29: --upgrade rolls back immediately on a crash-looping container ==="
T29="$TMPROOT/t29"
mkdir -p "$T29/server"
make_fakebin "$T29/bin" 200
make_fake_docker_upgrade "$T29/bin"
make_fake_curl_unhealthy_until_rollback "$T29/bin"
T29_SH=$(make_isolated_server "$T29/server")
T29_LOG="$T29/docker.log"

T29_EXIT=0
# Poll ceiling left at the REAL default: if state were not consulted, this
# test would hang for 180s instead of failing fast.
T29_OUT=$(env -i PATH="$T29/bin:/usr/bin:/bin" \
  _UM_REPO_ROOT="$REPO_ROOT" HOME="$T29/server" \
  FAKE_DOCKER_LOG="$T29_LOG" FAKE_RESTART_COUNT=5 \
  MEM0_MCP_PORT=6335 \
  bash "$T29_SH" --upgrade 2>&1) || T29_EXIT=$?

assert_exit_nonzero "T29: exits non-zero on a crash-looping container" "$T29_EXIT"
assert_contains "T29: names the crash-loop" "$T29_OUT" "CRASH-LOOPING"
assert_contains "T29: says it is not waiting out the clock" "$T29_OUT" "Not waiting out the clock"
assert_contains "T29: still rolled back" "$T29_OUT" "ROLLBACK SUCCEEDED"

# ─── T29b: ONE transient death is not a crash-loop ───────────────────────────
# `depends_on` does not wait for readiness, so a server that starts before
# qdrant is accepting connections can die once and come up fine. Rolling that
# back would abort an upgrade that was about to succeed — the false-failure
# this whole state check exists to avoid, just with a different trigger.
echo ""
echo "=== T29b: a single restart is tolerated, not treated as a crash-loop ==="
T29B="$TMPROOT/t29b"
mkdir -p "$T29B/server"
make_fakebin "$T29B/bin" 200
make_fake_docker_upgrade "$T29B/bin"
T29B_SH=$(make_isolated_server "$T29B/server")
T29B_LOG="$T29B/docker.log"

T29B_EXIT=0
# Model the real timeline: the first probe finds nothing listening (the server
# died once on a not-yet-ready qdrant), and a later probe succeeds. If the
# tolerance were absent, the RestartCount=1 seen on that first failed probe
# would end the upgrade before the second probe ever ran.
cat > "$T29B/bin/curl" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/health"* ]]; then
  n_file="${TMPDIR:-/tmp}/t29b-health-calls"
  n=$(cat "$n_file" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$n_file"
  if [ "$n" -le 1 ]; then exit 7; fi
  printf '{"ok":true,"memories":42}'
  exit 0
fi
exit 0
FAKE
chmod +x "$T29B/bin/curl"
rm -f "${TMPDIR:-/tmp}/t29b-health-calls"
T29B_OUT=$(run_upgrade "$T29B/bin" "$T29B_SH" "$T29B_LOG" \
  FAKE_RESTART_COUNT=1 _UM_UPGRADE_POLL_ATTEMPTS=3 -- --upgrade) || T29B_EXIT=$?
assert_exit_zero "T29b: one restart + healthy ⇒ upgrade succeeds" "$T29B_EXIT"
assert_contains "T29b: reports completion" "$T29B_OUT" "Upgrade complete"
assert_not_contains "T29b: no crash-loop verdict" "$T29B_OUT" "CRASH-LOOPING"
assert_not_contains "T29b: no rollback" "$T29B_OUT" "AUTO-ROLLBACK"

# ─── T29c: legacy override filename is called out, never silently ignored ────
echo ""
echo "=== T29c: leftover docker-compose.local.yml warns that it is inert ==="
T29C="$TMPROOT/t29c"
mkdir -p "$T29C/server"
make_fakebin "$T29C/bin" 200
make_fake_docker_upgrade "$T29C/bin"
T29C_SH=$(make_isolated_server "$T29C/server")
printf 'services:\n  memory-server:\n    ports: !override\n      - "127.0.0.1:6399:6335"\n' \
  > "$T29C/server/docker-compose.local.yml"
T29C_LOG="$T29C/docker.log"

T29C_EXIT=0
T29C_OUT=$(run_upgrade "$T29C/bin" "$T29C_SH" "$T29C_LOG" -- --upgrade) || T29C_EXIT=$?
assert_exit_zero "T29c: still runs" "$T29C_EXIT"
assert_contains "T29c: warns the legacy file is inert" "$T29C_OUT" "NO LONGER APPLIED"
assert_contains "T29c: gives the rename command" "$T29C_OUT" "docker-compose.override.yml"
rm -f "$T29C/server/docker-compose.local.yml"

# ─── T30: health URL comes from compose, not from MEM0_MCP_PORT ──────────────
# A host override can REPLACE the published ports, so a URL derived from
# MEM0_MCP_PORT alone can point at an unbound port — every poll then fails and
# a healthy upgrade gets reported as "the server is DOWN" and rolled back.
echo ""
echo "=== T30: --upgrade resolves the health port from compose ==="
T30="$TMPROOT/t30"
mkdir -p "$T30/server"
make_fakebin "$T30/bin" 200
make_fake_docker_upgrade "$T30/bin"
T30_SH=$(make_isolated_server "$T30/server")
T30_LOG="$T30/docker.log"

T30_EXIT=0
# MEM0_MCP_PORT says 6335; compose reports the container published on 6337.
T30_OUT=$(run_upgrade "$T30/bin" "$T30_SH" "$T30_LOG" FAKE_PORT_OUT=0.0.0.0:6337 -- --upgrade) || T30_EXIT=$?

assert_exit_zero "T30: --upgrade exits 0" "$T30_EXIT"
assert_contains "T30: health URL uses the published port" "$T30_OUT" "http://localhost:6337/health"
assert_not_contains "T30: does not use the .env port" "$T30_OUT" "http://localhost:6335/health"
# A 0.0.0.0 bind is probed over loopback, which is reachable everywhere.
assert_not_contains "T30: never dials 0.0.0.0" "$T30_OUT" "http://0.0.0.0"

# Falls back to MEM0_MCP_PORT when compose cannot answer.
T30B_LOG="$T30/nofallback.log"
T30B_EXIT=0
T30B_OUT=$(run_upgrade "$T30/bin" "$T30_SH" "$T30B_LOG" FAKE_NO_PORT=1 -- --upgrade) || T30B_EXIT=$?
assert_exit_zero "T30: still succeeds when compose cannot report a port" "$T30B_EXIT"
assert_contains "T30: falls back to MEM0_MCP_PORT" "$T30B_OUT" "http://localhost:6335/health"

# ─── T31: a 200 from the port is not proof the new image is serving ──────────
# Anything bound to that port satisfies the poll. On a half-migrated host a
# stale container answers, and a failed swap would report "Upgrade complete".
echo ""
echo "=== T31: --upgrade rejects a healthy port served by the wrong image ==="
T31="$TMPROOT/t31"
mkdir -p "$T31/server"
make_fakebin "$T31/bin" 200
make_fake_docker_upgrade "$T31/bin"
T31_SH=$(make_isolated_server "$T31/server")
T31_LOG="$T31/docker.log"

T31_EXIT=0
# /health answers 200 throughout, but the container serving it is not the
# image we just pre-flighted and swapped in.
T31_OUT=$(run_upgrade "$T31/bin" "$T31_SH" "$T31_LOG" \
  FAKE_RUNNING_ID=sha256:stalecontainer FAKE_TARGET_ID=sha256:newimage -- --upgrade) || T31_EXIT=$?

assert_exit_nonzero "T31: exits non-zero when the wrong image is serving" "$T31_EXIT"
assert_not_contains "T31: does NOT claim success" "$T31_OUT" "Upgrade complete"
assert_contains "T31: says the swap did not take" "$T31_OUT" "the swap did not take"
assert_contains "T31: names the image actually running" "$T31_OUT" "sha256:stalecontainer"
assert_contains "T31: rolled back" "$T31_OUT" "AUTO-ROLLBACK"

# ─── T27: _compose() file selection — override is appended LAST ──────────────
# _compose() is the single point that decides which compose files every docker
# invocation in this script sees. An explicit -f suppresses compose's own
# auto-load of docker-compose.override.yml, so _compose MUST re-add it by hand
# — and LAST, or the host's overrides lose to the base file they exist to
# correct. Asserted through a real run: the fake docker records the argv.
echo ""
echo "=== T27: _compose() appends docker-compose.override.yml last when present ==="
T27="$TMPROOT/t27"
mkdir -p "$T27/server"
make_fakebin "$T27/bin" 200
make_fake_docker_upgrade "$T27/bin"
T27_SH=$(make_isolated_server "$T27/server")

# (a) no override file present ⇒ never referenced
T27A_LOG="$T27/no-override.log"
run_upgrade "$T27/bin" "$T27_SH" "$T27A_LOG" -- --upgrade >/dev/null 2>&1 || true
assert_not_contains "T27: override not referenced when absent" "$(cat "$T27A_LOG")" "docker-compose.override.yml"
assert_contains "T27: base compose file always passed" "$(cat "$T27A_LOG")" "docker-compose.yml"

# (b) override file present ⇒ appended, and LAST
printf 'services:\n  memory-server:\n    ports: !override\n      - "127.0.0.1:6399:6335"\n' \
  > "$T27/server/docker-compose.override.yml"
T27B_LOG="$T27/with-override.log"
run_upgrade "$T27/bin" "$T27_SH" "$T27B_LOG" -- --upgrade >/dev/null 2>&1 || true
T27B_UP=$(grep -- "up -d" "$T27B_LOG" | head -1)
assert_contains "T27: override passed when present" "$T27B_UP" "docker-compose.override.yml"
# Order check: the override's -f must come after the base file's.
T27_BASE_POS=$(awk '{print index($0, "docker-compose.yml")}' <<< "$T27B_UP")
T27_OVR_POS=$(awk '{print index($0, "docker-compose.override.yml")}' <<< "$T27B_UP")
if [ "$T27_OVR_POS" -gt "$T27_BASE_POS" ] && [ "$T27_OVR_POS" -gt 0 ]; then
  pass "T27: override -f appears AFTER the base -f"
else
  fail_test "T27: override -f appears AFTER the base -f" "argv: $T27B_UP"
fi

# (c) build mode ⇒ base, build override, then host override last
T27C_LOG="$T27/build-mode.log"
run_upgrade "$T27/bin" "$T27_SH" "$T27C_LOG" UM_BUILD_LOCAL=1 -- --upgrade >/dev/null 2>&1 || true
T27C_UP=$(grep -- "up -d" "$T27C_LOG" | head -1)
T27C_BUILD_POS=$(awk '{print index($0, "docker-compose.build.yml")}' <<< "$T27C_UP")
T27C_OVR_POS=$(awk '{print index($0, "docker-compose.override.yml")}' <<< "$T27C_UP")
if [ "$T27C_BUILD_POS" -gt 0 ] && [ "$T27C_OVR_POS" -gt "$T27C_BUILD_POS" ]; then
  pass "T27: host override still wins over the build override"
else
  fail_test "T27: host override still wins over the build override" "argv: $T27C_UP"
fi
rm -f "$T27/server/docker-compose.override.yml"

# ─── T28: .env values are normalized the way compose's parser does ───────────
# A quoted MEM0_MCP_PORT used to reach the health URL verbatim
# (http://localhost:"6335"/health), which can never answer — and --upgrade
# reads that as "the server is DOWN" and rolls back a healthy upgrade.
echo ""
echo "=== T28: --verify tolerates quoted / commented / CRLF .env values ==="
T28="$TMPROOT/t28"
mkdir -p "$T28/vault" "$T28/plugins" "$T28/home"
make_fakebin "$T28/bin" 200
T28_SH=$(make_isolated_server "$T28/server")
cp -r "$PLUGIN_SRC" "$T28/plugins/universal-memory"
{
  printf 'MEM0_MCP_PORT="6335"\r\n'
  printf 'UM_VAULT_DIR=%s   # inline comment\n' "$T28/vault"
  printf "UM_OPENAI_API_KEY='sk-testkey12345'\n"
} > "$T28/server/.env"

T28_EXIT=0
T28_OUT=$(env PATH="$T28/bin:$PATH" \
  _UM_REPO_ROOT="$REPO_ROOT" \
  CLAUDE_PLUGINS_DIR="$T28/plugins" \
  HOME="$T28/home" \
  bash "$T28_SH" --verify 2>&1) || T28_EXIT=$?

assert_exit_zero "T28: --verify exits 0 with quoted/commented/CRLF values" "$T28_EXIT"
# The health line proves the port was unquoted before the URL was built.
assert_contains "T28: port unquoted in health URL" "$T28_OUT" "http://localhost:6335/health"
assert_not_contains "T28: no quote leaked into the URL" "$T28_OUT" 'localhost:"6335"'
# The vault check proves the inline comment was stripped from the path.
assert_contains "T28: inline comment stripped from vault path" "$T28_OUT" "vault-dir"
assert_not_contains "T28: vault path has no comment residue" "$T28_OUT" "# inline comment"

# ─── T32: --upgrade refreshes the um CLI after a healthy server upgrade ──────
# The CLI is a copy of the repo's scripts with no self-update path, so it stays
# at whatever version was installed until someone re-runs the installer. That
# is how a host ran a current server with a CLI a full release behind, making
# that release's capture-freshness cron uninstallable.
echo ""
echo "=== T32: --upgrade refreshes the um CLI ==="
T32="$TMPROOT/t32"
mkdir -p "$T32/server" "$T32/home/.local/share/um/cli" "$T32/repo/installer"
make_fakebin "$T32/bin" 200
make_fake_docker_upgrade "$T32/bin"
T32_SH=$(make_isolated_server "$T32/server")
# Fake source tree whose install-cli.sh records how it was invoked.
cat > "$T32/repo/installer/install-cli.sh" <<'FAKE'
#!/usr/bin/env bash
printf 'CLI-INSTALLER-RAN args=%s\n' "$*" >> "$UM_CLI_INSTALL_LOG"
echo "um installed"
exit 0
FAKE
chmod +x "$T32/repo/installer/install-cli.sh"
T32_LOG="$T32/docker.log"
T32_CLI_LOG="$T32/cli-installer.log"

T32_EXIT=0
T32_OUT=$(env -i PATH="$T32/bin:/usr/bin:/bin" \
  _UM_REPO_ROOT="$T32/repo" HOME="$T32/home" \
  FAKE_DOCKER_LOG="$T32_LOG" UM_CLI_INSTALL_LOG="$T32_CLI_LOG" \
  _UM_UPGRADE_POLL_ATTEMPTS=1 MEM0_MCP_PORT=6335 \
  bash "$T32_SH" --upgrade 2>&1) || T32_EXIT=$?

assert_exit_zero "T32: upgrade exits 0" "$T32_EXIT"
assert_contains "T32: announces the CLI refresh" "$T32_OUT" "Refreshing the um CLI"
assert_file_exists "T32: CLI installer was invoked" "$T32_CLI_LOG"
# --no-path is load-bearing: install-cli.sh rewrites the shell rc marker block
# from the CURRENT environment, and --upgrade never collects an API key — so a
# refresh without it would blank UM_OPENAI_API_KEY in the operator's profile.
assert_contains "T32: refresh passes --no-path (never touches shell profiles)" \
  "$(cat "$T32_CLI_LOG" 2>/dev/null)" "--no-path"
assert_contains "T32: refresh is non-interactive" \
  "$(cat "$T32_CLI_LOG" 2>/dev/null)" "--yes"
assert_contains "T32: points at the three-surface doc" "$T32_OUT" "docs/upgrading.md"

# ─── T32b: CLI not installed on this host ⇒ refresh is skipped silently ──────
echo ""
echo "=== T32b: no CLI installed ⇒ no refresh attempted ==="
T32B="$TMPROOT/t32b"
mkdir -p "$T32B/server" "$T32B/home" "$T32B/repo/installer"
make_fakebin "$T32B/bin" 200
make_fake_docker_upgrade "$T32B/bin"
T32B_SH=$(make_isolated_server "$T32B/server")
cp "$T32/repo/installer/install-cli.sh" "$T32B/repo/installer/install-cli.sh"
T32B_CLI_LOG="$T32B/cli-installer.log"

T32B_EXIT=0
T32B_OUT=$(env -i PATH="$T32B/bin:/usr/bin:/bin" \
  _UM_REPO_ROOT="$T32B/repo" HOME="$T32B/home" \
  FAKE_DOCKER_LOG="$T32B/docker.log" UM_CLI_INSTALL_LOG="$T32B_CLI_LOG" \
  _UM_UPGRADE_POLL_ATTEMPTS=1 MEM0_MCP_PORT=6335 \
  bash "$T32B_SH" --upgrade 2>&1) || T32B_EXIT=$?

assert_exit_zero "T32b: upgrade still exits 0" "$T32B_EXIT"
assert_not_contains "T32b: no refresh announced" "$T32B_OUT" "Refreshing the um CLI"
if [ -f "$T32B_CLI_LOG" ]; then
  fail_test "T32b: CLI installer not invoked when CLI absent" "installer ran anyway"
else
  pass "T32b: CLI installer not invoked when CLI absent"
fi

# ─── T32c: a failing/missing CLI refresh never fails the server upgrade ──────
# The server upgrade has already succeeded and been health-verified by this
# point. A stale CLI is a real problem, but turning it into a failed exit code
# would invite an operator to roll back a perfectly good server.
echo ""
echo "=== T32c: CLI refresh failure does not fail or roll back the upgrade ==="
T32C="$TMPROOT/t32c"
mkdir -p "$T32C/server" "$T32C/home/.local/share/um/cli" "$T32C/repo/installer"
make_fakebin "$T32C/bin" 200
make_fake_docker_upgrade "$T32C/bin"
T32C_SH=$(make_isolated_server "$T32C/server")
cat > "$T32C/repo/installer/install-cli.sh" <<'FAKE'
#!/usr/bin/env bash
echo "install-cli: python3 not found" >&2
exit 1
FAKE
chmod +x "$T32C/repo/installer/install-cli.sh"
T32C_LOG="$T32C/docker.log"

T32C_EXIT=0
T32C_OUT=$(env -i PATH="$T32C/bin:/usr/bin:/bin" \
  _UM_REPO_ROOT="$T32C/repo" HOME="$T32C/home" \
  FAKE_DOCKER_LOG="$T32C_LOG" \
  _UM_UPGRADE_POLL_ATTEMPTS=1 MEM0_MCP_PORT=6335 \
  bash "$T32C_SH" --upgrade 2>&1) || T32C_EXIT=$?

assert_exit_zero "T32c: failing CLI refresh still exits 0" "$T32C_EXIT"
assert_contains "T32c: reports the refresh failure" "$T32C_OUT" "CLI refresh FAILED"
assert_contains "T32c: gives the manual command" "$T32C_OUT" "install-cli.sh --no-path"
assert_contains "T32c: server upgrade still reported complete" "$T32C_OUT" "Upgrade complete"
assert_not_contains "T32c: no rollback triggered" "$T32C_OUT" "AUTO-ROLLBACK"

# ─── T32d: installer missing entirely (tarball / partial tree) ───────────────
echo ""
echo "=== T32d: CLI installed but installer absent ⇒ actionable warning ==="
T32D="$TMPROOT/t32d"
mkdir -p "$T32D/server" "$T32D/home/.local/share/um/cli" "$T32D/repo"
make_fakebin "$T32D/bin" 200
make_fake_docker_upgrade "$T32D/bin"
T32D_SH=$(make_isolated_server "$T32D/server")

T32D_EXIT=0
T32D_OUT=$(env -i PATH="$T32D/bin:/usr/bin:/bin" \
  _UM_REPO_ROOT="$T32D/repo" HOME="$T32D/home" \
  FAKE_DOCKER_LOG="$T32D/docker.log" \
  _UM_UPGRADE_POLL_ATTEMPTS=1 MEM0_MCP_PORT=6335 \
  bash "$T32D_SH" --upgrade 2>&1) || T32D_EXIT=$?

assert_exit_zero "T32d: still exits 0 on a partial tree" "$T32D_EXIT"
assert_contains "T32d: names the missing installer" "$T32D_OUT" "install-cli.sh is missing"
assert_contains "T32d: warns the CLI is now older" "$T32D_OUT" "OLDER than your server"

# ─── T33: --verify reports all three versions and flags skew ────────────────
echo ""
echo "=== T33: --verify reports server / CLI / plugin versions ==="
T33="$TMPROOT/t33"
mkdir -p "$T33/vault" "$T33/plugins" "$T33/home/.local/.claude-plugin" "$T33/repo/plugins/claude-code"
make_fakebin "$T33/bin" 200
T33_SH=$(make_isolated_server "$T33/server")
cp -r "$PLUGIN_SRC" "$T33/plugins/universal-memory"
# The fake repo carries the REAL plugin tree (hooks and all) so the other
# verify checks behave normally and any exit code is attributable to versions.
cp -r "$PLUGIN_SRC" "$T33/repo/plugins/claude-code/universal-memory"
# Installed CLI marker: a full release behind the source tree — the exact skew
# that hid for a release cycle.
printf '{"name":"universal-memory","version":"1.6.0"}\n' > "$T33/home/.local/.claude-plugin/plugin.json"
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33/repo/plugins/claude-code/universal-memory/.claude-plugin/plugin.json"
# Installed plugin: NEWER than the server we will report (1.7.0).
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33/plugins/universal-memory/.claude-plugin/plugin.json"
# Fake docker that reports a running server carrying an OCI version label.
cat > "$T33/bin/docker" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"compose version"* ]]; then echo "Docker Compose version v2.27.0"; exit 0; fi
if [[ "$args" == info* ]] || [[ "$args" == *" info"* ]]; then echo "{}"; exit 0; fi
if [[ "$args" == *"ps -q"* ]]; then echo "c0ffee1234ab"; exit 0; fi
if [[ "$args" == *"org.opencontainers.image.version"* ]]; then echo "${FAKE_SERVER_VER:-1.7.0}"; exit 0; fi
if [[ "$args" == *"ps"* ]]; then echo "NAME            STATUS"; echo "memory-server   Up 2 hours"; exit 0; fi
exit 0
FAKE
chmod +x "$T33/bin/docker"

T33_EXIT=0
T33_OUT=$(env PATH="$T33/bin:$PATH" \
  _UM_REPO_ROOT="$T33/repo" \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T33/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T33/plugins" \
  HOME="$T33/home" \
  bash "$T33_SH" --verify 2>&1) || T33_EXIT=$?

# Both skews here are ADVISORY. A stale CLI or a newer plugin is worth saying
# out loud, but failing an otherwise-healthy server verify over it would train
# operators to ignore the exit code. Only the hard floor (T33c) fails.
assert_exit_zero "T33: advisory skew does NOT fail verify" "$T33_EXIT"
assert_contains "T33: reports server version"      "$T33_OUT" "version-server"
assert_contains "T33: server version value"        "$T33_OUT" "1.7.0"
assert_contains "T33: reports CLI version"         "$T33_OUT" "version-cli"
assert_contains "T33: CLI version value"           "$T33_OUT" "1.6.0"
assert_contains "T33: reports plugin version"      "$T33_OUT" "version-plugin"
assert_contains "T33: reports source tree version" "$T33_OUT" "version-source-tree"
# Skew A: installed plugin (1.8.1) newer than server (1.7.0).
assert_contains "T33: flags plugin-newer-than-server skew" "$T33_OUT" "is NEWER than server"
# Skew B: CLI (1.6.0) behind the source tree (1.8.1) — the release-cycle gap.
assert_contains "T33: flags CLI-behind-source skew" "$T33_OUT" "BEHIND this source tree"
assert_contains "T33: gives the CLI refresh command" "$T33_OUT" "install-cli.sh --no-path"

# ─── T33b: matched versions produce no skew warnings ────────────────────────
echo ""
echo "=== T33b: no skew warnings when all three match ==="
T33B="$TMPROOT/t33b"
mkdir -p "$T33B/vault" "$T33B/plugins" "$T33B/home/.local/.claude-plugin" "$T33B/repo/plugins/claude-code"
cp -r "$T33/bin" "$T33B/bin"
T33B_SH=$(make_isolated_server "$T33B/server")
cp -r "$PLUGIN_SRC" "$T33B/plugins/universal-memory"
cp -r "$PLUGIN_SRC" "$T33B/repo/plugins/claude-code/universal-memory"
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33B/home/.local/.claude-plugin/plugin.json"
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33B/repo/plugins/claude-code/universal-memory/.claude-plugin/plugin.json"
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33B/plugins/universal-memory/.claude-plugin/plugin.json"

T33B_EXIT=0
T33B_OUT=$(env PATH="$T33B/bin:$PATH" \
  _UM_REPO_ROOT="$T33B/repo" \
  FAKE_SERVER_VER=1.8.1 \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T33B/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T33B/plugins" \
  HOME="$T33B/home" \
  bash "$T33B_SH" --verify 2>&1) || T33B_EXIT=$?

assert_exit_zero "T33b: --verify passes with matched versions" "$T33B_EXIT"
assert_not_contains "T33b: no skew warning" "$T33B_OUT" "version-skew"
assert_contains "T33b: all checks still pass" "$T33B_OUT" "All checks passed"

# ─── T33c: a server below the capture-contract floor FAILS verify ───────────
# Unlike the advisory skews, the plugin genuinely cannot capture against a
# pre-1.7 server — every capture 404s. That is worth a non-zero exit.
echo ""
echo "=== T33c: server below the 1.7.0 capture floor fails verify ==="
T33C="$TMPROOT/t33c"
mkdir -p "$T33C/vault" "$T33C/plugins" "$T33C/home/.local/.claude-plugin" "$T33C/repo/plugins/claude-code"
cp -r "$T33/bin" "$T33C/bin"
T33C_SH=$(make_isolated_server "$T33C/server")
cp -r "$PLUGIN_SRC" "$T33C/plugins/universal-memory"
cp -r "$PLUGIN_SRC" "$T33C/repo/plugins/claude-code/universal-memory"
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33C/plugins/universal-memory/.claude-plugin/plugin.json"
printf '{"name":"universal-memory","version":"1.8.1"}\n' > "$T33C/repo/plugins/claude-code/universal-memory/.claude-plugin/plugin.json"

T33C_EXIT=0
T33C_OUT=$(env PATH="$T33C/bin:$PATH" \
  _UM_REPO_ROOT="$T33C/repo" \
  FAKE_SERVER_VER=1.6.0 \
  MEM0_MCP_PORT=6335 \
  UM_VAULT_DIR="$T33C/vault" \
  UM_OPENAI_API_KEY=sk-testkey12345 \
  CLAUDE_PLUGINS_DIR="$T33C/plugins" \
  HOME="$T33C/home" \
  bash "$T33C_SH" --verify 2>&1) || T33C_EXIT=$?

assert_exit_nonzero "T33c: --verify fails below the capture floor" "$T33C_EXIT"
assert_contains "T33c: names the floor" "$T33C_OUT" "version-floor"
assert_contains "T33c: explains the consequence" "$T33C_OUT" "cannot capture against it"

# ─── T26: drift gate — --upgrade's fallback image ref tracks the compose file ─
# --upgrade resolves the target image from `docker compose config`, but falls
# back to a hardcoded mirror of docker-compose.yml's memory-server `image:`
# line when compose can't answer. If that line is ever edited (new registry,
# renamed image) the mirror silently goes stale and the fallback would
# pre-flight — and name in its error messages — an image nobody deploys.
echo ""
echo "=== T26: --upgrade fallback image ref matches docker-compose.yml ==="
T26_COMPOSE_REF=$(grep -E '^\s+image:\s+\$\{UM_IMAGE' "$SCRIPT_DIR/docker-compose.yml" | sed 's/^[[:space:]]*image:[[:space:]]*//')
T26_INSTALL_REF=$(grep -oE '\$\{UM_IMAGE:-ghcr\.io[^}]*\}[^"]*' "$INSTALL_SH" | head -1)
if [ -n "$T26_COMPOSE_REF" ] && [ "$T26_INSTALL_REF" = "$T26_COMPOSE_REF" ]; then
  pass "T26: install.sh fallback ref matches docker-compose.yml image line"
else
  fail_test "T26: install.sh fallback ref matches docker-compose.yml image line" \
    "compose='$T26_COMPOSE_REF' install.sh='$T26_INSTALL_REF'"
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
