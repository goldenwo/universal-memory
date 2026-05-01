#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$SCRIPT_DIR/install.sh"
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1" >&2; }

# Portable mktemp subdirectory: mktemp -d -p is GNU-only; macOS requires TMPDIR=.
mktemp_in() { TMPDIR="$1" mktemp -d; }

# v0.7 note: T1–T12 input streams updated for the new 4-path provider menu.
# v0.6 fed `\n` for the openai-key prompt; v0.7 replaces that with
# wizard_menu_providers, which expects a path number (1-4). We use path 4
# ("Skip — I'll edit .env myself") here because these tests cover the
# dispatcher / summary flow, not provider selection. Provider selection is
# tested in F4 below.

# T1: Wizard option 1 (Everything detected) fires server + cli delegates
# Input: 1 (component menu) + blank (vault default) + 4 (skip provider menu) + Y (proceed)
T1=$(mktemp_in "$TMPROOT")
OUT=$(printf '1\n\n4\nY\n' | HOME="$T1" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: server/install.sh"; then pass "T1: wizard option 1 → server delegate fires"
else fail "T1: wizard option 1 did not trigger server install; out: $(echo "$OUT" | head -20)"; fi

# T2: Wizard option 3 (CLI-only) + custom server URL
# Input: 3 (component menu) + URL + blank (vault) + 4 (skip provider menu) + Y (proceed)
T2=$(mktemp_in "$TMPROOT")
OUT=$(printf '3\nhttp://pi.local:6335\n\n4\nY\n' | HOME="$T2" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: installer/install-cli.sh"; then pass "T2: wizard option 3 → cli delegate fires"
else fail "T2: wizard option 3 did not trigger cli install; out: $(echo "$OUT" | head -20)"; fi

# T3: Invalid menu choices retry before succeeding (anchored to dispatcher pre-menu)
# Input: X (invalid) + 99 (invalid) + 4 (valid component) + blank (vault) + 4 (skip provider) + Y (proceed)
# wizard_menu_providers' path 4 has its own "Invalid choice" loop, so we count
# only the "Invalid choice" messages emitted BEFORE the "Provider setup:" banner
# to anchor the assertion to wizard_menu_main's retries (the dispatcher), not
# the provider sub-menu's retries. If the wizard_menu_main retry loop is broken,
# the X+99 invalids would not be re-emitted and BEFORE_COUNT would drop to 0.
mkdir -p "$TMPROOT/t3"
OUT=$(printf 'X\n99\n4\n\n4\nY\n' | HOME="$TMPROOT/t3" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
BEFORE_MENU=$(echo "$OUT" | awk '/Provider setup:/{exit} {print}')
BEFORE_COUNT=$(echo "$BEFORE_MENU" | grep -c "Invalid choice" || true)
if [[ "$BEFORE_COUNT" -ge 2 ]]; then pass "T3: dispatcher retries on invalid pre-menu ($BEFORE_COUNT invalid-choice messages before provider menu)"
else fail "T3: expected ≥2 'Invalid choice' messages before 'Provider setup:', got $BEFORE_COUNT; out: $(echo "$OUT" | head -20)"; fi

# T4: Wizard option 2 (Just Claude Code plugin)
# Input: 2 (component menu) + blank (vault) + 4 (skip provider) + Y (proceed)
T4=$(mktemp_in "$TMPROOT")
OUT=$(printf '2\n\n4\nY\n' | HOME="$T4" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: installer/install-plugin-cc.sh"; then pass "T4: wizard option 2 → plugin-cc delegate fires"
else fail "T4: wizard option 2 did not trigger plugin-cc install; out: $(echo "$OUT" | head -20)"; fi

# T5: Wizard option 4 (Server only)
# Input: 4 (component menu) + blank (vault) + 4 (skip provider) + Y (proceed)
T5=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n4\nY\n' | HOME="$T5" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: server/install.sh"; then pass "T5: wizard option 4 → server delegate fires"
else fail "T5: wizard option 4 did not trigger server install; out: $(echo "$OUT" | head -20)"; fi

# T6: Wizard option 5 (Custom) — server + cli, decline plugins
# Input: 5 (component menu) + Y (server) + n (cc) + n (codex) + Y (cli) + blank (vault) + 4 (skip provider) + Y (proceed)
T6=$(mktemp_in "$TMPROOT")
OUT=$(printf '5\nY\nn\nn\nY\n\n4\nY\n' | HOME="$T6" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "delegate: server/install.sh" && echo "$OUT" | grep -q "delegate: installer/install-cli.sh"; then
  pass "T6: custom → server + cli both fire"
else fail "T6: custom did not fire both delegates; out: $(echo "$OUT" | head -25)"; fi

# T7: Decline proceed — should abort with "Aborted."
# Input: 1 (component menu) + blank (vault) + 4 (skip provider) + n (decline proceed)
T7=$(mktemp_in "$TMPROOT")
OUT=$(printf '1\n\n4\nn\n' | HOME="$T7" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "Aborted"; then pass "T7: decline proceed aborts cleanly"
else fail "T7: expected 'Aborted.' in output; out: $(echo "$OUT" | head -20)"; fi

# T8: --interactive with pre-seeded --cli flag — wizard still runs
# (--interactive forces wizard regardless of other component flags)
T8=$(mktemp_in "$TMPROOT")
OUT=$(printf '1\n\n4\nY\n' | HOME="$T8" UM_DRY_RUN=1 bash "$INSTALL" --interactive --cli --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "universal-memory v0.5.0 installer"; then pass "T8: --interactive + --cli still runs wizard"
else fail "T8: wizard didn't run with --interactive --cli; out: $(echo "$OUT" | head -15)"; fi

# T9: Wizard header shows v0.5.0
T9=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n4\nY\n' | HOME="$T9" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "v0.5.0"; then pass "T9: wizard header shows v0.5.0"
else fail "T9: v0.5.0 not found in wizard output; out: $(echo "$OUT" | head -5)"; fi

# T10: wizard_detect_env prints environment detection block
T10=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n4\nY\n' | HOME="$T10" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "Detected environment"; then pass "T10: wizard shows 'Detected environment' block"
else fail "T10: 'Detected environment' not found; out: $(echo "$OUT" | head -10)"; fi

# T11: wizard_summarize shows "About to install:" before execution
T11=$(mktemp_in "$TMPROOT")
OUT=$(printf '4\n\n4\nY\n' | HOME="$T11" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "About to install:"; then pass "T11: wizard shows 'About to install:' summary"
else fail "T11: 'About to install:' not found in output; out: $(echo "$OUT" | head -20)"; fi

# T12: option 3 custom server URL appears in summary
T12=$(mktemp_in "$TMPROOT")
OUT=$(printf '3\nhttp://pi.local:6335\n\n4\nY\n' | HOME="$T12" UM_DRY_RUN=1 bash "$INSTALL" --interactive --dry-run 2>&1 || true)
if echo "$OUT" | grep -q "pi.local:6335"; then pass "T12: custom server URL appears in wizard summary"
else fail "T12: custom server URL not found in summary; out: $(echo "$OUT" | head -20)"; fi

# ─── F1: wizard_select unit tests ─────────────────────────────────────────────
# Source wizard-lib.sh to test wizard_select directly via canned stdin.

# shellcheck source=installer/wizard-lib.sh
. "$SCRIPT_DIR/wizard-lib.sh"

assert_eq() {
  # assert_eq <actual> <expected> <label>
  if [ "$1" = "$2" ]; then pass "$3"
  else fail "$3 (expected=$2 actual=$1)"; fi
}

assert_ne() {
  if [[ "$1" != "$2" ]]; then
    pass "$3"
  else
    fail "$3 (got '$1', expected NOT '$2')"
  fi
}

assert_nocontains() {
  if [[ "$1" != *"$2"* ]]; then
    pass "$3"
  else
    fail "$3 (got '$1' which contains '$2')"
  fi
}

test_wizard_select_basic() {
  # Use a here-string so wizard_select runs in the current shell (printf -v
  # modifies $CHOICE in this scope). A `... | wizard_select` pipe would put it in a
  # subshell and the assignment would be lost.
  CHOICE=""
  wizard_select CHOICE "Pick one:" alpha beta gamma <<< $'2\n' >/dev/null
  assert_eq "$CHOICE" "beta" "F1.T1: wizard_select selects option 2 (beta)"
}

test_wizard_select_reprompts_on_invalid() {
  CHOICE=""
  wizard_select CHOICE "Pick:" alpha beta <<< $'bogus\n9\n1\n' >/dev/null
  assert_eq "$CHOICE" "alpha" "F1.T2: wizard_select re-prompts on bogus + out-of-range, accepts 1 (alpha)"
}

test_wizard_select_eof_returns_nonzero() {
  unset CHOICE
  if wizard_select CHOICE "Pick:" alpha beta < /dev/null; then
    fail "F1.T3: expected non-zero on EOF, got 0"
  else
    pass "F1.T3: wizard_select returns non-zero on EOF"
  fi
}

test_wizard_select_empty_opts_returns_nonzero() {
  unset CHOICE
  if wizard_select CHOICE "Pick:"; then
    fail "F1.T4: expected non-zero on empty opts, got 0"
  else
    pass "F1.T4: wizard_select returns non-zero on empty opts"
  fi
}

test_wizard_select_basic
test_wizard_select_reprompts_on_invalid
test_wizard_select_eof_returns_nonzero
test_wizard_select_empty_opts_returns_nonzero

# ─── F2: wizard_validate_api_key unit tests ──────────────────────────────────
# Use here-strings/here-docs (NOT pipes) so wizard_validate_api_key runs in the
# current shell and `export "$var"` is visible to the assertions. A
# `printf … | wizard_validate_api_key` pipe would put the function in a
# subshell and the export would be lost.

test_wizard_validate_anthropic_key_format() {
  unset ANTHROPIC_API_KEY
  wizard_validate_api_key anthropic ANTHROPIC_API_KEY <<< 'sk-ant-realkey' >/dev/null
  assert_eq "$ANTHROPIC_API_KEY" "sk-ant-realkey" "F2.T3: anthropic format"
}

test_wizard_validate_google_key_format() {
  unset GOOGLE_API_KEY
  wizard_validate_api_key google GOOGLE_API_KEY <<< 'AIzaRealKey' >/dev/null
  assert_eq "$GOOGLE_API_KEY" "AIzaRealKey" "F2.T4: google AIza format"
}

test_wizard_validate_returns_1_on_eof() {
  unset OPENAI_API_KEY
  wizard_validate_api_key openai OPENAI_API_KEY < /dev/null >/dev/null
  assert_eq "$?" "1" "F2.T5: EOF/empty returns 1"
}

test_wizard_validate_unknown_provider() {
  wizard_validate_api_key cohere COHERE_KEY <<< 'whatever' 2>/dev/null
  assert_eq "$?" "1" "F2.T6: unknown provider returns 1"
}

test_wizard_validate_anthropic_key_format
test_wizard_validate_google_key_format
test_wizard_validate_returns_1_on_eof
test_wizard_validate_unknown_provider

# ─── F3: wizard_probe_ollama unit tests ──────────────────────────────────────

test_wizard_probe_ollama_reachable() {
  # Stub `curl` with a mock that always returns 0
  local stub_dir; stub_dir=$(mktemp -d)
  cat > "$stub_dir/curl" <<'EOF'
#!/bin/sh
echo "fake response"
exit 0
EOF
  chmod +x "$stub_dir/curl"
  PATH="$stub_dir:$PATH" wizard_probe_ollama "http://localhost:11434"
  assert_eq "$?" "0" "reachable host returns 0"
  rm -rf "$stub_dir"
}

test_wizard_probe_ollama_unreachable() {
  # Stub `curl` with a mock that always returns non-zero
  local stub_dir; stub_dir=$(mktemp -d)
  cat > "$stub_dir/curl" <<'EOF'
#!/bin/sh
exit 7  # connection refused
EOF
  chmod +x "$stub_dir/curl"
  PATH="$stub_dir:$PATH" wizard_probe_ollama "http://localhost:11434"
  assert_ne "$?" "0" "unreachable host returns non-zero"
  rm -rf "$stub_dir"
}

test_wizard_probe_ollama_reachable
test_wizard_probe_ollama_unreachable

# ─── F4: wizard_menu_providers + wizard_collect_keys tests ────────────────────
# Use here-docs (NOT pipes) so wizard_menu_providers runs in current shell and
# `export UM_*_PROVIDER` is visible to assertions. Pipes would put the function
# in a subshell and the export would be lost (same lesson as F1/F2).

test_wizard_menu_path1_openai_only() {
  unset UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER OPENAI_API_KEY UM_OPENAI_API_KEY
  wizard_menu_providers >/dev/null <<EOF
1
sk-validkey
EOF
  assert_eq "$UM_EMBEDDING_PROVIDER"  "openai" "F4.T1: path 1 sets embed=openai"
  assert_eq "$UM_SUMMARIZER_PROVIDER" "openai" "F4.T1: path 1 sets summ=openai"
  assert_eq "$UM_FACTS_PROVIDER"      "openai" "F4.T1: path 1 sets facts=openai"
  assert_eq "$OPENAI_API_KEY"         "sk-validkey" "F4.T1: path 1 collected key"
}

test_wizard_menu_path2_mix_anthropic_summ_openai_embed() {
  unset UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER OPENAI_API_KEY UM_OPENAI_API_KEY ANTHROPIC_API_KEY UM_ANTHROPIC_API_KEY
  # Path 2 → embed sub-picker pick 1 (openai), summ pick 2 (anthropic), facts pick 1 (openai).
  # embed_opts = (openai google ollama), so 1=openai.
  # summ_opts = (openai anthropic google ollama), so 2=anthropic.
  # facts_opts = (openai anthropic google ollama), so 1=openai.
  # Then collect_keys prompts for openai key + anthropic key (sorted-unique walk).
  wizard_menu_providers >/dev/null <<EOF
2
1
2
1
sk-ant-k
sk-openai-k
EOF
  assert_eq "$UM_EMBEDDING_PROVIDER"  "openai"    "F4.T2: path 2 mix embed=openai"
  assert_eq "$UM_SUMMARIZER_PROVIDER" "anthropic" "F4.T2: path 2 mix summ=anthropic"
  assert_eq "$UM_FACTS_PROVIDER"      "openai"    "F4.T2: path 2 mix facts=openai"
}

test_wizard_menu_path2_anthropic_hidden_under_embeddings() {
  unset UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER OPENAI_API_KEY UM_OPENAI_API_KEY
  # Path 2 → embed sub-picker should NOT list anthropic. Capture only the
  # embeddings prompt block (header line + the 3 numbered options) by grepping
  # the lines between "Embeddings provider:" and "Summarizer provider:".
  local output
  output=$(wizard_menu_providers 2>&1 <<EOF
2
1
1
1
sk-validkey
EOF
)
  # Extract just the embeddings sub-picker section.
  local embed_block
  embed_block=$(echo "$output" | awk '/Embeddings provider:/,/Summarizer provider:/')
  assert_nocontains "$embed_block" "anthropic" "F4.T3: anthropic must not appear in embeddings sub-picker"
}

test_wizard_menu_path3_local_ollama() {
  unset UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER OLLAMA_HOST
  local stub_dir; stub_dir=$(mktemp -d)
  cat > "$stub_dir/curl" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$stub_dir/curl"
  PATH="$stub_dir:$PATH" wizard_menu_providers >/dev/null <<EOF
3
http://localhost:11434
EOF
  assert_eq "$UM_EMBEDDING_PROVIDER"  "ollama" "F4.T4: path 3 sets embed=ollama"
  assert_eq "$UM_SUMMARIZER_PROVIDER" "ollama" "F4.T4: path 3 sets summ=ollama"
  assert_eq "$UM_FACTS_PROVIDER"      "ollama" "F4.T4: path 3 sets facts=ollama"
  rm -rf "$stub_dir"
}

test_wizard_menu_path4_skip_writes_placeholder_env() {
  # Path 4 should write .env from .env.example (best-effort) without prompting.
  # Run in a fresh tmpdir to avoid modifying the worktree, then assert exit 0.
  local tdir; tdir=$(mktemp -d)
  ( cd "$tdir" && wizard_menu_providers >/dev/null <<EOF
4
EOF
  )
  assert_eq "$?" "0" "F4.T5: path 4 exits success without prompts"
  rm -rf "$tdir"
}

test_wizard_menu_path1_openai_only
test_wizard_menu_path2_mix_anthropic_summ_openai_embed
test_wizard_menu_path2_anthropic_hidden_under_embeddings
test_wizard_menu_path3_local_ollama
test_wizard_menu_path4_skip_writes_placeholder_env

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
