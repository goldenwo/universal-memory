#!/usr/bin/env bash
# bin/um-tail.sh — batch tail of raw captures (FS-direct; does not hit the server)
# Called via `um tail [<project>] [options]`
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LIB_DIR="${UM_LIB_DIR:-$SCRIPT_DIR/../hooks/lib}"

# shellcheck source=../hooks/lib/resolve-project.sh
source "$LIB_DIR/resolve-project.sh"

_usage() {
  cat <<EOF
Usage: um tail [<project>] [options]

Print the N most recent raw captures (fs-direct; does not hit the server).

Arguments:
  <project>         Project name. If omitted, resolved from \$UM_PROJECT or git repo name.

Options:
  -n, --limit N     Max entries (default 10)
  --json            Emit JSONL: {captured_at, type, body} per entry. Default is plain text.
  --help, -h        Show this message

Vault:
  Reads from \$UM_VAULT_DIR/captures/<project>/raw/*.md (default vault: \$HOME/.um/vault).

Exit codes:
  0  success (empty output if project has no raw captures)
  2  project cannot be resolved
EOF
}

CLI_PROJECT=""
LIMIT=10
JSON_OUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) _usage; exit 0 ;;
    -n|--limit) LIMIT="$2"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    --) shift; break ;;
    -*) echo "um tail: unknown option: $1" >&2; _usage >&2; exit 2 ;;
    *)
      if [ -z "$CLI_PROJECT" ]; then
        CLI_PROJECT="$1"
      else
        echo "um tail: too many positional args" >&2; _usage >&2; exit 2
      fi
      shift
      ;;
  esac
done

project="$(resolve_project "$CLI_PROJECT")" || exit $?

VAULT_DIR="${UM_VAULT_DIR:-$HOME/.um/vault}"
RAW_DIR="$VAULT_DIR/captures/$project/raw"

if [ ! -d "$RAW_DIR" ]; then
  # No captures for this project — exit 0 empty
  exit 0
fi

# Gather all raw files sorted by filename (YYYY-MM-DD.md = chronological order).
shopt -s nullglob
raw_files=("$RAW_DIR"/*.md)
shopt -u nullglob

if [ ${#raw_files[@]} -eq 0 ]; then
  exit 0
fi

# Parse raw capture files to JSONL using Python (more robust than awk for
# multi-line bodies with special characters).
# Falls back to awk if python3 is unavailable.
_parse_raw_files_to_json() {
  if command -v python3 >/dev/null 2>&1; then
    UM_TAIL_LIMIT="$LIMIT" python3 - "$@" <<'PY'
import sys, re, json, os

entries = []
for path in sys.argv[1:]:
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            content = f.read()
    except OSError:
        continue
    # Split on lines that are exactly "---" (optionally trailing whitespace)
    # parts alternate: [leading-empty, frontmatter, body, frontmatter, body, ...]
    parts = re.split(r'^---[ \t]*$', content, flags=re.MULTILINE)
    # The first split element is whatever appears before the first "---".
    # Entries start at index 1 (frontmatter) and index 2 (body), stepping by 2.
    i = 1
    while i + 1 < len(parts):
        fm_text = parts[i].strip()
        body_text = parts[i + 1].strip()
        fm = {}
        for line in fm_text.split('\n'):
            m = re.match(r'^(\w+):\s*(.+)$', line.strip())
            if m:
                fm[m.group(1)] = m.group(2)
        # Only emit entries that have at least a captured_at or non-empty body
        if fm or body_text:
            entries.append({
                'captured_at': fm.get('captured_at', ''),
                'type': fm.get('type', ''),
                'body': body_text,
            })
        i += 2

# Sort by captured_at DESC (ISO-8601 strings sort lexicographically)
entries.sort(key=lambda e: e['captured_at'], reverse=True)

limit = int(os.environ.get('UM_TAIL_LIMIT', '10'))
for e in entries[:limit]:
    print(json.dumps(e))
PY
  else
    # awk fallback: same logic without Python
    awk -v limit="$LIMIT" '
      BEGIN { in_fm=0; fm=""; body=""; captured=""; etype=""; count=0 }
      /^---[ \t]*$/ {
        if (in_fm == 0) {
          # Emit previous entry if one was being accumulated
          if (NR > 1 && (captured != "" || etype != "" || body != "")) {
            # Strip trailing newline from body
            sub(/\n$/, "", body)
            # JSON-escape body, captured_at, type
            b=body; gsub(/\\/, "\\\\", b); gsub(/"/, "\\\"", b); gsub(/\n/, "\\n", b)
            c=captured; gsub(/\\/, "\\\\", c); gsub(/"/, "\\\"", c)
            t=etype; gsub(/\\/, "\\\\", t); gsub(/"/, "\\\"", t)
            entries[count++] = "{\"captured_at\":\"" c "\",\"type\":\"" t "\",\"body\":\"" b "\"}"
          }
          in_fm=1; captured=""; etype=""; body=""
          next
        } else {
          in_fm=0
          next
        }
      }
      in_fm == 1 {
        if (match($0, /^captured_at:[ \t]*/)) { captured = substr($0, RSTART + RLENGTH); next }
        if (match($0, /^type:[ \t]*/)) { etype = substr($0, RSTART + RLENGTH); next }
        next
      }
      in_fm == 0 && NR > 1 {
        if (body == "") body = $0
        else body = body "\n" $0
      }
      END {
        # Emit final entry
        if (captured != "" || etype != "" || body != "") {
          sub(/\n$/, "", body)
          b=body; gsub(/\\/, "\\\\", b); gsub(/"/, "\\\"", b); gsub(/\n/, "\\n", b)
          c=captured; gsub(/\\/, "\\\\", c); gsub(/"/, "\\\"", c)
          t=etype; gsub(/\\/, "\\\\", t); gsub(/"/, "\\\"", t)
          entries[count++] = "{\"captured_at\":\"" c "\",\"type\":\"" t "\",\"body\":\"" b "\"}"
        }
        # Sort entries descending by captured_at (simple: reverse insertion order
        # since files are fed newest-last; not a true sort but better than nothing)
        n = (count < limit) ? count : limit
        for (i=count-1; i>=count-n; i--) {
          if (entries[i] != "") print entries[i]
        }
      }
    ' "$@"
  fi
}

# Parse all raw files; output is JSONL sorted by captured_at DESC, limited to N
filtered=$(_parse_raw_files_to_json "${raw_files[@]}")

if [ -z "$filtered" ]; then
  exit 0
fi

if [ "$JSON_OUT" = "1" ]; then
  echo "$filtered"
else
  # Plain text: one entry per block with [captured_at] type=<type> header, body, separator
  echo "$filtered" | while IFS= read -r line; do
    [ -z "$line" ] && continue
    captured=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('captured_at',''))" 2>/dev/null \
      || echo "$line" | sed -nE 's/.*"captured_at":"([^"]*)".*/\1/p')
    etype=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('type',''))" 2>/dev/null \
      || echo "$line" | sed -nE 's/.*"type":"([^"]*)".*/\1/p')
    body=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('body',''))" 2>/dev/null \
      || echo "$line" | sed -nE 's/.*"body":"(.*)"\}/\1/p' | sed 's/\\\\/\\/g; s/\\"/"/g; s/\\n/\n/g')
    printf '[%s] type=%s\n%s\n---\n' "$captured" "$etype" "$body"
  done
fi
