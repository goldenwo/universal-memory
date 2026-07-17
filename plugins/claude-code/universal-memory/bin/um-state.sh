#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=lib/um-curl-wrap.sh
source "$SCRIPT_DIR/lib/um-curl-wrap.sh"
LIB_DIR="${UM_LIB_DIR:-$SCRIPT_DIR/../hooks/lib}"

# shellcheck source=../hooks/lib/resolve-project.sh
source "$LIB_DIR/resolve-project.sh"

# #159 T6b: file-aware endpoint resolution — same composed semantic as the
# hooks (spec §4: UM_SERVER_URL env → deprecated UM_ENDPOINT env →
# ~/.um/endpoint file → http://localhost:6335). um-api.sh lives in the same
# lib dir (installer glob-copies hooks/lib/*.sh); fall back to the legacy
# env-only default when it is absent (pre-#159 partial install).
if [ -r "$LIB_DIR/um-api.sh" ]; then
  # shellcheck source=../hooks/lib/um-api.sh
  source "$LIB_DIR/um-api.sh"
  DEFAULT_SERVER="$(um_api_endpoint)"
else
  DEFAULT_SERVER="${UM_SERVER_URL:-http://localhost:6335}"
fi

_usage() {
  cat <<EOF
Usage: um state [<project>] [options]

Wraps GET /api/state/{project}. Prints current state.md body to stdout.

Arguments:
  <project>         Project name. If omitted, resolved from \$UM_PROJECT or git repo name.

Options:
  --json            Emit a single JSON object: {project, body, valid_from}. Default is plain body.
  --server URL      Override server URL (default: \$UM_SERVER_URL, else ~/.um/endpoint, else http://localhost:6335)
  --help, -h        Show this message

Exit codes:
  0  success (empty output if state.md does not exist for this project)
  2  project cannot be resolved (and --project / \$UM_PROJECT / git repo name all failed)
  3  server error
EOF
}

CLI_PROJECT=""
SERVER="$DEFAULT_SERVER"
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

response=$(_um_curl_wrap "um-state" -fSsm 10 --fail-with-body \
  -H "Authorization: Bearer ${UM_AUTH_TOKEN:-}" \
  -H "User-Agent: um-cli/0.6" \
  "$URL") || exit 3

# Parse response: {ok, project, state: {frontmatter, body} | null, valid_from}
# state: null → empty output, exit 0

if [ "$JSON_OUT" = "1" ]; then
  # Emit {project, body, valid_from} — no frontmatter (keep object flat for pipelines)
  echo "$response" | jq -c '{project: .project, body: (.state.body // ""), valid_from: .valid_from}'
else
  # Plain body; if state is null, emit nothing
  echo "$response" | jq -r '.state.body // empty'
fi
