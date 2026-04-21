#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

_usage() {
  cat <<EOF
Usage: um search <query> [options]

Wraps GET /api/search. Returns JSONL (one JSON object per result).

Arguments:
  <query>           Search query (required, non-empty)

Options:
  --full            Request full bodies (default: compact snippet only)
  --limit N         Max results (default 5)
  --server URL      Override server URL (default: \$UM_SERVER_URL or http://localhost:6335)
  --help, -h        Show this message

Output:
  JSONL — one object per result.
  Compact shape (default): {id, title, score, snippet}
  Full shape (--full):     {id, title, score, body, metadata}

Exit codes:
  0  success
  2  missing/empty query or bad usage
  3  server error
EOF
}

# Pure-bash URL percent-encoding (RFC 3986 unreserved chars stay as-is)
_urlencode() {
  local string="$1"
  local encoded=""
  local i char hex
  for (( i=0; i<${#string}; i++ )); do
    char="${string:$i:1}"
    case "$char" in
      [A-Za-z0-9._~-]) encoded+="$char" ;;
      *) printf -v hex '%%%02X' "'$char"; encoded+="$hex" ;;
    esac
  done
  printf '%s' "$encoded"
}

# Parse flags
QUERY=""
FULL=0
LIMIT=5
SERVER="${UM_SERVER_URL:-http://localhost:6335}"
QUERY_PROVIDED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    --full) FULL=1; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "um search: unknown option: $1" >&2; _usage >&2; exit 2 ;;
    *)
      QUERY_PROVIDED=1
      if [ -z "$QUERY" ]; then
        QUERY="$1"
      else
        QUERY="$QUERY $1"
      fi
      shift
      ;;
  esac
done

# Reject: no arg provided AT ALL, OR arg provided but empty string
if [ "$QUERY_PROVIDED" = "0" ] || [ -z "$QUERY" ]; then
  echo "um search: query is required (non-empty)" >&2
  _usage >&2
  exit 2
fi

# URL-encode the query (pure bash — no external dependency)
Q_ENC=$(_urlencode "$QUERY")

# Build URL
URL="$SERVER/api/search?q=$Q_ENC&limit=$LIMIT"
[ "$FULL" = "1" ] && URL="$URL&full=1"

# Fetch
response=$(curl -fSsm 10 "$URL" 2>&1) || {
  curl_rc=$?
  echo "um search: curl exit $curl_rc: $response" >&2
  exit 3
}

# Emit JSONL — one object per result
# Use jq if available; otherwise fall back to a minimal awk-based extractor.
if command -v jq >/dev/null 2>&1; then
  echo "$response" | jq -c '.results // [] | .[]'
else
  # Minimal fallback: each top-level object in the results array on its own line.
  # Works for well-formatted single-line JSON from the server.
  echo "$response" | awk '
    BEGIN { depth=0; in_results=0; obj="" }
    {
      line=$0
      # look for "results":[ marker
      if (!in_results && index(line, "\"results\"") > 0) { in_results=1 }
      if (!in_results) next
      n=split(line, chars, "")
      for (i=1; i<=n; i++) {
        c=chars[i]
        if (c=="{") {
          depth++
          obj=obj c
        } else if (c=="}") {
          obj=obj c
          depth--
          if (depth==0 && obj!="") { print obj; obj="" }
        } else if (depth>0) {
          obj=obj c
        }
      }
    }
  '
fi
