#!/usr/bin/env bash
# installer/lib/marker-block.sh — shared marker-block writer for install.sh + install-cli.sh
#
# Signature:
#   _write_marker_block "$profile" "$summarizer_or_empty"
#
# The block holds UM_SUMMARIZER, UM_SERVER_URL, UM_LIB_DIR, UM_CLI_DIR, an
# optional UM_PROMPT_DIR, the UM_AUTH_TOKEN trailer and the PATH guard. The
# canonical-superset vars are read from the caller's env INSIDE this function
# with ${VAR:-default} fallbacks. Callers must set these via their own env
# before calling.
#
# No secrets in the block. It is written mode 0644 into ~/.bashrc / ~/.zshrc,
# so it never carries an API key (it used to export UM_OPENAI_API_KEY): the
# server's key lives in server/.env (0600), and the one client-side consumer,
# um-preview, reads UM_OPENAI_API_KEY or OPENAI_API_KEY from the user's own
# environment. The auth token stays in ~/.um/auth-token (0600); the block only
# reads it at shell startup.
#
# Env-sourced contract (RH5 R2-round): the block always reflects the caller's current
# env. Nothing is carried over from old block contents — running either installer
# overwrites the whole block. That rewrite is also the migration for the old key
# line: a block written by an earlier installer that still holds
# `export UM_OPENAI_API_KEY=...` loses that line the next time any installer runs.
# A user's own export OUTSIDE the block is theirs and is never touched.
#
# This file is sourced (not executed directly). It defines only _write_marker_block.

# _marker_escape_sq <value>
# Escapes single-quote characters in <value> using the standard bash technique
# of ending the single-quoted string, inserting a literal quote, then
# resuming: foo'bar → foo'\''bar.
# Required because any of the five user-controlled values (summarizer, server
# URL, lib dir, CLI dir, prompt dir) may legally contain single quotes on Linux
# (e.g. /home/bob's data), which would otherwise produce invalid bash in the
# written rc file.
_marker_escape_sq() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

_write_marker_block() {
  # A caller still on the old three-argument form would pass the API key in
  # the summarizer slot, and the key would land in the rc file as
  # UM_SUMMARIZER. Refuse instead of writing it.
  if [ "$#" -gt 2 ]; then
    printf '_write_marker_block: takes <profile> [summarizer]; got %s arguments (an API key is no longer written to shell profiles)\n' "$#" >&2
    return 2
  fi
  local profile="$1"
  local summarizer="${2:-}"  # UM_SUMMARIZER value (default "openai" if empty)

  local marker_start='# --- universal-memory (auto-added by install.sh) ---'
  local marker_end='# --- end universal-memory ---'

  # Idempotent: remove existing block, write fresh. Atomic via temp file.
  # I1+I2: Use same-directory mktemp so mv is a true rename (atomic, not cross-fs cp+rm).
  # Trap cleans up temp on early exit (INT/TERM/RETURN).
  local tmp
  tmp=$(mktemp "$(dirname "$profile")/.um-marker.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" RETURN INT TERM
  if [ -f "$profile" ]; then
    # Strip the existing marker block AND any blank lines immediately preceding
    # the start sentinel (so a prior run's leading '\n' separator does not
    # accumulate — cf. monotonic-bashrc-growth bug found in v0.4 VM smoke test).
    # Buffered-blanks technique: hold blank lines until we see a non-blank; if
    # that non-blank is the marker start, discard the buffer instead of emitting.
    awk -v s="$marker_start" -v e="$marker_end" '
      BEGIN { inblock=0; pending="" }
      $0 == s { inblock=1; pending=""; next }
      $0 == e { inblock=0; next }
      !inblock && $0 ~ /^[[:space:]]*$/ { pending = pending $0 "\n"; next }
      !inblock { printf "%s%s\n", pending, $0; pending="" }
    ' "$profile" > "$tmp"
  fi

  # Append canonical-superset block.
  # All five user-controlled values are passed through _marker_escape_sq so
  # a value containing a single-quote character does not produce invalid bash.
  # The PATH guard line has no user-value interpolation and is left as-is.
  # UM_OPENAI_API_KEY is deliberately absent, even when the caller's env has
  # it (see the header).
  local _sum; _sum=$(_marker_escape_sq "${summarizer:-${UM_SUMMARIZER:-openai}}")
  local _srv; _srv=$(_marker_escape_sq "${UM_SERVER_URL:-http://localhost:6335}")
  local _lib; _lib=$(_marker_escape_sq "${UM_LIB_DIR:-$HOME/.local/share/um/lib}")
  local _cli; _cli=$(_marker_escape_sq "${UM_CLI_DIR:-$HOME/.local/share/um/cli}")
  local _pdir; _pdir=$(_marker_escape_sq "${UM_PROMPT_DIR:-}")
  {
    printf '\n%s\n' "$marker_start"
    printf "export UM_SUMMARIZER='%s'\n" "$_sum"
    printf "export UM_SERVER_URL='%s'\n" "$_srv"
    printf "export UM_LIB_DIR='%s'\n" "$_lib"
    printf "export UM_CLI_DIR='%s'\n" "$_cli"
    [[ -n "$_pdir" ]] && printf "export UM_PROMPT_DIR='%s'\n" "$_pdir"
    # v0.6 bearer-auth trailer (spec §4.2): auto-export UM_AUTH_TOKEN from
    # ~/.um/auth-token at shell startup, if the file exists. Short-circuits
    # cleanly when the file is absent (e.g. first shell after uninstall or
    # a revoked token). Static literal — no user-controlled interpolation,
    # so _marker_escape_sq is not involved (V2 verification §7).
    #
    # IMPORTANT — ordering: this line is emitted BEFORE the PATH guard. If
    # the trailer were the final line and auth-token were absent, the
    # rc-sourcing exit status would be 1 (from `[ -r ]` failing), which
    # `set -e` users' prompt displays / CI harnesses may surface as an
    # error. The PATH guard that follows is an unconditional `export
    # PATH=…` on the no-already-present branch, guaranteeing the marker
    # block's final command exits 0. V2 verification §6.2 (commit e0a5a7f)
    # documents this finding; it overrides the v0.6 spec's original
    # "append after PATH guard" wording.
    # Both printfs emit literal shell snippets that the user's rc file will
    # source — $HOME/$PATH must be expanded by the user's shell at source-time,
    # NOT by THIS shell at write-time. Single quotes are essential.
    # shellcheck disable=SC2016
    printf '%s\n' '[ -r "$HOME/.um/auth-token" ] && export UM_AUTH_TOKEN="$(cat "$HOME/.um/auth-token")"'
    # shellcheck disable=SC2016
    printf 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n'
    printf '%s\n' "$marker_end"
  } >> "$tmp"

  chmod 644 "$tmp"
  mv "$tmp" "$profile"
}
