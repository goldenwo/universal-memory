#!/usr/bin/env bash
# bin/lib/um-curl-wrap.sh — shared friendly-error curl wrapper for um CLIs
#
# Contract:
#   source this file, then call:
#     _um_curl_wrap <cli-name> <curl-args...>
#
#   The wrapper appends -w $'\n%{http_code}' to capture the HTTP status on a
#   trailing line. On 2xx it prints the response body and returns 0. On known
#   error codes it emits a human-friendly message to stderr and returns 1.
#   On network failure (empty status) it prints a "could not reach server"
#   message. All original curl args (headers, URL, etc.) pass through via "$@".
#
#   NOTE: Do NOT use this wrapper for fire-and-forget / best-effort reindex
#   calls. Those already use inline || echo fallback patterns.

_um_curl_wrap() {
  local name="$1"; shift
  local out status body
  out=$(curl "$@" -w $'\n%{http_code}' 2>&1) || true
  status=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | head -n -1)
  case "$status" in
    2*) printf '%s\n' "$body"; return 0 ;;
    401) printf '[%s] auth failed — set UM_AUTH_TOKEN from ~/.um/auth-token or re-run installer\n' "$name" >&2; return 1 ;;
    429) printf '[%s] rate limited — retry in a moment\n' "$name" >&2; return 1 ;;
    503) printf '[%s] busy (lock contention) — retry in a moment\n' "$name" >&2; return 1 ;;
    "")  printf '[%s] could not reach server — is the UM server running?\n' "$name" >&2; return 1 ;;
    *)   local msg
         msg=$(printf '%s' "$body" | grep -oE '"message":"[^"]*"' | head -1 | cut -d: -f2- | tr -d '"')
         printf '[%s] server error %s: %s\n' "$name" "$status" "$msg" >&2; return 1 ;;
  esac
}
