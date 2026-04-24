#!/usr/bin/env bash
# installer/install-token.test.sh — Task B.4 idempotency test for
# UM_AUTH_TOKEN preservation and .env byte-stability across re-runs.
#
# Asserts: running install.sh twice produces byte-identical .env and
# ~/.um/auth-token. A regenerate-on-every-run bug would silently break
# remote clients who had the first-run token cached
# (Claude.ai tunnel, Custom GPT, Codex plugin on different boxes).
#
# Design notes
#   - Isolation: HOME, UM_INSTALL_DIR, and PATH are all sandboxed. No
#     real ~/.um/auth-token or server/.env is ever touched.
#   - We point UM_INSTALL_DIR at a staged copy of the repo (layout:
#     <stage>/server/ + <stage>/installer/ + <stage>/plugins/) so the
#     top-level dispatcher's `bash $INSTALL_DIR/server/install.sh` call
#     lands in our isolated tree.
#   - installer/install.sh owns UM_AUTH_TOKEN generation/preservation
#     and ~/.um/auth-token mirroring (before delegation).
#   - server/install.sh reads the exported UM_AUTH_TOKEN from env and
#     emits UM_AUTH_TOKEN=... into the isolated .env.
#   - Fake docker/curl/python3 let the installer reach .env-write
#     without real network / daemon dependencies.
#   - `chmod 600` on ~/.um/auth-token is a no-op on Windows NTFS.
#     The test therefore only asserts file contents, not file mode.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")"
INSTALLER_SH="$SCRIPT_DIR/install.sh"

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

assert_nonempty() {
  local name="$1" val="$2"
  if [ -n "$val" ]; then pass "$name"; else fail_test "$name" "value was empty"; fi
}

assert_file_exists() {
  local name="$1" file="$2"
  if [ -e "$file" ]; then pass "$name"; else fail_test "$name" "file not found: $file"; fi
}

# ─── Temp root + cleanup trap ────────────────────────────────────────────────
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT INT TERM

# ─── Fake binary factory (docker/curl/python3/git) ───────────────────────────
# Replicates the offline fakes in server/install.test.sh so the installer
# reaches .env write without hitting docker/openai.
make_fakebin() {
  local dest="$1"
  mkdir -p "$dest"

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

  cat > "$dest/curl" <<'FAKE'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"openai.com"* ]]; then
  [[ "$args" == *"-w"* ]] && printf '200'
  exit 0
fi
if [[ "$args" == *"/health"* ]]; then
  printf '{"status":"ok"}'
  exit 0
fi
exit 0
FAKE
  chmod +x "$dest/curl"

  cat > "$dest/python3" <<'FAKE'
#!/usr/bin/env bash
[[ "$*" == *"import yaml"* ]] && exit 0
exec /usr/bin/python3 "$@" 2>/dev/null || exit 0
FAKE
  chmod +x "$dest/python3"

  # Fake git — only needs to resolve --show-toplevel for REPO_ROOT lookups.
  # Our stage layout has no .git, so delegates resort to their $(dirname ...)
  # fallbacks. Provide git so `command -v git` prereq passes.
  cat > "$dest/git" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
  chmod +x "$dest/git"
}

# stage_install_dir <stage_root>
#   Creates an isolated checkout-lookalike at <stage_root> with:
#     server/install.sh, server/.env.example, server/docker-compose.yml,
#     server/lib/ (all files), installer/install.sh, installer/lib/,
#     installer/wizard-lib.sh, plugins/ (empty — ok, server/install.sh
#     no longer copies plugins inline)
#   Marks .git so RUNNING_FROM_LOCAL_REPO detection is benign.
stage_install_dir() {
  local stage="$1"
  mkdir -p "$stage/server" "$stage/installer/lib" "$stage/plugins"
  cp "$REPO_ROOT/server/install.sh"       "$stage/server/install.sh"
  cp "$REPO_ROOT/server/.env.example"     "$stage/server/.env.example"
  cp "$REPO_ROOT/server/docker-compose.yml" "$stage/server/docker-compose.yml"
  cp "$REPO_ROOT/installer/install.sh"    "$stage/installer/install.sh"
  cp "$REPO_ROOT/installer/wizard-lib.sh" "$stage/installer/wizard-lib.sh"
  cp "$REPO_ROOT/installer/lib/marker-block.sh" "$stage/installer/lib/marker-block.sh"
  # Mark as "local repo" so installer/install.sh skips git clone/pull
  mkdir -p "$stage/.git"
}

# run_token_install <fakebin> <home> <stage>
#   Invoke installer/install.sh with --server --yes against an isolated
#   stage. UM_NONINTERACTIVE=1 + key vars in env drive the non-interactive
#   path. Key validation is skipped to keep the test offline.
run_token_install() {
  local fakebin="$1" home="$2" stage="$3"
  env \
    PATH="$fakebin:$PATH" \
    HOME="$home" \
    UM_INSTALL_DIR="$stage" \
    UM_NONINTERACTIVE=1 \
    OPENAI_API_KEY=sk-testkey12345 \
    UM_OPENAI_API_KEY=sk-testkey12345 \
    MEM0_USER_ID=b4testuser \
    MEM0_MCP_PORT=6335 \
    UM_VAULT_DIR="$home/vault" \
    UM_SUMMARY_ENABLED=true \
    UM_TEMPORAL_DECAY=false \
    UM_SKIP_KEY_VALIDATION=1 \
    UM_SKIP_DOCKER=1 \
    CLAUDE_PLUGINS_DIR="$home/plugins" \
    SHELL=/bin/bash \
    bash "$stage/installer/install.sh" --server --yes 2>&1
}

# ─── T1: fresh install generates token + writes .env ─────────────────────────
echo ""
echo "=== T1: fresh install generates token and writes .env ==="
T1="$TMPROOT/t1"
T1_HOME="$T1/home"
T1_STAGE="$T1/stage"
mkdir -p "$T1_HOME/vault" "$T1_HOME/plugins"
touch "$T1_HOME/.bashrc"
make_fakebin "$T1/bin"
stage_install_dir "$T1_STAGE"
T1_ENV_FILE="$T1_STAGE/server/.env"

T1_EXIT=0
T1_OUT=$(run_token_install "$T1/bin" "$T1_HOME" "$T1_STAGE") || T1_EXIT=$?
if [ "$T1_EXIT" -ne 0 ]; then
  fail_test "T1: install exits 0" "exit $T1_EXIT; tail: $(printf '%s\n' "$T1_OUT" | tail -30)"
else
  pass "T1: install exits 0"
fi

assert_file_exists "T1: .env written" "$T1_ENV_FILE"
assert_file_exists "T1: ~/.um/auth-token mirrored" "$T1_HOME/.um/auth-token"

T1_TOKEN_ENV=$(grep -E '^UM_AUTH_TOKEN=' "$T1_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
T1_TOKEN_FILE=$(cat "$T1_HOME/.um/auth-token" 2>/dev/null || echo "")
assert_nonempty "T1: UM_AUTH_TOKEN non-empty in .env" "$T1_TOKEN_ENV"
assert_nonempty "T1: ~/.um/auth-token non-empty"      "$T1_TOKEN_FILE"
assert_eq       "T1: token-in-.env matches mirror"    "$T1_TOKEN_ENV" "$T1_TOKEN_FILE"

# Sanity-check token shape: openssl rand -hex 32 → 64 lowercase hex chars
if [[ "$T1_TOKEN_FILE" =~ ^[0-9a-f]{64}$ ]]; then
  pass "T1: token is 64-char hex (openssl rand -hex 32)"
else
  fail_test "T1: token is 64-char hex" "got: ${T1_TOKEN_FILE:0:16}... (len=${#T1_TOKEN_FILE})"
fi

# Snapshot .env body (minus timestamp banner) for T2 comparison
T1_ENV_BODY=$(grep -v '^# Generated by install.sh on ' "$T1_ENV_FILE")

# ─── T2: re-run is byte-identical (.env + token) ─────────────────────────────
echo ""
echo "=== T2: re-run install — .env and ~/.um/auth-token byte-identical ==="
T2_EXIT=0
T2_OUT=$(run_token_install "$T1/bin" "$T1_HOME" "$T1_STAGE") || T2_EXIT=$?
if [ "$T2_EXIT" -ne 0 ]; then
  fail_test "T2: re-run exits 0" "exit $T2_EXIT; tail: $(printf '%s\n' "$T2_OUT" | tail -30)"
else
  pass "T2: re-run exits 0"
fi

T2_TOKEN_FILE=$(cat "$T1_HOME/.um/auth-token" 2>/dev/null || echo "")
T2_TOKEN_ENV=$(grep -E '^UM_AUTH_TOKEN=' "$T1_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)

assert_eq "T2: ~/.um/auth-token preserved across runs" "$T2_TOKEN_FILE" "$T1_TOKEN_FILE"
assert_eq "T2: UM_AUTH_TOKEN in .env preserved"        "$T2_TOKEN_ENV"  "$T1_TOKEN_ENV"

# .env body (excluding timestamp) must be byte-identical
T2_ENV_BODY=$(grep -v '^# Generated by install.sh on ' "$T1_ENV_FILE")
if [ "$T1_ENV_BODY" = "$T2_ENV_BODY" ]; then
  pass "T2: .env body byte-identical (ignoring timestamp banner)"
else
  fail_test "T2: .env body byte-identical (ignoring timestamp banner)" \
    "diff: $(diff <(printf '%s\n' "$T1_ENV_BODY") <(printf '%s\n' "$T2_ENV_BODY") | head -20)"
fi

# ─── T3: pre-seeded .env token is respected ──────────────────────────────────
# Simulates "user already has a deployed token; re-run must not clobber".
echo ""
echo "=== T3: pre-seeded UM_AUTH_TOKEN in .env is reused on install ==="
T3="$TMPROOT/t3"
T3_HOME="$T3/home"
T3_STAGE="$T3/stage"
mkdir -p "$T3_HOME/vault" "$T3_HOME/plugins"
touch "$T3_HOME/.bashrc"
make_fakebin "$T3/bin"
stage_install_dir "$T3_STAGE"
T3_ENV_FILE="$T3_STAGE/server/.env"

# Seed a known token value (64 hex chars)
SEEDED_TOKEN="deadbeef$(printf '%056d' 0 | tr '0' 'a')"
cat > "$T3_ENV_FILE" <<EOF
# Seeded by test — pre-existing .env from a prior install
OPENAI_API_KEY=sk-old-key-0000
MEM0_USER_ID=b4testuser
MEM0_MCP_PORT=6335
UM_VAULT_DIR=$T3_HOME/vault
UM_SUMMARY_ENABLED=true
UM_TEMPORAL_DECAY=false
UM_AUTH_TOKEN=$SEEDED_TOKEN
EOF

T3_EXIT=0
T3_OUT=$(run_token_install "$T3/bin" "$T3_HOME" "$T3_STAGE") || T3_EXIT=$?
if [ "$T3_EXIT" -ne 0 ]; then
  fail_test "T3: install exits 0 with seeded .env" "exit $T3_EXIT; tail: $(printf '%s\n' "$T3_OUT" | tail -30)"
else
  pass "T3: install exits 0 with seeded .env"
fi

T3_TOKEN_ENV=$(grep -E '^UM_AUTH_TOKEN=' "$T3_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
T3_TOKEN_FILE=$(cat "$T3_HOME/.um/auth-token" 2>/dev/null || echo "")
assert_eq "T3: seeded token preserved in .env"            "$T3_TOKEN_ENV"  "$SEEDED_TOKEN"
assert_eq "T3: seeded token mirrored to ~/.um/auth-token" "$T3_TOKEN_FILE" "$SEEDED_TOKEN"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================================================"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "================================================================"
exit 0
