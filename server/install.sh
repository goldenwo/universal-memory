#!/usr/bin/env bash
# install.sh — universal-memory server interactive installer.
# Usage: ./install.sh          (interactive)
#        ./install.sh --verify (post-install sanity check only)
#        ./install.sh --yes    (non-interactive, accept all defaults)
#        ./install.sh -y       (alias for --yes)
#        UM_NONINTERACTIVE=1 ./install.sh  (read all values from env, no prompts)
#
# Exits non-zero on any error. Prints what it does. Never installs Docker
# for you — if Docker is missing it points at the upstream install docs
# and exits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _UM_REPO_ROOT can be set externally (e.g. by tests running from a temp dir).
REPO_ROOT="${_UM_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")}"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

info()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Temp file cleanup ───────────────────────────────────────────────────────
# Script-level cleanup guarantees we never leak secrets (API keys) in /tmp,
# even on SIGINT (Ctrl-C), SIGTERM, or errexit. Works across bash 3.2 / 4.x /
# Git Bash. To register a temp file, assign its path to _UM_TMP_KEYFILE (the
# only secret-bearing temp file in the script today). If more arrive later,
# extend to an array.
_UM_TMP_KEYFILE=""
_um_cleanup() {
	if [ -n "${_UM_TMP_KEYFILE:-}" ]; then
		rm -f "$_UM_TMP_KEYFILE" 2>/dev/null || true
		_UM_TMP_KEYFILE=""
	fi
}
trap _um_cleanup EXIT INT TERM

# ─── --verify mode ───────────────────────────────────────────────────────────
if [ "${1:-}" = "--verify" ]; then
  _vpass() { printf '\033[1;32m[verify]\033[0m %-30s \xe2\x9c\x85  %s\n' "$1" "${2:-}"; }
  _vfail() { printf '\033[1;31m[verify]\033[0m %-30s \xe2\x9d\x8c  %s\n' "$1" "${2:-}" >&2; }
  _verify_fail=0

  # M2: Guard against unset HOME when neither HOME nor CLAUDE_PLUGINS_DIR is available.
  if [ -z "${HOME:-}" ] && [ -z "${CLAUDE_PLUGINS_DIR:-}" ]; then
    fail "Neither HOME nor CLAUDE_PLUGINS_DIR is set — cannot determine plugin directory"
  fi

  # Load .env so UM_VAULT_DIR etc. are available even if not already set in env.
  # We read the file manually to avoid clobbering vars the caller has explicitly
  # exported (e.g. when tests pass UM_VAULT_DIR directly).
  if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r _k _v || [ -n "$_k" ]; do
      # Skip comments and blank lines
      [[ "$_k" =~ ^[[:space:]]*# ]] && continue
      [ -z "$_k" ] && continue
      # C2: Validate key is a valid shell identifier; skip malformed lines with a warning.
      if ! [[ "$_k" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        warn "Skipping malformed .env line: '$_k' is not a valid variable name"
        continue
      fi
      # Only export if not already set in environment
      if [ -z "${!_k+x}" ]; then
        export "$_k=$_v"
      fi
    done < "$ENV_FILE"
  fi

  _PORT="${MEM0_MCP_PORT:-6335}"
  _PLUGIN_DIR="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/universal-memory"
  _VAULT="${UM_VAULT_DIR:-$HOME/.um/vault}"

  # I3: Determine whether `timeout` is available (GNU coreutils / BSD).
  _TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && _TIMEOUT_CMD="timeout"

  echo ""
  echo "[verify] Running post-install checks..."
  echo ""

  # ── docker-up ──────────────────────────────────────────────────────────────
  _docker_ps_out=$(${_TIMEOUT_CMD:+$_TIMEOUT_CMD 10} docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || true)
  if echo "$_docker_ps_out" | grep -qiE 'memory-server.*(Up|running)'; then
    _vpass "docker-up" "containers are Up"
  else
    _vfail "docker-up" "memory-server container not Up. Run: docker compose -f $COMPOSE_FILE up -d"
    _verify_fail=1
  fi

  # ── server-health ──────────────────────────────────────────────────────────
  if curl -sf --max-time 5 "http://localhost:$_PORT/health" >/dev/null 2>&1; then
    _vpass "server-health" "HTTP 200 at http://localhost:$_PORT/health"
  else
    _vfail "server-health" "server not responding. Check: docker compose logs memory-server"
    _verify_fail=1
  fi

  # ── plugin-registered ─────────────────────────────────────────────────────
  if [ -e "$_PLUGIN_DIR" ]; then
    _vpass "plugin-registered" "$_PLUGIN_DIR"
  else
    _vfail "plugin-registered" "$_PLUGIN_DIR not found. Re-run install.sh to install the plugin."
    _verify_fail=1
  fi

  # ── env-vars ──────────────────────────────────────────────────────────────
  _ev_ok=1
  _ev_msg=""
  [ -n "${UM_VAULT_DIR:-}" ] || { _ev_ok=0; _ev_msg="UM_VAULT_DIR missing"; }
  [ -n "${UM_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}" ] || { _ev_ok=0; _ev_msg="${_ev_msg:+$_ev_msg, }UM_OPENAI_API_KEY/OPENAI_API_KEY missing"; }
  if [ "$_ev_ok" = "1" ]; then
    _vpass "env-vars" "UM_VAULT_DIR, UM_OPENAI_API_KEY"
  else
    _vfail "env-vars" "$_ev_msg. Source your shell profile or re-run install.sh."
    _verify_fail=1
  fi

  # ── vault-dir ─────────────────────────────────────────────────────────────
  if [ -d "$_VAULT" ] && [ -w "$_VAULT" ]; then
    _vpass "vault-dir" "$_VAULT"
  else
    _vfail "vault-dir" "$_VAULT missing or not writable. Run: mkdir -p $_VAULT"
    _verify_fail=1
  fi

  # ── pyyaml ────────────────────────────────────────────────────────────────
  if python3 -c 'import yaml' 2>/dev/null; then
    _vpass "pyyaml" ""
  else
    _vfail "pyyaml" "pyyaml not found. Run: pip install pyyaml"
    _verify_fail=1
  fi

  # ── hook-smoke ────────────────────────────────────────────────────────────
  _HOOK_SCRIPT="$REPO_ROOT/plugins/claude-code/universal-memory/hooks/stop.sh"
  _SMOKE_PROJECT="install-verify"
  _SMOKE_DIR="$_VAULT/captures/$_SMOKE_PROJECT/raw"
  _TODAY=$(date -u +%Y-%m-%d)
  _SMOKE_FILE="$_SMOKE_DIR/$_TODAY.md"

  if [ -f "$_HOOK_SCRIPT" ]; then
    mkdir -p "$_SMOKE_DIR" 2>/dev/null || true
    _before_size=0
    [ -f "$_SMOKE_FILE" ] && _before_size=$(wc -c < "$_SMOKE_FILE")

    echo "verify smoke transcript" | UM_VAULT_DIR="$_VAULT" CLAUDE_CWD="$_SMOKE_PROJECT" bash "$_HOOK_SCRIPT" 2>/dev/null || true

    if [ -f "$_SMOKE_FILE" ] && [ "$(wc -c < "$_SMOKE_FILE")" -gt "$_before_size" ]; then
      _SMOKE_REL="captures/$_SMOKE_PROJECT/raw/$_TODAY.md"
      _vpass "hook-smoke" "raw capture created at $_SMOKE_REL"
    else
      _vfail "hook-smoke" "stop.sh did not write to $_SMOKE_FILE"
      _verify_fail=1
    fi
  else
    _vfail "hook-smoke" "stop.sh not found at $_HOOK_SCRIPT"
    _verify_fail=1
  fi

  # ── session-end-dry-run ───────────────────────────────────────────────────
  _SESSION_END="$REPO_ROOT/plugins/claude-code/universal-memory/hooks/session-end.sh"
  if [ -f "$_SESSION_END" ]; then
    if UM_SUMMARY_ENABLED=false UM_VAULT_DIR="$_VAULT" ${_TIMEOUT_CMD:+$_TIMEOUT_CMD 30} bash "$_SESSION_END" 2>/dev/null; then
      _vpass "session-end-dry-run" "exited 0 (summary skipped per UM_SUMMARY_ENABLED=false)"
    else
      _vfail "session-end-dry-run" "session-end.sh exited non-zero. Check env vars and logs."
      _verify_fail=1
    fi
  else
    _vfail "session-end-dry-run" "session-end.sh not found at $_SESSION_END"
    _verify_fail=1
  fi

  # ── cleanup ───────────────────────────────────────────────────────────────
  rm -rf "$_VAULT/captures/$_SMOKE_PROJECT" 2>/dev/null || true
  _vpass "cleanup" "removed $_VAULT/captures/$_SMOKE_PROJECT"

  echo ""
  if [ "$_verify_fail" -eq 0 ]; then
    echo "All checks passed. Restart Claude Code to activate hooks."
    exit 0
  else
    echo "One or more checks failed. See diagnostics above." >&2
    exit 1
  fi
fi

# ─── CLI arg parsing (--yes / -y) ────────────────────────────────────────────
# --yes/-y is a user-facing shortcut for "run non-interactively with sensible
# defaults." It implies UM_NONINTERACTIVE=1 but is friendlier:
#   - default vault dir to $HOME/.um/vault if UM_VAULT_DIR unset
#   - use env OPENAI_API_KEY if present; if absent AND no `claude` CLI,
#     proceed with a warning (UM_SUMMARIZER=openai) instead of failing
#   - accept "copy" for plugin install without asking
#   - append to shell profile without confirmation
# --verify is already handled above (early exit); do not re-parse it here.
for _arg in "$@"; do
	case "$_arg" in
		--yes|-y)
			UM_YES=1
			UM_NONINTERACTIVE=1
			;;
		--verify)
			# Handled above; reaching here means the user combined flags.
			# Honor the --verify early-exit behavior by rejecting the combo.
			fail "--verify must be the sole argument; do not combine with --yes."
			;;
	esac
done

# When --yes is set, backfill any missing required vars with defaults so the
# UM_NONINTERACTIVE strict-check below does not `:?` abort. This is the one
# place where `--yes` diverges from `UM_NONINTERACTIVE=1`: it tolerates a
# missing OPENAI_API_KEY and falls back to an empty string (no summaries).
if [ "${UM_YES:-0}" = "1" ]; then
	: "${UM_VAULT_DIR:=$HOME/.um/vault}"
	# Allow OPENAI_API_KEY to be empty — we handle the fallback path below.
	: "${OPENAI_API_KEY:=}"
	# MEM0_USER_ID: if absent, use a safe default namespace. Users can override
	# later by editing server/.env.
	: "${MEM0_USER_ID:=default}"
	: "${MEM0_MCP_PORT:=6335}"
	: "${UM_SUMMARY_ENABLED:=true}"
	: "${UM_TEMPORAL_DECAY:=false}"
	# UM_OPENAI_API_KEY falls back to OPENAI_API_KEY (which may itself be empty).
	: "${UM_OPENAI_API_KEY:=$OPENAI_API_KEY}"
	export UM_VAULT_DIR OPENAI_API_KEY MEM0_USER_ID MEM0_MCP_PORT \
		UM_SUMMARY_ENABLED UM_TEMPORAL_DECAY UM_OPENAI_API_KEY
fi

# ─── Prereq checks ───────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "Docker not found. Install Docker Engine first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 not found. Update Docker Desktop or install the compose plugin."
docker info >/dev/null 2>&1 || fail "Docker daemon not reachable. Start Docker Desktop (or the docker service) and re-run."

[ -f "$ENV_EXAMPLE" ] || fail "Not finding $ENV_EXAMPLE — are you running this from the repo's server/ directory or via ./install.sh?"
[ -f "$COMPOSE_FILE" ] || fail "Not finding $COMPOSE_FILE."

ok "Docker is running and server files are present."

# ─── pyyaml availability ─────────────────────────────────────────────────────
# Shell hooks (Phase C) use python3 + pyyaml to parse session frontmatter.
# Flag missing pyyaml now so users don't hit cryptic errors at hook time.
python3 -c 'import yaml' 2>/dev/null || {
	fail "pyyaml is not available. Install it with: pip install pyyaml"
}
ok "pyyaml is available."

# ─── Collect required values ─────────────────────────────────────────────────
prompt() {
	# $1=var name, $2=description, $3=default (optional), $4=secret (1=silent input)
	local var="$1" desc="$2" default="${3:-}" secret="${4:-0}"
	local current="${!var:-}"

	if [ -n "$current" ]; then
		ok "$var already set in environment — using it."
		return
	fi

	local val=""
	while [ -z "$val" ]; do
		if [ "$secret" = "1" ]; then
			printf '%s%s: ' "$desc" "${default:+ [default: $default]}" >&2
			IFS= read -rs val
			echo >&2
		else
			printf '%s%s: ' "$desc" "${default:+ [default: $default]}" >&2
			IFS= read -r val
		fi
		[ -z "$val" ] && [ -n "$default" ] && val="$default"
		if [ -z "$val" ]; then
			warn "Required. Please enter a value."
		fi
	done
	# $var is always a hardcoded literal from this script — never user input.
	# Indirect expansion ("${!var:-}") and this eval are safe here.
	eval "$var=\$val"
	eval "export $var"
}

if [ "${UM_NONINTERACTIVE:-0}" = "1" ]; then
	# --yes mode pre-populates defaults (including empty OPENAI_API_KEY) above.
	# Only the stricter UM_NONINTERACTIVE=1 (without --yes) requires a real key.
	if [ "${UM_YES:-0}" != "1" ]; then
		: "${OPENAI_API_KEY:?UM_NONINTERACTIVE=1 but OPENAI_API_KEY is not set}"
		: "${MEM0_USER_ID:?UM_NONINTERACTIVE=1 but MEM0_USER_ID is not set}"
	fi
	MEM0_MCP_PORT="${MEM0_MCP_PORT:-6335}"
	UM_VAULT_DIR="${UM_VAULT_DIR:-$HOME/.um/vault}"
	UM_SUMMARY_ENABLED="${UM_SUMMARY_ENABLED:-true}"
	# UM_OPENAI_API_KEY: fall back to OPENAI_API_KEY if not explicitly set
	UM_OPENAI_API_KEY="${UM_OPENAI_API_KEY:-$OPENAI_API_KEY}"
	UM_TEMPORAL_DECAY="${UM_TEMPORAL_DECAY:-false}"
	ok "Non-interactive mode — using env values."
else
	info "Collecting configuration (press Enter to accept a shown default)."
	# $var names below are hardcoded literals from this script — never user input.
	# Indirect expansion ("${!var:-}") and the eval inside prompt() are safe.
	prompt OPENAI_API_KEY "OpenAI API key (input hidden)" "" 1
	prompt MEM0_USER_ID   "Memory namespace / user ID (any string; identifies this memory store)" "" 0
	prompt MEM0_MCP_PORT  "HTTP port to expose" "6335" 0

	# UM_OPENAI_API_KEY defaults to whatever OPENAI_API_KEY was just entered
	_um_oai_default="${UM_OPENAI_API_KEY:-$OPENAI_API_KEY}"
	prompt UM_OPENAI_API_KEY "OpenAI API key for UM hooks (input hidden; default: same as above)" "$_um_oai_default" 1
	prompt UM_VAULT_DIR       "Vault directory for session summaries" "${UM_VAULT_DIR:-$HOME/.um/vault}" 0
	prompt UM_SUMMARY_ENABLED "Enable session-summary pipeline (true/false)" "${UM_SUMMARY_ENABLED:-true}" 0
	prompt UM_TEMPORAL_DECAY  "Enable temporal decay weighting (true/false)" "${UM_TEMPORAL_DECAY:-false}" 0
fi

# Basic sanity
[[ "$OPENAI_API_KEY" == sk-* ]] || warn "OPENAI_API_KEY does not start with 'sk-' — continuing anyway."
[[ "$MEM0_MCP_PORT" =~ ^[0-9]+$ ]] || fail "MEM0_MCP_PORT must be a number. Got: $MEM0_MCP_PORT"
[[ "$OPENAI_API_KEY" =~ [[:space:]] ]] && fail "OPENAI_API_KEY contains whitespace — refusing to write to .env."
[[ "$UM_OPENAI_API_KEY" =~ [[:space:]] ]] && fail "UM_OPENAI_API_KEY contains whitespace — refusing to write to .env."
[[ "$MEM0_USER_ID" =~ [[:space:]] ]] && fail "MEM0_USER_ID contains whitespace — refusing to write to .env."
[[ "$UM_VAULT_DIR" =~ [[:space:]] ]] && fail "UM_VAULT_DIR contains whitespace — refusing to write to .env."
[[ "$UM_SUMMARY_ENABLED" =~ ^(true|false)$ ]] || fail "UM_SUMMARY_ENABLED must be 'true' or 'false'. Got: $UM_SUMMARY_ENABLED"
[[ "$UM_TEMPORAL_DECAY" =~ ^(true|false)$ ]] || fail "UM_TEMPORAL_DECAY must be 'true' or 'false'. Got: $UM_TEMPORAL_DECAY"

# ─── P0-3: API key validation ────────────────────────────────────────────────
# Only probe when the key is freshly entered (not pre-existing in env) and
# validation is not explicitly skipped.
_validate_openai_key() {
	local key="$1"
	info "Validating OpenAI API key (GET /v1/models, 5s timeout)..."
	local http_status
	# C3: Write the auth header to a temp file so the key never appears in ps output.
	# Path is registered in script-level _UM_TMP_KEYFILE so the EXIT/INT/TERM
	# trap above guarantees cleanup on any exit path, including Ctrl-C.
	_UM_TMP_KEYFILE=$(mktemp)
	chmod 600 "$_UM_TMP_KEYFILE"
	printf 'header = "Authorization: Bearer %s"\n' "$key" > "$_UM_TMP_KEYFILE"
	http_status=$(curl -sfo /dev/null -w "%{http_code}" --max-time 5 \
		--config "$_UM_TMP_KEYFILE" \
		https://api.openai.com/v1/models 2>/dev/null || echo "000")
	_um_cleanup
	case "$http_status" in
		200) ok "OpenAI API key validated." ;;
		401) return 1 ;;  # caller handles retry or fail
		429) warn "OpenAI key rate-limited (429); validation skipped, will retry at runtime." ;;
		000) warn "Could not reach OpenAI (network issue); skipping validation." ;;
		*)   warn "Unexpected HTTP $http_status from OpenAI; continuing." ;;
	esac
	return 0
}

if [ "${UM_SKIP_KEY_VALIDATION:-0}" = "1" ]; then
	info "UM_SKIP_KEY_VALIDATION=1 — skipping OpenAI key probe."
else
	# Validate UM_OPENAI_API_KEY (used by hooks). Loop on 401 in interactive mode.
	_key_to_validate="${UM_OPENAI_API_KEY:-}"
	if [ -n "$_key_to_validate" ]; then
		while true; do
			if _validate_openai_key "$_key_to_validate"; then
				break
			fi
			# 401 path
			if [ "${UM_NONINTERACTIVE:-0}" = "1" ]; then
				fail "OpenAI API rejected this key (401). Set UM_OPENAI_API_KEY to a valid key and retry."
			fi
			warn "OpenAI API rejected this key (401). Please re-enter."
			printf 'UM_OPENAI_API_KEY (input hidden): ' >&2
			IFS= read -rs _key_to_validate
			echo >&2
			[ -z "$_key_to_validate" ] && fail "Empty key — aborting."
		done
		UM_OPENAI_API_KEY="$_key_to_validate"
		export UM_OPENAI_API_KEY
	fi
fi

# Create vault directory (idempotent)
mkdir -p "$UM_VAULT_DIR" || fail "Could not create vault directory: $UM_VAULT_DIR"
ok "Vault directory ready: $UM_VAULT_DIR"

info "Collected: user=$MEM0_USER_ID port=$MEM0_MCP_PORT  (API key hidden)"

# ─── Write .env ──────────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
	if [ "${UM_NONINTERACTIVE:-0}" = "1" ]; then
		BACKUP="$ENV_FILE.bak.$(date +%s)-$$"
		cp "$ENV_FILE" "$BACKUP"
		ok "Existing .env backed up to $(basename "$BACKUP")."
	else
		printf '%s exists. [O]verwrite, [B]ackup-then-overwrite, or [A]bort? [B] ' "$ENV_FILE" >&2
		read -r CHOICE
		CHOICE="${CHOICE:-B}"
		case "$CHOICE" in
			[Oo]*) ;;
			[Aa]*) fail "Aborted by user." ;;
			*)
				BACKUP="$ENV_FILE.bak.$(date +%s)-$$"
				cp "$ENV_FILE" "$BACKUP"
				ok "Backed up to $(basename "$BACKUP")."
				;;
		esac
	fi
fi

# Write .env safely — do NOT use heredoc expansion on values. If a key ever
# contains $, `, or \ they would be interpolated by the shell and the written
# file would be wrong. Use printf with %s to pass values literally.
{
	printf '# Generated by install.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
	printf 'MEM0_USER_ID=%s\n'   "$MEM0_USER_ID"
	printf 'MEM0_MCP_PORT=%s\n'  "$MEM0_MCP_PORT"
	printf 'UM_VAULT_DIR=%s\n'          "$UM_VAULT_DIR"
	printf 'UM_MOUNT_MODE=%s\n'         "ro"
	printf 'UM_SUMMARY_ENABLED=%s\n'    "$UM_SUMMARY_ENABLED"
	printf 'UM_OPENAI_API_KEY=%s\n'     "$UM_OPENAI_API_KEY"
	printf 'UM_TEMPORAL_DECAY=%s\n'     "$UM_TEMPORAL_DECAY"
} > "$ENV_FILE"

chmod 600 "$ENV_FILE" 2>/dev/null || true  # best-effort; no-op on Windows
ok ".env written."

# ─── P0-1: Plugin install ────────────────────────────────────────────────────
_PLUGIN_SRC="$REPO_ROOT/plugins/claude-code/universal-memory"
_PLUGIN_TARGET_BASE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
_PLUGIN_TARGET="$_PLUGIN_TARGET_BASE/universal-memory"

_read_plugin_version() {
	local dir="$1"
	# plugin.json may be at the root or under .claude-plugin/
	local pjson
	if [ -f "$dir/.claude-plugin/plugin.json" ]; then
		pjson="$dir/.claude-plugin/plugin.json"
	elif [ -f "$dir/plugin.json" ]; then
		pjson="$dir/plugin.json"
	else
		return 0  # no plugin.json found — return empty string, exit 0
	fi
	# Extract version without jq — simple grep
	grep '"version"' "$pjson" 2>/dev/null | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1
}

# Copy the canonical routing rubric into an installed plugin so
# session-start.sh can read it via the sibling-copy fallback when the
# repo is not reachable (e.g. installed-plugin copy outside the checkout).
# On failure warn visibly — a silent failure would make a missing rubric
# indistinguishable from a successful install.
_copy_rubric_to_target() {
	local target="$1"
	local src_rubric="$REPO_ROOT/docs/memory-routing-rubric.md"
	if [ ! -r "$src_rubric" ]; then
		warn "Rubric source missing at $src_rubric — session-start will use inline fallback."
		return
	fi
	if ! cp "$src_rubric" "$target/rubric.md" 2>/dev/null; then
		warn "Could not copy rubric.md to $target — session-start will use inline fallback."
	fi
}

_install_plugin() {
	local src="$_PLUGIN_SRC"
	local target="$_PLUGIN_TARGET"

	if [ ! -d "$src" ]; then
		warn "Plugin source not found at $src — skipping plugin install."
		return
	fi

	mkdir -p "$_PLUGIN_TARGET_BASE" || { warn "Could not create plugin directory $_PLUGIN_TARGET_BASE — skipping."; return; }

	# Already a symlink pointing at src?
	if [ -L "$target" ]; then
		local link_dest
		link_dest=$(readlink "$target" 2>/dev/null || true)
		if [ "$link_dest" = "$src" ]; then
			ok "Plugin already linked at $target — skipping."
			return
		fi
		warn "Plugin symlink at $target points elsewhere ($link_dest). Will prompt for action."
	fi

	# Already a directory?
	if [ -d "$target" ] && [ ! -L "$target" ]; then
		local src_ver target_ver
		src_ver=$(_read_plugin_version "$src")
		target_ver=$(_read_plugin_version "$target")
		if [ -n "$src_ver" ] && [ -n "$target_ver" ]; then
			if [ "$src_ver" = "$target_ver" ]; then
				ok "Plugin v$target_ver already installed at $target — skipping."
				return
			fi
			# Compare versions: if target > src, skip.
			# I5: sort -V gives wrong result for e.g. 0.9 vs 0.10 when unavailable.
			# If sort -V is not present, warn and skip the comparison (treat as same,
			# let user decide via the copy/link prompt rather than silently upgrading).
			if ! sort -V </dev/null >/dev/null 2>&1; then
				warn "sort -V not available — cannot reliably compare plugin versions; skipping version check."
			else
				local newer
				newer=$(printf '%s\n%s\n' "$src_ver" "$target_ver" | sort -V | tail -1)
				if [ "$newer" = "$target_ver" ] && [ "$src_ver" != "$target_ver" ]; then
					warn "Installed plugin (v$target_ver) is newer than source (v$src_ver) — skipping."
					return
				fi
			fi
			# target is older — prompt for replacement
			if [ "${UM_NONINTERACTIVE:-0}" != "1" ]; then
				printf 'Replace installed plugin v%s with v%s? [Y/n] ' "$target_ver" "$src_ver" >&2
				read -r _replace
				_replace="${_replace:-Y}"
				[[ "$_replace" =~ ^[Nn] ]] && { info "Plugin update skipped."; return; }
			fi
			rm -rf "$target"
		fi
	fi

	# Prompt: copy, link, or skip
	local _action="c"
	if [ "${UM_NONINTERACTIVE:-0}" = "1" ]; then
		_action="c"
	else
		printf 'Install plugin to %s? (c)opy, (l)ink for development, (s)kip [c] ' "$target" >&2
		read -r _action
		_action="${_action:-c}"
	fi

	# C1: Remove any pre-existing symlink or directory at the target before
	# placing a new copy or symlink.  Without this, cp -r into an existing
	# symlink would write files into the symlink's target (data corruption), and
	# ln -s would fail with "File exists".  This MUST happen only inside the
	# install branches — the (s)kip branch must be non-destructive so that an
	# existing install is preserved if the user declines to replace it.
	case "$_action" in
		[lL]*)
			if [ -L "$target" ]; then
				rm -f "$target"
			elif [ -d "$target" ]; then
				rm -rf "$target"
			fi
			if ln -s "$src" "$target" 2>/dev/null; then
				ok "Plugin symlinked: $target -> $src"
				# Do NOT copy rubric into $target here — it would resolve
				# through the symlink and pollute the repo source tree with
				# an untracked rubric.md. session-start.sh's canonical-path
				# lookup ($SCRIPT_DIR/../../../../docs/memory-routing-rubric.md)
				# already resolves correctly through the symlink.
			else
				warn "ln -s failed (Windows may require Developer Mode). Falling back to copy."
				if cp -r "$src" "$target"; then
					ok "Plugin copied to $target (copy fallback)."
					_copy_rubric_to_target "$target"
				fi
			fi
			;;
		[sS]*)
			info "Plugin install skipped — install manually to $target"
			return
			;;
		*)
			if [ -L "$target" ]; then
				rm -f "$target"
			elif [ -d "$target" ]; then
				rm -rf "$target"
			fi
			if cp -r "$src" "$target"; then
				ok "Plugin copied to $target"
				_copy_rubric_to_target "$target"
			fi
			;;
	esac

	local installed_ver
	installed_ver=$(_read_plugin_version "$target")
	ok "Plugin installed. Restart Claude Code to load v${installed_ver:-?} hooks."
}

info "Installing Claude Code plugin..."
_install_plugin

# ─── P0-2: Shell profile export ──────────────────────────────────────────────
_UM_MARKER_START="# --- universal-memory (auto-added by install.sh) ---"
_UM_MARKER_END="# --- end universal-memory ---"

# Detect summarizer default — prefer claude CLI (zero-cost) if available.
# Probed BEFORE writing the profile so the detected value is the one written.
if command -v claude >/dev/null 2>&1; then
	_um_summarizer_default="claude-agent-sdk"
	info "Claude CLI detected — defaulting UM_SUMMARIZER=claude-agent-sdk (zero-cost, uses your existing Claude subscription)"
else
	_um_summarizer_default="openai"
	info "Claude CLI not detected — defaulting UM_SUMMARIZER=openai (requires UM_OPENAI_API_KEY)"
	# B3: In --yes mode with no key AND no claude CLI, the user will have no
	# working summarizer. Don't fail (the install is otherwise useful — raw
	# captures still work), but warn loudly so they know summaries are off
	# until they set UM_OPENAI_API_KEY or install the claude CLI.
	if [ "${UM_YES:-0}" = "1" ] && [ -z "${UM_OPENAI_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
		warn "No OPENAI_API_KEY and no claude CLI detected — summaries will be skipped."
		warn "To enable: set UM_OPENAI_API_KEY in your shell, or install the claude CLI, then re-run install.sh."
	fi
fi

_detect_profile() {
	local shell_name
	shell_name=$(basename "${SHELL:-bash}")
	case "$shell_name" in
		zsh)  echo "$HOME/.zshrc" ;;
		bash) echo "$HOME/.bashrc" ;;
		*)    echo "" ;;
	esac
}

# Write a fresh marker block with all managed env vars to the end of $profile.
# Caller must ensure any existing block has already been removed.
_write_marker_block() {
	local profile="$1"
	local key_value="$2"
	local summarizer="$3"
	{
		printf '\n%s\n' "$_UM_MARKER_START"
		printf "export UM_OPENAI_API_KEY='%s'\n" "$key_value"
		printf "export UM_SUMMARIZER='%s'\n" "$summarizer"
		printf '%s\n' "$_UM_MARKER_END"
	} >> "$profile"
}

# Strip any existing marker block from the profile. Idempotent: no-op if absent.
# Uses a sed script that deletes lines from the start marker through the end
# marker inclusive. We anchor on literal marker strings (no regex specials).
_strip_marker_block() {
	local profile="$1"
	# Quick exit if no block present
	grep -qF "$_UM_MARKER_START" "$profile" 2>/dev/null || return 0
	# sed -i with .bak backup for portability (GNU sed and BSD/macOS sed agree
	# when a backup suffix is supplied). The .bak file is removed after.
	# Marker strings contain no sed metacharacters (no /, \, &, etc.), but
	# if that ever changes, switch to a different delimiter here.
	sed -i.bak "\|$_UM_MARKER_START|,\|$_UM_MARKER_END|d" "$profile"
	rm -f "$profile.bak" 2>/dev/null || true
}

_append_to_profile() {
	local profile="$1"
	local key_value="$2"       # literal key string
	local summarizer="$3"      # auto-detected summarizer default

	if [ -z "$profile" ]; then
		warn "Unknown shell; cannot auto-append UM_OPENAI_API_KEY. Add manually:"
		warn "  export UM_OPENAI_API_KEY='<your-key>'"
		warn "  export UM_SUMMARIZER='$summarizer'"
		return
	fi

	# Case 1: marker block already exists → this is a re-install.
	# We need to decide: does the existing block have a matching key?
	#   - If yes: rewrite the block declaratively so every managed var is
	#     up-to-date (UM_SUMMARIZER might be new since the last install).
	#   - If no: warn about the conflict and leave everything alone (user's
	#     custom key wins; they should update manually).
	if grep -qF "$_UM_MARKER_START" "$profile" 2>/dev/null; then
		if grep -q "export UM_OPENAI_API_KEY='${key_value}'" "$profile" 2>/dev/null || \
		   grep -q "export UM_OPENAI_API_KEY=\"${key_value}\"" "$profile" 2>/dev/null || \
		   grep -q "export UM_OPENAI_API_KEY=${key_value}" "$profile" 2>/dev/null; then
			# Matching key inside existing marker block — rewrite block so
			# UM_SUMMARIZER (and any future managed vars) are included.
			ok "UM_OPENAI_API_KEY already present in $profile with matching value — refreshing managed block."
			_strip_marker_block "$profile"
			_write_marker_block "$profile" "$key_value" "$summarizer"
			ok "Managed block refreshed in $profile (UM_OPENAI_API_KEY + UM_SUMMARIZER)."
			info "Reload your shell or run: source $profile"
			return
		else
			warn "Found existing UM_OPENAI_API_KEY in $profile with different value; please update manually."
			return
		fi
	fi

	# Case 2: no marker block, but a bare UM_OPENAI_API_KEY export exists
	# somewhere in the profile (user-managed, outside our block). Respect it.
	if grep -q 'export UM_OPENAI_API_KEY' "$profile" 2>/dev/null; then
		if grep -q "export UM_OPENAI_API_KEY='${key_value}'" "$profile" 2>/dev/null || \
		   grep -q "export UM_OPENAI_API_KEY=\"${key_value}\"" "$profile" 2>/dev/null || \
		   grep -q "export UM_OPENAI_API_KEY=${key_value}" "$profile" 2>/dev/null; then
			ok "UM_OPENAI_API_KEY already present in $profile with matching value — skipping."
		else
			warn "Found existing UM_OPENAI_API_KEY in $profile with different value; please update manually."
		fi
		return
	fi

	# Case 3: fresh install — prompt, then write the block.
	if [ "${UM_NONINTERACTIVE:-0}" != "1" ]; then
		printf 'Append UM_OPENAI_API_KEY to %s? [Y/n] ' "$profile" >&2
		read -r _ans
		_ans="${_ans:-Y}"
		[[ "$_ans" =~ ^[Nn] ]] && { info "Shell profile update skipped — add UM_OPENAI_API_KEY manually."; return; }
	fi

	# Append marker block — use printf to avoid value interpolation.
	# UM_SUMMARIZER is included in the same marker block so uninstall/re-install
	# paths manage both together.
	_write_marker_block "$profile" "$key_value" "$summarizer"

	ok "UM_OPENAI_API_KEY and UM_SUMMARIZER appended to $profile"
	info "Reload your shell or run: source $profile"
}

_SHELL_PROFILE=$(_detect_profile)
info "Updating shell profile${_SHELL_PROFILE:+ ($_SHELL_PROFILE)}..."
_append_to_profile "$_SHELL_PROFILE" "$UM_OPENAI_API_KEY" "$_um_summarizer_default"

# ─── Start stack ─────────────────────────────────────────────────────────────
info "Pulling / building images..."
docker compose -f "$COMPOSE_FILE" up -d 2>&1 | sed 's/^/[compose] /'

# ─── Poll /health until ready ─────────────────────────────────────────────────
# Cold-build on slow hardware (ARM Pi, constrained CI runners) can easily
# take >90s end-to-end before the server binds. Allow 180s to cover that.
ENDPOINT="http://localhost:$MEM0_MCP_PORT/health"
info "Waiting for $ENDPOINT (up to 180s)..."

READY=0
for i in $(seq 1 90); do
	if curl -sf --max-time 3 "$ENDPOINT" >/dev/null 2>&1; then
		READY=1
		break
	fi
	sleep 2
done

if [ "$READY" != "1" ]; then
	warn "Server did not become healthy within 180s."
	warn "Check logs with: docker compose -f $COMPOSE_FILE logs memory-server"
	exit 1
fi

HEALTH=$(curl -sf "$ENDPOINT")
ok "Server is healthy: $HEALTH"

# ─── Success banner ──────────────────────────────────────────────────────────
_profile_hint=""
if [ -n "$_SHELL_PROFILE" ]; then
	_profile_hint="  Shell profile updated: source $_SHELL_PROFILE (or open a new terminal)"
else
	_profile_hint="  Add to your shell profile:  export UM_OPENAI_API_KEY='<your-key>'"
fi

cat <<EOF

╔═════════════════════════════════════════════════════════════════════╗
║ universal-memory server is running at http://localhost:$MEM0_MCP_PORT
║
║ Next steps:
║   1. Verify the install:    bash server/install.sh --verify
║   2. Restart Claude Code to load the plugin and activate hooks.
║   3. Stop the stack:        docker compose down
║   4. Restart later:         docker compose up -d
║
║ Data persists at: server/data/qdrant/
║ Edit configuration: server/.env
║
║ Shell:
║   $_profile_hint
╚═════════════════════════════════════════════════════════════════════╝
EOF
