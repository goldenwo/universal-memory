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

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
