#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=lib/um-curl-wrap.sh
source "$SCRIPT_DIR/lib/um-curl-wrap.sh"
LIB_DIR="${UM_LIB_DIR:-$SCRIPT_DIR/../hooks/lib}"

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
Usage: um list [options]

Wraps GET /api/list. Returns JSONL (one JSON object per memory).
Scope: vault-wide (NOT project-filtered — see B.1.4b decision).

Options:
  --full            Request full bodies + metadata (default: compact shape)
  --limit N         Max results (if supported by server)
  --server URL      Override server URL (default: \$UM_SERVER_URL, else ~/.um/endpoint, else http://localhost:6335)
  --help, -h        Show this message

Output:
  JSONL — one object per memory.
  Compact shape (default): {id, title, snippet}
  Full shape (--full):     compact + {body, metadata}

Exit codes:
  0  success
  2  bad usage
  3  server error

Note:
  A positional <project> arg is accepted but IGNORED with a stderr warning,
  per B.1.4b's decision to keep /api/list vault-wide.
EOF
}

FULL=0
LIMIT=""
SERVER="$DEFAULT_SERVER"

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    --full) FULL=1; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "um list: unknown option: $1" >&2; _usage >&2; exit 2 ;;
    *)
      # Positional arg — ignore with warning (B.1.4b scope decision: /api/list is vault-wide)
      echo "um list: warning: positional arg '$1' ignored (/api/list is vault-wide; see docs/um-cli.md)" >&2
      shift
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "um list: jq is required" >&2
  exit 3
fi

# Build query string
params=()
[ "$FULL" = "1" ] && params+=("full=1")
[ -n "$LIMIT" ] && params+=("limit=$LIMIT")
QS=""
if [ ${#params[@]} -gt 0 ]; then
  QS="?$(IFS=\&; echo "${params[*]}")"
fi

URL="$SERVER/api/list$QS"

response=$(_um_curl_wrap "um-list" -fSsm 10 --fail-with-body \
  -H "Authorization: Bearer ${AUTH_TOKEN:-}" \
  -H "User-Agent: um-cli/0.6" \
  "$URL") || exit 3

# /api/list returns {results: [...]} envelope. Map the inner array.
echo "$response" | jq -c '.results[]'
