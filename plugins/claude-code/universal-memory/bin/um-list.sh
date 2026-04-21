#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

_usage() {
  cat <<EOF
Usage: um list [options]

Wraps GET /api/list. Returns JSONL (one JSON object per memory).
Scope: vault-wide (NOT project-filtered — see B.1.4b decision).

Options:
  --full            Request full bodies + metadata (default: compact shape)
  --limit N         Max results (if supported by server)
  --server URL      Override server URL (default: \$UM_SERVER_URL or http://localhost:6335)
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
SERVER="${UM_SERVER_URL:-http://localhost:6335}"

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

response=$(curl -sfm 10 "$URL" 2>&1) || {
  echo "um list: server error or timeout: $response" >&2
  exit 3
}

# /api/list returns a RAW ARRAY, not {results: [...]}. Map directly.
echo "$response" | jq -c '.[]'
