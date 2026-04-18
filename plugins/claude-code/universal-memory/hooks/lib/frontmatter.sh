#!/usr/bin/env bash
# hooks/lib/frontmatter.sh — frontmatter read/write helpers
# Source this file; do not execute directly.
# Requires: python3 with pyyaml (graceful degradation if absent)

# Read a single frontmatter field as text.
# Usage: value=$(fm_read FILE FIELD)
# Returns: field value on stdout, or empty string if missing.
# Exit: 0 always (graceful).
fm_read() {
  local file="$1"
  local field="$2"
  python3 - "$file" "$field" <<'PY'
import sys, re
try:
    import yaml
except ImportError:
    sys.exit(0)  # graceful: no yaml lib = no frontmatter
file_path, field = sys.argv[1], sys.argv[2]
try:
    with open(file_path, 'r', encoding='utf-8') as f:
        text = f.read()
except Exception:
    sys.exit(0)
m = re.match(r'^---\r?\n(.*?)\r?\n---[ \t]*\r?\n?', text, re.DOTALL)
if not m:
    sys.exit(0)
try:
    fm = yaml.safe_load(m.group(1)) or {}
except Exception:
    sys.exit(0)
if not isinstance(fm, dict):
    sys.exit(0)
val = fm.get(field)
if val is None:
    sys.exit(0)
if isinstance(val, list):
    print(' '.join(str(v) for v in val))
else:
    # Re-emit the raw YAML scalar so datetime objects stay as ISO strings
    import io
    out = io.StringIO()
    yaml.dump(val, out, default_flow_style=True, allow_unicode=True)
    raw = out.getvalue().strip()
    # yaml.dump wraps strings in quotes or appends \n...; strip quotes if present
    if raw.startswith("'") and raw.endswith("'"):
        raw = raw[1:-1]
    elif raw.startswith('"') and raw.endswith('"'):
        raw = raw[1:-1]
    # For datetime, yaml.dump emits e.g. 2026-04-01 00:00:00+00:00 — use original text instead
    # Re-extract the raw scalar text directly from the source YAML
    import re as _re
    field_pattern = _re.compile(r'^\s*' + _re.escape(field) + r'\s*:\s*(.+)$', _re.MULTILINE)
    m2 = field_pattern.search(m.group(1))
    if m2:
        print(m2.group(1).strip())
    else:
        print(raw)
PY
}

# Atomically write frontmatter + body to FILE.
# Usage: fm_write FILE FRONTMATTER_YAML BODY
#   FRONTMATTER_YAML is a YAML mapping (without --- delimiters)
#   BODY is the markdown body
# Returns: 0 on success, 1 on write failure or YAML validation error.
fm_write() {
  local file="$1"
  local fm_yaml="$2"
  local body="$3"
  local dir
  dir=$(dirname "$file")
  mkdir -p "$dir" || return 1

  # Validate YAML before writing if python3 is available
  if command -v python3 >/dev/null 2>&1; then
    if ! printf '%s\n' "$fm_yaml" | python3 -c 'import sys, yaml; yaml.safe_load(sys.stdin.read())' 2>/dev/null; then
      return 1
    fi
  fi

  local tmp="${file}.tmp.$$"
  {
    printf '%s\n' '---'
    printf '%s\n' "$fm_yaml"
    printf '%s\n' '---'
    printf '%s\n' "$body"
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
  return 0
}
