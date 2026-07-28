# hooks/lib/project_guard.py — non-project cwd guard (#186).
#
# The desktop app spawns auxiliary sessions with cwd=$HOME (verified live
# 2026-07-27: SessionEnd meta.cwd == C:\Users\<user>, no transcript ever
# written). Minting a project slug from such a cwd buckets every one of those
# sessions into one giant <home-basename> project — combined with #185 this
# fabricated dozens of misattributed summaries per day.
#
# Contract (consumed by session-end.sh and stop.sh):
#   guard(cwd_raw, fallback_raw) -> "SKIP:<reason>" | "<project-basename>"
#   - cwd_raw:      meta.cwd from the hook stdin JSON (may be empty)
#   - fallback_raw: bash-resolved "${CLAUDE_CWD:-$(pwd)}" (may be empty)
#   Reasons: home-cwd (cwd == $HOME), non-project-cwd (no project marker
#   found walking up, or no cwd at all). FAIL CLOSED: every non-project
#   outcome is an explicit SKIP sentinel — the caller must never fall back
#   to an unguarded leg (review finding: the old `[ -z "$PROJECT" ]` bash
#   fallback re-minted the exact slug this guard suppresses).
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
    cur = cwd
    while True:
        if cur in homes:
            # Reached the home boundary without a marker below it: markers AT
            # or above $HOME (e.g. ~/.claude) must not qualify a home subdir.
            return "SKIP:non-project-cwd"
        for m in markers:
            if os.path.exists(os.path.join(cur, m)):
                base = os.path.basename(cwd.rstrip("/\\"))
                return base if base else "SKIP:non-project-cwd"
        parent = os.path.dirname(cur)
        if parent == cur:  # fixed point: drive root / UNC root / '/'
            return "SKIP:non-project-cwd"
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
