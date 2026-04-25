#!/usr/bin/env bash
# installer/lib/marker-block.test.sh — Task B.5 Part A trailer test
#
# Asserts that _write_marker_block emits the UM_AUTH_TOKEN auto-export trailer
# BEFORE the PATH guard line. This ordering matters for set -e users: if the
# trailer is the last command and ~/.um/auth-token is absent, the final exit
# status of sourcing the rc file is 1, which some shell configurations surface
# in prompts or test harnesses. Keeping the unconditional PATH-guard `export`
# as the final command guarantees the block ends with exit 0.
#
# V2 verification (commit e0a5a7f) docs/research/2026-04-24-v0.6-verifications/
# V2-marker-trailer.md §6.2 explicitly flagged this ordering as the correct
# fix — the v0.6 spec's original "after" wording was unsafe.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=./marker-block.sh
source "$REPO/installer/lib/marker-block.sh"

fails=0
assert() {
  local cond="$1" msg="$2"
  if ! eval "$cond"; then
    echo "FAIL: $msg"
    fails=$((fails + 1))
  else
    echo "  PASS: $msg"
  fi
}

# ─── Setup ────────────────────────────────────────────────────────────────
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

UM_SERVER_URL="http://localhost:6335" \
UM_LIB_DIR="$HOME/.local/share/um/lib" \
UM_CLI_DIR="$HOME/.local/share/um/cli" \
  _write_marker_block "$tmp" "test-key" "openai"

# ─── Assertions: trailer presence + exact form ──────────────────────────────
# shellcheck disable=SC2034  # consumed by `assert` via single-quoted bash strings (eval)
trailer_text=$(grep 'auth-token' "$tmp" | head -1 || true)
assert '[ -n "$trailer_text" ]' 'marker block contains auth-token trailer'
assert '[[ "$trailer_text" == *"[ -r"*"auth-token"*"]"* ]]' 'exact trailer form matches spec ([ -r … auth-token ])'
assert '[[ "$trailer_text" == *"export UM_AUTH_TOKEN="* ]]' 'trailer exports UM_AUTH_TOKEN'
assert '[[ "$trailer_text" == *"cat"*"auth-token"* ]]' 'trailer reads ~/.um/auth-token via cat'

# ─── Ordering: trailer MUST come BEFORE PATH guard (V2 set -e safety) ───────
trailer_line=$(grep -n 'auth-token' "$tmp" | head -1 | cut -d: -f1)
pathguard_line=$(grep -n 'PATH=' "$tmp" | head -1 | cut -d: -f1)
assert '[ -n "$trailer_line" ] && [ -n "$pathguard_line" ] && [ "$trailer_line" -lt "$pathguard_line" ]' \
  "trailer (line $trailer_line) precedes PATH guard (line $pathguard_line) — set -e safety"

# ─── No single-quote escaping artefacts (trailer is a static literal) ───────
# Ensures the trailer line itself was not run through _marker_escape_sq — the
# line should contain literal double-quotes around $HOME path, not SQ-escape.
assert '[[ "$trailer_text" == *"\"\$HOME/.um/auth-token\""* ]]' 'trailer uses double-quoted $HOME path (literal, not SQ-escaped)'

# ─── Idempotency: re-running produces the same trailer exactly once ─────────
UM_SERVER_URL="http://localhost:6335" \
UM_LIB_DIR="$HOME/.local/share/um/lib" \
UM_CLI_DIR="$HOME/.local/share/um/cli" \
  _write_marker_block "$tmp" "test-key" "openai"
trailer_count=$(grep -c 'auth-token' "$tmp" || true)
assert '[ "$trailer_count" = "1" ]' "trailer appears exactly once after re-run (got $trailer_count)"

# ─── Marker block sentinels present ─────────────────────────────────────────
assert 'grep -qF "universal-memory (auto-added" "$tmp"' 'block start sentinel present'
assert 'grep -qF "end universal-memory" "$tmp"    ' 'block end sentinel present'

echo ""
if [ "$fails" -eq 0 ]; then
  echo "PASS (all assertions)"
  exit 0
else
  echo "$fails failures"
  exit 1
fi
