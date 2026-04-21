# hooks/lib/resolve-project.sh
# Resolve <project> per docs/um-cli.md §"Project-resolution order":
#   1. $1 arg (--project <p>)
#   2. $UM_PROJECT env
#   3. .um/config UM_PROJECT= entry (pre-loaded by dispatcher; skipped for um-capture standalone)
#   4. git rev-parse --show-toplevel | basename
#   5. exit 2 with helpful message
resolve_project() {
  local from_arg="${1:-}"
  if [ -n "$from_arg" ]; then echo "$from_arg"; return 0; fi
  if [ -n "${UM_PROJECT:-}" ]; then echo "$UM_PROJECT"; return 0; fi
  local git_root
  git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || git_root=""
  if [ -n "$git_root" ]; then basename "$git_root"; return 0; fi
  echo "um: no project specified; use --project, set UM_PROJECT, add UM_PROJECT=... to .um/config, or run from inside a git repo" >&2
  return 2
}
