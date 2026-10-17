#!/bin/bash
# um-preview.test.sh — verify the preview CLI outputs a draft state.md without writing
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/um-preview"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

make_fake_openai() {
  local outdir="$1" summary_body="$2"
  mkdir -p "$outdir"
  cat > "$outdir/curl" <<BIN
#!/bin/bash
# Fake curl: returns OpenAI-shaped JSON with \$summary_body as content
cat <<'JSON'
{"choices":[{"message":{"content":"$summary_body"}}]}
JSON
BIN
  chmod +x "$outdir/curl"
}

# ─── Test 1: happy path — preview emits draft, state.md NOT written ─────────
echo "=== T1: um-preview emits draft state.md without writing ==="
tmp=$(mktemp -d)
export UM_VAULT_DIR="$tmp/vault"
export UM_OPENAI_API_KEY="sk-fake"
mkdir -p "$UM_VAULT_DIR/captures/test-proj/raw"
printf '# 2026-04-20T12:00Z\nUser: fixed auth bug via JWT refactor\nThis is a longer capture so we clear the 50-char transcript-length guard in summarize.sh.\n' > "$UM_VAULT_DIR/captures/test-proj/raw/$(date -u +%Y-%m-%d).md"

# Mock curl to feed canned summary for BOTH summarize.sh and update-state.sh calls
# (They both call curl; make_fake_openai returns the same canned body for any call)
fake_bin="$tmp/bin"
make_fake_openai "$fake_bin" "---\nschema_version: 1\ntype: state\nid: state-test-proj\ntitle: State of play — test-proj\nstatus: current\nvalid_from: 2026-04-20T12:00:00Z\nproject: test-proj\n---\n\n# State of play\n\n## Current focus\nAuth refactor complete.\n\n## In flight\n- JWT testing\n\n## Recent decisions\n- Use RS256\n\n## Next actions\n- Deploy staging\n\n## Open questions\n- Key rotation cadence\n\n## Environment\n- branch: main"

T1_OUT=$(PATH="$fake_bin:$PATH" bash "$BIN" --project test-proj 2>&1) || T1_EXIT=$?
T1_EXIT=${T1_EXIT:-0}

if [ "$T1_EXIT" -eq 0 ]; then pass "T1: exits 0"; else fail "T1: expected exit 0, got $T1_EXIT (output: $T1_OUT)"; fi
if echo "$T1_OUT" | grep -q "# State of play"; then pass "T1: H1 present"; else fail "T1: no H1 in output (got: $T1_OUT)"; fi
if echo "$T1_OUT" | grep -q "## Current focus"; then pass "T1: Current focus section present"; else fail "T1: no Current focus section"; fi
# Crucially: state.md must NOT have been written
if [ ! -f "$UM_VAULT_DIR/state/test-proj/state.md" ]; then pass "T1: state.md NOT written"; else fail "T1: state.md was written (preview shouldn't write)"; fi
# No lockdir left behind
if [ ! -d "$UM_VAULT_DIR/state/test-proj/state.md.lockdir" ]; then pass "T1: no lockdir"; else fail "T1: lockdir left behind"; fi
rm -rf "$tmp"

# ─── Test 2: no captures for today → user-friendly error ─────────────────
echo ""
echo "=== T2: No captures for today shows friendly error ==="
tmp=$(mktemp -d)
export UM_VAULT_DIR="$tmp/vault"
mkdir -p "$UM_VAULT_DIR/captures/empty-proj/raw"
# Do NOT create today's raw file

T2_OUT=$(bash "$BIN" --project empty-proj 2>&1) || T2_EXIT=$?
T2_EXIT=${T2_EXIT:-0}

if [ "$T2_EXIT" -ne 0 ]; then pass "T2: non-zero exit on missing captures"; else fail "T2: should exit non-zero when no captures"; fi
if echo "$T2_OUT" | grep -qi "no captures\|captures for today"; then pass "T2: user-friendly message shown"; else fail "T2: no friendly message (got: $T2_OUT)"; fi
rm -rf "$tmp"

# Stub `claude` for the claude-agent-sdk tests: the merge step's prompt ends
# with "Produce the updated state.md", so it gets $STUB_STATE_FILE back; the
# summarize step gets a one-line summary. Every call is logged.
make_fake_claude() {
  local outdir="$1"
  mkdir -p "$outdir"
  cat > "$outdir/claude" <<'BIN'
#!/bin/bash
input=$(cat)
echo "claude $*" >> "$CALL_LOG"
case "$input" in
  *"Produce the updated state.md"*) cat "$STUB_STATE_FILE" ;;
  *) echo "Claude summary: fixed auth bug via JWT refactor." ;;
esac
BIN
  # curl must never be reached on the claude-agent-sdk path.
  cat > "$outdir/curl" <<'BIN'
#!/bin/bash
echo "curl $*" >> "$CALL_LOG"
exit 7
BIN
  chmod +x "$outdir/claude" "$outdir/curl"
}

# ─── Test 3 (#385): claude-agent-sdk with no OpenAI key prints the draft ─────
echo ""
echo "=== T3: UM_SUMMARIZER=claude-agent-sdk, no OpenAI key → draft printed ==="
tmp=$(mktemp -d)
export UM_VAULT_DIR="$tmp/vault"
mkdir -p "$UM_VAULT_DIR/captures/sdk-proj/raw"
printf '# 2026-04-20T12:00Z\nUser: fixed auth bug via JWT refactor\nThis is a longer capture so we clear the 50-char transcript-length guard in summarize.sh.\n' > "$UM_VAULT_DIR/captures/sdk-proj/raw/$(date -u +%Y-%m-%d).md"
fake_bin="$tmp/bin"
make_fake_claude "$fake_bin"
export CALL_LOG="$tmp/calls.log" STUB_STATE_FILE="$tmp/state-reply.md"
printf -- '---\nschema_version: 1\ntype: state\nid: state-sdk-proj\nproject: sdk-proj\n---\n\n# State of play\n\n## Current focus\nAuth refactor via claude.\n\n## In flight\n- JWT testing\n\n## Recent decisions\n- Use RS256\n\n## Next actions\n- Deploy staging\n\n## Open questions\n- Key rotation cadence\n\n## Environment\n- branch: main\n' > "$STUB_STATE_FILE"

T3_EXIT=0
T3_OUT=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY PATH="$fake_bin:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$BIN" --project sdk-proj 2>/dev/null) || T3_EXIT=$?

if [ "$T3_EXIT" -eq 0 ]; then pass "T3: exits 0"; else fail "T3: expected exit 0, got $T3_EXIT"; fi
if echo "$T3_OUT" | grep -q "Auth refactor via claude"; then pass "T3: draft from claude printed"; else fail "T3: no draft on stdout (got: '$T3_OUT')"; fi
if [ "$(grep -c '^claude ' "$CALL_LOG" 2>/dev/null || true)" = "2" ]; then pass "T3: claude ran for both steps"; else fail "T3: expected 2 claude calls (log: $(cat "$CALL_LOG" 2>/dev/null))"; fi
if ! grep -q '^curl ' "$CALL_LOG" 2>/dev/null; then pass "T3: OpenAI never called"; else fail "T3: curl was called (log: $(cat "$CALL_LOG"))"; fi
if [ ! -f "$UM_VAULT_DIR/state/sdk-proj/state.md" ]; then pass "T3: state.md NOT written"; else fail "T3: state.md was written"; fi
rm -rf "$tmp"

# ─── Test 4 (#385): an empty draft says why instead of printing nothing ─────
echo ""
echo "=== T4: merge step returns nothing → non-zero exit with a reason ==="
tmp=$(mktemp -d)
export UM_VAULT_DIR="$tmp/vault"
mkdir -p "$UM_VAULT_DIR/captures/sdk-proj/raw"
printf '# 2026-04-20T12:00Z\nUser: fixed auth bug via JWT refactor\nThis is a longer capture so we clear the 50-char transcript-length guard in summarize.sh.\n' > "$UM_VAULT_DIR/captures/sdk-proj/raw/$(date -u +%Y-%m-%d).md"
fake_bin="$tmp/bin"
make_fake_claude "$fake_bin"
export CALL_LOG="$tmp/calls.log" STUB_STATE_FILE="$tmp/state-reply.md"
# A reply with no frontmatter or sections: update-state.sh rejects it, and
# with no OpenAI key there is no fallback, so the draft is empty.
printf 'Sorry, I cannot produce that.\n' > "$STUB_STATE_FILE"

T4_EXIT=0
T4_OUT=$(env -u UM_OPENAI_API_KEY -u OPENAI_API_KEY PATH="$fake_bin:$PATH" UM_SUMMARIZER=claude-agent-sdk \
  bash "$BIN" --project sdk-proj 2>&1) || T4_EXIT=$?

if [ "$T4_EXIT" -ne 0 ]; then pass "T4: non-zero exit on an empty draft"; else fail "T4: expected non-zero exit, got 0 (output: '$T4_OUT')"; fi
if echo "$T4_OUT" | grep -q "um-preview: .*empty draft"; then pass "T4: says the draft is empty"; else fail "T4: no empty-draft message (got: '$T4_OUT')"; fi
rm -rf "$tmp"

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
