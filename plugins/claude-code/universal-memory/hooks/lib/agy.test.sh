#!/usr/bin/env bash
# hooks/lib/agy.test.sh — unit tests for agy.sh, the Antigravity hook
# translation (#410).
#
# Run: bash agy.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Scenarios:
#   G1. A full Antigravity input maps to the four Claude-shaped fields;
#       forward-slash Windows paths pass through unchanged.
#   G2. Input that is not a JSON object ⇒ rc 1, empty output.
#   G3. workspacePaths missing, empty, or not a list ⇒ rc 2, empty output.
#   G4. Extra fields are dropped; an odd conversationId passes through (the
#       hooks that consume it validate it).
#   G5. lastUserInput absent, empty, blank or not a string ⇒ no prompt key.
#   G6. um_agy_inject joins the context of several hook outputs into one
#       injectSteps message; nothing to inject ⇒ {}.
#   G7. um_agy_sid / um_agy_has_prompt read the translated line.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# shellcheck source=um-api.sh
source "$SCRIPT_DIR/um-api.sh"
# shellcheck source=agy.sh
source "$SCRIPT_DIR/agy.sh"

PYBIN=$(um_find_python) || { echo "SKIP: no working python interpreter" >&2; exit 1; }

# field <json> <key> — one field of a JSON object, '<absent>' when missing.
field() {
  printf '%s' "$1" | "$PYBIN" -c '
import json, sys
sys.stdout.reconfigure(newline=chr(10))
d = json.loads(sys.stdin.buffer.read().decode("utf-8"))
v = d.get(sys.argv[1], "<absent>")
sys.stdout.write(v if isinstance(v, str) else json.dumps(v))' "$2"
}

# keys <json> — the object keys, sorted, comma-joined.
keys() {
  printf '%s' "$1" | "$PYBIN" -c '
import json, sys
print(",".join(sorted(json.loads(sys.stdin.buffer.read().decode("utf-8")))), end="")'
}

# translate <json> — sets OUT and RC.
translate() {
  RC=0
  OUT=$(printf '%s' "$1" | um_agy_to_claude) || RC=$?
}

# inject <line>... — sets OUT.
inject() {
  OUT=$(printf '%s\n' "$@" | um_agy_inject)
}

# injected_text <json> — the one injected message, '<none>' when there is none.
injected_text() {
  printf '%s' "$1" | "$PYBIN" -c '
import json, sys
sys.stdout.reconfigure(newline=chr(10))
d = json.loads(sys.stdin.buffer.read().decode("utf-8"))
steps = d.get("injectSteps")
if not steps:
    sys.stdout.write("<none>")
else:
    assert len(steps) == 1, steps
    sys.stdout.write(steps[0]["systemMessage"]["systemMessage"])'
}

# ctx <text> — a Claude-shaped hook output carrying <text> as context.
ctx() {
  "$PYBIN" -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.argv[1]}}), end="")' "$1"
}

echo "=== G1: full input ==="
translate '{"conversationId":"0b9d3f6e-1111-4222-8333-444455556666","workspacePaths":["C:/Projects/example-project","C:/Projects/other"],"transcriptPath":"C:/Users/someone/.gemini/antigravity-cli/brain/0b9d/transcript_full.jsonl","lastUserInput":"fix the loader","hookEventName":"SessionStart"}'
assert_eq "G1: rc 0" "$RC" "0"
assert_eq "G1: session_id" "$(field "$OUT" session_id)" "0b9d3f6e-1111-4222-8333-444455556666"
assert_eq "G1: cwd is the first workspace path, unchanged" "$(field "$OUT" cwd)" "C:/Projects/example-project"
assert_eq "G1: transcript_path" "$(field "$OUT" transcript_path)" "C:/Users/someone/.gemini/antigravity-cli/brain/0b9d/transcript_full.jsonl"
assert_eq "G1: prompt" "$(field "$OUT" prompt)" "fix the loader"
assert_eq "G1: exactly the four fields" "$(keys "$OUT")" "cwd,prompt,session_id,transcript_path"
assert_eq "G1: one line" "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" "1"
translate '{"conversationId":"c1","workspacePaths":["C:\\Projects\\example-project"]}'
assert_eq "G1: a backslash path survives" "$(field "$OUT" cwd)" 'C:\Projects\example-project'

echo "=== G2: not a JSON object ==="
for bad in 'not json at all' '["a","b"]' '"just a string"' '{"conversationId":'; do
  translate "$bad"
  assert_eq "G2: rc 1 for: $bad" "$RC" "1"
  assert_eq "G2: empty output for: $bad" "$OUT" ""
done

echo "=== G3: no workspace ==="
for bad in '{"conversationId":"c1"}' '{"conversationId":"c1","workspacePaths":[]}' \
           '{"conversationId":"c1","workspacePaths":"C:/Projects/x"}' \
           '{"conversationId":"c1","workspacePaths":[""]}' '{"conversationId":"c1","workspacePaths":[7]}'; do
  translate "$bad"
  assert_eq "G3: rc 2 for: $bad" "$RC" "2"
  assert_eq "G3: empty output for: $bad" "$OUT" ""
done

echo "=== G4: extra fields, odd ids ==="
# shellcheck disable=SC2016  # the id is literal text, never expanded
translate '{"conversationId":"../odd id;$(x)","workspacePaths":["/home/u/p"],"stop_hook_active":true,"prompt":"smuggled","cwd":"/smuggled","model":"m"}'
assert_eq "G4: rc 0" "$RC" "0"
# shellcheck disable=SC2016
assert_eq "G4: odd conversationId passes through" "$(field "$OUT" session_id)" '../odd id;$(x)'
assert_eq "G4: cwd comes from workspacePaths only" "$(field "$OUT" cwd)" "/home/u/p"
assert_eq "G4: nothing else is copied" "$(keys "$OUT")" "cwd,session_id"
translate '{"workspacePaths":["/home/u/p"]}'
assert_eq "G4: a missing conversationId becomes an empty session_id" "$(field "$OUT" session_id)" ""

echo "=== G5: no usable prompt ==="
for p in '' ',"lastUserInput":""' ',"lastUserInput":"   \n\t "' ',"lastUserInput":null' ',"lastUserInput":["x"]' ',"lastUserInput":5'; do
  translate "{\"conversationId\":\"c1\",\"workspacePaths\":[\"/home/u/p\"]$p}"
  assert_eq "G5: no prompt key for: ${p:-<absent>}" "$(field "$OUT" prompt)" "<absent>"
  if um_agy_has_prompt "$OUT"; then fail "G5: has_prompt false for: ${p:-<absent>}" "said true"
  else pass "G5: has_prompt false for: ${p:-<absent>}"; fi
done

echo "=== G6: inject ==="
inject "$(ctx 'state of play')" "$(ctx 'memory hits')"
assert_eq "G6: two contexts join with one blank line" "$(injected_text "$OUT")" "state of play

memory hits"
assert_eq "G6: one line of output" "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" "1"
inject '{}' "$(ctx 'only this')"
assert_eq "G6: an empty output is skipped" "$(injected_text "$OUT")" "only this"
inject "$(ctx '   ')" "$(ctx 'only this')"
assert_eq "G6: blank context is skipped" "$(injected_text "$OUT")" "only this"
inject '{}' ''
assert_eq "G6: nothing to inject gives {}" "$OUT" "{}"
inject 'not json' '["x"]' '{"hookSpecificOutput":"x"}' '{"hookSpecificOutput":{"additionalContext":7}}'
assert_eq "G6: unusable outputs give {}" "$OUT" "{}"
OUT=$(printf '' | um_agy_inject)
assert_eq "G6: empty stdin gives {}" "$OUT" "{}"
TRICKY='quote " backslash \ tab	end
second line — café ✓'
inject "$(ctx "$TRICKY")"
assert_eq "G6: quotes, backslashes, newlines and non-ASCII survive" "$(injected_text "$OUT")" "$TRICKY"
case "$OUT" in *$'\r'*) fail "G6: no carriage return in the output" "found one" ;; *) pass "G6: no carriage return in the output" ;; esac

echo "=== G7: sid and prompt probes ==="
translate '{"conversationId":"0b9d3f6e-1111","workspacePaths":["/home/u/p"],"lastUserInput":"say \"prompt\": hi"}'
assert_eq "G7: sid" "$(um_agy_sid "$OUT")" "0b9d3f6e-1111"
if um_agy_has_prompt "$OUT"; then pass "G7: has_prompt true"; else fail "G7: has_prompt true" "said false"; fi
translate '{"conversationId":"c1","workspacePaths":["/home/u/say \"prompt\": x"]}'
if um_agy_has_prompt "$OUT"; then fail "G7: a path that mentions prompt is not a prompt" "said true"
else pass "G7: a path that mentions prompt is not a prompt"; fi
translate '{"conversationId":"odd id","workspacePaths":["/home/u/p"]}'
assert_eq "G7: an unsafe sid is reported as unknown" "$(um_agy_sid "$OUT")" "unknown"
assert_eq "G7: no translation, unknown sid" "$(um_agy_sid "")" "unknown"

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
