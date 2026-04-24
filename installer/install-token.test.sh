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

# ─── T4: fresh install lands all 13 v0.6 keys in .env (Part B) ───────────────
# Reuses T1's end-state .env (the fresh install in T1).
echo ""
echo "=== T4: fresh install writes all 13 v0.6 env keys ==="
_b5_keys=(
  UM_ALLOW_LOOPBACK_NOAUTH UM_RATE_LIMIT_RPM UM_RATE_LIMIT_BURST UM_RATE_LIMIT_MAX_IPS
  UM_METRICS_LOOPBACK_ONLY UM_METRICS_AUTH_REQUIRED UM_OPENAPI_AUTH_REQUIRED UM_LOG_LEVEL
  UM_HTTP_MAX_REQUEST_BYTES UM_LOCK_LOW_DISK_THRESHOLD UM_UPSTREAM_RETRY_MAX
  UM_BRIDGE_MAX_PER_RUN UM_BRIDGE_JITTER_SEC
)
T4_MISSING=()
for _k in "${_b5_keys[@]}"; do
  if ! grep -qE "^${_k}=" "$T1_ENV_FILE"; then
    T4_MISSING+=("$_k")
  fi
done
if [ "${#T4_MISSING[@]}" -eq 0 ]; then
  pass "T4: all 13 v0.6 keys present in fresh-install .env"
else
  fail_test "T4: v0.6 keys missing from fresh-install .env" "missing: ${T4_MISSING[*]}"
fi

# Dated-header sentinel for the v0.6 migration block
if grep -qE '^# --- Added by v0.6 migration on [0-9]{4}-[0-9]{2}-[0-9]{2} ---$' "$T1_ENV_FILE"; then
  pass "T4: v0.6 dated migration header present"
else
  fail_test "T4: v0.6 dated migration header missing" ".env tail: $(tail -20 "$T1_ENV_FILE")"
fi

# ─── T5: re-run on .env that already has v0.6 keys — user values preserved ───
echo ""
echo "=== T5: re-run preserves user-tuned v0.6 values; idempotent ==="
T5="$TMPROOT/t5"
T5_HOME="$T5/home"
T5_STAGE="$T5/stage"
mkdir -p "$T5_HOME/vault" "$T5_HOME/plugins"
touch "$T5_HOME/.bashrc"
make_fakebin "$T5/bin"
stage_install_dir "$T5_STAGE"
T5_ENV_FILE="$T5_STAGE/server/.env"

# Seed a pre-existing v0.5 .env with ONE user-tuned v0.6 key (UM_RATE_LIMIT_RPM=120)
# plus other standard v0.5 content. Verifies the merge path handles the mixed
# case: legacy v0.5 keys get rewritten, user-tuned v0.6 key is preserved,
# missing v0.6 keys get defaulted.
cat > "$T5_ENV_FILE" <<EOF
# Pre-existing v0.5 .env (seeded by test)
OPENAI_API_KEY=sk-old-key
MEM0_USER_ID=b5user
MEM0_MCP_PORT=6335
UM_VAULT_DIR=$T5_HOME/vault
UM_SUMMARY_ENABLED=true
UM_TEMPORAL_DECAY=false
UM_AUTH_TOKEN=seeded000000000000000000000000000000000000000000000000000000aaaa
UM_RATE_LIMIT_RPM=120
UM_LOG_LEVEL=debug
EOF

T5_EXIT=0
T5_OUT=$(run_token_install "$T5/bin" "$T5_HOME" "$T5_STAGE") || T5_EXIT=$?
if [ "$T5_EXIT" -ne 0 ]; then
  fail_test "T5: re-run exits 0" "exit $T5_EXIT; tail: $(printf '%s\n' "$T5_OUT" | tail -30)"
else
  pass "T5: re-run exits 0"
fi

# User-tuned values from seeded .env must be preserved
T5_RPM=$(grep -E '^UM_RATE_LIMIT_RPM=' "$T5_ENV_FILE" | head -1 | cut -d= -f2-)
T5_LOG=$(grep -E '^UM_LOG_LEVEL='      "$T5_ENV_FILE" | head -1 | cut -d= -f2-)
assert_eq "T5: user UM_RATE_LIMIT_RPM preserved"  "$T5_RPM" "120"
assert_eq "T5: user UM_LOG_LEVEL preserved"       "$T5_LOG" "debug"

# Missing keys must land at safe defaults
T5_BURST=$(grep -E '^UM_RATE_LIMIT_BURST=' "$T5_ENV_FILE" | head -1 | cut -d= -f2-)
T5_BRIDGE=$(grep -E '^UM_BRIDGE_MAX_PER_RUN=' "$T5_ENV_FILE" | head -1 | cut -d= -f2-)
assert_eq "T5: missing UM_RATE_LIMIT_BURST defaulted to 10"   "$T5_BURST"  "10"
assert_eq "T5: missing UM_BRIDGE_MAX_PER_RUN defaulted to 50" "$T5_BRIDGE" "50"

# All 13 v0.6 keys must appear exactly once (no duplicates after the merge)
for _k in "${_b5_keys[@]}"; do
  _count=$(grep -cE "^${_k}=" "$T5_ENV_FILE")
  if [ "$_count" != "1" ]; then
    fail_test "T5: $_k appears exactly once" "count=$_count"
    break
  fi
done
# Only emit a single PASS message for the no-dup check (not 13 × once each)
_all_once=1
for _k in "${_b5_keys[@]}"; do
  _count=$(grep -cE "^${_k}=" "$T5_ENV_FILE")
  [ "$_count" = "1" ] || _all_once=0
done
if [ "$_all_once" = "1" ]; then pass "T5: all 13 v0.6 keys appear exactly once"; fi

# Second re-run idempotency — no duplicate appends, byte-stable body
T5_FIRST_BODY=$(grep -v '^# Generated by install.sh on ' "$T5_ENV_FILE")
T5B_EXIT=0
T5B_OUT=$(run_token_install "$T5/bin" "$T5_HOME" "$T5_STAGE") || T5B_EXIT=$?
assert_exit_zero_msg() { if [ "$1" -eq 0 ]; then pass "$2"; else fail_test "$2" "exit=$1"; fi; }
assert_exit_zero_msg "$T5B_EXIT" "T5: second re-run exits 0"

T5_SECOND_BODY=$(grep -v '^# Generated by install.sh on ' "$T5_ENV_FILE")
if [ "$T5_FIRST_BODY" = "$T5_SECOND_BODY" ]; then
  pass "T5: .env body byte-identical after second re-run (merge idempotent)"
else
  fail_test "T5: .env body diverged on second re-run" \
    "diff: $(diff <(printf '%s\n' "$T5_FIRST_BODY") <(printf '%s\n' "$T5_SECOND_BODY") | head -20)"
fi

# No duplicate migration headers after second re-run
T5_HEADER_COUNT=$(grep -cE '^# --- Added by v0.6 migration on' "$T5_ENV_FILE")
assert_eq "T5: exactly one dated migration header after two re-runs" "$T5_HEADER_COUNT" "1"

# ─── T6: delta summary prints on re-run, not on fresh install (Part C) ───────
echo ""
echo "=== T6: post-install delta summary is gated on UM_WAS_EXISTING_INSTALL ==="

# T6a: fresh-install output from T1 run — must NOT contain the delta block.
# (T1 started with no .env, so UM_WAS_EXISTING_INSTALL=0 → summary suppressed.)
if printf '%s\n' "$T1_OUT" | grep -q 'v0.5 → v0.6 changes applied'; then
  fail_test "T6a: fresh-install suppresses delta summary" \
    "fresh T1 output should NOT print 'v0.5 → v0.6 changes applied' — got: $(printf '%s\n' "$T1_OUT" | grep -A1 'v0.5')"
else
  pass "T6a: fresh-install suppresses delta summary"
fi

# T6b: T5's re-run output MUST include the delta summary, since T5 pre-seeded
# an existing .env before running install.
if printf '%s\n' "$T5_OUT" | grep -q 'v0.5 → v0.6 changes applied'; then
  pass "T6b: re-run prints delta summary"
else
  fail_test "T6b: re-run should print delta summary" \
    "T5 output tail: $(printf '%s\n' "$T5_OUT" | tail -20)"
fi

# T6c: UM_QUIET=1 suppresses the summary even on re-runs.
echo ""
echo "=== T6c: UM_QUIET=1 suppresses delta summary on re-run ==="
T6C="$TMPROOT/t6c"
T6C_HOME="$T6C/home"
T6C_STAGE="$T6C/stage"
mkdir -p "$T6C_HOME/vault" "$T6C_HOME/plugins"
touch "$T6C_HOME/.bashrc"
make_fakebin "$T6C/bin"
stage_install_dir "$T6C_STAGE"
T6C_ENV_FILE="$T6C_STAGE/server/.env"

# Seed a basic v0.5 .env to make it an "upgrade"
cat > "$T6C_ENV_FILE" <<EOF
OPENAI_API_KEY=sk-old-key
MEM0_USER_ID=b5user
MEM0_MCP_PORT=6335
UM_VAULT_DIR=$T6C_HOME/vault
UM_SUMMARY_ENABLED=true
UM_TEMPORAL_DECAY=false
EOF

T6C_EXIT=0
T6C_OUT=$(env \
    PATH="$T6C/bin:$PATH" \
    HOME="$T6C_HOME" \
    UM_INSTALL_DIR="$T6C_STAGE" \
    UM_NONINTERACTIVE=1 \
    UM_QUIET=1 \
    OPENAI_API_KEY=sk-testkey12345 \
    UM_OPENAI_API_KEY=sk-testkey12345 \
    MEM0_USER_ID=b5user \
    MEM0_MCP_PORT=6335 \
    UM_VAULT_DIR="$T6C_HOME/vault" \
    UM_SUMMARY_ENABLED=true \
    UM_TEMPORAL_DECAY=false \
    UM_SKIP_KEY_VALIDATION=1 \
    UM_SKIP_DOCKER=1 \
    CLAUDE_PLUGINS_DIR="$T6C_HOME/plugins" \
    SHELL=/bin/bash \
    bash "$T6C_STAGE/installer/install.sh" --server --yes 2>&1) || T6C_EXIT=$?
assert_exit_zero_msg "$T6C_EXIT" "T6c: install with UM_QUIET=1 exits 0"

if printf '%s\n' "$T6C_OUT" | grep -q 'v0.5 → v0.6 changes applied'; then
  fail_test "T6c: UM_QUIET=1 suppresses delta summary" "saw banner despite UM_QUIET=1"
else
  pass "T6c: UM_QUIET=1 suppresses delta summary"
fi

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
