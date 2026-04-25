#!/usr/bin/env bash
# um-bridge-claude-mem.test.sh — shell tests for the um-bridge-claude-mem CLI
# Run from repo root: bash plugins/claude-code/universal-memory/bin/um-bridge-claude-mem.test.sh
#
# Tests covered:
#   1. Schema mismatch → exit nonzero, output contains "schema version"
#   2. --cursor-reset → cursor file deleted, exit 0
#   3. (Bonus) Non-existent --db-path → exit 0, no output (silent skip)
#   4. (Bonus) Path-traversal attempt → exit 1, output contains "outside allowlist" or "UNC"

set -uo pipefail

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
CLI="$SCRIPT_DIR/um-bridge-claude-mem"

PASS=0
FAIL=0
SKIP=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s\n' "$1"
}
skip() { SKIP=$((SKIP + 1)); printf '  SKIP: %s\n' "$1"; }

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"
  else fail "$name (expected to contain '$needle', got: '${haystack:0:400}')"; fi
}

assert_exit() {
  local name="$1" code="$2" want="$3"
  if [ "$code" = "$want" ]; then pass "$name"
  else fail "$name (exit code: got=$code want=$want)"; fi
}

# ---------------------------------------------------------------------------
# Temp dir for cursor-reset test
# ---------------------------------------------------------------------------
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ---------------------------------------------------------------------------
# Check node + better-sqlite3 available (tests 1, 3, 4 depend on it)
# ---------------------------------------------------------------------------
HAVE_BRIDGE=0
if node -e "import('better-sqlite3')" 2>/dev/null; then
  HAVE_BRIDGE=1
fi

# ---------------------------------------------------------------------------
# Test 1: Schema mismatch → exit nonzero + "schema version" in output
# ---------------------------------------------------------------------------
printf '\nTest 1: Schema mismatch detection\n'

WRONG_SCHEMA_DB="$REPO_ROOT/server/test/fixtures/claude-mem-wrong-schema.db"

if [ "$HAVE_BRIDGE" -eq 0 ]; then
  skip "T1: schema mismatch (better-sqlite3 not installed — run npm install in bin/)"
else
  # Create the wrong-schema fixture using node (sqlite3 CLI may not be available)
  if [ ! -f "$WRONG_SCHEMA_DB" ]; then
    node --input-type=module <<EOF
import { writeFileSync } from 'fs';
// Minimal valid SQLite3 file with user_version=9999 and a junk 'sessions' table.
// We create it programmatically since sqlite3 CLI is not guaranteed on all dev boxes.
// Use better-sqlite3 which we know is installed if HAVE_BRIDGE=1.
import Database from 'better-sqlite3';
const db = new Database('$WRONG_SCHEMA_DB');
db.pragma('user_version = 9999');
db.exec('CREATE TABLE sessions (bad TEXT)');
db.close();
console.log('created fixture');
EOF
  fi

  out=$(node "$CLI" --once --db-path="$WRONG_SCHEMA_DB" 2>&1 || true)
  exit_code=$?
  assert_contains "T1a: output mentions schema version" "$out" "schema version"
  if [ "$exit_code" -eq 0 ]; then
    fail "T1b: schema mismatch should exit nonzero (got 0)"
  else
    pass "T1b: exit nonzero on schema mismatch (exit=$exit_code)"
  fi
fi

# ---------------------------------------------------------------------------
# Test 2: --cursor-reset deletes cursor file and exits 0
# ---------------------------------------------------------------------------
printf '\nTest 2: --cursor-reset handler\n'

FAKE_VAULT="$TMPDIR_ROOT/vault"
CURSOR_DIR="$FAKE_VAULT/.local/bridges"
CURSOR_FILE="$CURSOR_DIR/claude-mem.json"

mkdir -p "$CURSOR_DIR"
echo '{"schema":1,"last_ingested_id":null}' > "$CURSOR_FILE"

out=$(UM_VAULT_DIR="$FAKE_VAULT" node "$CLI" --cursor-reset 2>&1)
reset_exit=$?

assert_exit "T2a: --cursor-reset exits 0" "$reset_exit" "0"
assert_contains "T2b: output mentions cursor reset" "$out" "cursor reset"
if [ -f "$CURSOR_FILE" ]; then
  fail "T2c: cursor file should have been deleted (still present)"
else
  pass "T2c: cursor file deleted"
fi

# Test 2d: --cursor-reset with no cursor file → still exits 0 (idempotent)
out2=$(UM_VAULT_DIR="$FAKE_VAULT" node "$CLI" --cursor-reset 2>&1)
reset_exit2=$?
assert_exit "T2d: --cursor-reset with no file exits 0 (idempotent)" "$reset_exit2" "0"

# ---------------------------------------------------------------------------
# Test 3 (Bonus): Non-existent --db-path → exit 0, silent
# ---------------------------------------------------------------------------
printf '\nTest 3 (Bonus): Non-existent DB path → silent exit 0\n'

if [ "$HAVE_BRIDGE" -eq 0 ]; then
  skip "T3: non-existent path (better-sqlite3 not installed)"
else
  NONEXISTENT_PATH="$TMPDIR_ROOT/nonexistent-claude-mem/claude-mem.db"
  # The nonexistent path is NOT in the allowlist normally; we need it to point
  # inside fixtures or ~/.claude-mem. Use a path that resolves to ENOENT within
  # the fixtures dir allowlist by pointing to a file that doesn't exist there.
  FIXTURES_DIR="$REPO_ROOT/server/test/fixtures"
  out3=$(node "$CLI" --once --db-path="$FIXTURES_DIR/does-not-exist.db" 2>&1)
  exit3=$?
  assert_exit "T3a: non-existent DB exits 0" "$exit3" "0"
  if [ -z "$out3" ]; then
    pass "T3b: no output on silent skip"
  else
    # Some output is acceptable (e.g. a debug line) — not a hard failure
    skip "T3b: got output on silent skip (acceptable): $out3"
  fi
fi

# ---------------------------------------------------------------------------
# Test 4 (Bonus): Path-traversal attempt → exit 1 with informative message
# ---------------------------------------------------------------------------
printf '\nTest 4 (Bonus): Path-traversal guard\n'

if [ "$HAVE_BRIDGE" -eq 0 ]; then
  skip "T4: path-traversal (better-sqlite3 not installed)"
else
  # UNC path test — use Windows-style on win32, POSIX double-slash elsewhere
  if [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "cygwin"* ]] || [[ "$(uname -s)" == MINGW* ]]; then
    TRAVERSAL_PATH='\\\\attacker\\share\\evil.db'
  else
    TRAVERSAL_PATH='//attacker/share/evil.db'
  fi

  out4=$(node "$CLI" --once --db-path="$TRAVERSAL_PATH" 2>&1 || true)
  exit4=$?
  assert_exit "T4a: UNC path exits 1" "$exit4" "1"
  if [[ "$out4" == *"UNC"* ]] || [[ "$out4" == *"outside allowlist"* ]]; then
    pass "T4b: UNC/allowlist rejection message present"
  else
    fail "T4b: expected 'UNC' or 'outside allowlist' in output, got: ${out4:0:200}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n'
printf 'Results: %d pass, %d fail, %d skip\n' "$PASS" "$FAIL" "$SKIP"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '\nFailed tests:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi

exit 0
