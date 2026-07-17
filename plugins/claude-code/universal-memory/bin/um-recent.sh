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
  # Token: env else ~/.um/auth-token file (um_api_token) — a marketplace
  # /um-setup install writes the token file but exports nothing, so env-only
  # resolution would resolve the remote endpoint and then 401.
  AUTH_TOKEN="${UM_AUTH_TOKEN:-$(um_api_token)}"
else
  DEFAULT_SERVER="${UM_SERVER_URL:-http://localhost:6335}"
  AUTH_TOKEN="${UM_AUTH_TOKEN:-}"
fi

_usage() {
  cat <<EOF
Usage: um recent [<project>] [options]

Wraps GET /api/recent/{project}. Returns JSONL (one JSON object per memory).
Results ordered newest-first by mtime.

Arguments:
  <project>         Project name. If omitted, resolved from \$UM_PROJECT or git repo name.

Options:
  -n, --limit N     Max results (default 10)
  --full            Request full bodies (default: compact snippet only)
  --server URL      Override server URL (default: \$UM_SERVER_URL, else ~/.um/endpoint, else http://localhost:6335)
  --help, -h        Show this message

Output:
  JSONL — one object per result.
  Compact shape (default): {id, title, snippet}
  Full shape (--full):     compact + {body, metadata}

Exit codes:
  0  success (empty JSONL if project has no memories)
  2  project cannot be resolved
  3  server error
EOF
}

CLI_PROJECT=""
FULL=0
LIMIT=10
SERVER="$DEFAULT_SERVER"

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    --full) FULL=1; shift ;;
    -n|--limit) LIMIT="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "um recent: unknown option: $1" >&2; _usage >&2; exit 2 ;;
    *)
      if [ -z "$CLI_PROJECT" ]; then
        CLI_PROJECT="$1"
      else
        echo "um recent: too many positional args" >&2; _usage >&2; exit 2
      fi
      shift
      ;;
  esac
done

project="$(resolve_project "$CLI_PROJECT")" || exit $?

if ! command -v jq >/dev/null 2>&1; then
  echo "um recent: jq is required" >&2
  exit 3
fi

URL="$SERVER/api/recent/$project?limit=$LIMIT"
[ "$FULL" = "1" ] && URL="$URL&full=1"

response=$(_um_curl_wrap "um-recent" -fSsm 10 --fail-with-body \
  -H "Authorization: Bearer ${AUTH_TOKEN:-}" \
  -H "User-Agent: um-cli/0.6" \
  "$URL") || exit 3

echo "$response" | jq -c '.results // [] | .[]'
