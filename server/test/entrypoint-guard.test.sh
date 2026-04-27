#!/usr/bin/env bash
# server/test/entrypoint-guard.test.sh — verify entrypoint.sh's #28 guard.
#
# Run from repo root:
#   bash server/test/entrypoint-guard.test.sh
#
# We exercise the guard by stubbing `id` so the script sees whatever UID we
# want without needing actual root. Each test toggles env vars and verifies
# the entrypoint either exits 1 (refuse) or execs the inner command.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/../entrypoint.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=installer/lib/test-harness.sh
source "$REPO_ROOT/installer/lib/test-harness.sh"

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
  else fail "$name (got='$got' want='$want')"; fi
}
assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected '$needle', got: '${haystack:0:200}')"; fi
}

# Build a per-UID id stub directory we can prepend to PATH
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ROOT_STUB="$TMP/root"
NODE_STUB="$TMP/node"
mkdir -p "$ROOT_STUB" "$NODE_STUB"

cat > "$ROOT_STUB/id" <<'EOF'
#!/bin/sh
case "$1" in
  -u) echo 0 ;;
  *) echo "uid=0(root) gid=0(root)" ;;
esac
EOF
cat > "$NODE_STUB/id" <<'EOF'
#!/bin/sh
case "$1" in
  -u) echo 1000 ;;
  *) echo "uid=1000(node) gid=1000(node)" ;;
esac
EOF
chmod +x "$ROOT_STUB/id" "$NODE_STUB/id"

# Helper: run the entrypoint with a chosen id-stub dir and env overrides.
# All other PATH entries are preserved so cat/chmod/etc still work.
run_with() {
  local stub="$1"; shift
  PATH="$stub:$PATH" "$@" "$ENTRYPOINT" /bin/sh -c 'echo started'
}

# T1: root + writes + rw → REFUSE
printf '\nT1: root + UM_MCP_WRITE_ENABLED=true + UM_MOUNT_MODE=rw → exit 1\n'
_tx_capture T1 run_with "$ROOT_STUB" env UM_MCP_WRITE_ENABLED=true UM_MOUNT_MODE=rw UM_ENTRYPOINT_GUARD_DISABLE=0
assert_eq        "T1a: exit 1 when guard fires" "${TX_EXIT_T1:-unset}" "1"
assert_contains  "T1b: error message names root"   "${TX_OUT_T1:-}" "running as root"
assert_contains  "T1c: error message points to fix" "${TX_OUT_T1:-}" "UM_CONTAINER_USER"

# T2: non-root → ALLOW
printf '\nT2: non-root (UID=1000) + writes + rw → start command runs\n'
_tx_capture T2 run_with "$NODE_STUB" env UM_MCP_WRITE_ENABLED=true UM_MOUNT_MODE=rw
assert_eq       "T2a: exit 0 with non-root UID" "${TX_EXIT_T2:-unset}" "0"
assert_contains "T2b: command actually runs"     "${TX_OUT_T2:-}" "started"

# T3: root + writes-disabled → ALLOW (only one of three conditions)
printf '\nT3: root + writes-disabled → start command runs (only 1/3 conditions)\n'
_tx_capture T3 run_with "$ROOT_STUB" env UM_MCP_WRITE_ENABLED=false UM_MOUNT_MODE=rw
assert_eq       "T3a: exit 0 when writes disabled" "${TX_EXIT_T3:-unset}" "0"
assert_contains "T3b: command actually runs"        "${TX_OUT_T3:-}" "started"

# T4: root + writes + ro mount → ALLOW
printf '\nT4: root + writes + ro mount → start command runs\n'
_tx_capture T4 run_with "$ROOT_STUB" env UM_MCP_WRITE_ENABLED=true UM_MOUNT_MODE=ro
assert_eq       "T4a: exit 0 when mount is ro" "${TX_EXIT_T4:-unset}" "0"
assert_contains "T4b: command actually runs"    "${TX_OUT_T4:-}" "started"

# T5: explicit disable opt-out
printf '\nT5: UM_ENTRYPOINT_GUARD_DISABLE=1 bypasses guard\n'
_tx_capture T5 run_with "$ROOT_STUB" env UM_MCP_WRITE_ENABLED=true UM_MOUNT_MODE=rw UM_ENTRYPOINT_GUARD_DISABLE=1
assert_eq       "T5a: exit 0 with explicit opt-out" "${TX_EXIT_T5:-unset}" "0"
assert_contains "T5b: command actually runs"         "${TX_OUT_T5:-}" "started"

printf '\n---\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nFailed tests:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
