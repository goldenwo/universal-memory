#!/usr/bin/env bash
# hooks/agy-hooks-json.test.sh — guards for the plugin-root hooks.json, the
# file Antigravity loads for this plugin (#410). Claude Code and Codex load
# hooks/hooks.json instead and never read this one.
#
# Run: bash agy-hooks-json.test.sh
#
# Why these pins exist: Antigravity runs a hook command on Windows as
# cmd /c "<command>" from the installed plugin's root (agy 1.5.3, measured
# 2026-11-09). Two mistakes there fail silently, with the error only in
# Antigravity's own cli.log and the session carrying on without memory:
#   - any double quote in the command breaks it;
#   - "hooks\run-hook.cmd" written with ONE backslash is valid JSON, where \r
#     is a carriage return. The command becomes hooks<CR>un-hook.cmd, the
#     manifest still validates, and no hook ever runs. This happened in the
#     third probe run.
#
#   K1. Exactly one group holding SessionStart and Stop, one command handler
#       each, with the timeouts the entry scripts were sized for.
#   K2. No command, as parsed, holds a control character or a double quote.
#   K3. Every command is exactly `hooks\run-hook.cmd <s> || bash hooks/<s>`
#       for one script <s> that exists, next to a run-hook.cmd that exists.
#   K4. hooks/hooks.json still passes its own suite, untouched.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_HOOKS="$SCRIPT_DIR/../hooks.json"
SEP=$'\x1f'

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

PYBIN=""
for _c in py python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c '' >/dev/null 2>&1; then
    PYBIN="$_c"; break
  fi
done
if [ -z "$PYBIN" ]; then
  echo "SKIP: no working python interpreter — these tests need one" >&2
  exit 1
fi

native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"
  else printf '%s' "$1"; fi
}

# One line per handler: group SEP event SEP index SEP type SEP timeout SEP
# flags SEP command. flags names what K2 forbids, found on the PARSED string;
# the command itself is printed with those characters made visible so a
# failure message can show them.
ROWS=$("$PYBIN" -c '
import json, sys
sys.stdout.reconfigure(newline=chr(10))
sep = chr(0x1f)
with open(sys.argv[1], encoding="utf-8") as fh:
    d = json.load(fh)
for group, events in d.items():
    for event, handlers in events.items():
        for i, h in enumerate(handlers):
            cmd = h.get("command", "")
            flags = []
            if any(ord(c) < 0x20 or ord(c) == 0x7f for c in cmd):
                flags.append("control")
            if chr(34) in cmd:
                flags.append("quote")
            shown = "".join(c if ord(c) >= 0x20 and ord(c) != 0x7f else "<%02x>" % ord(c) for c in cmd)
            print(sep.join([group, event, str(i), str(h.get("type")), str(h.get("timeout")),
                            ",".join(flags) or "clean", shown]))
' "$(native_path "$ROOT_HOOKS")" 2>&1) || { fail "plugin-root hooks.json parses" "$ROWS"; ROWS=""; }

echo "=== K1: shape ==="
assert_eq "K1: two handlers in all" "$(printf '%s\n' "$ROWS" | grep -c .)" "2"
assert_eq "K1: one group, universal-memory" "$(printf '%s\n' "$ROWS" | cut -d"$SEP" -f1 | sort -u)" "universal-memory"
assert_eq "K1: the events are SessionStart and Stop, handler 0 each" \
  "$(printf '%s\n' "$ROWS" | cut -d"$SEP" -f2,3 | tr "$SEP" ':' | sort | tr '\n' ' ')" "SessionStart:0 Stop:0 "

while IFS="$SEP" read -r group event index type timeout flags cmd; do
  [ -n "$event" ] || continue
  case "$event" in
    SessionStart) script="agy-session-start.sh"; want_timeout="60" ;;
    Stop)         script="agy-stop.sh";          want_timeout="120" ;;
    *)            script="<no script for $event>"; want_timeout="<none>" ;;
  esac
  echo "=== $event ==="
  assert_eq "K1: $event is a command handler" "$type" "command"
  assert_eq "K1: $event timeout" "$timeout" "$want_timeout"
  assert_eq "K2: $event command has no control character and no double quote" "$flags" "clean"
  assert_eq "K3: $event command is the one pinned form" "$cmd" "hooks\\run-hook.cmd $script || bash hooks/$script"
  if [ -f "$SCRIPT_DIR/$script" ]; then pass "K3: $event script exists"
  else fail "K3: $event script exists" "not found: hooks/$script"; fi
done <<< "$ROWS"

if [ -f "$SCRIPT_DIR/run-hook.cmd" ]; then pass "K3: run-hook.cmd exists"
else fail "K3: run-hook.cmd exists" "not found"; fi

echo "=== K2 control: the single-backslash mistake is caught ==="
# The check must be able to fail: parse the mistake and see it flagged.
BAD=$("$PYBIN" -c '
import json
cmd = json.loads(chr(34) + "hooks" + chr(92) + "run-hook.cmd x.sh" + chr(34))
print("control" if any(ord(c) < 0x20 for c in cmd) else "clean", end="")')
assert_eq "K2: one backslash before r parses to a control character" "$BAD" "control"

echo "=== K4: hooks/hooks.json ==="
if bash "$SCRIPT_DIR/hooks-json.test.sh" >/dev/null 2>&1; then pass "K4: hooks-json.test.sh passes"
else fail "K4: hooks-json.test.sh passes" "it failed; run it for the detail"; fi

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
