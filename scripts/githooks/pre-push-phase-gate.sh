#!/usr/bin/env bash
# pre-push-phase-gate.sh — enforce smoke + shellcheck on phase-boundary pushes.
#
# Codifies the v0.6 phase-boundary smoke gate documented in
# docs/process/review-playbook.md § Recurring lessons § v0.6.
#
# ─── Install ──────────────────────────────────────────────────────────────────
#
# Per-clone, run once:
#
#   git config --local core.hooksPath scripts/githooks
#
# That points git at this directory for hooks. Verify with:
#
#   git config --local --get core.hooksPath
#   # → scripts/githooks
#
# ─── Behavior ─────────────────────────────────────────────────────────────────
#
# Trigger: push to any remote branch matching `v*`. Other branches (main,
# feature branches, docs/* PR branches) skip the gate — only release-track
# work-branches enforce phase-boundary discipline.
#
# Detection: scans the push range for commit messages matching a
# phase-boundary pattern. Conventional-commit form with a phase identifier:
#
#   feat(B.14): integration gate
#   fix(C.11): retry+jitter wiring
#   refactor(D.10): bridge integration smoke
#
# The regex matches `<type>(<phase>.<task>):` where `<phase>` is a single
# uppercase letter and `<task>` is a number. Adjust below if your naming
# convention differs. Optionally also matches a `Phase-boundary: X.Y` git
# trailer for explicit opt-in tagging.
#
# Gate: when a phase-boundary commit is in the push range, runs (in order):
#
#   1. docker compose up -d --force-recreate --no-deps memory-server
#   2. bash server/test/smoke.sh
#   3. shellcheck --severity=warning over the installer tree
#
# Refuses the push if any step fails. Exit 0 on success, 1 on failure.
#
# ─── Bypass ───────────────────────────────────────────────────────────────────
#
# For hot-fix paths only:
#
#   git push --no-verify
#
# The next non-hot-fix push will catch any drift the bypass introduced.
# Bypassing routinely defeats the gate — see PR #31 retrospective.

set -euo pipefail

# ─── Args (per git pre-push hook contract) ────────────────────────────────────
remote="${1:-origin}"
url="${2:-}"

# Hook reads `<local_ref> <local_sha> <remote_ref> <remote_sha>` lines on stdin.
# An empty stdin (e.g., when tested manually) means no refs to push — skip.
if [ -t 0 ]; then
  echo "[pre-push-phase-gate] no refs on stdin (manual run?) — skipping" >&2
  exit 0
fi

triggered=0
while read -r local_ref local_sha remote_ref remote_sha; do
  # Only fire on `v*` remote branches.
  case "$remote_ref" in
    refs/heads/v*) ;;
    *) continue ;;
  esac

  # Determine the commit range being pushed.
  # If `remote_sha` is the all-zeros SHA, the branch is new; compare against
  # the merge-base with `main` instead so we cover only the new commits.
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    base=$(git merge-base "$local_sha" "origin/main" 2>/dev/null || echo "")
    if [ -z "$base" ]; then
      base=$(git rev-parse "$local_sha~10" 2>/dev/null || echo "$local_sha")
    fi
    range="$base..$local_sha"
  else
    range="$remote_sha..$local_sha"
  fi

  # Phase-boundary detection: conventional-commit form with `(X.N)` phase
  # tag, OR an explicit `Phase-boundary:` trailer.
  phase_pattern='^[a-z]+(\([^)]*[A-Z]\.[0-9]+[^)]*\)):'
  trailer_pattern='^Phase-boundary:'

  if git log --format='%s%n%(trailers)' "$range" 2>/dev/null \
     | grep -qE "$phase_pattern|$trailer_pattern"; then
    triggered=1
    echo "[pre-push-phase-gate] phase-boundary commits detected in $range" >&2
    break
  fi
done

if [ "$triggered" -ne 1 ]; then
  exit 0
fi

# ─── Run the gate ─────────────────────────────────────────────────────────────

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

echo "[pre-push-phase-gate] gate firing — smoke + shellcheck against fresh stack" >&2

# 1. Fresh stack.
echo "[pre-push-phase-gate] (1/3) docker compose up -d --force-recreate" >&2
if ! ( cd server && docker compose up -d --force-recreate --no-deps memory-server ) >/dev/null 2>&1; then
  echo "[pre-push-phase-gate] FAIL: docker compose up failed" >&2
  echo "[pre-push-phase-gate] check 'docker compose logs memory-server' for cause" >&2
  exit 1
fi

# Wait briefly for the server to come up.
echo "[pre-push-phase-gate]       waiting for /health..." >&2
for i in $(seq 1 60); do
  if curl -sf http://localhost:6335/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -sf http://localhost:6335/health >/dev/null 2>&1; then
  echo "[pre-push-phase-gate] FAIL: server did not become healthy within 60s" >&2
  exit 1
fi

# 2. Smoke.
echo "[pre-push-phase-gate] (2/3) bash server/test/smoke.sh" >&2
if ! bash server/test/smoke.sh; then
  echo "[pre-push-phase-gate] FAIL: smoke.sh exited non-zero" >&2
  echo "[pre-push-phase-gate] fix the failure or push with --no-verify (hot-fix only)" >&2
  exit 1
fi

# 3. Shellcheck the installer tree.
echo "[pre-push-phase-gate] (3/3) shellcheck --severity=warning installer/" >&2
if ! shellcheck --severity=warning \
     installer/*.sh installer/lib/*.sh \
     installer/*.test.sh installer/lib/*.test.sh \
     plugins/claude-code/universal-memory/hooks/*.test.sh 2>&1; then
  echo "[pre-push-phase-gate] FAIL: shellcheck found warnings" >&2
  echo "[pre-push-phase-gate] fix the warnings or push with --no-verify (hot-fix only)" >&2
  exit 1
fi

echo "[pre-push-phase-gate] OK: phase-boundary gate green" >&2
exit 0
