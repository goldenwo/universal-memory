#!/usr/bin/env bash
# install-plugin-codex.test.sh — tests for installer/install-plugin-codex.sh
#
# The installer registers the plugin through Codex's own marketplace commands,
# which install the same plugin tree Claude Code gets, hooks included. A fake
# `codex` on PATH records every call; no network. Rewritten 2026-10-20 when
# the copy of an MCP-only plugin into ~/.codex/plugins/universal-memory was
# retired: a 2026-10-20 clean-room run showed Codex never loads that directory.
#
# Run: bash installer/install-plugin-codex.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"

# shellcheck source=installer/lib/test-harness.sh
source "$REPO_ROOT/installer/lib/test-harness.sh"
PLUGIN_CODEX_SH="$SCRIPT_DIR/install-plugin-codex.sh"

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
  if [ "$got" = "$want" ]; then pass "$name"; else fail_test "$name" "got [$got], want [$want]"; fi
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
assert_absent() {
  local name="$1" file="$2"
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then pass "$name"; else fail_test "$name" "unexpectedly present: $file"; fi
}
assert_exit_zero() {
  local name="$1" code="$2"
  if [ "$code" -eq 0 ]; then pass "$name"; else fail_test "$name" "exit code $code (expected 0)"; fi
}
assert_exit_nonzero() {
  local name="$1" code="$2"
  if [ "$code" -ne 0 ]; then pass "$name"; else fail_test "$name" "exit 0 (expected non-zero)"; fi
}

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# make_fakecodex <dir> — a fake `codex` that appends "<argv>|CODEX_HOME=<value>"
# to <dir>/codex.calls. Exit codes per step come from UM_TEST_CODEX_MKT_ADD_RC,
# UM_TEST_CODEX_UPGRADE_RC and UM_TEST_CODEX_ADD_RC (default 0). A successful
# `plugin add` prints the line real Codex 0.157.1 prints.
make_fakecodex() {
  local dest="$1"
  mkdir -p "$dest"
  cat > "$dest/codex" <<FAKE
#!/usr/bin/env bash
printf '%s|CODEX_HOME=%s\n' "\$*" "\${CODEX_HOME:-}" >> "$dest/codex.calls"
case "\$*" in
  "plugin marketplace add "*) exit "\${UM_TEST_CODEX_MKT_ADD_RC:-0}" ;;
  "plugin marketplace upgrade"*) exit "\${UM_TEST_CODEX_UPGRADE_RC:-0}" ;;
  "plugin add "*)
    rc="\${UM_TEST_CODEX_ADD_RC:-0}"
    if [ "\$rc" -eq 0 ]; then
      echo "Added plugin \\\`universal-memory\\\` from marketplace \\\`universal-memory\\\`."
      echo "Installed plugin root: \${CODEX_HOME:-\$HOME/.codex}/plugins/cache/universal-memory/universal-memory/1.28.2"
    fi
    exit "\$rc" ;;
esac
exit 0
FAKE
  chmod +x "$dest/codex"
}

# calls_of <dir> — the recorded argv lines, without the CODEX_HOME field.
calls_of() { cut -d'|' -f1 "$1/codex.calls" 2>/dev/null || true; }

# run_plugin_codex <path_prefix> [env_var=val ...] — run the installer with the fake first on PATH.
# shellcheck disable=SC2317,SC2329  # invoked indirectly through _tx_capture (SC2329 is the newer code)
run_plugin_codex() {
  local prefix="$1"; shift
  env PATH="$prefix:$PATH" "$@" bash "$PLUGIN_CODEX_SH" --yes 2>&1
}

# run_without_codex <bindir> [env_var=val ...] — a PATH that hides any real codex.
# shellcheck disable=SC2317,SC2329
run_without_codex() {
  local bindir="$1"; shift
  env PATH="$bindir:/usr/bin:/bin" "$@" bash "$PLUGIN_CODEX_SH" --yes 2>&1
}
codex_on_system_path() { PATH="/usr/bin:/bin" command -v codex >/dev/null 2>&1; }

EXPECTED_CALLS='plugin marketplace add goldenwo/universal-memory
plugin marketplace upgrade universal-memory
plugin add universal-memory@universal-memory'

# ─── C1: a fresh host — the three marketplace calls, nothing copied ──────────
# ~/.codex does not exist yet: `codex plugin marketplace add` creates it, so a
# Codex that has never run still gets the plugin.
echo ""
echo "=== C1: registers through codex plugin marketplace on a fresh host ==="
T="$TMPROOT/c1"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C1 run_plugin_codex "$T/bin" HOME="$T/home"
_dump_on_fail C1
assert_exit_zero "C1: exits 0" "$TX_EXIT_C1"
assert_eq "C1: marketplace add, upgrade, plugin add — in that order" "$(calls_of "$T/bin")" "$EXPECTED_CALLS"
assert_absent "C1: no copy under ~/.codex/plugins" "$T/home/.codex/plugins/universal-memory"
assert_contains "C1: says where Codex installed it" "$TX_OUT_C1" "plugins/cache/universal-memory/universal-memory/1.28.2"
assert_contains "C1: names the one step left — trusting the hooks" "$TX_OUT_C1" "trust the universal-memory hooks"
assert_contains "C1: says a newer Codex asks again after each update" "$TX_OUT_C1" "asks again after each universal-memory update"
if [ -e "$T/home/.bashrc" ] || [ -e "$T/home/.zshrc" ] || [ -e "$T/home/.profile" ]; then
  fail_test "C1: no shell rc written" "an rc file appeared in $T/home"
else
  pass "C1: no shell rc written"
fi

# ─── C2: a re-run moves an existing install forward ──────────────────────────
# Codex has no `plugin update`: upgrade refreshes the Git marketplace, and a
# repeated `plugin add` installs its current version (measured 2026-10-20).
# Codex 0.164.0 and later ties hook approval to the plugin's files, so this is
# the run after which it asks the user to trust the hooks again.
echo ""
echo "=== C2: re-run on a host that already has ~/.codex ==="
T="$TMPROOT/c2"; mkdir -p "$T/home/.codex"; make_fakecodex "$T/bin"
_tx_capture C2 run_plugin_codex "$T/bin" HOME="$T/home"
assert_exit_zero "C2: exits 0" "$TX_EXIT_C2"
assert_eq "C2: same three calls" "$(calls_of "$T/bin")" "$EXPECTED_CALLS"
assert_contains "C2: an update says the hooks need trusting again" "$TX_OUT_C2" "asks again after each universal-memory update"

# ─── C3: UM_PLUGIN_MARKETPLACE names another Git source ──────────────────────
echo ""
echo "=== C3: UM_PLUGIN_MARKETPLACE override (Git source) ==="
T="$TMPROOT/c3"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C3 run_plugin_codex "$T/bin" HOME="$T/home" UM_PLUGIN_MARKETPLACE=someone/universal-memory-fork
assert_exit_zero "C3: exits 0" "$TX_EXIT_C3"
assert_contains "C3: marketplace add uses the override" "$(calls_of "$T/bin")" "plugin marketplace add someone/universal-memory-fork"
assert_contains "C3: a Git source is still upgraded" "$(calls_of "$T/bin")" "plugin marketplace upgrade universal-memory"

# ─── C4: a local checkout as the marketplace — nothing to upgrade ────────────
# `codex plugin marketplace upgrade` exits 1 on a local source ("not configured
# as a Git marketplace"); Codex reads a local source live, so it is skipped.
echo ""
echo "=== C4: UM_PLUGIN_MARKETPLACE is a local directory ==="
T="$TMPROOT/c4"; mkdir -p "$T/home" "$T/checkout"; make_fakecodex "$T/bin"
_tx_capture C4 run_plugin_codex "$T/bin" HOME="$T/home" UM_PLUGIN_MARKETPLACE="$T/checkout"
_dump_on_fail C4
assert_exit_zero "C4: exits 0" "$TX_EXIT_C4"
assert_eq "C4: add the checkout, then the plugin; no upgrade" "$(calls_of "$T/bin")" "plugin marketplace add $T/checkout
plugin add universal-memory@universal-memory"
assert_not_contains "C4: no upgrade warning" "$TX_OUT_C4" "upgrade failed"

# ─── C5: Codex's home exists but no codex CLI — say the two commands ─────────
echo ""
echo "=== C5: ~/.codex present, codex CLI missing ==="
T="$TMPROOT/c5"; mkdir -p "$T/home/.codex" "$T/bin"
if codex_on_system_path; then
  pass "C5: skipped (a codex CLI lives in /usr/bin or /bin on this machine)"
else
  _tx_capture C5 run_without_codex "$T/bin" HOME="$T/home"
  assert_exit_zero "C5: exits 0" "$TX_EXIT_C5"
  assert_contains "C5: names marketplace add" "$TX_OUT_C5" "codex plugin marketplace add goldenwo/universal-memory"
  assert_contains "C5: names plugin add" "$TX_OUT_C5" "codex plugin add universal-memory@universal-memory"
  assert_absent "C5: nothing written under ~/.codex/plugins" "$T/home/.codex/plugins"
fi

# ─── C6: no codex CLI and no Codex home — skip quietly (was T19) ─────────────
echo ""
echo "=== C6: Codex absent → skip, exit 0, nothing created ==="
T="$TMPROOT/c6"; mkdir -p "$T/home" "$T/bin"
if codex_on_system_path; then
  pass "C6: skipped (a codex CLI lives in /usr/bin or /bin on this machine)"
else
  _tx_capture C6 run_without_codex "$T/bin" HOME="$T/home"
  assert_exit_zero "C6: exits 0 when Codex is absent" "$TX_EXIT_C6"
  assert_contains "C6: skip message for absent Codex" "$TX_OUT_C6" "Codex CLI not detected"
  assert_absent "C6: ~/.codex not created" "$T/home/.codex"
fi

# ─── C7: a failing marketplace add fails the installer ───────────────────────
echo ""
echo "=== C7: marketplace add fails ==="
T="$TMPROOT/c7"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C7 run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_CODEX_MKT_ADD_RC=1
assert_exit_nonzero "C7: non-zero exit" "$TX_EXIT_C7"
assert_contains "C7: says which step failed" "$TX_OUT_C7" "codex plugin marketplace add goldenwo/universal-memory failed"
assert_not_contains "C7: no plugin add after a failed marketplace add" "$(calls_of "$T/bin")" "plugin add universal-memory@universal-memory"

# ─── C8: a failing plugin add fails the installer ────────────────────────────
echo ""
echo "=== C8: plugin add fails ==="
T="$TMPROOT/c8"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C8 run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_CODEX_ADD_RC=1
assert_exit_nonzero "C8: non-zero exit" "$TX_EXIT_C8"
assert_contains "C8: says which step failed" "$TX_OUT_C8" "codex plugin add universal-memory@universal-memory failed"
assert_not_contains "C8: no success claim" "$TX_OUT_C8" "trust the universal-memory hooks"

# ─── C9: a failing upgrade only warns; the add still runs ────────────────────
echo ""
echo "=== C9: marketplace upgrade fails ==="
T="$TMPROOT/c9"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
_tx_capture C9 run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_CODEX_UPGRADE_RC=1
assert_exit_zero "C9: exits 0" "$TX_EXIT_C9"
assert_contains "C9: warns about the upgrade" "$TX_OUT_C9" "codex plugin marketplace upgrade universal-memory failed"
assert_contains "C9: plugin add still runs" "$(calls_of "$T/bin")" "plugin add universal-memory@universal-memory"

# ─── C10: an old copy is reported, not deleted (CODEX_HOME honoured) ─────────
echo ""
echo "=== C10: old \$CODEX_HOME/plugins/universal-memory copy ==="
T="$TMPROOT/c10"; mkdir -p "$T/home" "$T/codexhome/plugins/universal-memory/.codex-plugin"; make_fakecodex "$T/bin"
echo '{ "name": "universal-memory", "version": "0.7.0-alpha" }' > "$T/codexhome/plugins/universal-memory/.codex-plugin/plugin.json"
_tx_capture C10 run_plugin_codex "$T/bin" HOME="$T/home" CODEX_HOME="$T/codexhome"
assert_exit_zero "C10: exits 0" "$TX_EXIT_C10"
assert_contains "C10: names the old copy" "$TX_OUT_C10" "$T/codexhome/plugins/universal-memory"
assert_contains "C10: says Codex does not load it" "$TX_OUT_C10" "Codex does not load it"
assert_contains "C10: gives the removal command" "$TX_OUT_C10" "rm -rf '$T/codexhome/plugins/universal-memory'"
assert_file_exists "C10: the old copy is left in place" "$T/codexhome/plugins/universal-memory/.codex-plugin/plugin.json"
assert_contains "C10: codex runs with the caller's CODEX_HOME" "$(cat "$T/bin/codex.calls")" "CODEX_HOME=$T/codexhome"

# ─── C11: CODEX_HOME locates Codex when the CLI is missing ───────────────────
echo ""
echo "=== C11: CODEX_HOME present, ~/.codex absent, codex CLI missing ==="
T="$TMPROOT/c11"; mkdir -p "$T/home" "$T/codexhome" "$T/bin"
if codex_on_system_path; then
  pass "C11: skipped (a codex CLI lives in /usr/bin or /bin on this machine)"
else
  _tx_capture C11 run_without_codex "$T/bin" HOME="$T/home" CODEX_HOME="$T/codexhome"
  assert_exit_zero "C11: exits 0" "$TX_EXIT_C11"
  assert_contains "C11: names the commands" "$TX_OUT_C11" "codex plugin add universal-memory@universal-memory"
fi

# ─── C12: the marketplace serves Codex the plugin with hooks ─────────────────
# Codex reads .claude-plugin/marketplace.json; its universal-memory entry is the
# Claude Code plugin tree. The MCP-only plugins/codex copy is retired.
echo ""
echo "=== C12: marketplace entry and the retired copy ==="
assert_contains "C12: marketplace entry points at the hooks tree" \
  "$(cat "$REPO_ROOT/.claude-plugin/marketplace.json")" '"source": "./plugins/claude-code/universal-memory"'
assert_file_exists "C12: that tree ships hooks/hooks.json" "$REPO_ROOT/plugins/claude-code/universal-memory/hooks/hooks.json"
assert_absent "C12: plugins/codex/universal-memory is retired" "$REPO_ROOT/plugins/codex/universal-memory"

# ═══ K: the hook approval check ══════════════════════════════════════════════
# installer/lib/codex_hook_approval.py reads what Codex stores about its
# approval of the four hooks and prints one line, "<state><TAB><message>".
# Every case builds a scratch Codex home: an installed plugin, config.toml
# tables, sometimes .hook-trust/. No real Codex home is read.
#
# The expected hashes are built here with printf and sha256sum, entry by entry,
# from Codex's rule (codex-rs/hooks/src/engine/plugin_fingerprint.rs and
# plugin_trust.rs at rust-v0.167.0). They are a second implementation of one
# reading of that source: they pin the rule, not that the reading is right.
APPROVAL_PY="$SCRIPT_DIR/lib/codex_hook_approval.py"
PLUGIN_ID="universal-memory@universal-memory"
HOOK_EVENTS="session_start user_prompt_submit stop session_end"

# The interpreter probe and the path form come from the lib the installer
# uses, so these tests run the Python the installer would, the way it would.
# shellcheck source=lib/codex-hook-approval.sh
source "$SCRIPT_DIR/lib/codex-hook-approval.sh"

# native_path <path> — the path as K_PY reads it (C:\... for a Windows Python).
native_path() { _um_codex_hooks_native_path "$K_PY" "$1"; }

# make_dir_link <target_dir> <link> — a link to a directory: a symlink, or on
# Windows, where Git Bash's `ln -s` copies instead, a junction. Codex refuses
# both inside a plugin and resolves both in CODEX_HOME. Fails where neither
# can be made.
make_dir_link() {
  local target="$1" link="$2"
  if ln -s "$target" "$link" 2>/dev/null && [ -L "$link" ]; then return 0; fi
  rm -rf "$link"
  "$K_PY" -c 'import sys, _winapi; _winapi.CreateJunction(sys.argv[1], sys.argv[2])' \
    "$(native_path "$target")" "$(native_path "$link")" 2>/dev/null || return 1
  [ -d "$link" ]
}

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

# le64 <n> — n as eight little-endian bytes.
le64() {
  local n="$1" _
  for _ in 1 2 3 4 5 6 7 8; do
    # shellcheck disable=SC2059  # the format IS the byte, as an octal escape
    printf "\\$(printf '%03o' $((n & 255)))"
    n=$((n >> 8))
  done
}

# new_codex_home <name> — a Codex home whose config.toml already holds what a
# real one does: a setting, the plugin's own table (with an `enabled` that is
# not a hook's) and another plugin's hook table.
new_codex_home() {
  local home="$TMPROOT/$1"
  mkdir -p "$home"
  {
    printf 'model = "test"\n\n'
    printf '[plugins."%s"]\nenabled = true\n\n' "$PLUGIN_ID"
    printf '[hooks.state."other@market:hooks/hooks.json:stop:0:0"]\n'
    printf 'trusted_hash = "sha256:other"\nenabled = false\n\n'
  } > "$home/config.toml"
  printf '%s\n' "$home"
}

# make_plugin_tree <codex_home> — installs the fixture plugin; prints its root.
# `a` (a directory holding `b`) next to the file `a-b`: Codex sorts each
# directory's entries by name and walks into `a` before `a-b`, where sorting
# whole paths would put `a-b` first.
make_plugin_tree() {
  local root="$1/plugins/cache/universal-memory/universal-memory/1.2.3"
  mkdir -p "$root/.claude-plugin" "$root/hooks" "$root/a" "$root/empty"
  printf '{"name":"universal-memory","version":"1.2.3"}\n' > "$root/.claude-plugin/plugin.json"
  printf '{"hooks":{}}\n' > "$root/hooks/hooks.json"
  printf 'inner\n' > "$root/a/b"
  printf 'sibling\n' > "$root/a-b"
  printf '%s\n' "$root"
}

_hash_dir()  { le64 "${#1}"; printf '%s' "$1"; printf 'directory'; }
_hash_file() { le64 "${#1}"; printf '%s' "$1"; printf 'file'; le64 "$(($(wc -c < "$2")))"; cat "$2"; }

# fixture_hash <root> [paths] — the fixture tree's hash by Codex's rule. With
# "paths" the entries are in whole-path order instead, which Codex does not use.
fixture_hash() {
  local r="$1" order="${2:-codex}" s="$K_SEP"
  {
    printf 'codex-plugin-bundle-v1'
    _hash_dir ""
    _hash_dir ".claude-plugin"
    _hash_file ".claude-plugin${s}plugin.json" "$r/.claude-plugin/plugin.json"
    _hash_dir "a"
    if [ "$order" = paths ]; then
      _hash_file "a-b" "$r/a-b"
      _hash_file "a${s}b" "$r/a/b"
    else
      _hash_file "a${s}b" "$r/a/b"
      _hash_file "a-b" "$r/a-b"
    fi
    _hash_dir "empty"
    _hash_dir "hooks"
    _hash_file "hooks${s}hooks.json" "$r/hooks/hooks.json"
  } | sha256_hex
}

# baseline_name <config path as Codex holds it> — the file Codex keeps a
# pre-0.164 approval's baseline in, under .hook-trust/.
baseline_name() {
  { le64 "${#1}"; printf '%s' "$1"; le64 "${#PLUGIN_ID}"; printf '%s' "$PLUGIN_ID"; } | sha256_hex
}

# hook_table <home> <event> <line>... — one hook's table in config.toml.
# K_QUOTE is the quote around the key; Codex writes both kinds.
K_QUOTE='"'
hook_table() {
  local home="$1" event="$2"
  shift 2
  {
    printf '[hooks.state.%s%s:hooks/hooks.json:%s:0:0%s]\n' "$K_QUOTE" "$PLUGIN_ID" "$event" "$K_QUOTE"
    [ "$#" -eq 0 ] || printf '%s\n' "$@"
    printf '\n'
  } >> "$home/config.toml"
}

# all_hooks <home> <line>... — the same table lines for all four hooks.
all_hooks() {
  local home="$1" event
  shift
  for event in $HOOK_EVENTS; do hook_table "$home" "$event" "$@"; done
}

# _snapshot <dir> — every path under it and every file's checksum.
_snapshot() {
  (cd "$1" && find . | LC_ALL=C sort && find . -type f -exec cksum {} + | LC_ALL=C sort) 2>/dev/null
}

# run_check <home> — runs the check; sets K_STATE and K_MSG. Every run also
# counts toward K20: one line with one tab, exit 0, the home left as it was.
K_RUNS=0
K_SHAPE_FAILS=()
run_check() {
  local home="$1" before after out rc=0 tabs raw="$TMPROOT/check.out"
  before=$(_snapshot "$home")
  # Through a file: Git Bash's $(...) drops a trailing CR LF pair, which would
  # hide a Windows Python answering in CRLF.
  "$K_PY" "$(native_path "$APPROVAL_PY")" --codex-home "$(native_path "$home")" > "$raw" 2>/dev/null || rc=$?
  after=$(_snapshot "$home")
  out=$(tr -d '\r' < "$raw")
  [ "$(tr -d -c '\r' < "$raw" | wc -c)" -eq 0 ] || K_SHAPE_FAILS+=("a carriage return in the output ($home)")
  [ "$(wc -l < "$raw")" -eq 1 ] || K_SHAPE_FAILS+=("not exactly one line ($home)")
  K_STATE="${out%%$'\t'*}"
  K_MSG="${out#*$'\t'}"
  K_RUNS=$((K_RUNS + 1))
  tabs="${out//[^$'\t']/}"
  [ "$rc" -eq 0 ] || K_SHAPE_FAILS+=("exit $rc ($home)")
  [ "${#tabs}" -eq 1 ] || K_SHAPE_FAILS+=("${#tabs} tabs ($home)")
  [ "$before" = "$after" ] || K_SHAPE_FAILS+=("the Codex home changed ($home)")
}

echo ""
echo "=== K: the hook approval check ==="
K_PY=$(_um_codex_hooks_python) || K_PY=""
if [ -z "$K_PY" ]; then
  fail_test "K: needs a working Python (py, python3 or python)" "none runs"
else
  K_SEP=$("$K_PY" -c 'import os, sys; sys.stdout.write(os.sep)')

  # K1: the hash, checked through the result. A config that stores the hash
  # built here reads as approved; the whole-path-order hash does not.
  H=$(new_codex_home k1); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  run_check "$H"
  assert_eq "K1: the hash built here by Codex's rule is the one the check computes" "$K_STATE" "approved"
  assert_eq "K8: four hooks whose stored content hash matches" "$K_MSG" "Codex has universal-memory's hooks approved."
  H=$(new_codex_home k1b); ROOT=$(make_plugin_tree "$H")
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"sha256:$(fixture_hash "$ROOT" paths)\""
  run_check "$H"
  assert_eq "K1: a hash of the entries in whole-path order is not it" "$K_STATE" "needs-approval"

  # K2: what Codex leaves out of the hash.
  H=$(new_codex_home k2); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  mkdir -p "$ROOT/__pycache__" "$ROOT/hooks/.venv/lib" "$ROOT/pkg.egg-info"
  printf 'x' > "$ROOT/__pycache__/m.cpython-312.pyc"
  printf 'x' > "$ROOT/hooks/stray.pyc"
  printf 'x' > "$ROOT/hooks/.venv/lib/site.py"
  printf 'x' > "$ROOT/pkg.egg-info/PKG-INFO"
  run_check "$H"
  assert_eq "K2: __pycache__, .venv, *.pyc and *.egg-info do not change the hash" "$K_STATE" "approved"

  # K3: everything else does.
  k3_case() {
    local name="$1" change="$2"
    H=$(new_codex_home "k3-$name"); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
    all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
    (cd "$ROOT" && eval "$change")
    run_check "$H"
    assert_eq "K3/K9: $name changes the hash" "$K_STATE" "needs-approval"
  }
  k3_case "one byte in a file" "printf 'Inner\n' > a/b"
  k3_case "a file's length" "printf 'inner\n\n' > a/b"
  k3_case "a new file" "printf 'x' > hooks/new.sh"
  k3_case "a new empty directory" "mkdir hooks/empty2"
  k3_case "a renamed file" "mv a-b a-c"
  k3_case "the version in plugin.json" "printf '{\"name\":\"universal-memory\",\"version\":\"1.2.4\"}\n' > .claude-plugin/plugin.json"
  assert_contains "K9: says what to do" "$K_MSG" "trust them again"
  assert_contains "K9: says older Codex still runs them" "$K_MSG" "Codex before 0.164 still runs them"

  # K5–K7: not installed, never approved.
  H=$(new_codex_home k5)
  run_check "$H"
  assert_eq "K5: no plugin directory" "$K_STATE" "not-installed"
  H=$(new_codex_home k6); ROOT=$(make_plugin_tree "$H")
  run_check "$H"
  assert_eq "K6: installed, no approval stored" "$K_STATE" "never-approved"
  assert_contains "K6: counts all four" "$K_MSG" "4 of 4 not approved"
  assert_contains "K6: names the step" "$K_MSG" "Trust all and continue"
  H=$(new_codex_home k6b); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" "trusted_content_hash = \"$HASH\""
  run_check "$H"
  assert_eq "K6b: a content hash without trusted_hash is not an approval" "$K_STATE" "never-approved"
  H=$(new_codex_home k7); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  for event in session_start user_prompt_submit stop; do
    hook_table "$H" "$event" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  done
  run_check "$H"
  assert_eq "K7: one hook of four never approved" "$K_STATE" "never-approved"
  assert_contains "K7: counts the one" "$K_MSG" "1 of 4 not approved"

  # K8b: with a content hash stored, Codex does not consult the baseline file.
  H=$(new_codex_home k8b); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  mkdir -p "$H/.hook-trust"
  printf 'sha256:stale' > "$H/.hook-trust/$(baseline_name "$(native_path "$H")${K_SEP}config.toml")"
  run_check "$H"
  assert_eq "K8b: a matching content hash wins over a stale baseline" "$K_STATE" "approved"

  # K10–K13: approvals made before Codex 0.164 (trusted_hash only).
  H=$(new_codex_home k10); ROOT=$(make_plugin_tree "$H")
  all_hooks "$H" 'trusted_hash = "sha256:decl"'
  run_check "$H"
  assert_eq "K10: older approval, no baseline yet" "$K_STATE" "approved"
  H=$(new_codex_home k11); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"'
  mkdir -p "$H/.hook-trust"
  printf '%s' "$HASH" > "$H/.hook-trust/$(baseline_name "$(native_path "$H")${K_SEP}config.toml")"
  run_check "$H"
  assert_eq "K11: older approval, baseline matches" "$K_STATE" "approved"
  # K4 rides on K12: only a file under the right name can turn this into
  # needs-approval. Under any other name it would be K13's "unknown".
  H=$(new_codex_home k12); ROOT=$(make_plugin_tree "$H")
  all_hooks "$H" 'trusted_hash = "sha256:decl"'
  mkdir -p "$H/.hook-trust"
  printf 'sha256:stale' > "$H/.hook-trust/$(baseline_name "$(native_path "$H")${K_SEP}config.toml")"
  run_check "$H"
  assert_eq "K4/K12: the baseline is found under the name built here, and differs" "$K_STATE" "needs-approval"
  H=$(new_codex_home k13); ROOT=$(make_plugin_tree "$H")
  all_hooks "$H" 'trusted_hash = "sha256:decl"'
  mkdir -p "$H/.hook-trust"
  printf 'sha256:someone-else' > "$H/.hook-trust/0000000000000000000000000000000000000000000000000000000000000000"
  run_check "$H"
  assert_eq "K13: baselines exist, none can be matched to this plugin" "$K_STATE" "unknown"
  assert_contains "K13: says it could not tell" "$K_MSG" "Could not tell"
  H=$(new_codex_home k13b); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"'
  mkdir -p "$H/.hook-trust"
  printf '%s' "$HASH" > "$H/.hook-trust/0000000000000000000000000000000000000000000000000000000000000000"
  run_check "$H"
  assert_eq "K13b: a baseline under another name that holds this plugin's hash" "$K_STATE" "approved"

  # K4b: Codex resolves links in CODEX_HOME, so the baseline can sit under the
  # name for the real path while the caller reached the home through a link.
  H=$(new_codex_home k4b-real); ROOT=$(make_plugin_tree "$H")
  all_hooks "$H" 'trusted_hash = "sha256:decl"'
  if make_dir_link "$H" "$TMPROOT/k4b-link"; then
    REAL=$("$K_PY" -c 'import os, sys; sys.stdout.write(os.path.realpath(sys.argv[1]))' "$(native_path "$H")")
    mkdir -p "$H/.hook-trust"
    printf 'sha256:stale' > "$H/.hook-trust/$(baseline_name "${REAL}${K_SEP}config.toml")"
    run_check "$TMPROOT/k4b-link"
    assert_eq "K4b: the baseline under the resolved path's name is found" "$K_STATE" "needs-approval"
  else
    pass "K4b: skipped (this platform made no link)"
  fi

  # K14–K15b: the four hooks can differ.
  H=$(new_codex_home k14); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  for event in session_start user_prompt_submit stop; do
    hook_table "$H" "$event" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  done
  hook_table "$H" session_end 'trusted_hash = "sha256:decl"'
  mkdir -p "$H/.hook-trust"
  printf 'sha256:stale' > "$H/.hook-trust/$(baseline_name "$(native_path "$H")${K_SEP}config.toml")"
  run_check "$H"
  assert_eq "K14: three approved, one older approval gone stale" "$K_STATE" "needs-approval"
  H=$(new_codex_home k15); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  for event in session_start user_prompt_submit stop; do
    hook_table "$H" "$event" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  done
  hook_table "$H" session_end 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\"" 'enabled = false'
  run_check "$H"
  assert_eq "K15: one hook switched off" "$K_STATE" "disabled"
  assert_contains "K15: names the hook" "$K_MSG" "1 of 4 universal-memory hooks are switched off in Codex's hook settings: session_end."
  H=$(new_codex_home k15b); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  for event in session_start user_prompt_submit stop; do
    hook_table "$H" "$event" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  done
  hook_table "$H" session_end 'enabled = false'
  run_check "$H"
  assert_eq "K15b: switched off counts before never approved" "$K_STATE" "disabled"

  # K16–K19: shapes the check does not read are "unknown", never a guess.
  H=$(new_codex_home k16); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  mkdir -p "$H/plugins/cache/universal-memory/universal-memory/1.2.2"
  run_check "$H"
  assert_eq "K16: two installed versions" "$K_STATE" "unknown"
  H=$(new_codex_home k17); ROOT=$(make_plugin_tree "$H")
  printf 'hooks.state."%s:hooks/hooks.json:stop:0:0".trusted_hash = "sha256:decl"\n' "$PLUGIN_ID" >> "$H/config.toml"
  run_check "$H"
  assert_eq "K17: a hook's state written as a dotted key" "$K_STATE" "unknown"
  H=$(new_codex_home k17b); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\"" 'enabled = "no"'
  run_check "$H"
  assert_eq "K17b: a field value of the wrong kind" "$K_STATE" "unknown"
  H=$(new_codex_home k17c); ROOT=$(make_plugin_tree "$H")
  rm "$H/config.toml"
  run_check "$H"
  assert_eq "K17c: plugin installed, config.toml missing" "$K_STATE" "unknown"
  H=$(new_codex_home k18); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  K_QUOTE="'"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  K_QUOTE='"'
  run_check "$H"
  assert_eq "K18: single-quoted table names" "$K_STATE" "approved"
  H=$(new_codex_home k19); ROOT=$(make_plugin_tree "$H"); HASH="sha256:$(fixture_hash "$ROOT")"
  all_hooks "$H" 'trusted_hash = "sha256:decl"' "trusted_content_hash = \"$HASH\""
  if make_dir_link "$ROOT/a" "$ROOT/a-link"; then
    run_check "$H"
    assert_eq "K19: a link inside the plugin, which Codex refuses" "$K_STATE" "unknown"
  else
    pass "K19: skipped (this platform made no link)"
  fi

  # K20: what every run above had in common.
  if [ "${#K_SHAPE_FAILS[@]}" -eq 0 ]; then
    pass "K20: all $K_RUNS runs printed one line with one tab, exited 0 and left the Codex home unchanged"
  else
    fail_test "K20: one line, one tab, exit 0, Codex home unchanged" "${K_SHAPE_FAILS[*]}"
  fi

  # ─── K21: --check ──────────────────────────────────────────────────────────
  # check_mode <label> <bindir> <codex_home> — the installer's --check.
  # shellcheck disable=SC2317,SC2329
  run_check_mode() {
    local prefix="$1"; shift
    env PATH="$prefix:$PATH" "$@" bash "$PLUGIN_CODEX_SH" --check 2>&1
  }
  echo ""
  echo "=== K21: --check reports the state and runs no codex command ==="
  T="$TMPROOT/k21"; make_fakecodex "$T/bin"
  k21_case() {
    local label="$1" home="$2" want_exit="$3" want_text="$4" exit_var="TX_EXIT_$1" out_var="TX_OUT_$1"
    _tx_capture "$label" run_check_mode "$T/bin" HOME="$TMPROOT/nohome" CODEX_HOME="$home"
    assert_eq "K21: --check exit code, $label" "${!exit_var}" "$want_exit"
    assert_contains "K21: --check message, $label" "${!out_var}" "$want_text"
  }
  k21_case approved "$TMPROOT/k1" 0 "Codex has universal-memory's hooks approved."
  k21_case needs_approval "$TMPROOT/k1b" 1 "trust them again"
  k21_case never_approved "$TMPROOT/k6" 1 "4 of 4 not approved"
  k21_case unknown "$TMPROOT/k13" 0 "Could not tell"
  k21_case disabled "$TMPROOT/k15" 0 "switched off"
  k21_case not_installed "$TMPROOT/k5" 0 "not installed in Codex"
  assert_absent "K21: the fake codex was never called" "$T/bin/codex.calls"

  # ─── K22–K23: the install run names the state it ends in ───────────────────
  echo ""
  echo "=== K22: an update under an older approval with nothing to redo ==="
  T="$TMPROOT/k22"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
  cp -R "$TMPROOT/k10" "$T/home/.codex"
  _tx_capture K22 run_plugin_codex "$T/bin" HOME="$T/home"
  _dump_on_fail K22
  assert_exit_zero "K22: exits 0" "$TX_EXIT_K22"
  assert_contains "K22: says the hooks are approved" "$TX_OUT_K22" "Codex has universal-memory's hooks approved."
  assert_not_contains "K22: does not ask for a first approval" "$TX_OUT_K22" "trust the universal-memory hooks"
  assert_not_contains "K22: does not ask for a new approval" "$TX_OUT_K22" "trust them again"

  echo ""
  echo "=== K23: an update that leaves the hooks needing approval ==="
  T="$TMPROOT/k23"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
  cp -R "$TMPROOT/k1b" "$T/home/.codex"
  _tx_capture K23 run_plugin_codex "$T/bin" HOME="$T/home"
  _dump_on_fail K23
  assert_exit_zero "K23: exits 0 (the install itself worked)" "$TX_EXIT_K23"
  assert_contains "K23: says to trust them again" "$TX_OUT_K23" "trust them again"
  assert_not_contains "K23: not the unconditional wording" "$TX_OUT_K23" "asks again after each universal-memory update"

  # ─── K25: a check that fails or answers nonsense is "unknown" ──────────────
  # A stand-in `py` ahead on PATH passes the probe (`py -c ''`) and then
  # misbehaves as UM_TEST_PY_MODE says. The Codex home is K1b's, where a
  # working check says needs-approval.
  echo ""
  echo "=== K25: a failing or garbled check never stops the installer ==="
  T="$TMPROOT/k25"; mkdir -p "$T/home"; make_fakecodex "$T/bin"
  cp -R "$TMPROOT/k1b" "$T/home/.codex"
  cat > "$T/bin/py" <<'FAKEPY'
#!/usr/bin/env bash
[ "${1:-}" = "-c" ] && exit 0
case "${UM_TEST_PY_MODE:-}" in
  fail) echo "Traceback (most recent call last):" >&2; exit 1 ;;
  silent) exit 0 ;;
  nonsense) printf 'banana\tCodex has every hook approved.\n' ;;
  twolines) printf 'approved\tone\napproved\ttwo\n' ;;
  notab) printf 'approved\n' ;;
esac
exit 0
FAKEPY
  chmod +x "$T/bin/py"
  for mode in fail silent nonsense twolines notab; do
    _tx_capture K25I run_plugin_codex "$T/bin" HOME="$T/home" UM_TEST_PY_MODE="$mode"
    assert_exit_zero "K25: install run exits 0, check $mode" "$TX_EXIT_K25I"
    assert_contains "K25: install run prints the fallback wording, check $mode" "$TX_OUT_K25I" "trust the universal-memory hooks"
    assert_contains "K25: fallback keeps the per-update line, check $mode" "$TX_OUT_K25I" "asks again after each universal-memory update"
    _tx_capture K25C run_check_mode "$T/bin" HOME="$T/home" UM_TEST_PY_MODE="$mode"
    assert_exit_zero "K25: --check exits 0, check $mode" "$TX_EXIT_K25C"
    assert_contains "K25: --check says it could not tell, check $mode" "$TX_OUT_K25C" "Could not tell"
    # Called bare under `set -e`, as server/install.sh --verify calls it. (The
    # installer calls it on the left of `||`, where bash ignores `set -e`.)
    K25_EXIT=0
    # shellcheck disable=SC2016  # the inner bash expands $1, $2 and the state
    K25_OUT=$(env PATH="$T/bin:$PATH" UM_TEST_PY_MODE="$mode" bash -c '
      set -euo pipefail
      source "$1"
      um_codex_hook_approval "$2"
      printf "%s" "$UM_CODEX_HOOKS_STATE"' _ "$SCRIPT_DIR/lib/codex-hook-approval.sh" "$T/home/.codex" 2>&1) || K25_EXIT=$?
    assert_exit_zero "K25: the helper returns under set -e, check $mode" "$K25_EXIT"
    assert_eq "K25: the helper reports unknown, check $mode" "$K25_OUT" "unknown"
  done

  # A copy of the installer without lib/ beside it still installs.
  mkdir -p "$T/alone"
  cp "$PLUGIN_CODEX_SH" "$T/alone/install-plugin-codex.sh"
  K25_EXIT=0
  K25_OUT=$(env PATH="$T/bin:$PATH" HOME="$T/home" bash "$T/alone/install-plugin-codex.sh" --yes 2>&1) || K25_EXIT=$?
  assert_exit_zero "K25: install run exits 0 without lib/" "$K25_EXIT"
  assert_contains "K25: install run prints the fallback wording without lib/" "$K25_OUT" "trust the universal-memory hooks"
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
