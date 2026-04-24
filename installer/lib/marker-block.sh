#!/usr/bin/env bash
# installer/lib/marker-block.sh — shared marker-block writer for install.sh + install-cli.sh
#
# Signature (KEPT unchanged from install.sh — RM2 R2-round):
#   _write_marker_block "$profile" "$key_value_or_empty" "$summarizer_or_empty"
#
# The canonical-superset vars (UM_SERVER_URL, UM_LIB_DIR, UM_CLI_DIR, PATH guard) are
# read from the caller's env INSIDE this function with ${VAR:-default} fallbacks.
# Callers must set these via their own env before calling.
#
# Env-sourced contract (RH5 R2-round): the block always reflects the caller's current
# env. No migration from old block contents — running either installer overwrites.
#
# This file is sourced (not executed directly). It defines only _write_marker_block.

# _marker_escape_sq <value>
# Escapes single-quote characters in <value> using the standard bash technique
# of ending the single-quoted string, inserting a literal quote, then
# resuming: foo'bar → foo'\''bar.
# Required because any of the five user-controlled values (key, summarizer,
# server URL, lib dir, CLI dir) may legally contain single quotes on Linux
# (e.g. /home/bob's data), which would otherwise produce invalid bash in the
# written rc file.
_marker_escape_sq() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

_write_marker_block() {
  local profile="$1"
  local key_value="$2"       # UM_OPENAI_API_KEY value (may be empty for CLI-only)
  local summarizer="$3"      # UM_SUMMARIZER value (default "openai" if empty)

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
  local _key; _key=$(_marker_escape_sq "${key_value:-${UM_OPENAI_API_KEY:-}}")
  local _sum; _sum=$(_marker_escape_sq "${summarizer:-${UM_SUMMARIZER:-openai}}")
  local _srv; _srv=$(_marker_escape_sq "${UM_SERVER_URL:-http://localhost:6335}")
  local _lib; _lib=$(_marker_escape_sq "${UM_LIB_DIR:-$HOME/.local/share/um/lib}")
  local _cli; _cli=$(_marker_escape_sq "${UM_CLI_DIR:-$HOME/.local/share/um/cli}")
  local _pdir; _pdir=$(_marker_escape_sq "${UM_PROMPT_DIR:-}")
  {
    printf '\n%s\n' "$marker_start"
    printf "export UM_OPENAI_API_KEY='%s'\n" "$_key"
    printf "export UM_SUMMARIZER='%s'\n" "$_sum"
    printf "export UM_SERVER_URL='%s'\n" "$_srv"
    printf "export UM_LIB_DIR='%s'\n" "$_lib"
    printf "export UM_CLI_DIR='%s'\n" "$_cli"
    [[ -n "$_pdir" ]] && printf "export UM_PROMPT_DIR='%s'\n" "$_pdir"
    printf 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n'
    printf '%s\n' "$marker_end"
  } >> "$tmp"

  chmod 644 "$tmp"
  mv "$tmp" "$profile"
}
