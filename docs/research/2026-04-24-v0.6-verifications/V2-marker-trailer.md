# V2 — Marker-Block Trailer bash+zsh Portability Verification

**Date:** 2026-04-24
**Cycle:** v0.6 Pre-1
**Spec ref:** §9.2 (Phase B blocker verification)
**Status:** DONE_WITH_CONCERNS — 2 of 3 shells verified on Windows; zsh flagged for macOS/Linux verification before Phase B ships.

---

## 1. Scope

Phase B of v0.6 will append a trailer line to `installer/lib/marker-block.sh`'s written block that auto-exports `UM_AUTH_TOKEN` from `~/.um/auth-token` at every shell startup:

```bash
[ -r "$HOME/.um/auth-token" ] && export UM_AUTH_TOKEN="$(cat "$HOME/.um/auth-token")"
```

This verification confirms the trailer is:

1. Portable across POSIX sh, bash, and zsh.
2. Safe in both the present-file branch (export happens) and the absent-file branch (short-circuit — no export, no error).
3. Compatible with the existing `_marker_escape_sq` quoting helper.

## 2. Environment

| Shell | Version | Host | Result |
|-------|---------|------|--------|
| bash  | GNU bash 5.2.37(1)-release (x86_64-pc-msys) | Windows 11, Git Bash | PASS |
| sh    | Resolves to bash on MSYS; behaves POSIX-compatibly | Windows 11, Git Bash | PASS |
| zsh   | Not installed on Windows dev box | Windows 11 | NOT TESTED — flagged for macOS/Linux follow-up |

The `[ -r … ] && …` construct and `$(…)` command substitution are both defined by POSIX.1-2017 (Shell and Utilities §2.9.2, §2.6.3) and implemented identically in bash ≥ 3 and zsh ≥ 4. The trailer uses no bashisms or zshisms. bash-on-MSYS is the same source tree as bash-on-Linux/macOS for these features, so the Windows bash result is expected to generalize, but empirical zsh verification is still recommended before Phase B ships.

## 3. Test Script (verbatim)

`/tmp/test-trailer.sh`:

```sh
#!/usr/bin/env sh
# Test the exact trailer line that v0.6 install.sh will write
export HOME_TEST="$HOME"
mkdir -p "$HOME_TEST/.um"
echo 'bash-trailer' > "$HOME_TEST/.um/auth-token.test"
[ -r "$HOME_TEST/.um/auth-token.test" ] && export UM_AUTH_TOKEN_TEST="$(cat "$HOME_TEST/.um/auth-token.test")"
echo "UM_AUTH_TOKEN_TEST=$UM_AUTH_TOKEN_TEST"
rm -f "$HOME_TEST/.um/auth-token.test"
```

## 4. Results — Present-File Branch (export path)

### 4.1 bash

```
$ bash /tmp/test-trailer.sh
UM_AUTH_TOKEN_TEST=bash-trailer
```

PASS. Token round-trips through the file and ends up exported in the parent shell's env (of the script), no warnings.

### 4.2 sh (POSIX)

```
$ sh /tmp/test-trailer.sh
UM_AUTH_TOKEN_TEST=bash-trailer
```

PASS. Identical behavior. Confirms the trailer works even if the user's rc is sourced by a POSIX-conformant shell.

### 4.3 zsh

NOT TESTED — `zsh` is not installed on the Windows dev box. Flagged for macOS/Linux verification. See §8.

## 5. Results — Absent-File Branch (short-circuit)

Script: `[ -r "$HOME/.um/auth-token.absent-test" ] && export UM_AUTH_TOKEN_TEST=…` where the file does not exist.

### 5.1 bash

```
$ bash /tmp/test-trailer-absent.sh
exit_status=1
UM_AUTH_TOKEN_TEST_set=
UM_AUTH_TOKEN_TEST_value=''
```

### 5.2 sh

```
$ sh /tmp/test-trailer-absent.sh
exit_status=1
UM_AUTH_TOKEN_TEST_set=
UM_AUTH_TOKEN_TEST_value=''
```

**Interpretation:**

- The `&&` correctly short-circuits: the right-hand `export … "$(cat …)"` is NOT executed (no error about missing file, no stray cat output).
- `UM_AUTH_TOKEN_TEST` is not set in the environment (`${VAR+yes}` gives empty, not `yes`).
- The exit status of the compound command is `1` (from the failed `[ -r ]`). This is normal POSIX behavior and not a bug.

### 5.3 Non-trailing-newline token

```
$ bash -c '…; printf "token-no-trailing-newline" > file; … cat file …'
no-nl value=[token-no-trailing-newline]
```

PASS. `"$(cat file)"` preserves the full byte sequence; `$()` strips only trailing newlines (POSIX), which is the expected behavior for a token file written by a well-formed writer.

### 5.4 HOME with spaces (macOS edge case)

```
$ HOME="/tmp/home with space" bash -c '…'
space-HOME value=space-tok
```

PASS. The trailer's double-quoted `"$HOME/.um/auth-token"` correctly handles spaces in `$HOME`. This matters because a small fraction of macOS users have paths like `/Users/Bob Smith`.

## 6. Results — `set -e` / `set -eu` Interaction

Some users enable `set -e` or `set -eu` in their rc files. Since the trailer's left operand (`[ -r … ]`) can legitimately fail, this warrants a check.

### 6.1 Absent-file under `set -eu`, trailer NOT last line

```
$ bash test-trailer-errcheck.sh
absent-path OK (did not abort under set -eu)
present value=strict-tok
$ echo $?
0
```

PASS. Because the trailer is part of a compound `&&` chain, `set -e` does NOT terminate on the failed `[ -r ]`. This is per POSIX: "the -e setting shall be ignored when executing … any command in an AND-OR list other than the last." This is the key portability guarantee.

### 6.2 Concern: `$?` at first prompt

If `set -e` is enabled AND the trailer is the very last line of a sourced rc file AND the auth-token file is absent, the shell's last exit status after sourcing will be `1`. This will NOT cause the shell to exit (interactive sourcing does not propagate `set -e` in the same way). It will, however, surface as a non-zero `$?` visible in PS1 prompts that display exit status.

**Mitigation for Phase B** (low priority, but worth recording): append `; :` or `|| true` to the trailer if we want a clean `$?`. Example:

```bash
[ -r "$HOME/.um/auth-token" ] && export UM_AUTH_TOKEN="$(cat "$HOME/.um/auth-token")" ; :
```

Or simply ensure the trailer is NOT the last line of the marker block (easy — put it above the PATH guard). Recommendation: **keep the trailer as-specified and let the PATH-guard line that follows it clear `$?`.** No change needed if trailer is not last.

## 7. Escape-Helper (`_marker_escape_sq`) Interaction

`installer/lib/marker-block.sh` lines 24-26:

```bash
_marker_escape_sq() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}
```

This helper exists to escape single-quote characters in **user-controlled values** (key, summarizer, server URL, lib dir, CLI dir — lines 62-67 of the file), which are then interpolated into `export VAR='…'` single-quoted assignments.

The Phase B trailer is a **static string literal** with no user-controlled interpolation and **no single-quote characters**:

```bash
[ -r "$HOME/.um/auth-token" ] && export UM_AUTH_TOKEN="$(cat "$HOME/.um/auth-token")"
```

- All quoting is **double-quote** (for shell variable/command-sub expansion at rc-source time).
- No single quotes anywhere in the line.
- No user-supplied values are concatenated by the writer; the path is hard-coded.

**Conclusion:** the trailer does NOT need to be passed through `_marker_escape_sq`, and will not conflict with the helper. Phase B should write the trailer as a literal `printf '%s\n' "…"` line, bypassing the escape pipeline used for the five user-controlled exports. No changes to `_marker_escape_sq` are required.

## 8. Flags / Follow-ups

1. **zsh empirical test missing.** Action: re-run §3's test script under `zsh /tmp/test-trailer.sh` on a macOS or Linux host (one of the v0.6 smoke-CI runners) before Phase B merges. Expected result: identical output to bash. If this fails, pause Phase B and escalate.

2. **Documentation note for Phase B PR:** the trailer will leave `$?=1` at rc-source time if the token file is absent AND the trailer is the final line of the marker block. Current block ordering (PATH guard follows trailer) naturally avoids this; Phase B MUST keep the trailer before the PATH guard in the written block.

3. **No changes to `_marker_escape_sq`.** Phase B's `printf` for the trailer should be a raw literal line, not routed through the escape helper.

## 9. Final Verdict

**OK to proceed with the trailer as-specified**, subject to:

- [ ] zsh smoke test on macOS/Linux confirming bash-equivalent behavior (§8.1).
- [ ] Phase B writes the trailer **before** the PATH guard line in the marker block (§8.2).
- [ ] Phase B does NOT pass the trailer through `_marker_escape_sq` (§7).

All three are implementation-level notes, not architectural blockers. Trailer syntax is correct and portable.

---

*Verification performed 2026-04-24 on Windows 11 Git Bash 5.2.37. `/tmp/test-trailer.sh`, `/tmp/test-trailer-absent.sh`, `/tmp/test-trailer-whitespace.sh`, `/tmp/test-trailer-errcheck.sh` are scratch scripts and are not committed.*
