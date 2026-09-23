#!/usr/bin/env bash
# hooks/hooks-json.test.sh — guards for hooks.json, the file BOTH Claude Code and
# Codex load for this plugin (#313).
#
# Run: bash hooks-json.test.sh
#
# Why these pins exist: Codex only runs a hook the user has trusted, and the trust
# hash covers the handler as Codex normalizes it — event, matcher, the SELECTED
# command (command on macOS/Linux, commandWindows on Windows), async, timeout,
# statusMessage (openai/codex codex-rs/hooks/src/engine/discovery.rs hook_hash).
# Any edit to those fields silently un-trusts the hook for every Codex user on that
# platform until they re-approve it, and until then Codex runs none of it. Change
# the scripts or run-hook.cmd instead; neither is part of the hash.
#
#   J1. Exactly the four events, one group and one handler each.
#   J2. Every hashed field except commandWindows is byte-pinned (macOS/Linux trust).
#   J3. commandWindows routes the SAME script through run-hook.cmd in the one
#       pinned form (Windows trust — changing it re-prompts every Windows user).
#   J4. Every script named exists, and so does run-hook.cmd.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_JSON="$SCRIPT_DIR/hooks.json"
LAUNCHER="$SCRIPT_DIR/run-hook.cmd"
SEP=$'\x1f'   # unit separator: NOT IFS whitespace, so empty fields (matcher "") survive read

PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL: %s — %s\n' "$1" "${2:-}"
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"
  else fail "$name" "got='$got', want='$want'"; fi
}

# One line per handler, fields joined by the 0x1f unit separator. Not "|": the
# SessionStart matcher contains it. Not TAB: it is IFS whitespace, so read would
# collapse the empty matchers and shift every later field.
# event, matcher, handler JSON without commandWindows, commandWindows, handlers in group, groups in event.
ROWS=$(node -e '
  const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks;
  for (const [ev, groups] of Object.entries(h)) {
    for (const g of groups) {
      for (const x of g.hooks) {
        const { commandWindows, ...rest } = x;
        console.log([ev, g.matcher ?? "<none>", JSON.stringify(rest), commandWindows ?? "<none>",
                     g.hooks.length, groups.length].join("\x1f"));
      }
    }
  }' "$HOOKS_JSON")

field() { printf '%s\n' "$ROWS" | grep "^$1$SEP" | cut -d"$SEP" -f"$2"; }

echo "hooks.json guards"

# J1
assert_eq "J1 events" "$(printf '%s\n' "$ROWS" | cut -d"$SEP" -f1 | tr '\n' ' ')" "SessionStart UserPromptSubmit Stop SessionEnd "
assert_eq "J1 one group and one handler per event" "$(printf '%s\n' "$ROWS" | cut -d"$SEP" -f5,6 | sort -u)" "1${SEP}1"

# J2 — pinned exactly as shipped through v1.23.0.
# The expected handler strings are single-quoted on purpose: ${CLAUDE_PLUGIN_ROOT} is part
# of the pinned literal, never expanded by this shell.
assert_eq "J2 SessionStart matcher" "$(field SessionStart 2)" 'startup|clear|compact'
# shellcheck disable=SC2016
assert_eq "J2 SessionStart handler" "$(field SessionStart 3)" \
  '{"type":"command","command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh\"","async":false}'
assert_eq "J2 UserPromptSubmit matcher" "$(field UserPromptSubmit 2)" ''
# shellcheck disable=SC2016
assert_eq "J2 UserPromptSubmit handler" "$(field UserPromptSubmit 3)" \
  '{"type":"command","command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.sh\"","async":false}'
assert_eq "J2 Stop matcher" "$(field Stop 2)" ''
# shellcheck disable=SC2016
assert_eq "J2 Stop handler" "$(field Stop 3)" \
  '{"type":"command","command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh\"","async":false,"timeout":120}'
assert_eq "J2 SessionEnd matcher" "$(field SessionEnd 2)" ''
# shellcheck disable=SC2016
assert_eq "J2 SessionEnd handler" "$(field SessionEnd 3)" \
  '{"type":"command","command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/session-end.sh\"","async":false}'

# J3 + J4
SCRIPTS=()
while IFS="$SEP" read -r ev _matcher handler cmdwin _n _g; do
  script=$(printf '%s' "$handler" | sed -n 's|.*/hooks/\([a-z-]*\.sh\).*|\1|p')
  SCRIPTS+=("$script")
  assert_eq "J3 $ev commandWindows" "$cmdwin" \
    "cmd /d /c \"\${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" $script"
  if [ -f "$SCRIPT_DIR/$script" ]; then pass "J4 $script exists"; else fail "J4 $script exists" "missing"; fi
done <<< "$ROWS"
if [ -f "$LAUNCHER" ]; then pass "J4 run-hook.cmd exists"; else fail "J4 run-hook.cmd exists" "missing"; fi

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
