#!/usr/bin/env bash
# hooks/lib/um-api.sh — shared config/auth/HTTP/log library for the API-always
# capture hooks (#159, spec docs/plans/2026-07-16-cc-plugin-remote-spec.md §4–§5).
#
# Sourced (NOT executed) by stop.sh / session-end.sh / session-start.sh /
# user-prompt-submit.sh / auto-start.sh. Defines:
#
#   um_api_endpoint  — composed endpoint resolution (spec §4 tiers 1–4)
#   um_api_token     — bearer token from ${UM_TOKEN_FILE:-~/.um/auth-token}
#   um_api_post      — curl POST wrapper (connect 3s / total 10s, X-UM-Source,
#                      Bearer auth when a token exists; body → stdout,
#                      HTTP code → $UM_API_HTTP_CODE, rc 0 iff 2xx)
#   um_log           — one-line-per-fire append to ~/.um/hook.log
#   um_find_python   — py → python3 → python interpreter probe (Windows-aware)
#   um_g7_message    — the pinned "captures are OFF" actionable banner (spec §5 G7)
#
# Endpoint resolution SUBSUMES endpoint.sh (single source of truth for the env
# tiers — do not fork its semantics): gate on um_endpoint_configured() (tiers
# 1–2: UM_SERVER_URL, then deprecated UM_ENDPOINT); if unconfigured, the NEW
# ~/.um/endpoint file tier (written by the installer remote flow / um-setup);
# only then um_resolve_endpoint()'s loopback default (http://localhost:6335).

_UM_API_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=endpoint.sh
source "$_UM_API_LIB_DIR/endpoint.sh"

# Docs link carried by the G7 banner. The plugin docs page ships later in this
# arc (spec §7); keep this constant in sync when that page lands.
UM_DOCS_LINK="${UM_DOCS_LINK:-https://github.com/goldenwo/universal-memory/blob/main/docs/claude-code-plugin.md}"

# um_api_endpoint
# Prints the resolved endpoint URL on stdout (spec §4 order):
#   1–2. env tiers via endpoint.sh (UM_SERVER_URL, deprecated UM_ENDPOINT)
#   3.   ~/.um/endpoint file (trimmed; empty/unreadable ⇒ fall through)
#   4.   um_resolve_endpoint()'s default (http://localhost:6335)
# Deprecation warnings from endpoint.sh pass through on stderr unchanged.
um_api_endpoint() {
  if um_endpoint_configured; then
    um_resolve_endpoint
    return 0
  fi
  local file="$HOME/.um/endpoint" value=""
  if [ -r "$file" ]; then
    value=$(tr -d '[:space:]' < "$file" 2>/dev/null) || value=""
  fi
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi
  um_resolve_endpoint
}

# um_api_token
# Prints the bearer token (trimmed) from ${UM_TOKEN_FILE:-~/.um/auth-token}.
# Absent/empty file ⇒ prints nothing, rc 0 — a valid loopback no-auth dev
# setup (spec §4). Never fails.
um_api_token() {
  local token_file="${UM_TOKEN_FILE:-$HOME/.um/auth-token}"
  [ -r "$token_file" ] || return 0
  tr -d '[:space:]' < "$token_file" 2>/dev/null || true
}

# um_api_post <path> <json_body> [max_time_seconds]
# POST <json_body> to <resolved-endpoint><path>.
#   - connect timeout 3s; total timeout 10s (3rd arg overrides — the detached
#     checkpoint call uses 120s per spec §5)
#   - Content-Type: application/json; X-UM-Source: claude-code-plugin
#   - Authorization: Bearer <token> ONLY when a token resolves (never logged)
# Response body → stdout. HTTP code → global UM_API_HTTP_CODE ('000' on
# transport failure/timeout — call OUTSIDE command substitution when you need
# it). Returns 0 iff HTTP 2xx.
um_api_post() {
  local path="$1" body="$2" max_time="${3:-10}"
  local endpoint token url raw code
  endpoint=$(um_api_endpoint)
  token=$(um_api_token)
  url="${endpoint%/}${path}"

  local -a curl_args=(
    -s -X POST "$url"
    --connect-timeout 3
    --max-time "$max_time"
    -H 'Content-Type: application/json'
    -H 'X-UM-Source: claude-code-plugin'
    -w '\n__UM_HTTP_CODE__%{http_code}'
    -d "$body"
  )
  if [ -n "$token" ]; then
    curl_args+=(-H "Authorization: Bearer $token")
  fi

  raw=$(curl "${curl_args[@]}" 2>/dev/null) || true
  code=$(printf '%s' "$raw" | grep -o '__UM_HTTP_CODE__[0-9]*' | tail -1 | sed 's/__UM_HTTP_CODE__//')
  UM_API_HTTP_CODE="${code:-000}"

  printf '%s\n' "$raw" | sed '/^__UM_HTTP_CODE__[0-9]*$/d'

  case "$UM_API_HTTP_CODE" in
    2[0-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

# um_log <msg...>
# Appends one line to ~/.um/hook.log (spec §5 format:
# `<ts> <hook> posted http=<code> …` / `<ts> <hook> skip=<reason>`).
# Hook name comes from $UM_HOOK_NAME (set it before sourcing/calling) else the
# executing script's basename. Best-effort: never fails the caller.
um_log() {
  local hook
  hook="${UM_HOOK_NAME:-$(basename "$0" .sh)}"
  mkdir -p "$HOME/.um" 2>/dev/null || true
  printf '%s %s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$hook" "$*" \
    >> "$HOME/.um/hook.log" 2>/dev/null || true
}

# um_find_python
# Prints the first WORKING interpreter among py → python3 → python, rc 1 if
# none. On Windows the bare `python3`/`python` names are often Microsoft Store
# app-execution-alias stubs that exist on PATH but don't run; only `py` is
# reliably real there — hence the probe actually executes each candidate
# (spec §10 / bespoke v2 pattern).
um_find_python() {
  local c
  for c in py python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c '' >/dev/null 2>&1; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

# um_g7_message <reason> [endpoint]
# The pinned G7 actionable banner (spec §5): session-start.sh PREPENDS this to
# the additionalContext it injects — exit-0 hook stderr is invisible to users.
#   reason ∈ {unreachable, writes-disabled}; anything else gets a generic form.
um_g7_message() {
  local reason="$1" endpoint="${2:-}"
  case "$reason" in
    unreachable)
      printf '⚠ UM: captures are OFF — server unreachable at %s; see %s\n' \
        "$endpoint" "$UM_DOCS_LINK"
      ;;
    writes-disabled)
      printf '⚠ UM: captures are OFF — server has writes disabled; see %s\n' \
        "$UM_DOCS_LINK"
      ;;
    *)
      printf '⚠ UM: captures are OFF (%s); see %s\n' "$reason" "$UM_DOCS_LINK"
      ;;
  esac
}
