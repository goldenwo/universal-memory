#!/usr/bin/env bash
# hooks/lib/resolve-project.test.sh — resolve_project's git tier (#328).
#
# Run: bash resolve-project.test.sh
# All tests must pass (exit 0 = pass, non-zero = fail).
#
# Fixtures are made by git itself, so the .git files are the real thing:
#   R1. main checkout            -> main
#   R2. linked worktree          -> main   (#328: not the worktree folder)
#   R3. subdir of that worktree  -> main
#   R4. worktree of a BARE main  -> proj   (<repo>.git names <repo>)
#   R5. --project arg wins over git
#   R6. UM_PROJECT env wins over git
#   R7. no git at all -> rc 2, nothing on stdout
# Precedence over the hooks' rule: project_guard.py names the same checkouts
# the same way (session-end.test.sh G14b-e), which is the point of #328.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-project.sh
source "$SCRIPT_DIR/resolve-project.sh"

PASS=0
FAIL=0
FAILURES=()
pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); FAILURES+=("$1"); printf '  FAIL: %s\n' "$1"; }
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$name"; else fail "$name (got='$got', want='$want')"; fi
}

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT
G() { git -c user.email=t@example.com -c user.name=t -c init.defaultBranch=main "$@"; }

G init -q "$TMPDIR_ROOT/main"
G -C "$TMPDIR_ROOT/main" commit -q --allow-empty -m init
G -C "$TMPDIR_ROOT/main" worktree add -q "$TMPDIR_ROOT/wt-linked" >/dev/null 2>&1
mkdir -p "$TMPDIR_ROOT/wt-linked/sub"
G clone -q --bare "$TMPDIR_ROOT/main" "$TMPDIR_ROOT/proj.git"
G -C "$TMPDIR_ROOT/proj.git" worktree add -q "$TMPDIR_ROOT/wt-bare" >/dev/null 2>&1
mkdir -p "$TMPDIR_ROOT/plain"

# resolve_in <dir> [arg] — run resolve_project from <dir> with UM_PROJECT unset.
resolve_in() { local d="$1"; shift; (cd "$d" && unset UM_PROJECT && resolve_project "$@" 2>/dev/null); }

echo "=== R1: main checkout names itself ==="
assert_eq "R1: main -> main" "$(resolve_in "$TMPDIR_ROOT/main")" "main"

echo "=== R2 (#328): a linked worktree names its main checkout ==="
assert_eq "R2: wt-linked -> main" "$(resolve_in "$TMPDIR_ROOT/wt-linked")" "main"

echo "=== R3 (#328): a subdir of the worktree names the main checkout ==="
assert_eq "R3: wt-linked/sub -> main" "$(resolve_in "$TMPDIR_ROOT/wt-linked/sub")" "main"

echo "=== R4 (#328): a worktree of a bare main names the repository ==="
assert_eq "R4: wt-bare -> proj" "$(resolve_in "$TMPDIR_ROOT/wt-bare")" "proj"

echo "=== R5: --project arg wins ==="
assert_eq "R5: explicit arg" "$(resolve_in "$TMPDIR_ROOT/wt-linked" explicit)" "explicit"

echo "=== R6: UM_PROJECT wins over git ==="
assert_eq "R6: env" "$(cd "$TMPDIR_ROOT/wt-linked" && UM_PROJECT=fromenv resolve_project 2>/dev/null)" "fromenv"

echo "=== R7: no git -> rc 2, empty stdout ==="
R7_OUT=$(resolve_in "$TMPDIR_ROOT/plain"); R7_RC=$?
assert_eq "R7: rc 2" "$R7_RC" "2"
assert_eq "R7: empty stdout" "$R7_OUT" ""

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
