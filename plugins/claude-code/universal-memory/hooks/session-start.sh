#!/bin/bash
# session-start.sh — universal-memory SessionStart hook for Claude Code
#
# Queries the configured memory server for context relevant to the current
# project and returns it as additionalContext for the new session.
#
# Required env:
#   UM_ENDPOINT   Memory server base URL, e.g. http://localhost:6335
#
# Exits silently if UM_ENDPOINT is unset or the server is unreachable —
# we never block session start on memory availability.

set -euo pipefail

if [ -z "${UM_ENDPOINT:-}" ]; then
	exit 0
fi

PROJECT=$(basename "${CLAUDE_CWD:-$(pwd)}")

# Auto-start the server if it's unreachable and the operator configured
# UM_COMPOSE_DIR. Silent on normal path (server already up).
AUTO_START="$(dirname "${BASH_SOURCE[0]}")/auto-start.sh"
if [ -x "$AUTO_START" ]; then
	bash "$AUTO_START" || true
fi

curl -sf --max-time 10 -X POST "$UM_ENDPOINT/api/search" \
	-H 'Content-Type: application/json' \
	-d "{\"query\": \"$PROJECT project architecture preferences conventions\", \"limit\": 10}" \
	2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    # v0.2.0 wraps in {results: [...]}; v0.1.x returned a bare array. Support both.
    items = data.get('results') if isinstance(data, dict) else data
    if not items:
        print(json.dumps({"additionalContext": ""}))
        sys.exit(0)
    lines = ["# Cross-session memory (universal-memory)", ""]
    seen = set()
    for i, r in enumerate(items):
        mem = r.get("memory", "")
        mid = r.get("id", "")
        if mid in seen or not mem:
            continue
        seen.add(mid)
        score = int(r.get("score", 0) * 100)
        lines.append(f"{i+1}. [{score}%] {mem}")
    print(json.dumps({"additionalContext": chr(10).join(lines)}))
except Exception:
    print(json.dumps({"additionalContext": ""}))
'
