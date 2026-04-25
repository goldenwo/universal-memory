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
		--skip-docker)
			UM_SKIP_DOCKER=1
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
if [ "${UM_SKIP_DOCKER:-0}" -eq 1 ]; then
	info "Skipping docker stack (--skip-docker set)."
else
	command -v docker >/dev/null 2>&1 || fail "Docker not found. Install Docker Engine first: https://docs.docker.com/engine/install/"
	docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 not found. Update Docker Desktop or install the compose plugin."
	docker info >/dev/null 2>&1 || fail "Docker daemon not reachable. Start Docker Desktop (or the docker service) and re-run."
fi

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

# ─── v0.6: was-existing-install probe (spec §4.2 — delta summary gating) ────
# Captured BEFORE any .env writes so the end-of-run post-install delta summary
# (Part C) can tell upgrading users ("fresh .env existed at start") apart from
# first-time users ("no .env at start"). Must stay above the token block —
# token generation doesn't touch .env, but the subsequent .env writer does.
UM_WAS_EXISTING_INSTALL=0
if [ -f "$ENV_FILE" ]; then
	UM_WAS_EXISTING_INSTALL=1
fi

# ─── v0.6: UM_AUTH_TOKEN preservation + generation (spec §4.2) ───────────────
# On re-run, read UM_AUTH_TOKEN out of existing .env and reuse it so already-
# running remote clients (Claude.ai tunnel, Custom GPT, Codex plugin on
# different boxes) don't have their cached token silently invalidated by a
# fresh install. Only generate a new 64-char hex token on true first run
# (no pre-existing value in env OR in .env). Mirror idempotently to
# ~/.um/auth-token with mode 600 — best-effort; chmod is a no-op on Windows
# NTFS, where ACL inheritance from ~/.um (mode 700) provides equivalent
# protection.
#
# This block is placed BEFORE the prompt/collection loop so that the
# resulting UM_AUTH_TOKEN is already in the environment by the time the
# .env-write block runs. It's idempotent: running install.sh N times
# against the same .env produces the same token across all N runs.
#
# Direct-invocation callers (server/install.sh without installer/install.sh
# in front) get the same preservation — this is the single source of truth
# for the token lifecycle.
if [ -z "${UM_AUTH_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
	# `|| true` is mandatory: when .env exists but lacks UM_AUTH_TOKEN= (the
	# v0.5 → v0.6 upgrade case), grep returns 1 and under `set -euo pipefail`
	# the whole assignment aborts the script. `|| true` swallows the grep miss
	# and leaves _UM_AT_EXISTING empty, letting the generation branch handle
	# the fresh-token path downstream.
	_UM_AT_EXISTING=$(grep -E '^UM_AUTH_TOKEN=' "$ENV_FILE" 2>/dev/null \
		| head -1 \
		| cut -d= -f2- \
		| sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//' \
		|| true)
	if [ -n "$_UM_AT_EXISTING" ]; then
		UM_AUTH_TOKEN="$_UM_AT_EXISTING"
		info "Reusing existing UM_AUTH_TOKEN from .env."
	fi
	unset _UM_AT_EXISTING
fi
if [ -z "${UM_AUTH_TOKEN:-}" ]; then
	command -v openssl >/dev/null 2>&1 \
		|| fail "openssl not found in PATH. UM_AUTH_TOKEN cannot be generated. Install openssl (apt/brew/choco) or export a pre-generated UM_AUTH_TOKEN."
	UM_AUTH_TOKEN=$(openssl rand -hex 32)
	info "Generated new UM_AUTH_TOKEN."
fi
export UM_AUTH_TOKEN

# Mirror to ~/.um/auth-token (chmod 600). Parent dir gets 700. Best-effort
# on Windows NTFS where chmod is a no-op — equivalent protection comes from
# ACL inheritance off ~/.um.
if [ -n "${HOME:-}" ]; then
	mkdir -p "$HOME/.um"
	chmod 700 "$HOME/.um" 2>/dev/null || true
	printf '%s' "$UM_AUTH_TOKEN" > "$HOME/.um/auth-token"
	chmod 600 "$HOME/.um/auth-token" 2>/dev/null || true
fi

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

# ─── v0.5 env-override validation ────────────────────────────────────────────
# UM_MOUNT_MODE / UM_MCP_WRITE_ENABLED / UM_CONTAINER_USER are advanced env
# overrides. Validate format + consistency to catch common footguns early.
if [ -n "${UM_MOUNT_MODE:-}" ]; then
	[[ "$UM_MOUNT_MODE" =~ ^(ro|rw)$ ]] || fail "UM_MOUNT_MODE must be 'ro' or 'rw'. Got: $UM_MOUNT_MODE"
fi
if [ -n "${UM_MCP_WRITE_ENABLED:-}" ]; then
	[[ "$UM_MCP_WRITE_ENABLED" =~ ^(true|false|1|0)$ ]] || fail "UM_MCP_WRITE_ENABLED must be 'true'/'false'/'1'/'0'. Got: $UM_MCP_WRITE_ENABLED"
fi
# Consistency: rw mount without writes-enabled is attack surface with no feature
# benefit (container can scribble on the vault from a non-MCP path, but the MCP
# write tool surface is still gated off). Fail fast with a clear message.
_mount_mode_effective="${UM_MOUNT_MODE:-ro}"
_writes_effective="${UM_MCP_WRITE_ENABLED:-false}"
if [ "$_mount_mode_effective" = "rw" ] \
	&& [ "$_writes_effective" != "true" ] && [ "$_writes_effective" != "1" ]; then
	fail "UM_MOUNT_MODE=rw requires UM_MCP_WRITE_ENABLED=true. A rw mount without MCP writes is attack surface with no feature benefit — either enable writes explicitly, or leave mount as ro."
fi
# UM_CONTAINER_USER: pins the container UID:GID to match the host user for rw-
# mount installs (avoids cross-user EACCES on vault writes). Accept either the
# literal 'node' (Dockerfile default, UID 1000 in node:alpine) or a numeric
# uid:gid pair. Reject root (0:0) — any shell with UM_CONTAINER_USER=0:0 +
# UM_MOUNT_MODE=rw gets root inside the container writing to the host vault.
if [ -n "${UM_CONTAINER_USER:-}" ]; then
	if [[ "$UM_CONTAINER_USER" != "node" ]] \
		&& ! [[ "$UM_CONTAINER_USER" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then
		fail "UM_CONTAINER_USER must be 'node' or a numeric <uid>:<gid> pair with both >0. Got: $UM_CONTAINER_USER. Root (0:0) is rejected — combined with UM_MOUNT_MODE=rw it gets root inside the container writing to the host vault. Use \"\$(id -u):\$(id -g)\" for CI / rw-mount installs."
	fi
fi

# v0.6 (#30) — UM_CONTAINER_USER change warning across re-runs.
# Files in the vault were written with whatever UID:GID was active LAST time
# install.sh ran. Switching the container user without chown-ing the vault
# causes EACCES on subsequent writes. Detect the change and surface it so
# users don't silently produce a broken install.
_PRIOR_CONTAINER_USER=""
if [ -f "$ENV_FILE" ]; then
	# Trailing `|| true` masks the pipeline's exit code: grep returns 1 when
	# UM_CONTAINER_USER isn't yet in .env (which is the common case for re-runs
	# of installs that never set the override), and `set -o pipefail` would
	# otherwise propagate that 1 → `set -e` would kill the script silently.
	_PRIOR_CONTAINER_USER=$(grep -E '^UM_CONTAINER_USER=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)
fi
if [ -n "${UM_CONTAINER_USER:-}" ] && [ -n "$_PRIOR_CONTAINER_USER" ] \
	&& [ "$UM_CONTAINER_USER" != "$_PRIOR_CONTAINER_USER" ]; then
	warn "UM_CONTAINER_USER changed: was '$_PRIOR_CONTAINER_USER', now '$UM_CONTAINER_USER'."
	warn "  Existing vault files were written with the old UID:GID. Switching"
	warn "  without chown-ing the vault will cause EACCES on subsequent writes."
	warn "  Recommended: chown -R <new-uid>:<new-gid> $UM_VAULT_DIR"
	if [ "${NONINTERACTIVE_STRICT:-0}" = "1" ]; then
		fail "NONINTERACTIVE_STRICT=1 — refusing to proceed with UM_CONTAINER_USER change."
	fi
	if [ "${UM_NONINTERACTIVE:-0}" != "1" ]; then
		printf 'Continue with new UM_CONTAINER_USER? [y/N] ' >&2
		read -r _ans
		case "$_ans" in [yY]*) ;; *) fail "Aborted by user." ;; esac
	fi
fi

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
	# UM_MOUNT_MODE defaults to "ro" (safe — container cannot modify host vault).
	# Honor env override in NONINTERACTIVE mode so CI / automated installs can
	# opt into rw when they need to exercise vault-write code paths (Task 7/8/T10).
	printf 'UM_MOUNT_MODE=%s\n'         "${UM_MOUNT_MODE:-ro}"
	printf 'UM_SUMMARY_ENABLED=%s\n'    "$UM_SUMMARY_ENABLED"
	printf 'UM_OPENAI_API_KEY=%s\n'     "$UM_OPENAI_API_KEY"
	printf 'UM_TEMPORAL_DECAY=%s\n'     "$UM_TEMPORAL_DECAY"
	# UM_MCP_WRITE_ENABLED defaults to false (safe — MCP write tools gated off).
	# Honor env override so CI / automated installs can enable the write-tool
	# surface for end-to-end MCP coverage (smoke T10-G/H/I).
	printf 'UM_MCP_WRITE_ENABLED=%s\n'  "${UM_MCP_WRITE_ENABLED:-false}"
	# UM_CONTAINER_USER (#30): only emit when explicitly set so unset installs
	# stay silent. Persisted so the next install run can detect a change.
	if [ -n "${UM_CONTAINER_USER:-}" ]; then
		printf 'UM_CONTAINER_USER=%s\n'  "$UM_CONTAINER_USER"
	fi
	# --- bearer auth (v0.6+) ---
	# UM_AUTH_TOKEN is generated or preserved by the block above. Emitting
	# the same value the server will read at boot keeps .env + ~/.um/auth-token
	# in sync across re-runs (spec §4.2 token-preservation contract).
	printf 'UM_AUTH_TOKEN=%s\n'         "$UM_AUTH_TOKEN"
} > "$ENV_FILE"

chmod 600 "$ENV_FILE" 2>/dev/null || true  # best-effort; no-op on Windows
ok ".env written."

# ─── v0.6: new-keys-merged on re-run (spec §4.2, round-8 fix) ────────────────
# The v0.5-era writer above rewrites a fixed set of keys on every run. v0.6
# adds 13 new env keys for bearer auth, rate-limit, metrics/openapi auth,
# logging, request limits, bridge, and upstream retry. They are NOT in the
# v0.5 writer output. This block appends any v0.6 key that's missing from
# the freshly-written .env, defaulting to safe values. User-tuned values
# that were present in the PREVIOUS .env must be preserved — we snapshot
# those from the backup (.env.bak.*) created before the rewrite, or from
# the environment (if the user exported them before running install).
#
# Why a snapshot step: the v0.5 writer's rewrite drops anything not in its
# fixed list. Without snapshot, a user who hand-edited UM_RATE_LIMIT_RPM=120
# into .env would silently lose their value on re-run. Snapshot-then-append
# preserves it.
#
# bash 3.2 compat: uses parallel arrays (macOS default bash is 3.2 and does
# not support `declare -A` associative arrays). Keys and defaults are
# index-aligned across the two arrays.
v06_keys=(
	UM_ALLOW_LOOPBACK_NOAUTH
	UM_RATE_LIMIT_RPM
	UM_RATE_LIMIT_BURST
	UM_RATE_LIMIT_MAX_IPS
	UM_METRICS_LOOPBACK_ONLY
	UM_METRICS_AUTH_REQUIRED
	UM_OPENAPI_AUTH_REQUIRED
	UM_LOG_LEVEL
	UM_HTTP_MAX_REQUEST_BYTES
	UM_LOCK_LOW_DISK_THRESHOLD
	UM_UPSTREAM_RETRY_MAX
	UM_BRIDGE_MAX_PER_RUN
	UM_BRIDGE_JITTER_SEC
)
v06_defaults=(
	true        # UM_ALLOW_LOOPBACK_NOAUTH
	60          # UM_RATE_LIMIT_RPM
	10          # UM_RATE_LIMIT_BURST
	10000       # UM_RATE_LIMIT_MAX_IPS
	true        # UM_METRICS_LOOPBACK_ONLY
	true        # UM_METRICS_AUTH_REQUIRED
	true        # UM_OPENAPI_AUTH_REQUIRED
	info        # UM_LOG_LEVEL
	2097152     # UM_HTTP_MAX_REQUEST_BYTES (2 MB)
	104857600   # UM_LOCK_LOW_DISK_THRESHOLD (100 MB)
	3           # UM_UPSTREAM_RETRY_MAX
	50          # UM_BRIDGE_MAX_PER_RUN
	600         # UM_BRIDGE_JITTER_SEC
)

# Parallel-array drift guard — v06_keys and v06_defaults must be same length.
# If a future editor adds one without the other, every subsequent default
# silently mis-aligns. Fail loud here instead.
if [ "${#v06_keys[@]}" -ne "${#v06_defaults[@]}" ]; then
	fail "internal: v06_keys (${#v06_keys[@]}) and v06_defaults (${#v06_defaults[@]}) length mismatch — edit both arrays together"
fi

# Locate the backup (if we just made one) so we can recover user-tuned values.
# BACKUP may be unset if the .env path was a pure fresh install — that's fine,
# the snapshot simply finds nothing and we fall through to defaults.
_um_read_backup_value() {
	# $1=key; stdout=value or empty. Treats first match as authoritative;
	# strips surrounding double/single quotes to match what the user likely
	# hand-edited.
	#
	# MUST ALWAYS return 0 (never let grep's no-match exit 1 leak out): this
	# function is called via $(...) under `set -euo pipefail`, and a non-zero
	# return from the pipeline would abort the whole install on every key
	# that isn't in the backup (which is most keys on a fresh .env path).
	# Captures pipeline output into a local, explicitly prints it, returns 0.
	local k="$1" _val=""
	[ -z "${BACKUP:-}" ] && return 0
	[ ! -f "$BACKUP" ]  && return 0
	_val=$(grep -E "^${k}=" "$BACKUP" 2>/dev/null \
		| head -1 \
		| cut -d= -f2- \
		| sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//' \
		|| true)
	printf '%s' "$_val"
	return 0
}

added_keys=()
preserved_keys=()
{
	# One header+body pass so the dated comment only appears if we actually
	# add at least one key. Buffered via a subshell-emitted string so the
	# header is withheld when added_keys ends up empty.
	_um_append_buffer=""
	for i in "${!v06_keys[@]}"; do
		key="${v06_keys[$i]}"
		default="${v06_defaults[$i]}"

		# If writer above happened to already emit this key, skip. (Currently
		# the writer doesn't emit any v0.6 key — belt-and-suspenders for future
		# writer expansions that might add some v0.6 keys inline.)
		if grep -qE "^${key}=" "$ENV_FILE"; then
			continue
		fi

		# Preserve user-tuned value from prior .env (via backup) if present.
		# Falls back to shell env, then to the v0.6 safe default.
		_um_existing=$(_um_read_backup_value "$key")
		if [ -n "$_um_existing" ]; then
			_um_val="$_um_existing"
			preserved_keys+=("$key")
		elif [ -n "${!key:-}" ]; then
			_um_val="${!key}"
			preserved_keys+=("$key")
		else
			_um_val="$default"
			added_keys+=("$key")
		fi
		_um_append_buffer+="${key}=${_um_val}"$'\n'
	done
	unset _um_existing _um_val

	if [ -n "$_um_append_buffer" ]; then
		{
			printf '\n'
			printf '# --- Added by v0.6 migration on %s ---\n' "$(date -u +%Y-%m-%d)"
			printf '%s' "$_um_append_buffer"
		} >> "$ENV_FILE"
	fi
	unset _um_append_buffer
}

if [ "${#added_keys[@]}" -gt 0 ]; then
	info "[install] added ${#added_keys[@]} new env keys to .env (defaulted; see MIGRATION.md)"
fi
if [ "${#preserved_keys[@]}" -gt 0 ]; then
	info "[install] preserved ${#preserved_keys[@]} user-tuned v0.6 env keys from prior .env"
fi

# ─── Plugin install (v0.5: delegated to standalone scripts) ──────────────────
# In v0.5+, plugin-copy is handled by installer/install-plugin-cc.sh and
# installer/install-plugin-codex.sh.  server/install.sh no longer does it
# inline.  Use installer/install.sh --plugin-cc / --plugin-codex, or
# installer/install.sh --all, to install plugins alongside the server.
info "Plugin install is now handled by installer/install-plugin-cc.sh and"
info "installer/install-plugin-codex.sh. To install plugins, run:"
info "  bash installer/install.sh --plugin-cc     # Claude Code plugin"
info "  bash installer/install.sh --plugin-codex  # Codex CLI plugin (if ~/.codex exists)"
info "  bash installer/install.sh --all           # install everything detected"

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

# Shared marker-block writer — canonical superset of managed vars.
# Sourced from installer/lib/marker-block.sh so install.sh and install-cli.sh
# write the identical block. Whichever installer runs last is authoritative.
# Resolve via REPO_ROOT (already computed above) so this works both in the
# real checkout and when install.sh is copied to a temp dir by the test harness.
# Falls back to script-dir-relative path in case tests pass a minimal REPO_ROOT
# that doesn't include installer/lib/ (e.g. T15 fake-repo scenario).
# shellcheck source=../installer/lib/marker-block.sh
_UM_MARKER_LIB="$REPO_ROOT/installer/lib/marker-block.sh"
if [ ! -f "$_UM_MARKER_LIB" ]; then
  _UM_MARKER_LIB="$(dirname "${BASH_SOURCE[0]}")/../installer/lib/marker-block.sh"
fi
source "$_UM_MARKER_LIB"
unset _UM_MARKER_LIB

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

	# Case 1: marker block already exists → env-sourced contract: always strip and
	# rewrite with the caller's current environment. No key-match check.
	# Rationale (plan RH6): install-cli.sh may have written the block first with an
	# empty key; when install.sh later runs with a real key in env, the old block must
	# be replaced unconditionally so the real key lands in the profile.
	if grep -qF "$_UM_MARKER_START" "$profile" 2>/dev/null; then
		ok "Managed block found in $profile — rewriting with current environment (env-sourced contract)."
		_strip_marker_block "$profile"
		_write_marker_block "$profile" "$key_value" "$summarizer"
		ok "Managed block refreshed in $profile."
		info "Reload your shell or run: source $profile"
		return
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
if [ "${UM_SKIP_DOCKER:-0}" -eq 1 ]; then
	info "Skipping docker stack start (--skip-docker set)."
else
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
fi

if [ "${UM_SKIP_DOCKER:-0}" -ne 1 ]; then
	HEALTH=$(curl -sf "$ENDPOINT")
	ok "Server is healthy: $HEALTH"
fi

# ─── v0.6 → v0.5 post-install delta summary (spec §4.2, round-8 fix) ────────
# When upgrading an existing install, surface the v0.5 → v0.6 changes users
# need to know about: bearer auth, new env keys, loopback behavior, and tunnel
# token rotation. Suppressed on fresh installs (no prior .env) and under
# UM_QUIET=1. Uses only POSIX tests so non-interactive + --yes paths also see
# it when coming from a v0.5 .env.
#
# Set UM_WAS_EXISTING_INSTALL=1 earlier (before token+env blocks) so the gate
# reflects state at script-entry, not post-write.
if [ "${UM_WAS_EXISTING_INSTALL:-0}" = "1" ] && [ -z "${UM_QUIET:-}" ]; then
	_added_count="${#added_keys[@]}"
	cat <<EOM

[install] v0.5 → v0.6 changes applied:
  • Bearer auth enabled — token written to ~/.um/auth-token (chmod 600)
  • ${_added_count} new env keys added to .env (defaulted; see MIGRATION.md)
  • Loopback bypass active by default; tunnel-fronted clients require token
  -> Tunnel users: rotate token in Claude.ai/Custom GPT connector settings
  -> Manual token rotation: see server/README.md "Advanced: writes-enabled install"
EOM
	unset _added_count
fi

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
