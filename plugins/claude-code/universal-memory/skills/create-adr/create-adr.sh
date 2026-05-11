#!/usr/bin/env bash
# create-adr.sh — bash helper for the /adr skill (option 2: markdown skill +
# bash helper). Public subcommands:
#
#   bash create-adr.sh help
#   bash create-adr.sh create --title "<title>" [--commit] [--no-path]
#   bash create-adr.sh sync NNNN
#
# Sourceable for unit tests; the dispatcher at the bottom only fires when
# the file is executed (not sourced).
#
# See docs/plans/2026-05-08-w1.1-create-adr-spec.md for the full design.

set -uo pipefail

# v1.1: source the W1.5 endpoint resolver. Falls back to inline definition
# for pre-v1.1 installs (matches the auto-start.sh:34 fail-soft pattern).
_UM_LIB_DIR="${UM_LIB_DIR:-$HOME/.local/share/um/lib}"
if [ -r "$_UM_LIB_DIR/endpoint.sh" ]; then
  # shellcheck source=/dev/null
  source "$_UM_LIB_DIR/endpoint.sh"
fi
if ! command -v um_resolve_endpoint >/dev/null 2>&1; then
  # Fallback used only when ~/.local/share/um/lib/endpoint.sh is absent
  # (pre-v1.1 install state). Mirrors the lib's behavior including the
  # both-set-with-different-values conflict warn so operators upgrading
  # from a partial install still see the deprecation/conflict signals.
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

# ─── pure-text helpers ──────────────────────────────────────────────────────

_sanitize_title() {
  local raw="$1"
  # Reject Unicode bidi-override codepoints (CVE-2021-42574 "Trojan Source").
  # UTF-8 bytes:  U+061C → \xD8\x9C ; U+202A-202E → \xE2\x80[\xAA-\xAE] ;
  #              U+2066-2069 → \xE2\x81[\xA6-\xA9].
  if printf '%s' "$raw" \
       | LC_ALL=C grep -qE $'\xD8\x9C|\xE2\x80[\xAA-\xAE]|\xE2\x81[\xA6-\xA9]'
  then
    _LAST_ERR="title contains disallowed bidi-override codepoint; remove and retry"
    return 1
  fi
  # Strip C0 controls (except LF, handled below) + DEL + C1 controls.
  # C1 in UTF-8 = \xC2[\x80-\x9F]. tr handles single-byte, sed handles
  # the two-byte C1 sequence.
  local stripped
  stripped=$(printf '%s' "$raw" \
    | LC_ALL=C tr -d '\000-\010\013-\037\177' \
    | LC_ALL=C sed $'s/\xC2[\x80-\x9F]//g' \
    | LC_ALL=C tr '\n' ' ')
  stripped=$(printf '%s' "$stripped" | sed -E 's/[[:space:]]+/ /g; s/^ +//; s/ +$//')
  printf '%s' "$stripped"
}

_slug() {
  local title="$1"
  local s
  s=$(printf '%s' "$title" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  s=$(printf '%s' "$s" | LC_ALL=C tr -cd 'a-z0-9 -')
  s=$(printf '%s' "$s" | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  s="${s:0:60}"
  s="${s%-}"
  if [ -z "$s" ]; then
    printf 'untitled'
  else
    printf '%s' "$s"
  fi
}

_fm_value() {
  # Trim leading/trailing whitespace from a frontmatter "key: value" tail,
  # then if the result is wrapped in double-quotes (matching what
  # `_yaml_dq` emits), strip them and unescape `\\` and `\"`. Plain
  # (un-quoted) scalars round-trip unchanged. Single-quote form not
  # supported because `_yaml_dq` never emits it.
  local s="$1"
  s=$(printf '%s' "$s" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  case "$s" in
    \"*\")
      s="${s#\"}"
      s="${s%\"}"
      s="${s//\\\"/\"}"
      s="${s//\\\\/\\}"
      ;;
  esac
  printf '%s' "$s"
}

_yaml_dq() {
  # Double-quote a YAML scalar: escape `\` and `"`. Caller wraps in quotes.
  # We always quote the scalars where the value is operator-supplied (title,
  # decided_by) so a `:` followed by space — common in ADR titles like
  # "Adopt mem0: a vector store" — doesn't break YAML parsing per the
  # YAML 1.2 plain-scalar rules.
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

_render_frontmatter() {
  local nnnn="$1"
  local slug="$2"
  local title="$3"
  local decided_at decided_by id title_q decided_by_q
  decided_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  decided_by=$(git config user.name 2>/dev/null || true)
  id=$(printf '%04d-%s' "$nnnn" "$slug")
  title_q=$(_yaml_dq "$title")
  decided_by_q=$(_yaml_dq "$decided_by")
  cat <<EOF
---
schema_version: 1
id: $id
title: $title_q
status: Proposed
supersedes: []
superseded_by: null
decided_at: $decided_at
decided_by: $decided_by_q
---

# $title

## Context

<placeholder — operator fills in>

## Decision

<placeholder>

## Consequences

<placeholder>
EOF
}

# ─── filesystem helpers ─────────────────────────────────────────────────────

_auto_number() {
  local dir="$1"
  local max=0
  local entry name prefix
  shopt -s nullglob
  for entry in "$dir"/[0-9][0-9][0-9][0-9]*; do
    name=$(basename "$entry")
    prefix="${name%%-*}"
    case "$prefix" in
      ''|*[!0-9]*) continue ;;
    esac
    # 10# forces base-10; bash treats leading-0 as octal otherwise (the
    # 0042 → 34 trap). Pinned by a unit test.
    if [ "$((10#$prefix))" -gt "$max" ]; then
      max="$((10#$prefix))"
    fi
  done
  shopt -u nullglob
  printf '%d' "$((max + 1))"
}

_safe_write_file() {
  local filepath="$1"
  local body="$2"
  if [ -L "$filepath" ]; then
    _LAST_ERR="refusing to write through symlink at $filepath"
    return 73
  fi
  if ! ( set -C; printf '%s' "$body" > "$filepath" ) 2>/dev/null; then
    _LAST_ERR="target file already exists or write failed: $filepath"
    return 17
  fi
  return 0
}

# ─── env / config helpers ───────────────────────────────────────────────────

_resolve_auth_token() {
  if [ -n "${UM_AUTH_TOKEN:-}" ]; then
    printf '%s' "$UM_AUTH_TOKEN"
    return 0
  fi
  local cfg="${HOME}/.claude/skills/create-adr/config.json"
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

_detect_self_application() {
  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  if [ -f "$toplevel/.um-self-host" ]; then
    return 0
  fi
  if [ -f "$toplevel/package.json" ]; then
    local name
    name=$(grep -E '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$toplevel/package.json" 2>/dev/null \
             | head -1 \
             | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
    if [ -z "$name" ]; then
      printf '[create-adr] warning: could not read name from %s/package.json; falling back to sentinel-only self-detection\n' \
        "$toplevel" >&2
      return 1
    fi
    if [ "$name" = "universal-memory-server" ]; then
      return 0
    fi
  fi
  return 1
}

_json_escape() {
  # Minimal JSON string escape using pure bash parameter substitution.
  # Avoids the git-bash/MSYS sed backslash quirk (some sed builds need
  # `\\\\` to match one literal `\` in BRE). We control the inputs
  # (titles after sanitization, file paths from git) so we don't need a
  # full JSON encoder.
  local s="$1"
  s="${s//\\/\\\\}"          # \ → \\
  s="${s//\"/\\\"}"          # " → \"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# ─── git + http helpers ─────────────────────────────────────────────────────

_git_commit_adr() {
  local nnnn="$1"
  local title="$2"
  local target="$3"
  local short_sha
  local git_dir
  git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 1
  # _GIT_TMPFILE is a deliberate global so the EXIT trap (set below) still
  # has the path in scope after the function returns and `tmpfile` falls
  # out of `local` scope. Without this, `set -u` makes the trap die with
  # "tmpfile: unbound variable" and that error leaks into the success
  # output as a 4th line.
  _GIT_TMPFILE=$(printf '%s/COMMIT_EDITMSG.create-adr.%d' "$git_dir" "$$")
  # RETURN cleans up on normal returns; EXIT covers signal-interrupt
  # (Ctrl-C between git add and git commit) so the tmpfile doesn't leak.
  # Use parameter-default to keep the trap robust even if _GIT_TMPFILE is
  # somehow unset by the time the trap fires.
  trap 'rm -f "${_GIT_TMPFILE:-}"' RETURN EXIT
  local tmpfile="$_GIT_TMPFILE"
  printf 'docs(adr): %04d %s\n' "$nnnn" "$title" > "$tmpfile" || return 1
  local add_out add_rc
  add_out=$(git add -- "$target" 2>&1)
  add_rc=$?
  if [ "$add_rc" -ne 0 ]; then
    # Surface the actual git error (e.g., gitignore match) so the operator
    # has a breadcrumb instead of just "git commit failed."
    printf 'git add failed:\n%s\n' "$add_out" >&2
    return 1
  fi
  local commit_out
  commit_out=$(git commit -F "$tmpfile" 2>&1)
  local commit_rc=$?
  if [ "$commit_rc" -ne 0 ]; then
    printf 'git commit failed:\n%s\n' "$commit_out" >&2
    return 1
  fi
  short_sha=$(git rev-parse --short HEAD 2>/dev/null) || return 1
  printf '%s' "$short_sha"
}

_post_memory_add() {
  local nnnn="$1"
  local slug="$2"
  local title="$3"
  local target="$4"
  local endpoint="$5"
  local no_path_flag="$6"
  local id
  id=$(printf '%04d' "$nnnn")
  local esc_title esc_target
  esc_title=$(_json_escape "$title")
  esc_target=$(_json_escape "$target")
  local decided_at
  decided_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  local repo_path_field=""
  if [ "$no_path_flag" -eq 0 ]; then
    local toplevel esc_toplevel
    toplevel=$(git rev-parse --show-toplevel 2>/dev/null || true)
    if [ -n "$toplevel" ]; then
      esc_toplevel=$(_json_escape "$toplevel")
      repo_path_field=$(printf '"repo_path":"%s",' "$esc_toplevel")
    fi
  fi
  local payload
  payload=$(printf '{"text":"%s","metadata":{"schema_version":1,"type":"adr","adr_id":"%s","adr_status":"Proposed",%s"decided_at":"%s","file_path":"%s"}}' \
    "$esc_title" "$id" "$repo_path_field" "$decided_at" "$esc_target")
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
  rm -f "$curl_out"
  case "$http_code" in
    2*)
      printf 'Registered with universal-memory (%s)' "$endpoint"
      return 0
      ;;
    401|403)
      # Auth-class: bucket 403 with 401. Both mean "fix auth and sync."
      printf 'WARNING: not registered with universal-memory — auth failed (HTTP %s; set UM_AUTH_TOKEN, see <repo>/server/.env). Run /adr sync %s after fixing.' "$http_code" "$id"
      return 0
      ;;
    400|422)
      # Client-error class that re-running won't fix. Suggesting `/adr sync`
      # would mislead — this is a payload/contract issue worth filing.
      printf 'WARNING: not registered with universal-memory (HTTP %s; payload rejected). Re-running will not help; check server logs and/or file an issue at https://github.com/goldenwo/universal-memory/issues.' "$http_code"
      return 0
      ;;
    429|5*)
      printf 'WARNING: not registered with universal-memory (HTTP %s) — re-run /adr sync %s' "$http_code" "$id"
      return 0
      ;;
    000)
      printf 'WARNING: not registered with universal-memory (request failed; server unreachable at %s) — re-run /adr sync %s' "$endpoint" "$id"
      return 0
      ;;
    *)
      printf 'WARNING: not registered with universal-memory (HTTP %s) — re-run /adr sync %s' "$http_code" "$id"
      return 0
      ;;
  esac
}

# ─── subcommand handlers ────────────────────────────────────────────────────

cmd_help() {
  cat <<'EOF'
/adr — author an Architectural Decision Record

Usage:
  /adr [<title>]              Create a new ADR with the given title
  /adr sync NNNN              Re-register existing ADR with UM server

Flags:
  --commit                    Force commit even when running in universal-memory itself
  --no-path                   Omit metadata.repo_path from memory_add payload
  --help, -h                  Show this help

Files written: docs/decisions/NNNN-<slug>.md (consumer repo root + git commit)
Server registered: memory_add (resolves UM_SERVER_URL via the W1.5 endpoint resolver)

See https://github.com/goldenwo/universal-memory/blob/main/MIGRATION.md
EOF
}

cmd_create() {
  local title="" commit_flag=0 no_path_flag=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --title)    title="${2:-}"; shift 2 ;;
      --title=*)  title="${1#--title=}"; shift ;;
      --commit)   commit_flag=1; shift ;;
      --no-path)  no_path_flag=1; shift ;;
      --)         shift; break ;;
      -*)         _die 64 "unknown flag: $1 (recognized: --title, --commit, --no-path)" ;;
      *)          _die 64 "unexpected positional: $1 (use --title <text>)" ;;
    esac
  done
  [ -n "$title" ] || _die 64 "missing required: --title <text>"

  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) \
    || _die 65 "requires a git repository (run /adr from a git checkout)"
  cd "$toplevel" || _die 70 "could not cd into git toplevel: $toplevel"

  if [ ! -d "docs/decisions" ]; then
    mkdir -p docs/decisions || _die 70 "could not create docs/decisions/"
    cat > docs/decisions/README.md <<'EOF'
# Architectural Decision Records

This directory holds ADRs created by the `/adr` Claude Code skill (universal-memory plugin).

Each `NNNN-<slug>.md` file records one decision:
- `Context` — the situation forcing the decision
- `Decision` — what we chose
- `Consequences` — what happens because of it

ADRs are immutable history. To revise an earlier decision, write a new ADR
that supersedes it (set `superseded_by` on the old one and `supersedes` on
the new one).

Run `/adr --help` from any Claude Code session to learn more.
EOF
  fi

  local skip_remote=0
  if [ "$commit_flag" -eq 0 ] && _detect_self_application; then
    skip_remote=1
  fi

  local clean_title slug
  clean_title=$(_sanitize_title "$title") || _die 65 "$_LAST_ERR"
  if [ -z "$clean_title" ]; then
    _die 65 "title is empty after sanitization (control chars only?); provide a substantive title"
  fi
  slug=$(_slug "$clean_title")

  local endpoint
  endpoint=$(um_resolve_endpoint)

  local nnnn target rc body
  nnnn=$(_auto_number docs/decisions)
  target=$(printf 'docs/decisions/%04d-%s.md' "$nnnn" "$slug")
  body=$(_render_frontmatter "$nnnn" "$slug" "$clean_title")
  _safe_write_file "$target" "$body"
  rc=$?
  if [ "$rc" -eq 17 ]; then
    nnnn=$((nnnn + 1))
    target=$(printf 'docs/decisions/%04d-%s.md' "$nnnn" "$slug")
    body=$(_render_frontmatter "$nnnn" "$slug" "$clean_title")
    _safe_write_file "$target" "$body"
    rc=$?
    [ "$rc" -eq 0 ] || _die 70 "auto-numbering collision: tried $((nnnn-1)) and $nnnn, both taken"
  elif [ "$rc" -ne 0 ]; then
    _die 70 "$_LAST_ERR"
  fi

  local short_sha=""
  if [ "$skip_remote" -eq 0 ]; then
    short_sha=$(_git_commit_adr "$nnnn" "$clean_title" "$target") \
      || _die 70 "git commit failed; ADR file written at $target"
  fi

  local registered_line
  if [ "$skip_remote" -eq 0 ]; then
    registered_line=$(_post_memory_add "$nnnn" "$slug" "$clean_title" \
                                       "$target" "$endpoint" "$no_path_flag")
  else
    registered_line="Skipped registration (universal-memory self-host)"
  fi

  printf 'ADR-%04d written: %s\n' "$nnnn" "$target"
  if [ "$skip_remote" -eq 0 ]; then
    printf 'Committed: %s\n' "$short_sha"
  else
    printf 'Committed: (skipped — self-host)\n'
  fi
  printf '%s\n' "$registered_line"
}

cmd_sync() {
  local nnnn="" no_path_flag=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-path)  no_path_flag=1; shift ;;
      --)         shift; break ;;
      -*)         _die 64 "unknown flag for sync: $1 (recognized: --no-path)" ;;
      *)
        if [ -z "$nnnn" ]; then
          nnnn="$1"; shift
        else
          _die 64 "unexpected extra argument for sync: $1 (use --no-path or end of args)"
        fi
        ;;
    esac
  done
  case "$nnnn" in
    ''|*[!0-9]*) _die 64 "usage: /adr sync NNNN [--no-path] (e.g. /adr sync 0042)" ;;
  esac
  local id
  id=$(printf '%04d' "$((10#$nnnn))")

  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) \
    || _die 65 "requires a git repository (run /adr from a git checkout)"
  cd "$toplevel" || _die 70 "could not cd into git toplevel: $toplevel"

  shopt -s nullglob
  local matches=( "docs/decisions/${id}-"*.md )
  shopt -u nullglob
  if [ "${#matches[@]}" -eq 0 ]; then
    _die 65 "no ADR found at docs/decisions/${id}-*.md"
  fi
  if [ "${#matches[@]}" -gt 1 ]; then
    _die 65 "multiple ADRs match docs/decisions/${id}-*.md: ${matches[*]}"
  fi
  local adr_file="${matches[0]}"

  # Parse the YAML frontmatter (between --- delimiters).
  local in_fm=0 fm_done=0
  local fm_id="" fm_title="" fm_status="" fm_decided_at="" fm_schema_version=""
  while IFS= read -r line; do
    if [ "$fm_done" -eq 1 ]; then break; fi
    if [ "$line" = "---" ]; then
      if [ "$in_fm" -eq 0 ]; then
        in_fm=1; continue
      else
        fm_done=1; continue
      fi
    fi
    [ "$in_fm" -eq 1 ] || continue
    case "$line" in
      'schema_version:'*)
        fm_schema_version=$(_fm_value "${line#schema_version:}") ;;
      'id:'*)
        fm_id=$(_fm_value "${line#id:}") ;;
      'title:'*)
        fm_title=$(_fm_value "${line#title:}") ;;
      'status:'*)
        fm_status=$(_fm_value "${line#status:}") ;;
      'decided_at:'*)
        fm_decided_at=$(_fm_value "${line#decided_at:}") ;;
    esac
  done < "$adr_file"

  [ "$fm_done" -eq 1 ] || _die 65 "$adr_file: missing closing frontmatter delimiter"
  [ -n "$fm_schema_version" ] || _die 65 "$adr_file: missing required field: schema_version"
  [ "$fm_schema_version" = "1" ] || _die 65 "$adr_file: schema_version=$fm_schema_version not supported (expected 1)"
  [ -n "$fm_id" ] || _die 65 "$adr_file: missing required field: id"
  [ -n "$fm_title" ] || _die 65 "$adr_file: missing required field: title"
  [ -n "$fm_status" ] || _die 65 "$adr_file: missing required field: status"
  [ -n "$fm_decided_at" ] || _die 65 "$adr_file: missing required field: decided_at"

  local endpoint token
  endpoint=$(um_resolve_endpoint)
  token=$(_resolve_auth_token)
  # Match cmd_create's adr_id shape: just the leading 4-digit prefix, NOT
  # the full `NNNN-slug` from frontmatter.id. Server-side reconciliation
  # between create + sync rounds depends on the same adr_id key.
  local fm_adr_id="${fm_id%%-*}"
  case "$fm_adr_id" in
    ''|*[!0-9]*) _die 65 "$adr_file: malformed id field; expected leading 4-digit prefix, got '$fm_id'" ;;
  esac
  local esc_title esc_target esc_toplevel esc_id esc_status esc_decided_at
  esc_title=$(_json_escape "$fm_title")
  esc_target=$(_json_escape "$adr_file")
  esc_toplevel=$(_json_escape "$toplevel")
  # Frontmatter values are operator-controllable (an attacker who lands a
  # crafted ADR file via PR could inject extra metadata fields once the
  # operator runs `/adr sync`). Escape every field that flows into JSON.
  esc_id=$(_json_escape "$fm_adr_id")
  esc_status=$(_json_escape "$fm_status")
  esc_decided_at=$(_json_escape "$fm_decided_at")
  local repo_path_field=""
  if [ "$no_path_flag" -eq 0 ]; then
    repo_path_field=$(printf '"repo_path":"%s",' "$esc_toplevel")
  fi
  local payload
  payload=$(printf '{"text":"%s","metadata":{"schema_version":1,"type":"adr","adr_id":"%s","adr_status":"%s",%s"decided_at":"%s","file_path":"%s"}}' \
    "$esc_title" "$esc_id" "$esc_status" "$repo_path_field" "$esc_decided_at" "$esc_target")
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
  rm -f "$curl_out"
  case "$http_code" in
    2*)
      printf 'Re-registered ADR-%s with universal-memory (%s)\n' "$fm_adr_id" "$endpoint"
      return 0
      ;;
    401|403)
      # DELIBERATE asymmetry vs cmd_create: sync IS the recovery command,
      # so an auth failure here means the operator's auth config is still
      # broken. Loud-fail surfaces "you still need to fix UM_AUTH_TOKEN."
      _die 77 "auth failed (HTTP $http_code) re-registering ADR-${fm_adr_id}; set UM_AUTH_TOKEN (see <repo>/server/.env) and re-run"
      ;;
    400|422)
      _die 65 "payload rejected (HTTP $http_code) re-registering ADR-${fm_adr_id}; this is not retryable — check server logs and/or file an issue"
      ;;
    429|5*)
      _die 75 "transient failure re-registering ADR-${fm_adr_id} (HTTP $http_code); retry later"
      ;;
    000)
      _die 75 "request failed re-registering ADR-${fm_adr_id}; server unreachable at $endpoint"
      ;;
    *)
      _die 70 "unexpected HTTP $http_code re-registering ADR-${fm_adr_id}"
      ;;
  esac
}

# ─── dispatcher ─────────────────────────────────────────────────────────────

# Sourceable for unit tests: only dispatch when executed as a script. When
# sourced, ${BASH_SOURCE[0]} differs from $0; when executed they match.
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  case "${1:-help}" in
    help|--help|-h)  cmd_help ;;
    create)          shift; cmd_create "$@" ;;
    sync)            shift; cmd_sync "$@" ;;
    *)               printf 'unknown subcommand: %s\n\n' "${1:-}" >&2
                     cmd_help >&2
                     exit 64
                     ;;
  esac
fi
