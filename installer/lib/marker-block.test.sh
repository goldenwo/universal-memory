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
#
# Also asserts the block never carries the OpenAI key: not from the caller's
# env, not carried over from an old block (the rewrite is the migration), and
# a user's own export outside the block is left untouched.
#
# All assertions below pass single-quoted EXPRESSIONS to `assert`, which
# eval's them. Inside those literals, `$trailer_text` etc. are intentionally
# not expanded by THIS shell — eval expands them at assertion time. Disable
# SC2016 file-wide rather than at every site.
# shellcheck disable=SC2016
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
tdir=$(mktemp -d)
trap 'rm -f "$tmp"; rm -rf "$tdir"' EXIT

# A key in the caller's env must NOT reach the block (it used to, via a
# ${UM_OPENAI_API_KEY:-} fallback). Set one here so the no-key assertions
# below are not vacuous.
UM_OPENAI_API_KEY="sk-env-key-must-not-land" \
UM_SERVER_URL="http://localhost:6335" \
UM_LIB_DIR="$HOME/.local/share/um/lib" \
UM_CLI_DIR="$HOME/.local/share/um/cli" \
  _write_marker_block "$tmp" "openai"

# ─── No API key in the block ────────────────────────────────────────────────
assert '! grep -q "UM_OPENAI_API_KEY" "$tmp"' 'block has no UM_OPENAI_API_KEY line'
assert '! grep -q "sk-env-key-must-not-land" "$tmp"' 'key from the caller env is not written'
assert 'grep -qx "export UM_SUMMARIZER='"'"'openai'"'"'" "$tmp"' 'block still exports UM_SUMMARIZER'
assert 'grep -qx "export UM_SERVER_URL='"'"'http://localhost:6335'"'"'" "$tmp"' 'block still exports UM_SERVER_URL'

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
  _write_marker_block "$tmp" "openai"
trailer_count=$(grep -c 'auth-token' "$tmp" || true)
assert '[ "$trailer_count" = "1" ]' "trailer appears exactly once after re-run (got $trailer_count)"

# ─── Marker block sentinels present ─────────────────────────────────────────
assert 'grep -qF "universal-memory (auto-added" "$tmp"' 'block start sentinel present'
assert 'grep -qF "end universal-memory" "$tmp"    ' 'block end sentinel present'

# ─── Migration: an old block's key line is dropped by the rewrite ───────────
# Blocks written by earlier installers exported the OpenAI key. Rewriting the
# block (which every installer run does) is what removes it.
old_rc="$tdir/old-block.rc"
cat > "$old_rc" <<'RC'
# user line before
# --- universal-memory (auto-added by install.sh) ---
export UM_OPENAI_API_KEY='sk-old-key-in-block'
export UM_SUMMARIZER='openai'
export UM_SERVER_URL='http://old:6335'
# --- end universal-memory ---
# user line after
RC
UM_SERVER_URL="http://localhost:6335" _write_marker_block "$old_rc" "openai"
assert '! grep -q "UM_OPENAI_API_KEY" "$old_rc"' 'migration: old block key line removed on rewrite'
assert '! grep -q "sk-old-key-in-block" "$old_rc"' 'migration: old key value gone from the file'
assert '[ "$(grep -cF "# --- universal-memory (auto-added by install.sh) ---" "$old_rc")" = "1" ]' 'migration: exactly one block after rewrite'
assert '! grep -q "http://old:6335" "$old_rc"' 'migration: rest of the old block replaced too'
assert 'grep -qx "# user line before" "$old_rc" && grep -qx "# user line after" "$old_rc"' 'migration: user lines around the block kept'

# ─── A user's own export OUTSIDE the block is left untouched ────────────────
own_rc="$tdir/own-export.rc"
cat > "$own_rc" <<'RC'
export UM_OPENAI_API_KEY='sk-users-own-key'
# --- universal-memory (auto-added by install.sh) ---
export UM_SUMMARIZER='openai'
# --- end universal-memory ---
RC
own_before=$(grep -n "sk-users-own-key" "$own_rc")
_write_marker_block "$own_rc" "claude-agent-sdk"
assert '[ "$(grep -n "sk-users-own-key" "$own_rc")" = "$own_before" ]' "user's own export kept verbatim, same line ($own_before)"
assert '[ "$(grep -c "UM_OPENAI_API_KEY" "$own_rc")" = "1" ]' "only the user's own key line remains (block adds none)"
assert 'grep -qx "export UM_SUMMARIZER='"'"'claude-agent-sdk'"'"'" "$own_rc"' 'block rewritten with the new summarizer'

# ─── The old three-argument form is refused, nothing written ────────────────
# A stale caller passing (profile, key, summarizer) would put the key in the
# UM_SUMMARIZER slot. The function must refuse rather than write it.
stale_rc="$tdir/stale-caller.rc"
printf '# untouched\n' > "$stale_rc"
stale_rc_code=0
_write_marker_block "$stale_rc" "sk-stale-caller-key" "openai" 2>/dev/null || stale_rc_code=$?
assert '[ "$stale_rc_code" -ne 0 ]' "old three-argument call fails (rc $stale_rc_code)"
assert '! grep -q "sk-stale-caller-key" "$stale_rc"' 'old three-argument call writes no key'
assert '[ "$(cat "$stale_rc")" = "# untouched" ]' 'old three-argument call leaves the file unchanged'

echo ""
if [ "$fails" -eq 0 ]; then
  echo "PASS (all assertions)"
  exit 0
else
  echo "$fails failures"
  exit 1
fi
