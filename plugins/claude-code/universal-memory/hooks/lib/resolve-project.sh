# hooks/lib/resolve-project.sh
# Resolve <project> per docs/um-cli.md §"Project-resolution order":
#   1. $1 arg (--project <p>)
#   2. $UM_PROJECT env
#   3. .um/config UM_PROJECT= entry (pre-loaded by dispatcher; skipped for um-capture standalone)
#   4. git rev-parse --show-toplevel | basename
#   5. exit 2 with helpful message

# Validate a project slug. Rejects path-traversal attempts and invalid chars.
# Returns 0 if valid, 1 + stderr message if not.
_um_validate_slug() {
  local value="$1"
  if [[ ! "$value" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "um: invalid project slug: '$value' (must match ^[a-zA-Z0-9._-]+\$)" >&2
    return 1
  fi
  return 0
}

resolve_project() {
  local from_arg="${1:-}"
  if [ -n "$from_arg" ]; then
    _um_validate_slug "$from_arg" || return 2
    echo "$from_arg"; return 0
  fi
  if [ -n "${UM_PROJECT:-}" ]; then
    _um_validate_slug "$UM_PROJECT" || return 2
    echo "$UM_PROJECT"; return 0
  fi
  local git_root
  git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || git_root=""
  if [ -n "$git_root" ]; then
    local bn
    bn="$(basename "$git_root")"
    _um_validate_slug "$bn" || return 2
    echo "$bn"; return 0
  fi
  echo "um: no project specified; use --project, set UM_PROJECT, add UM_PROJECT=... to .um/config, or run from inside a git repo" >&2
  return 2
}
