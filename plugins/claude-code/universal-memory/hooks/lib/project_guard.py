# hooks/lib/project_guard.py — non-project cwd guard (#186).
#
# The desktop app spawns auxiliary sessions with cwd=$HOME (verified live
# 2026-07-27: SessionEnd meta.cwd == C:\Users\<user>, no transcript ever
# written). Minting a project slug from such a cwd buckets every one of those
# sessions into one giant <home-basename> project — combined with #185 this
# fabricated dozens of misattributed summaries per day.
#
# Contract (consumed by session-end.sh, stop.sh, and session-start.sh):
#   guard(cwd_raw, fallback_raw) -> "SKIP:<reason>" | "<project-ROOT-basename>"
#   - cwd_raw:      meta.cwd from the hook stdin JSON (may be empty)
#   - fallback_raw: bash-resolved "${CLAUDE_CWD:-$(pwd)}" (may be empty)
#   #294: the returned slug names the project ROOT the walk found (see the
#   D1 algorithm comment inside guard() — the canonical statement), never
#   the cwd's own basename. Reasons: home-cwd (cwd == $HOME),
#   non-project-cwd (no project marker found walking up, or no cwd at
#   all). FAIL CLOSED: every non-project outcome is an explicit SKIP
#   sentinel — the caller must never fall back to an unguarded leg
#   (review finding: the old `[ -z "$PROJECT" ]` bash fallback re-minted
#   the exact slug this guard suppresses).
#
# Semantics (spec docs/plans/2026-07-27-185-186-checkpoint-guard-spec.md):
#   1. MSYS rewrite (/e/... -> E:/...) BEFORE realpath, Windows only —
#      native-Windows realpath('/c/Users/x') would yield C:\c\Users\x, a
#      path that exists nowhere, wrongly skipping every pwd-fallback session.
#      Applied to BOTH the cwd and every home candidate (review BLOCKER: a
#      git-bash HOME is MSYS-form; without this the home check never fires
#      on the exact platform where #186 was observed).
#   2. cwd == $HOME -> home-cwd. Checked FIRST: ~/.claude existing must not
#      make $HOME itself look like a project.
#   3. Marker walk-up from cwd toward the root, stopping (exclusive) at any
#      home candidate — ~/Downloads must not qualify via ~/.claude — and at
#      the filesystem fixed point (parent == cur, which is the ONLY correct
#      terminator on Windows: dirname('E:\\') == 'E:\\', so a `!= '/'` test
#      would never terminate for drive-rooted projects; same for UNC roots).
#   4. Symlinked-home edge (accepted): a project reached through a symlink
#      that realpaths outside $HOME walks to the root instead of the home
#      boundary — strictly more permissive, never a wrong skip.

import json
import os
import re
import sys

DEFAULT_MARKERS = ".git,.claude,package.json,pyproject.toml,go.mod,Cargo.toml,.hg,.svn"


def _norm(p):
    """Normalize a path for comparison: MSYS drive rewrite (Windows only,
    BEFORE realpath), then realpath + normcase + normpath."""
    if not p:
        return ""
    p = p.replace("\\", "/")
    if os.name == "nt":
        m = re.match(r"^/([A-Za-z])(/|$)", p)
        if m:
            p = m.group(1).upper() + ":" + (p[2:] or "/")
    try:
        p = os.path.realpath(p)
    except OSError:
        pass
    return os.path.normcase(os.path.normpath(p))


def _home_candidates():
    """Every plausible home spelling, normalized. HOME covers git-bash;
    USERPROFILE / HOMEDRIVE+HOMEPATH cover native-Windows interpreters
    (py.exe ignores HOME in expanduser since 3.8)."""
    raw = [os.environ.get("HOME"), os.environ.get("USERPROFILE")]
    hd, hp = os.environ.get("HOMEDRIVE"), os.environ.get("HOMEPATH")
    if hd and hp:
        raw.append(hd + hp)
    raw.append(os.path.expanduser("~"))
    return {_norm(c) for c in raw if c}


def _root_name(marker_dir):
    """The ONE naming site (#294 T1 step 2): every walk exit that names a
    project routes through here, so the empty-basename guard cannot be
    half-applied. None -> no marker was seen -> SKIP."""
    if marker_dir is None:
        return "SKIP:non-project-cwd"
    base = os.path.basename(marker_dir.rstrip("/\\"))
    return base if base else "SKIP:non-project-cwd"


def guard(cwd_raw, fallback_raw=""):
    cwd = _norm(cwd_raw) or _norm(fallback_raw)
    if not cwd or cwd == ".":
        return "SKIP:non-project-cwd"
    homes = _home_candidates()
    if cwd in homes:
        # #186 follow-up (operator decision 2026-07-28): a session running AT
        # $HOME is a general desktop-app chat — real content the operator
        # wants captured — so it routes to a CATCH-ALL project instead of a
        # home-basename slug. The zero-turn auxiliary sessions that motivated
        # #186 die independently at the server's thin-transcript gate (#185).
        # UM_HOME_PROJECT overrides the bucket name; set EMPTY to revert to
        # skipping home sessions entirely. Home SUBDIRS (~/Downloads etc.)
        # are not chats — they stay under the marker walk-up below.
        home_project = os.environ.get("UM_HOME_PROJECT", "desktop").strip()
        return home_project if home_project else "SKIP:home-cwd"

    markers = [m.strip() for m in
               (os.environ.get("UM_PROJECT_MARKERS") or DEFAULT_MARKERS).split(",")
               if m.strip()]
    # #294 D1 — THE naming algorithm (canonical statement; every other
    # comment site is a pointer here). The walk names the project ROOT,
    # not the cwd:
    #   1. The nearest ancestor (cwd included) containing `.git` names the
    #      project — but ONLY while `.git` is in the ACTIVE marker set
    #      (an operator whose UM_PROJECT_MARKERS excludes .git has said it
    #      is not a marker here; a marker too weak to qualify a project
    #      cannot name one — the G5b contract). Nearest-.git is git's own
    #      --show-toplevel semantics: nested checkouts resolve to the
    #      inner repo, worktrees/submodules to their own root (`.git` may
    #      be a FILE; exists() is the deliberate test — stat, never parse).
    #   2. No active `.git` below the boundary: the NEAREST ancestor
    #      carrying any other active marker names it. The walk REMEMBERS
    #      that dir and continues looking for a dominating .git, so both
    #      exits below return the remembered dir — the #294 spec's D4
    #      delta 2 (a pre-#294 reading of these exits returned SKIP even
    #      with a marker seen, which would kill capture for every non-git
    #      project under $HOME).
    #   3. No marker at all -> SKIP (unchanged).
    # Why .git dominates nearer markers: repo subdirs routinely carry
    # package.json/pyproject.toml (this repo's server/ minted a junk
    # "server" layer exactly that way); the repo is the session-continuity
    # unit. Both naming sites route through _root_name() — the single
    # empty-basename guard (a marker at a drive root yields basename '',
    # which must SKIP, never POST {"project":""} into a server 400).
    git_active = ".git" in markers
    cur = cwd
    remembered = None  # nearest non-git-marker dir seen so far
    while True:
        if cur in homes:
            # Home boundary (exclusive, unchanged): markers AT or above
            # $HOME (e.g. ~/.claude) must not qualify a home subdir — but
            # a marker dir remembered BELOW the boundary names the project.
            return _root_name(remembered)
        if git_active and os.path.exists(os.path.join(cur, ".git")):
            return _root_name(cur)
        if remembered is None:
            for m in markers:
                if m != ".git" and os.path.exists(os.path.join(cur, m)):
                    remembered = cur
                    break
        parent = os.path.dirname(cur)
        if parent == cur:  # fixed point: drive root / UNC root / '/'
            return _root_name(remembered)
        cur = parent


def main():
    """session-end.sh entry: stdin = SessionEnd metadata JSON; env
    UM_GUARD_FALLBACK = bash-resolved "${CLAUDE_CWD:-$(pwd)}". Prints exactly
    one line: the slug or a SKIP sentinel."""
    try:
        meta = json.load(sys.stdin)
    except Exception:
        print("SKIP:bad-stdin")
        return
    cwd = meta.get("cwd") or ""
    fallback = os.environ.get("UM_GUARD_FALLBACK", "")
    res = guard(cwd, fallback)
    if res.startswith("SKIP:"):
        # Carry the offending cwd into hook.log (#186 asked for the raw value
        # at debug level — the skip line is that channel).
        print(f"{res} cwd={cwd or fallback or '<none>'}")
    else:
        print(res)


if __name__ == "__main__":
    main()
