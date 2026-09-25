# shellcheck shell=bash
# hooks/lib/resolve-project.sh
# Resolve <project> per docs/um-cli.md §"Project-resolution order":
#   1. $1 arg (--project <p>)
#   2. $UM_PROJECT env
#   3. .um/config UM_PROJECT= entry (pre-loaded by dispatcher; skipped for um-capture standalone)
#   4. git rev-parse --show-toplevel | basename — except inside a linked
#      worktree (#328), which names its MAIN checkout: the hooks'
#      project_guard.py applies the same rule, so CLI and hooks agree.
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
    # #328: a linked worktree is the same repository checked out again, so
    # it belongs to the MAIN checkout's project. --git-common-dir is
    # <main>/.git from any worktree (and <repo>.git for a bare main);
    # anything else — a submodule's .git/modules/<name>, a git too old for
    # --path-format (< 2.31) — keeps the --show-toplevel name. Same rule as
    # project_guard.py's _worktree_main, so CLI and hooks name a worktree
    # identically.
    local common
    common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
    case "$(basename "${common:-/}")" in
      .git) git_root="$(dirname "$common")" ;;
      ?*.git) git_root="$(dirname "$common")/$(basename "$common" .git)" ;;
    esac
    local bn
    bn="$(basename "$git_root")"
    _um_validate_slug "$bn" || return 2
    echo "$bn"; return 0
  fi
  echo "um: no project specified; use --project, set UM_PROJECT, add UM_PROJECT=... to .um/config, or run from inside a git repo" >&2
  return 2
}
