#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LIB_DIR="${UM_LIB_DIR:-$SCRIPT_DIR/../hooks/lib}"

# shellcheck source=../hooks/lib/resolve-project.sh
source "$LIB_DIR/resolve-project.sh"

_usage() {
  cat <<EOF
Usage: um state [<project>] [options]

Wraps GET /api/state/{project}. Prints current state.md body to stdout.

Arguments:
  <project>         Project name. If omitted, resolved from \$UM_PROJECT or git repo name.

Options:
  --json            Emit a single JSON object: {project, body, valid_from}. Default is plain body.
  --server URL      Override server URL (default: \$UM_SERVER_URL or http://localhost:6335)
  --help, -h        Show this message

Exit codes:
  0  success (empty output if state.md does not exist for this project)
  2  project cannot be resolved (and --project / \$UM_PROJECT / git repo name all failed)
  3  server error
EOF
}

CLI_PROJECT=""
SERVER="${UM_SERVER_URL:-http://localhost:6335}"
JSON_OUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    --json) JSON_OUT=1; shift ;;
    --server) SERVER="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "um state: unknown option: $1" >&2; _usage >&2; exit 2 ;;
    *)
      if [ -z "$CLI_PROJECT" ]; then
        CLI_PROJECT="$1"
      else
        echo "um state: too many positional args" >&2; _usage >&2; exit 2
      fi
      shift
      ;;
  esac
done

# Resolve project (arg → env → git → error-exit-2)
project="$(resolve_project "$CLI_PROJECT")" || exit $?

if ! command -v jq >/dev/null 2>&1; then
  echo "um state: jq is required" >&2
  exit 3
fi

URL="$SERVER/api/state/$project"

response=$(curl -sfm 10 "$URL" 2>&1) || {
  echo "um state: server error or timeout: $response" >&2
  exit 3
}

# Parse response: {ok, project, state: {frontmatter, body} | null, valid_from}
# state: null → empty output, exit 0

if [ "$JSON_OUT" = "1" ]; then
  # Emit {project, body, valid_from} — no frontmatter (keep object flat for pipelines)
  echo "$response" | jq -c '{project: .project, body: (.state.body // ""), valid_from: .valid_from}'
else
  # Plain body; if state is null, emit nothing
  echo "$response" | jq -r '.state.body // empty'
fi
