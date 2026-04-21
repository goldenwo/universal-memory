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

_write_marker_block() {
  local profile="$1"
  local key_value="$2"       # UM_OPENAI_API_KEY value (may be empty for CLI-only)
  local summarizer="$3"      # UM_SUMMARIZER value (default "openai" if empty)

  local marker_start='# --- universal-memory (auto-added by install.sh) ---'
  local marker_end='# --- end universal-memory ---'

  # Idempotent: remove existing block, write fresh. Atomic via temp file.
  local tmp
  tmp=$(mktemp)
  if [ -f "$profile" ]; then
    awk -v s="$marker_start" -v e="$marker_end" '
      BEGIN { inblock=0 }
      $0 == s { inblock=1; next }
      $0 == e { inblock=0; next }
      !inblock { print }
    ' "$profile" > "$tmp"
  fi

  # Append canonical-superset block
  # Single-quoted values for key/summarizer match the historic format tests expect.
  # New superset vars (SERVER_URL, LIB_DIR, CLI_DIR, PATH guard) use ${VAR:-default}
  # expansion from the caller's env at write time.
  local _key="${key_value:-${UM_OPENAI_API_KEY:-}}"
  local _sum="${summarizer:-${UM_SUMMARIZER:-openai}}"
  local _srv="${UM_SERVER_URL:-http://localhost:6335}"
  local _lib="${UM_LIB_DIR:-$HOME/.local/share/um/lib}"
  local _cli="${UM_CLI_DIR:-$HOME/.local/share/um/cli}"
  {
    printf '\n%s\n' "$marker_start"
    printf "export UM_OPENAI_API_KEY='%s'\n" "$_key"
    printf "export UM_SUMMARIZER='%s'\n" "$_sum"
    printf "export UM_SERVER_URL='%s'\n" "$_srv"
    printf "export UM_LIB_DIR='%s'\n" "$_lib"
    printf "export UM_CLI_DIR='%s'\n" "$_cli"
    printf 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n'
    printf '%s\n' "$marker_end"
  } >> "$tmp"

  mv "$tmp" "$profile"
}
