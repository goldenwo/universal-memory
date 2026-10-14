#!/usr/bin/env bash
# bin/lib/um-json.sh — JSON shaping for the CLI's read subcommands.
#
# Uses jq when it is installed, python otherwise. python3 is already required
# for the CLI (install-cli.sh refuses without it); jq is not, and a fresh
# Ubuntu has none, so `um state`, `um list` and `um recent` failed with
# "jq is required" (2026-10-14 clean-room install). The python branches print
# what the jq filters print: compact JSON, one object per line.
#
# Contract: source this file, then pipe a server response into
#   _um_json_results                → one compact object per `.results[]` entry
#   _um_json_state json|text        → {project, body, valid_from} | the bare body
# Each returns 3 with a message when neither jq nor a working python exists.
# shellcheck disable=SC2016  # the python programs are single-quoted on purpose

# The interpreter the hooks use (um_find_python skips Windows Store stubs),
# else python3/python from PATH.
_um_json_python() {
  local py=""
  if declare -F um_find_python >/dev/null 2>&1; then py=$(um_find_python 2>/dev/null || true); fi
  [ -n "$py" ] || py=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)
  [ -n "$py" ] || { echo "um: reading the server's JSON needs jq or python3" >&2; return 3; }
  printf '%s\n' "$py"
}

_um_json_results_py() {
  local py; py=$(_um_json_python) || return 3
  "$py" -c 'import sys, json
for r in (json.load(sys.stdin).get("results") or []):
    print(json.dumps(r, separators=(",", ":"), ensure_ascii=False))'
}

_um_json_state_py() {
  local mode="$1" py; py=$(_um_json_python) || return 3
  "$py" -c 'import sys, json
d = json.load(sys.stdin)
raw = (d.get("state") or {}).get("body")
missing = raw is None or raw is False  # jq `//` falls through on null/false only
if sys.argv[1] == "json":
    print(json.dumps({"project": d.get("project"), "body": "" if missing else raw, "valid_from": d.get("valid_from")}, separators=(",", ":"), ensure_ascii=False))
elif not missing:
    print(raw)' "$mode"
}

_um_json_results() {
  if command -v jq >/dev/null 2>&1; then jq -c '.results // [] | .[]'; else _um_json_results_py; fi
}

_um_json_state() {
  local mode="$1"
  if command -v jq >/dev/null 2>&1; then
    if [ "$mode" = json ]; then
      jq -c '{project: .project, body: (.state.body // ""), valid_from: .valid_from}'
    else
      jq -r '.state.body // empty'
    fi
  else
    _um_json_state_py "$mode"
  fi
}
