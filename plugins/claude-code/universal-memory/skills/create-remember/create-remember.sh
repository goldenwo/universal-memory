#!/usr/bin/env bash
# create-remember.sh — bash helper for the /remember skill (B2 v1.1).
# Markdown skill body + bash helper pattern, second instance of the
# create-adr pattern (W1.1, 2026-05-08). Public subcommands:
#
#   bash create-remember.sh help
#   bash create-remember.sh remember --text "<text>"
#
# Sourceable for unit tests; the dispatcher at the bottom only fires
# when the file is executed (not sourced).
#
# See docs/plans/2026-05-10-b2-remember-skill-spec.md for the design.

set -uo pipefail

# ── W1.5 endpoint resolver source (matches create-adr.sh:18-47) ────────
_UM_LIB_DIR="${UM_LIB_DIR:-$HOME/.local/share/um/lib}"
if [ -r "$_UM_LIB_DIR/endpoint.sh" ]; then
  # shellcheck source=/dev/null
  source "$_UM_LIB_DIR/endpoint.sh"
fi
if ! command -v um_resolve_endpoint >/dev/null 2>&1; then
  um_resolve_endpoint() {
    local default_url="http://localhost:6335"
    local server_url="${UM_SERVER_URL:-}"
    local endpoint="${UM_ENDPOINT:-}"
    if [ -n "$server_url" ]; then
      if [ -n "$endpoint" ] && [ "$endpoint" != "$server_url" ]; then
        printf 'warning: UM_ENDPOINT and UM_SERVER_URL both set with different values; using UM_SERVER_URL=%s. UM_ENDPOINT is deprecated, remove it (will be removed in v1.2).\n' \
          "$server_url" >&2
      fi
      printf '%s\n' "$server_url"
      return 0
    fi
    if [ -n "$endpoint" ]; then
      printf 'warning: UM_ENDPOINT is deprecated; rename to UM_SERVER_URL. Will be removed in v1.2 (see MIGRATION.md).\n' >&2
      printf '%s\n' "$endpoint"
      return 0
    fi
    printf '%s\n' "$default_url"
  }
fi

_LAST_ERR=""

_die() {
  local code="${1:-70}"
  shift
  printf 'error: %s\n' "$*" >&2
  exit "$code"
}

# ─── pure-text helpers (copy of /adr's _sanitize_title + _json_escape) ────

_sanitize_text() {
  local raw="$1"
  # Reject Unicode bidi-override codepoints (CVE-2021-42574 "Trojan Source").
  # UTF-8 bytes:  U+061C → \xD8\x9C ; U+202A-202E → \xE2\x80[\xAA-\xAE] ;
  #              U+2066-2069 → \xE2\x81[\xA6-\xA9].
  #
  # Error-passthrough: write the rejection message to stderr in addition to
  # _LAST_ERR. The _LAST_ERR global only works for in-process unit tests
  # (sourced); when cmd_remember calls _sanitize_text via $(...) command
  # substitution, the subshell's _LAST_ERR mutation does not propagate to
  # the parent. cmd_remember captures stderr to recover the message.
  if printf '%s' "$raw" \
       | LC_ALL=C grep -qE $'\xD8\x9C|\xE2\x80[\xAA-\xAE]|\xE2\x81[\xA6-\xA9]'
  then
    _LAST_ERR="text contains disallowed bidi-override codepoint; remove and retry"
    printf '%s\n' "$_LAST_ERR" >&2
    return 1
  fi
  # Strip C0 controls (except LF, handled below) + DEL + C1 controls.
  local stripped
  stripped=$(printf '%s' "$raw" \
    | LC_ALL=C tr -d '\000-\010\013-\037\177' \
    | LC_ALL=C sed $'s/\xC2[\x80-\x9F]//g' \
    | LC_ALL=C tr '\n' ' ')
  stripped=$(printf '%s' "$stripped" | sed -E 's/[[:space:]]+/ /g; s/^ +//; s/ +$//')
  printf '%s' "$stripped"
}

_json_escape() {
  # Minimal JSON string escape using pure bash parameter substitution.
  # See create-adr.sh:248-261 for rationale (avoids sed BRE quirks on
  # git-bash/MSYS).
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# ─── codepoint length (B2 spec §"create-remember.sh function shape") ──────

# Primary: python3 (handles every codepoint correctly). BSD awk and busybox
# awk return bytes for length() regardless of LANG, so they are explicitly
# rejected. Operators without python3 can set UM_CODEPOINT_TOOL to a binary
# whose stdout for arg-1 is the codepoint count.
#
# Operator-trusted: UM_CODEPOINT_TOOL is the same trust model as the
# helper's PATH lookup for curl/python3 — operators install their own
# tooling. Future security-review pass should mark this consistent rather
# than re-raising.
_codepoint_length() {
  local s="$1"
  if [ -n "${UM_CODEPOINT_TOOL:-}" ]; then
    "$UM_CODEPOINT_TOOL" "$s"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; print(len(sys.argv[1]))' "$s"
    return $?
  fi
  _LAST_ERR="python3 required for codepoint counting; install python3 or set UM_CODEPOINT_TOOL"
  return 70
}

# Truncate to first N codepoints. Used for the success-output preview
# (60 codepoints). Mirrors python3 slicing — never produces mid-byte
# corruption because python3 operates on codepoints, not bytes.
_codepoint_truncate() {
  local s="$1"
  local n="$2"
  if [ -n "${UM_CODEPOINT_TOOL:-}" ]; then
    # Custom tool: operator implements truncate via 2-arg mode (text + N).
    # Spec'd contract: stdout is the truncated string. If custom tool
    # does not honor this contract, helper falls back to first N bytes
    # (best-effort; documented limitation).
    "$UM_CODEPOINT_TOOL" "$s" "$n" 2>/dev/null || printf '%s' "${s:0:$n}"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; print(sys.argv[1][:int(sys.argv[2])], end="")' "$s" "$n"
    return $?
  fi
  # Already would have failed in _codepoint_length earlier; defensive only.
  printf '%s' "${s:0:$n}"
}

# ─── env / config helpers ───────────────────────────────────────────────

_resolve_auth_token() {
  # Mirrors create-adr.sh:206-225, with config path scoped to /remember
  # (per-skill token scoping per B2 spec §"create-remember.sh function shape").
  if [ -n "${UM_AUTH_TOKEN:-}" ]; then
    printf '%s' "$UM_AUTH_TOKEN"
    return 0
  fi
  local cfg="${HOME}/.claude/skills/create-remember/config.json"
  if [ -r "$cfg" ]; then
    local tok
    tok=$(grep -E '"auth_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$cfg" 2>/dev/null \
            | head -1 \
            | sed -E 's/.*"auth_token"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
    if [ -n "$tok" ]; then
      printf '%s' "$tok"
      return 0
    fi
  fi
  printf ''
}

# F1 default-project display for success-output line 2.
#
# IMPORTANT (debug aid, NOT contract): this reads the CLIENT's process env.
# If the SERVER's UM_DEFAULT_PROJECT differs, the display will show what the
# CLIENT thinks — which may diverge from where the fact actually landed.
# The authoritative routing decision is server-side and logged via the
# F1 warn-line on applyDefaultProject. Operators debugging mismatched
# routing should consult server logs, not this output line.
_resolve_default_project_for_display() {
  local raw="${UM_DEFAULT_PROJECT:-}"
  if [ -n "$raw" ]; then
    printf '%s' "$raw"
    return 0
  fi
  printf 'default'
}

# ─── payload + POST ─────────────────────────────────────────────────────

_build_remember_payload() {
  local text="$1"
  local esc_text captured_at
  esc_text=$(_json_escape "$text")
  captured_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  printf '{"text":"%s","metadata":{"schema_version":1,"type":"note","captured_at":"%s"}}' \
    "$esc_text" "$captured_at"
}

# Stream the response body to stdout so the caller can parse for event.
# HTTP code is on stdout's final line via -w "%{http_code}".
_post_api_add() {
  local payload="$1"
  local endpoint="$2"
  local token
  token=$(_resolve_auth_token)
  local curl_out http_code
  curl_out=$(mktemp)
  local curl_args=(
    -sS
    --max-time 10
    -o "$curl_out"
    -w '%{http_code}'
    -X POST
    -H 'Content-Type: application/json'
  )
  if [ -n "$token" ]; then
    curl_args+=(-H "Authorization: Bearer $token")
  fi
  curl_args+=(--data "$payload" "$endpoint/api/add")
  http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="000"
  local body
  body=$(cat "$curl_out" 2>/dev/null || printf '')
  rm -f "$curl_out"
  # Emit: <http_code>\n<body>
  printf '%s\n%s' "$http_code" "$body"
}

# Parse response body to detect dedup event. Returns:
#   0 + stdout="dedup" if any results[].event === 'DEDUP_MERGED'
#   0 + stdout="add"   if results array present with no dedup events
#   0 + stdout="empty" if results array empty (zero facts extracted)
#   0 + stdout="unknown" if body unparseable or missing results key
#
# Helper graceful-degrades on "unknown" — surfaces plain success, no suffix.
_parse_event() {
  local body="$1"
  if [ -z "$body" ]; then
    printf 'unknown'
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    # Use python3 for robust JSON parsing; awk regex would mis-handle nested
    # objects and quoted strings.
    local out
    out=$(python3 -c '
import json, sys
try:
    obj = json.loads(sys.argv[1])
    results = obj.get("results")
    if not isinstance(results, list):
        print("unknown"); sys.exit(0)
    if len(results) == 0:
        print("empty"); sys.exit(0)
    for r in results:
        if isinstance(r, dict) and r.get("event") == "DEDUP_MERGED":
            print("dedup"); sys.exit(0)
    print("add")
except Exception:
    print("unknown")
' "$body" 2>/dev/null)
    printf '%s' "${out:-unknown}"
    return 0
  fi
  # python3 absent — best-effort string scan. Reports "unknown" rather than
  # falsely claiming "add" or "dedup". This branch is unreachable in
  # practice because _codepoint_length already required python3 earlier in
  # cmd_remember (which is a precondition before reaching the POST step).
  case "$body" in
    *'"DEDUP_MERGED"'*) printf 'dedup' ;;
    *'"results"'*'[]'*) printf 'empty' ;;
    *'"results"'*'"event"'*) printf 'add' ;;
    *) printf 'unknown' ;;
  esac
}

# ─── subcommand handlers ────────────────────────────────────────────────

cmd_help() {
  cat <<'EOF'
/remember — save a casual fact to universal-memory

Usage:
  /remember <text>            Save a fact (sanitized, max 4096 codepoints)
  /remember --help            Show this help

Behavior:
  - POSTs to ${UM_SERVER_URL}/api/add (resolves via W1.5 endpoint resolver)
  - Metadata: schema_version=1, type=note, captured_at=<ISO-8601 UTC>
  - Project: omitted by client; server's F1 soft-default applies
    (UM_DEFAULT_PROJECT or literal "default")
  - D1 dedup ON: identical text within τ=0.84 merges with the existing
    fact and surfaces "— dedup match" on line 2

Output (success, 2 lines):
  Remembered: <preview of first 60 codepoints>
  Registered with universal-memory (<endpoint>) project=<resolved>

Output (warn-only, 1 line):
  WARNING: not saved (HTTP <code>; <reason>). Re-run /remember "<preview>".

Auth: env UM_AUTH_TOKEN > ~/.claude/skills/create-remember/config.json
      ("auth_token" key) > anonymous (loopback-only acceptable).

See https://github.com/goldenwo/universal-memory for the server.
EOF
}

cmd_remember() {
  local text=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --text)    text="${2:-}"; shift 2 ;;
      --text=*)  text="${1#--text=}"; shift ;;
      --)        shift; break ;;
      -*)        _die 64 "unknown flag: $1 (recognized: --text)" ;;
      *)         _die 64 "unexpected positional: $1 (use --text <text>)" ;;
    esac
  done
  [ -n "$text" ] || _die 64 "missing required: --text <text>"

  # Sanitize. _sanitize_text writes its rejection message to stderr; capture
  # via a tmp-file so we can pass the message to _die in the parent shell
  # (subshell mutations of _LAST_ERR don't propagate to the parent across
  # $() command substitution).
  local clean err_file err_msg
  err_file=$(mktemp)
  if ! clean=$(_sanitize_text "$text" 2>"$err_file"); then
    err_msg=$(cat "$err_file" 2>/dev/null)
    rm -f "$err_file"
    _die 65 "${err_msg:-text validation failed}"
  fi
  rm -f "$err_file"
  if [ -z "$clean" ]; then
    _die 65 "text is empty after sanitization (control chars only?); provide a substantive fact"
  fi

  # Codepoint length check (4096 limit).
  local len
  len=$(_codepoint_length "$clean")
  local len_rc=$?
  if [ "$len_rc" -ne 0 ]; then
    _die 70 "$_LAST_ERR"
  fi
  if [ "$len" -gt 4096 ]; then
    _die 64 "text exceeds 4096-codepoint limit; split into multiple /remember calls or use /adr for structured content"
  fi

  # 60-codepoint preview for output line 1.
  local preview
  if [ "$len" -gt 60 ]; then
    preview=$(_codepoint_truncate "$clean" 60)
    preview="${preview}..."
  else
    preview="$clean"
  fi

  local endpoint
  endpoint=$(um_resolve_endpoint)

  # Build payload + POST. _post_api_add emits "<http_code>\n<body>".
  local payload
  payload=$(_build_remember_payload "$clean")
  local response
  response=$(_post_api_add "$payload" "$endpoint")
  local http_code body
  http_code=$(printf '%s' "$response" | head -n 1)
  body=$(printf '%s' "$response" | tail -n +2)

  local project
  project=$(_resolve_default_project_for_display)

  case "$http_code" in
    2*)
      local event
      event=$(_parse_event "$body")
      printf 'Remembered: %s\n' "$preview"
      case "$event" in
        dedup)
          printf 'Registered with universal-memory (%s) project=%s — dedup match\n' "$endpoint" "$project"
          ;;
        empty)
          printf 'Registered with universal-memory (%s) project=%s — note: server extracted zero facts\n' "$endpoint" "$project"
          ;;
        add|unknown)
          printf 'Registered with universal-memory (%s) project=%s\n' "$endpoint" "$project"
          ;;
      esac
      return 0
      ;;
    401|403)
      printf 'WARNING: not saved (HTTP %s; auth failed). Set UM_AUTH_TOKEN (see <repo>/server/.env) and re-run /remember "%s".\n' \
        "$http_code" "$preview"
      return 0
      ;;
    400|422)
      _die 65 "payload rejected (HTTP $http_code) — this is not retryable; check server logs and/or file an issue at https://github.com/goldenwo/universal-memory/issues"
      ;;
    429|5*)
      printf 'WARNING: not saved (HTTP %s; transient). Re-run /remember "%s".\n' \
        "$http_code" "$preview"
      return 0
      ;;
    000)
      printf 'WARNING: not saved to universal-memory (server unreachable at %s) — retry by re-running /remember "%s".\n' \
        "$endpoint" "$preview"
      return 0
      ;;
    3*)
      printf 'WARNING: not saved (HTTP %s; unexpected redirect from %s). Re-run /remember "%s".\n' \
        "$http_code" "$endpoint" "$preview"
      return 0
      ;;
    *)
      printf 'WARNING: not saved (HTTP %s). Re-run /remember "%s".\n' \
        "$http_code" "$preview"
      return 0
      ;;
  esac
}

# ─── dispatcher ─────────────────────────────────────────────────────────

if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  case "${1:-help}" in
    help|--help|-h)  cmd_help ;;
    remember)        shift; cmd_remember "$@" ;;
    *)               printf 'unknown subcommand: %s\n\n' "${1:-}" >&2
                     cmd_help >&2
                     exit 64
                     ;;
  esac
fi
