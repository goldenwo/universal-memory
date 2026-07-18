#!/usr/bin/env bash
# install.sh — universal-memory server interactive installer.
# Usage: ./install.sh                 (interactive)
#        ./install.sh --verify        (post-install sanity check only)
#        ./install.sh --upgrade       (upgrade to the version compose resolves)
#        ./install.sh --upgrade 1.8.1 (upgrade to a specific published version)
#        ./install.sh --yes           (non-interactive, accept all defaults)
#        ./install.sh -y              (alias for --yes)
#        UM_NONINTERACTIVE=1 ./install.sh  (read all values from env, no prompts)
#
# --verify and --upgrade are sole-argument modes: each exits early and refuses
# to be combined with --yes. --upgrade pre-flights the new image in a throwaway
# container BEFORE swapping the running one, and auto-rolls-back to the exact
# image that was running if the new container never reports healthy.
#
# Exits non-zero on any error. Prints what it does. Never installs Docker
# for you — if Docker is missing it points at the upstream install docs
# and exits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _UM_REPO_ROOT can be set externally (e.g. by tests running from a temp dir).
REPO_ROOT="${_UM_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")}"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BUILD_OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.build.yml"
# Host-specific overrides (gitignored, never shipped). Self-hosters need to
# pin things the base file cannot know: an alternate qdrant image for their
# CPU, extra port bindings (e.g. a tailnet IP alongside loopback), bind-mount
# paths outside the repo. Without this seam operators fall back to hand-rolled
# `docker run`, which is how a v1.8.0 upgrade lost its port bindings and left
# a server running-but-unreachable. Applied LAST so host config wins.
#
# The name is load-bearing: `docker-compose.override.yml` is compose's OWN
# auto-load convention, so a BARE `docker compose ...` run from this directory
# picks it up with no flags. That is what makes every recovery command this
# script prints safe to copy-paste — on a host whose override exists precisely
# because the base config does not work there (the Pi's crash-looping qdrant
# image), a printed `-f docker-compose.yml` command would rebuild the stack
# from the base file alone and take the host down in a new way.
#
# An explicit -f SUPPRESSES compose's auto-load, so _compose() — which always
# passes -f — must keep appending it by hand.
LOCAL_OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.override.yml"
# Pre-rename name, kept only to warn that a leftover file is now inert.
LEGACY_LOCAL_OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.local.yml"

# Human-facing command prefix. Recovery instructions must reproduce the SAME
# file set _compose() uses; the reliable way to do that in a copy-pasteable
# one-liner is a bare `docker compose` scoped to this directory, letting the
# auto-load convention above do the work.
_compose_hint() { printf 'cd %s && docker compose %s' "$SCRIPT_DIR" "$*"; }

# v1.0 W1.4 — image-mode detection. Default is pull-from-GHCR (fast, ~20s
# first-run). Set UM_BUILD_LOCAL=1 in the calling environment to build
# from local source instead (~2-5 min cold-build on slow hardware).
#
# The two docker-compose files compose: docker-compose.yml is the base
# (pull mode); docker-compose.build.yml overrides `image:` with a
# `build:` directive when stacked on top via `-f` chaining.
#
# This wrapper centralizes the file selection so every `docker compose`
# call below honors the same mode without each site repeating the logic.
_compose() {
	local _files=(-f "$COMPOSE_FILE")
	[ "${UM_BUILD_LOCAL:-0}" = "1" ] && _files+=(-f "$BUILD_OVERRIDE_FILE")
	[ -f "$LOCAL_OVERRIDE_FILE" ] && _files+=(-f "$LOCAL_OVERRIDE_FILE")
	docker compose "${_files[@]}" "$@"
}

info()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# The host-override seam was briefly named docker-compose.local.yml. Compose
# does not auto-load that name and _compose() no longer passes it, so a
# leftover file is silently ignored — which is precisely the failure mode this
# seam exists to prevent, and it would only be discovered when the stack came
# back up wrong. Say so on every run until it is renamed.
if [ -f "$LEGACY_LOCAL_OVERRIDE_FILE" ] && [ ! -f "$LOCAL_OVERRIDE_FILE" ]; then
	warn "$LEGACY_LOCAL_OVERRIDE_FILE is NO LONGER APPLIED (renamed seam)."
	warn "  Rename it so docker compose auto-loads it:"
	warn "    mv '$LEGACY_LOCAL_OVERRIDE_FILE' '$LOCAL_OVERRIDE_FILE'"
fi

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

# ─── Shared helpers for the sole-argument modes (--verify / --upgrade) ───────
# Both modes probe an already-running install, so both need the same two
# things first: the values the operator put in server/.env (which they may
# never have exported into their shell), and the port those values resolve to.
# Factored here so the two modes can never drift apart on either — a --upgrade
# that health-checked a different port than --verify would be its own outage.

# Load .env WITHOUT clobbering vars the caller explicitly exported (tests pass
# UM_VAULT_DIR / MEM0_MCP_PORT directly, and an explicit export must win over
# the file). Malformed lines are skipped with a warning rather than aborting.
_um_load_env_file() {
	[ -f "$ENV_FILE" ] || return 0
	while IFS='=' read -r _k _v || [ -n "$_k" ]; do
		# Skip comments and blank lines
		[[ "$_k" =~ ^[[:space:]]*# ]] && continue
		[ -z "$_k" ] && continue
		# C2: Validate key is a valid shell identifier; skip malformed lines with a warning.
		if ! [[ "$_k" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
			warn "Skipping malformed .env line: '$_k' is not a valid variable name"
			continue
		fi
		# Normalize the value the way compose's own .env parser does. Without
		# this, shapes compose accepts happily break callers: MEM0_MCP_PORT="6335"
		# yields the literal `"6335"` and a health URL that can never answer,
		# which then reads as "the server is down".
		_v="${_v%$'\r'}"                      # CRLF-authored .env
		case "$_v" in
			'"'*'"')  _v="${_v#\"}"; _v="${_v%\"}" ;;   # quoted: content is verbatim
			"'"*"'")  _v="${_v#\'}"; _v="${_v%\'}" ;;   # (a # inside quotes is data)
			*)
				# Unquoted: an inline comment must be whitespace-separated.
				_v="${_v%%[[:space:]]#*}"
				# ...then drop any trailing whitespace it left behind.
				_v="${_v%"${_v##*[![:space:]]}"}"
				;;
		esac
		# Only export if not already set in environment
		if [ -z "${!_k+x}" ]; then
			export "$_k=$_v"
		fi
	done < "$ENV_FILE"
}

# The HOST-side port the server is published on. MEM0_MCP_PORT is the host half
# of docker-compose.yml's `ports:` mapping (the container always listens on
# 6335 — pinned in the compose `environment:` block). It is a bare number in
# every install.sh-written .env, but compose also accepts a full host binding
# in that same variable (e.g. "127.0.0.1:6335", or "0.0.0.0:6337" as
# self-hosted deployments run it), so take the last colon-separated field to
# get the port out of either shape. Never hardcode a port at a call site.
#
# This is a best-effort derivation from config. When a container is actually
# running, `docker compose port` is authoritative — a host override file can
# REPLACE the published ports entirely, and this function cannot see that.
_um_port() {
	local _p="${MEM0_MCP_PORT:-6335}"
	printf '%s' "${_p##*:}"
}

# ─── Version reporting across the three updatable surfaces ───────────────────
# The server container, the `um` CLI, and the Claude Code plugin update through
# three different mechanisms with no shared release trigger, so they drift
# independently. A host once ran a current server while its CLI sat a full
# release behind — which silently made that release's capture-freshness cron
# uninstallable, because the script it needed did not exist in that tree.
# Nothing surfaced the gap. These helpers let --verify surface it.

# Extract a top-level "version" from a JSON file. Empty when absent/unreadable.
# grep+sed rather than jq: jq is not a dependency anywhere else in this script.
_um_json_version() {
	[ -f "$1" ] || return 0
	grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$1" 2>/dev/null \
		| head -1 \
		| sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
		|| true
}

# Version of the server the running container was built from. Prefers the OCI
# label the release workflow stamps, which stays accurate even when the image
# is tagged `latest`; falls back to the image tag for locally-built images.
_um_server_version() {
	local _cid _img _ver
	_cid=$(_compose ps -q memory-server 2>/dev/null | head -1 || true)
	[ -n "$_cid" ] || return 0
	_ver=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$_cid" 2>/dev/null || true)
	if [ -z "$_ver" ] || [ "$_ver" = "<no value>" ]; then
		_img=$(docker inspect -f '{{.Config.Image}}' "$_cid" 2>/dev/null || true)
		_ver="${_img##*:}"
		# A bare repo with no tag leaves the whole ref behind — not a version.
		case "$_ver" in */*) _ver="" ;; esac
	fi
	printf '%s' "$_ver"
}

# True when $1 is a strictly lower dotted-numeric version than $2. Anything
# non-numeric (`latest`, a digest, empty) returns false — an unknown version is
# never reported as skew, because a false skew warning trains operators to
# ignore the real one.
_um_ver_lt() {
	local _a="$1" _b="$2" _i _x _y
	[[ "$_a" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
	[[ "$_b" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
	local IFS=.
	local _A=() _B=()
	read -ra _A <<< "$_a"
	read -ra _B <<< "$_b"
	for _i in 0 1 2; do
		_x="${_A[$_i]:-0}"
		_y="${_B[$_i]:-0}"
		[ "$_x" -lt "$_y" ] && return 0
		[ "$_x" -gt "$_y" ] && return 1
	done
	return 1
}

# I3: `timeout` (GNU coreutils / BSD) is optional. Probe once; call sites use
# ${_TIMEOUT_CMD:+$_TIMEOUT_CMD <secs>} so its absence degrades to no timeout
# rather than a hard failure. (`A && B` never trips errexit when A fails.)
_TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && _TIMEOUT_CMD="timeout"

# ─── --verify mode ───────────────────────────────────────────────────────────
if [ "${1:-}" = "--verify" ]; then
  _vpass() { printf '\033[1;32m[verify]\033[0m %-30s \xe2\x9c\x85  %s\n' "$1" "${2:-}"; }
  _vfail() { printf '\033[1;31m[verify]\033[0m %-30s \xe2\x9d\x8c  %s\n' "$1" "${2:-}" >&2; }
  # Informational / advisory lines. Deliberately distinct glyphs: a version
  # readout is not a passed check, and version skew is a warning an operator
  # should act on without it failing an otherwise-healthy server verify.
  _vinfo() { printf '\033[1;34m[verify]\033[0m %-30s \xe2\x84\xb9   %s\n' "$1" "${2:-}"; }
  _vwarn() { printf '\033[1;33m[verify]\033[0m %-30s \xe2\x9a\xa0   %s\n' "$1" "${2:-}"; }
  _verify_fail=0

  # M2: Guard against unset HOME when neither HOME nor CLAUDE_PLUGINS_DIR is available.
  if [ -z "${HOME:-}" ] && [ -z "${CLAUDE_PLUGINS_DIR:-}" ]; then
    fail "Neither HOME nor CLAUDE_PLUGINS_DIR is set — cannot determine plugin directory"
  fi

  # Load .env so UM_VAULT_DIR etc. are available even if not already set in env.
  _um_load_env_file

  _PORT="$(_um_port)"
  _PLUGIN_DIR="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/universal-memory"
  _VAULT="${UM_VAULT_DIR:-$HOME/.um/vault}"

  echo ""
  echo "[verify] Running post-install checks..."
  echo ""

  # ── docker-up ──────────────────────────────────────────────────────────────
  # _vfail uses the base compose file only — read-only `ps` doesn't care
  # about the build override (image-mode detection is a build-time concern).
  _docker_ps_out=$(${_TIMEOUT_CMD:+$_TIMEOUT_CMD 10} docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || true)
  if echo "$_docker_ps_out" | grep -qiE 'memory-server.*(Up|running)'; then
    _vpass "docker-up" "containers are Up"
  else
    _vfail "docker-up" "memory-server container not Up. Run: $(_compose_hint 'up -d')"
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
  # v2 contract (#159): stop.sh reads hook-metadata JSON on stdin ({session_id,
  # transcript_path, cwd, ...}) and POSTs each new transcript message to
  # /api/append-turn — it no longer writes local vault captures. Smoke =
  # synthetic 1-message transcript + metadata JSON, run under an isolated
  # scratch HOME (cursor + hook.log stay out of the real ~/.um), endpoint
  # pinned to the same server the server-health check probed, real token file
  # honored. Pass = the hook's own log records a 2xx POST.
  _HOOK_SCRIPT="$REPO_ROOT/plugins/claude-code/universal-memory/hooks/stop.sh"
  _SMOKE_HOME=$(mktemp -d 2>/dev/null || echo "")

  # Same interpreter probe as the hooks' um_find_python: bare python3/python
  # on Windows are often Store app-execution-alias stubs; only a candidate
  # that actually runs counts.
  _VERIFY_PY=""
  for _c in py python3 python; do
    if command -v "$_c" >/dev/null 2>&1 && "$_c" -c '' >/dev/null 2>&1; then
      _VERIFY_PY="$_c"
      break
    fi
  done

  if [ ! -f "$_HOOK_SCRIPT" ]; then
    _vfail "hook-smoke" "stop.sh not found at $_HOOK_SCRIPT"
    _verify_fail=1
  elif [ -z "$_SMOKE_HOME" ] || [ -z "$_VERIFY_PY" ]; then
    _vfail "hook-smoke" "cannot stage smoke (mktemp or python missing)"
    _verify_fail=1
  else
    _SMOKE_TRANSCRIPT="$_SMOKE_HOME/transcript.jsonl"
    printf '%s\n' '{"type":"user","message":{"role":"user","content":"verify smoke transcript"},"timestamp":"2026-01-01T00:00:00Z"}' > "$_SMOKE_TRANSCRIPT"
    # Metadata built via json.dumps so the temp path survives spaces/backslashes.
    _SMOKE_META=$(UM_VERIFY_TRANSCRIPT="$_SMOKE_TRANSCRIPT" "$_VERIFY_PY" -c '
import json, os
print(json.dumps({
    "session_id": "install-verify",
    "transcript_path": os.environ["UM_VERIFY_TRANSCRIPT"],
    "cwd": "install-verify",
    "stop_hook_active": False,
}))' 2>/dev/null) || true
    _SMOKE_TOKEN_FILE="${UM_TOKEN_FILE:-$HOME/.um/auth-token}"
    printf '%s' "$_SMOKE_META" | \
      env HOME="$_SMOKE_HOME" UM_SERVER_URL="http://localhost:$_PORT" \
          UM_TOKEN_FILE="$_SMOKE_TOKEN_FILE" \
          ${_TIMEOUT_CMD:+$_TIMEOUT_CMD 60} bash "$_HOOK_SCRIPT" >/dev/null 2>&1 || true
    _SMOKE_LOG=$(cat "$_SMOKE_HOME/.um/hook.log" 2>/dev/null || true)
    if printf '%s' "$_SMOKE_LOG" | grep -q 'posted http=2'; then
      _vpass "hook-smoke" "stop.sh posted a smoke turn to /api/append-turn"
    elif printf '%s' "$_SMOKE_LOG" | grep -q 'skip=writes-disabled'; then
      # Stock defaults ship read-only — captures are this arc's whole point,
      # so verify fails, but with the flag-naming prescription (not "check
      # your token").
      _vfail "hook-smoke" "captures require UM_MCP_WRITE_ENABLED=true + UM_MOUNT_MODE=rw in server/.env (see docs/claude-code-plugin.md)"
      _verify_fail=1
    else
      _vfail "hook-smoke" "stop.sh did not post (hook.log: ${_SMOKE_LOG:-empty}). Check server/token."
      _verify_fail=1
    fi
  fi

  # ── session-end-dry-run ───────────────────────────────────────────────────
  # v2: session-end.sh reads metadata JSON and detaches a POST /api/checkpoint
  # (server-side LLM synthesis). Verify must NOT trigger a real checkpoint —
  # the dry-run feeds empty stdin, which the hook contract handles by logging
  # skip=empty-stdin and exiting 0 (parse, lib sourcing, and log plumbing all
  # exercised; nothing written server-side).
  _SESSION_END="$REPO_ROOT/plugins/claude-code/universal-memory/hooks/session-end.sh"
  if [ ! -f "$_SESSION_END" ]; then
    _vfail "session-end-dry-run" "session-end.sh not found at $_SESSION_END"
    _verify_fail=1
  elif [ -z "$_SMOKE_HOME" ]; then
    # No scratch HOME ⇒ fail outright — falling back to the real ~/.um/hook.log
    # could false-pass on a stale line (and would drop a stray line in it).
    _vfail "session-end-dry-run" "cannot stage dry-run (mktemp failed)"
    _verify_fail=1
  else
    if env HOME="$_SMOKE_HOME" ${_TIMEOUT_CMD:+$_TIMEOUT_CMD 30} bash "$_SESSION_END" </dev/null >/dev/null 2>&1 \
       && grep -q 'session-end skip=empty-stdin' "$_SMOKE_HOME/.um/hook.log" 2>/dev/null; then
      _vpass "session-end-dry-run" "exited 0, logged skip=empty-stdin (no checkpoint posted)"
    else
      _vfail "session-end-dry-run" "session-end.sh dry-run failed. Check env vars and logs."
      _verify_fail=1
    fi
  fi

  # ── cleanup ───────────────────────────────────────────────────────────────
  if [ -n "$_SMOKE_HOME" ]; then rm -rf "$_SMOKE_HOME" 2>/dev/null || true; fi
  # The POSTed smoke turn also lands server-side in the vault raw capture for
  # the install-verify project — remove it like the pre-#159 verify did. The
  # counters row + any already-indexed point are accepted best-effort residue.
  rm -rf "$_VAULT/captures/install-verify" 2>/dev/null || true
  _vpass "cleanup" "removed smoke scratch dir + vault captures/install-verify"

  # ── versions ──────────────────────────────────────────────────────────────
  # Three surfaces update through three different mechanisms — the server
  # container (install.sh --upgrade / compose pull), the `um` CLI (re-run
  # installer/install-cli.sh), and the Claude Code plugin (claude plugin
  # update). Nothing keeps them in step, and until now nothing reported the
  # drift either. Informational by default: an out-of-date CLI is a real
  # problem but not a reason to fail a server verify.
  echo ""
  _SERVER_VER=$(_um_server_version)
  _CLI_VER=$(_um_json_version "$HOME/.local/.claude-plugin/plugin.json")
  _PLUGIN_SRC_VER=$(_um_json_version "$REPO_ROOT/plugins/claude-code/universal-memory/.claude-plugin/plugin.json")
  _PLUGIN_INST_VER=$(_um_json_version "$_PLUGIN_DIR/.claude-plugin/plugin.json")

  _vinfo "version-server"      "${_SERVER_VER:-unknown (is the container running?)}"
  _vinfo "version-cli"         "${_CLI_VER:-not installed}${_CLI_VER:+   (um --version)}"
  _vinfo "version-plugin"      "${_PLUGIN_INST_VER:-not installed}${_PLUGIN_INST_VER:+   (installed)}"
  _vinfo "version-source-tree" "${_PLUGIN_SRC_VER:-unknown}"

  # Skew 1: the client half is NEWER than the server. This is the shape that
  # produces silent capture death — the plugin's routes 404 against a server
  # that predates them, which surfaces only as skip=server-too-old in
  # ~/.um/hook.log and a session-start banner.
  if [ -n "$_SERVER_VER" ]; then
    if [ -n "$_PLUGIN_INST_VER" ] && _um_ver_lt "$_SERVER_VER" "$_PLUGIN_INST_VER"; then
      _vwarn "version-skew" "plugin $_PLUGIN_INST_VER is NEWER than server $_SERVER_VER — upgrade the server first: bash server/install.sh --upgrade"
    fi
    # Skew 2: the server predates the API-always capture contract. The plugin
    # genuinely cannot capture against it, so this one fails the verify.
    if [ -n "$_PLUGIN_INST_VER" ] && _um_ver_lt "$_SERVER_VER" "1.7.0"; then
      _vfail "version-floor" "server $_SERVER_VER predates the /api capture contract (needs >= 1.7.0). The plugin cannot capture against it."
      _verify_fail=1
    fi
  fi

  # Skew 3: the CLI is behind the source tree it was installed from. This is
  # the case that hid for a full release cycle: the server was current, the
  # CLI was not, and the newer release's scripts simply were not on disk.
  if [ -n "$_CLI_VER" ] && [ -n "$_PLUGIN_SRC_VER" ] && _um_ver_lt "$_CLI_VER" "$_PLUGIN_SRC_VER"; then
    _vwarn "version-skew" "um CLI $_CLI_VER is BEHIND this source tree ($_PLUGIN_SRC_VER) — scripts added since $_CLI_VER are missing. Refresh: bash installer/install-cli.sh --no-path"
  fi

  echo ""
  if [ "$_verify_fail" -eq 0 ]; then
    echo "All checks passed. Restart Claude Code to activate hooks."
    exit 0
  else
    echo "One or more checks failed. See diagnostics above." >&2
    exit 1
  fi
fi

# ─── --upgrade mode ──────────────────────────────────────────────────────────
# Upgrade a running install, with a net. The v1.8.0 incident is the design
# brief: a published arm64 image whose node_modules/mem0ai had been emptied by
# a partial `npm prune` was pulled, swapped into the running stack, and
# crash-looped in production. Recovery took a hand-written rollback script,
# which itself had a bug — it rebuilt the container's `-p` port bindings from
# `docker inspect` of a container already in `Restarting` state, which reports
# none, so the server came back UNREACHABLE. Both bugs are fixed elsewhere; the
# lesson that the upgrade procedure belongs in the product is fixed here.
#
# The ORDER is the whole feature:
#   record → pull → PRE-FLIGHT → swap → health-verify → auto-rollback
#
#   • Pre-flight runs the NEW image in a throwaway container while the OLD one
#     is still serving, so a broken image is caught before it can cause an
#     outage rather than after.
#   • Every container operation goes through `_compose` — compose owns ports,
#     mounts, network and env. Hand-rolling `docker run` is precisely what
#     turned the incident's recovery into a second outage.
if [ "${1:-}" = "--upgrade" ]; then
	_uinfo() { printf '\033[1;34m[upgrade]\033[0m %s\n' "$*"; }
	_uok()   { printf '\033[1;32m[upgrade]\033[0m %s\n' "$*"; }
	_uwarn() { printf '\033[1;33m[upgrade]\033[0m %s\n' "$*"; }
	_ufail() { printf '\033[1;31m[upgrade]\033[0m %s\n' "$*" >&2; exit 1; }

	# ── Argument contract ─────────────────────────────────────────────────────
	# Sole-argument mode, optionally carrying a version: `--upgrade` or
	# `--upgrade 1.8.1`. Anything else is rejected rather than silently
	# ignored — same precedent as --verify.
	_UPG_VERSION="${2:-}"
	[ "$#" -le 2 ] || _ufail "--upgrade takes at most one argument (a version). Got: $*"
	case "$_UPG_VERSION" in
		-*) _ufail "--upgrade must be the sole argument; do not combine with $_UPG_VERSION." ;;
	esac
	if [ -n "$_UPG_VERSION" ] && ! [[ "$_UPG_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
		_ufail "Invalid version '$_UPG_VERSION'. Expected a published image tag, e.g. 1.8.1 or latest."
	fi
	# Operators reach for the git tag (v1.8.1); GHCR publishes bare semver
	# (1.8.1). Translate rather than let the registry answer "manifest unknown".
	if [[ "$_UPG_VERSION" =~ ^v[0-9] ]]; then
		_UPG_VERSION="${_UPG_VERSION#v}"
		_uinfo "Reading that as version '$_UPG_VERSION' (published tags are bare semver)."
	fi

	_um_load_env_file
	# Provisional; step 1 replaces it with what compose reports for the
	# actually-running container (a host override can republish the port).
	_UPG_HEALTH="http://localhost:$(_um_port)/health"
	# Test seam (same convention as _UM_REPO_ROOT): number of 2s health-poll
	# attempts. Not an operator knob — the default is the contract. 90 × 2s
	# matches the install path's 180s ceiling, which exists because a cold
	# start on slow hardware (ARM Pi, constrained CI) can exceed 90s. A
	# crash-loop is detected by container STATE, not by this clock, so a
	# generous ceiling costs nothing on the failure path.
	_UPG_POLL_ATTEMPTS="${_UM_UPGRADE_POLL_ATTEMPTS:-90}"
	# Protective tag for the rollback image (BLOCKER-1). See step 1.
	_UPG_ROLLBACK_TAG_NAME="um-rollback:previous"

	# UM_IMAGE beats UM_VERSION in docker-compose.yml's `image:` line, so a
	# pinned UM_IMAGE would silently ignore the version that was asked for.
	# Upgrading to something other than what the operator typed is the exact
	# class of surprise this mode exists to prevent.
	if [ -n "$_UPG_VERSION" ] && [ -n "${UM_IMAGE:-}" ]; then
		_ufail "UM_IMAGE is set ($UM_IMAGE) and takes precedence over the version you asked for ($_UPG_VERSION).
  Unset UM_IMAGE (or edit it in $ENV_FILE) and re-run, or point UM_IMAGE at the image you want."
	fi
	[ -n "$_UPG_VERSION" ] && export UM_VERSION="$_UPG_VERSION"

	command -v docker >/dev/null 2>&1 || _ufail "Docker not found. Install Docker Engine first: https://docs.docker.com/engine/install/"
	docker compose version >/dev/null 2>&1 || _ufail "Docker Compose v2 not found. Update Docker Desktop or install the compose plugin."
	docker info >/dev/null 2>&1 || _ufail "Docker daemon not reachable. Start Docker Desktop (or the docker service) and re-run."
	[ -f "$COMPOSE_FILE" ] || _ufail "Not finding $COMPOSE_FILE — run this from the repo's server/ directory or via ./install.sh."

	# Bounded health poll, $1 = number of attempts 2s apart. No sleep after the
	# last attempt. Exit: 0 healthy, 1 exhausted, 2 crash-looping.
	#
	# It watches container STATE as well as the clock, because the two failure
	# modes want opposite treatment and a timer alone cannot tell them apart:
	#   • Repeatedly dying ⇒ waiting out the ceiling changes nothing. Say so
	#     and roll back now.
	#   • Running but not answering ⇒ possibly just a slow boot on slow
	#     hardware. Keep waiting; a clock-only check would call this a failure
	#     and trigger a needless rollback of a perfectly good upgrade.
	#
	# The signal is RestartCount, not the instantaneous Restarting flag, and it
	# tolerates the first two deaths. `depends_on` does not wait for readiness,
	# so a memory-server that starts before qdrant is accepting connections can
	# legitimately die once and come up fine on the retry — treating that first
	# exit as a crash-loop would roll back an upgrade that was about to
	# succeed. `up -d` recreates the container, so the count starts at 0 here.
	# Docker's restart backoff is short early on, so a genuine crash-loop still
	# trips this within seconds.
	_upg_poll_health() {
		local _attempts="$1" _i _cid _restarts
		for _i in $(seq 1 "$_attempts"); do
			if curl -sf --max-time 3 "$_UPG_HEALTH" >/dev/null 2>&1; then
				return 0
			fi
			_cid=$(_compose ps -q memory-server 2>/dev/null | head -1 || true)
			if [ -n "$_cid" ]; then
				_restarts=$(docker inspect -f '{{.RestartCount}}' "$_cid" 2>/dev/null || true)
				if [[ "$_restarts" =~ ^[0-9]+$ ]] && [ "$_restarts" -ge 3 ]; then
					return 2
				fi
			fi
			if [ "$_i" -lt "$_attempts" ]; then sleep 2; fi
		done
		return 1
	}

	echo ""
	echo "[upgrade] Upgrading the universal-memory server."

	# ── Step 1/5: record the rollback target ─────────────────────────────────
	echo ""
	echo "[upgrade] Step 1/5 — recording the running image (rollback target)..."
	_UPG_CID=$(_compose ps -q memory-server 2>/dev/null | head -1 || true)
	if [ -z "$_UPG_CID" ]; then
		_ufail "No running memory-server container found — nothing to upgrade, and no image to roll back to.
  If the stack is stopped:  $(_compose_hint 'up -d')
  If this is a new install: bash server/install.sh"
	fi
	# Record the image ID (sha256), NOT .Config.Image (the tag). On the common
	# latest→latest upgrade the tag is byte-identical before and after the
	# pull, so "roll back to the tag" would restore the very image being rolled
	# back FROM. The ID pins the exact bits now serving.
	_UPG_ROLLBACK_ID=$(docker inspect -f '{{.Image}}' "$_UPG_CID" 2>/dev/null || true)
	_UPG_ROLLBACK_TAG=$(docker inspect -f '{{.Config.Image}}' "$_UPG_CID" 2>/dev/null || true)
	if [ -z "$_UPG_ROLLBACK_ID" ]; then
		_ufail "Could not determine the image behind container $_UPG_CID — refusing to upgrade with no rollback target.
  Check: docker inspect $_UPG_CID"
	fi

	# ...but an ID alone is not a durable handle. On the containerd image store
	# (the default since Docker Engine 29) `docker build -t <tag>` DELETES the
	# image the tag used to point at — even while a container is running from
	# it. Under UM_BUILD_LOCAL, step 2 rebuilds exactly the tag this container
	# came from, so by rollback time the recorded ID would no longer exist and
	# `UM_IMAGE=sha256:<id>` would be read as repo "sha256" / tag "<id>",
	# sending compose to a registry for an image that was never pushed.
	# A tag of our own is a reference that keeps the image alive, and it makes
	# the recovery commands printed below durable and readable.
	_UPG_ROLLBACK_REF="$_UPG_ROLLBACK_ID"
	if docker tag "$_UPG_ROLLBACK_ID" "$_UPG_ROLLBACK_TAG_NAME" >/dev/null 2>&1; then
		_UPG_ROLLBACK_REF="$_UPG_ROLLBACK_TAG_NAME"
	else
		_uwarn "Could not tag the running image as $_UPG_ROLLBACK_TAG_NAME — rolling back by ID instead."
		_uwarn "  If step 2 rebuilds this tag locally, that ID may not survive; consider upgrading with the stack stopped."
	fi
	_uok "Rollback target: ${_UPG_ROLLBACK_TAG:-<untagged>} ($_UPG_ROLLBACK_ID)"
	[ "$_UPG_ROLLBACK_REF" = "$_UPG_ROLLBACK_TAG_NAME" ] && _uinfo "Pinned as $_UPG_ROLLBACK_TAG_NAME so a local rebuild cannot destroy it."

	# Ask compose where the running service is actually published. A host
	# override file can REPLACE the `ports:` list (`!override`), which config
	# alone cannot be assumed to reflect at every call site — and a health URL
	# pointing at an unbound port fails every poll, which this script would
	# otherwise report as "the server is DOWN" and roll back a healthy upgrade.
	# The container listens on 6335 by contract (compose `environment:` pin).
	_UPG_PORT_OUT=$(_compose port memory-server 6335 2>/dev/null | head -1 || true)
	_UPG_PORT="${_UPG_PORT_OUT##*:}"
	if [[ "$_UPG_PORT" =~ ^[0-9]+$ ]]; then
		# Connect over loopback regardless of the reported bind address: a
		# 0.0.0.0 binding is reachable there, and 0.0.0.0 is not a valid
		# destination on every platform.
		_UPG_HEALTH="http://localhost:$_UPG_PORT/health"
	else
		_uwarn "compose could not report a published port; falling back to MEM0_MCP_PORT."
	fi
	_uinfo "Health endpoint: $_UPG_HEALTH"

	# Ctrl-C after the swap has started but before the verdict leaves the stack
	# on an unverified image with no rollback having run. Exiting silently
	# there is the one path that can strand an operator without instructions.
	_UPG_SWAPPED=0
	# shellcheck disable=SC2329  # invoked indirectly by the trap below
	_upg_on_interrupt() {
		echo "" >&2
		if [ "${_UPG_SWAPPED:-0}" = "1" ]; then
			printf '\033[1;31m[upgrade]\033[0m %s\n' "Interrupted AFTER the swap started — the stack may be running the new, unverified image." >&2
			printf '\033[1;31m[upgrade]\033[0m %s\n' "  Roll back:  cd $SCRIPT_DIR && UM_IMAGE=$_UPG_ROLLBACK_REF docker compose up -d" >&2
			printf '\033[1;31m[upgrade]\033[0m %s\n' "  Or verify:  curl $_UPG_HEALTH" >&2
		else
			printf '\033[1;32m[upgrade]\033[0m %s\n' "Interrupted before the swap — your running server is untouched." >&2
		fi
		_um_cleanup
		exit 130
	}
	trap _upg_on_interrupt INT TERM

	# ── Step 2/5: resolve + fetch the target image ───────────────────────────
	echo ""
	echo "[upgrade] Step 2/5 — resolving and fetching the target image..."
	# Resolve the target from compose's OWN normalized config, so a customized
	# compose file — or the UM_BUILD_LOCAL override stack — is honored.
	# Pre-flighting a different image than the one compose goes on to deploy
	# would defeat the entire point of pre-flighting.
	#
	# Deliberately NOT `config --images memory-server`: that also emits the
	# images of everything the service `depends_on` (qdrant), in unspecified
	# order, so taking the first line can hand back qdrant's image instead.
	# Match the service by NAME and take its `image:` key.
	_UPG_IMAGE=$(_compose config 2>/dev/null | awk '
		/^  memory-server:/ { f = 1; next }
		/^  [a-zA-Z]/       { f = 0 }
		f && /^    image:/  { gsub(/^"|"$/, "", $2); print $2; exit }
	' || true)
	if [ -z "$_UPG_IMAGE" ]; then
		# Fallback: mirror the default in docker-compose.yml's memory-server
		# `image:` line. Pinned against drift by install.test.sh (T26).
		_UPG_IMAGE="${UM_IMAGE:-ghcr.io/goldenwo/universal-memory-server:${UM_VERSION:-latest}}"
	fi
	_uinfo "Target image: $_UPG_IMAGE"
	if [ "${UM_BUILD_LOCAL:-0}" = "1" ]; then
		_uinfo "UM_BUILD_LOCAL=1 — building from local source instead of pulling."
		_compose build memory-server 2>&1 | sed 's/^/[compose] /' \
			|| _ufail "Build failed. The running server was NOT touched and is still serving."
	else
		_compose pull memory-server 2>&1 | sed 's/^/[compose] /' \
			|| _ufail "Pull failed. The running server was NOT touched and is still serving.
  Confirm the tag exists: $_UPG_IMAGE"
	fi

	# ── Step 3/5: PRE-FLIGHT (the load-bearing step) ─────────────────────────
	echo ""
	echo "[upgrade] Step 3/5 — pre-flighting the new image (running server still up)..."
	# Import the two things whose absence produced the v1.8.0 crash-loop:
	# mem0ai/oss (the dependency the partial prune deleted) and the server's own
	# lib/stats.mjs, which transitively pulls in logger + obs-fallback +
	# capture-events, so a broader slice of the app is proven loadable than a
	# single dependency probe would. Throwaway container: --rm, no ports, no
	# volumes, no env — it cannot reach the running stack or the vault.
	_UPG_PREFLIGHT_RC=0
	_UPG_PREFLIGHT_OUT=$(${_TIMEOUT_CMD:+$_TIMEOUT_CMD 120} docker run --rm --entrypoint node "$_UPG_IMAGE" \
		--input-type=module -e "await import('mem0ai/oss'); await import('./lib/stats.mjs');" 2>&1) || _UPG_PREFLIGHT_RC=$?
	if [ "$_UPG_PREFLIGHT_RC" -ne 0 ]; then
		printf '%s\n' "$_UPG_PREFLIGHT_OUT" | sed 's/^/[preflight] /' >&2
		_ufail "Pre-flight FAILED (exit $_UPG_PREFLIGHT_RC) — $_UPG_IMAGE cannot load its own dependencies.

  NOTHING WAS SWAPPED. Your running server is untouched and still serving.

  Do not deploy this tag. Upgrade to a known-good version instead:
    bash server/install.sh --upgrade <version>
  If this tag is a fresh release, its image build is broken — please report it."
	fi
	_uok "Pre-flight passed — the new image loads mem0ai/oss and lib/stats.mjs."

	# ── Step 4/5: swap ───────────────────────────────────────────────────────
	echo ""
	echo "[upgrade] Step 4/5 — swapping the container (compose owns ports/mounts/network)..."
	_UPG_SWAPPED=1
	_UPG_SWAP_RC=0
	_compose up -d 2>&1 | sed 's/^/[compose] /' || _UPG_SWAP_RC=$?

	# ── Step 5/5: health-verify, else auto-rollback ──────────────────────────
	echo ""
	echo "[upgrade] Step 5/5 — waiting for $_UPG_HEALTH (up to $((_UPG_POLL_ATTEMPTS * 2))s)..."
	_UPG_HEALTHY=0
	_UPG_WHY=""
	if [ "$_UPG_SWAP_RC" -ne 0 ]; then
		_UPG_WHY="compose up -d failed (exit $_UPG_SWAP_RC)."
	else
		_UPG_POLL_RC=0
		_upg_poll_health "$_UPG_POLL_ATTEMPTS" || _UPG_POLL_RC=$?
		case "$_UPG_POLL_RC" in
			0)
				# A 200 on the port only proves SOMETHING is listening there —
				# a stale container from a half-finished migration answers just
				# as well, and would let a failed swap report success. Confirm
				# the container compose is running is built from the image we
				# actually pre-flighted.
				_UPG_NEW_CID=$(_compose ps -q memory-server 2>/dev/null | head -1 || true)
				_UPG_RUNNING_ID=$(docker inspect -f '{{.Image}}' "$_UPG_NEW_CID" 2>/dev/null || true)
				_UPG_TARGET_ID=$(docker image inspect -f '{{.Id}}' "$_UPG_IMAGE" 2>/dev/null || true)
				if [ -z "$_UPG_TARGET_ID" ] || [ -z "$_UPG_RUNNING_ID" ]; then
					_uwarn "Could not confirm which image is serving; treating health as authoritative."
					_UPG_HEALTHY=1
				elif [ "$_UPG_RUNNING_ID" = "$_UPG_TARGET_ID" ]; then
					_UPG_HEALTHY=1
				else
					_UPG_WHY="$_UPG_HEALTH answered, but the running container is $_UPG_RUNNING_ID, not the upgraded image ($_UPG_TARGET_ID) — the swap did not take."
				fi
				;;
			2)  _UPG_WHY="The new container is CRASH-LOOPING (docker reports it restarting). Not waiting out the clock." ;;
			*)  _UPG_WHY="The new container never reported healthy at $_UPG_HEALTH within $((_UPG_POLL_ATTEMPTS * 2))s." ;;
		esac
	fi

	if [ "$_UPG_HEALTHY" != "1" ]; then
		_uwarn "$_UPG_WHY"
		echo ""
		echo "[upgrade] --- memory-server logs (last 50 lines) ---"
		_compose logs --tail 50 memory-server 2>&1 | sed 's/^/[logs] /' || true
		echo ""
		echo "[upgrade] AUTO-ROLLBACK — restoring the image that was running..."
		_uwarn "Restoring ${_UPG_ROLLBACK_TAG:-previous image} as $_UPG_ROLLBACK_REF"
		# Shell env beats .env for compose interpolation, so exporting UM_IMAGE
		# overrides the `image:` line for this recreate. Exported (not an
		# inline VAR=x prefix) because assignment-prefixes on shell FUNCTIONS
		# have shell/mode-dependent persistence — not something a rollback path
		# should be betting on.
		export UM_IMAGE="$_UPG_ROLLBACK_REF"
		_UPG_RB_RC=0
		_compose up -d 2>&1 | sed 's/^/[compose] /' || _UPG_RB_RC=$?
		_UPG_RB_POLL_RC=0
		if [ "$_UPG_RB_RC" -eq 0 ]; then
			_upg_poll_health "$_UPG_POLL_ATTEMPTS" || _UPG_RB_POLL_RC=$?
		else
			_UPG_RB_POLL_RC=1
		fi
		if [ "$_UPG_RB_POLL_RC" -eq 0 ]; then
			echo ""
			_uok "ROLLBACK SUCCEEDED — ${_UPG_ROLLBACK_TAG:-the previous image} is running and healthy at $_UPG_HEALTH."
			_uwarn "The upgrade to $_UPG_IMAGE did NOT take. Check the logs above before retrying."
			# The rollback is only in effect for THIS container. .env still
			# resolves to the version that just failed, and on a moving tag the
			# bad image is still what `latest` points at locally — so the next
			# plain `up -d` would quietly re-apply it.
			_uwarn "Rollback is NOT durable yet. To keep it across the next '$(_compose_hint 'up -d')':"
			_uwarn "  add UM_IMAGE=$_UPG_ROLLBACK_REF (or a known-good UM_VERSION) to $ENV_FILE"
			exit 1
		fi
		echo ""
		_ufail "ROLLBACK FAILED — the server is DOWN and needs a hand.
  Recover manually:
    cd $SCRIPT_DIR && UM_IMAGE=$_UPG_ROLLBACK_REF docker compose up -d
    curl $_UPG_HEALTH
  Then check: $(_compose_hint 'logs memory-server')"
	fi

	# ── Post-success: refresh the um CLI ─────────────────────────────────────
	# The `um` CLI (um-alert, um-search, um-state, ...) is a COPY of this repo's
	# scripts under ~/.local/share/um. It has no self-update path, so it stays
	# at whatever version was installed until someone re-runs the installer by
	# hand. That is how a host came to run a current server with a CLI a full
	# release behind — and why that release's capture-freshness cron could not
	# be installed: um-alert.sh did not exist in that tree, with nothing
	# anywhere reporting the gap.
	#
	# --upgrade already has the source tree and has just verified the server, so
	# it is the one moment where refreshing the CLI is both safe and obvious.
	# STRICTLY best-effort: the server upgrade has ALREADY SUCCEEDED here, and
	# nothing below may fail it, roll it back, or change its exit code.
	_UPG_CLI_DIR="${UM_CLI_DIR:-$HOME/.local/share/um/cli}"
	_UPG_CLI_INSTALLER="$REPO_ROOT/installer/install-cli.sh"
	if [ -d "$_UPG_CLI_DIR" ]; then
		echo ""
		echo "[upgrade] Refreshing the um CLI so it matches the server..."
		if [ ! -f "$_UPG_CLI_INSTALLER" ]; then
			# Tarball or partial tree: the CLI is installed but its installer is
			# not here to re-run. Say so loudly — a silently stale CLI is the
			# exact failure this step exists to end.
			_uwarn "CLI is installed at $_UPG_CLI_DIR, but $_UPG_CLI_INSTALLER is missing."
			_uwarn "  Your CLI is now OLDER than your server. From a full source tree, run:"
			_uwarn "    bash installer/install-cli.sh --no-path"
		# --no-path is load-bearing. install-cli.sh rewrites the shell rc marker
		# block from the CURRENT environment, and --upgrade never collects an
		# API key — so refreshing without it would blank UM_OPENAI_API_KEY in
		# the operator's profile. An upgrade must not touch shell profiles.
		elif bash "$_UPG_CLI_INSTALLER" --yes --no-path 2>&1 | sed 's/^/[cli] /'; then
			_UPG_CLI_VER=$(_um_json_version "$HOME/.local/.claude-plugin/plugin.json")
			_uok "um CLI refreshed${_UPG_CLI_VER:+ to $_UPG_CLI_VER}."
		else
			_uwarn "CLI refresh FAILED. The server upgrade is fine and still healthy — only the CLI is stale."
			_uwarn "  Re-run it yourself:  bash $_UPG_CLI_INSTALLER --no-path"
		fi
	fi

	# ── Success ──────────────────────────────────────────────────────────────
	_UPG_HEALTH_BODY=$(curl -sf --max-time 5 "$_UPG_HEALTH" 2>/dev/null || true)
	echo ""
	# Quoted delimiter + printf for the dynamic lines: the health body is a
	# server-controlled string, and an unquoted heredoc would run any `$(...)`
	# or backticks inside it as shell.
	cat <<'EOF'
╔═════════════════════════════════════════════════════════════════════╗
EOF
	printf '║ Upgrade complete — server healthy at %s\n' "$_UPG_HEALTH"
	printf '║\n'
	printf '║   now:    %s\n' "$_UPG_IMAGE"
	printf '║   was:    %s (%s)\n' "${_UPG_ROLLBACK_TAG:-<untagged>}" "$_UPG_ROLLBACK_ID"
	printf '║   health: %s\n' "${_UPG_HEALTH_BODY:-<no body>}"
	cat <<'EOF'
║
║ What changed: CHANGELOG.md (release notes)
║               MIGRATION.md (per-version upgrade steps)
║
║ The server is only one of three surfaces. If you use the Claude Code
║ plugin, update it too:  claude plugin update universal-memory
║ Full order + failure signatures: docs/upgrading.md
║
EOF
	printf '║ To revert to the previous image:\n'
	printf '║   cd %s && UM_IMAGE=%s docker compose up -d\n' "$SCRIPT_DIR" "$_UPG_ROLLBACK_REF"
	cat <<'EOF'
╚═════════════════════════════════════════════════════════════════════╝
EOF
	if [ -n "$_UPG_VERSION" ]; then
		echo ""
		info "This version was pinned for this run only. To make it stick across"
		info "a plain '$(_compose_hint 'up -d')', add UM_VERSION=$_UPG_VERSION to $ENV_FILE."
	fi
	exit 0
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
		--upgrade)
			# Same as --verify: handled above as a sole-argument early-exit
			# mode, so reaching here means it was passed after another flag.
			fail "--upgrade must be the sole argument; do not combine with --yes."
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
# shellcheck source=../installer/lib/marker-block.sh
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
	if [ "${UM_BUILD_LOCAL:-0}" = "1" ]; then
		info "Building images from local source (UM_BUILD_LOCAL=1)..."
	else
		info "Pulling images from GHCR (set UM_BUILD_LOCAL=1 to build from source)..."
	fi
	_compose up -d 2>&1 | sed 's/^/[compose] /'

	# ─── Poll /health until ready ─────────────────────────────────────────────────
	# Cold-build on slow hardware (ARM Pi, constrained CI runners) can easily
	# take >90s end-to-end before the server binds. Allow 180s to cover that.
	# _um_port(), not raw $MEM0_MCP_PORT: the variable is the HOST side of the
	# compose mapping and may carry a full binding (127.0.0.1:6337).
	ENDPOINT="http://localhost:$(_um_port)/health"
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
		warn "Check logs with: $(_compose_hint 'logs memory-server')"
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

# ─── v1.1 fresh-install hint: /adr skill ────────────────────────────────────
# Only on fresh installs (no prior .env). Quiet under UM_QUIET=1. Skipped on
# upgrades to avoid noise — existing operators learn about /adr via CHANGELOG.
if [ "${UM_WAS_EXISTING_INSTALL:-0}" = "0" ] && [ -z "${UM_QUIET:-}" ]; then
	cat <<'EOM'

[install] New in v1.1: the `/adr` Claude Code skill
  • From any session: /adr "<title>"   → writes docs/decisions/NNNN-<slug>.md,
                                          commits, and registers atomically
                                          with the universal-memory server.
  • /adr sync NNNN   → re-register an existing ADR (recovery for net failures)
  • /adr --help      → flags + usage
  • Install path: ~/.claude/skills/create-adr/ (manual copy from the plugin)
EOM
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
║ universal-memory server is running at http://localhost:$(_um_port)
║
║ Next steps:
║   1. Verify the install:    bash server/install.sh --verify
║   2. Restart Claude Code to load the plugin and activate hooks.
║   3. Upgrade later:         bash server/install.sh --upgrade
║   4. Stop the stack:        cd $SCRIPT_DIR && docker compose down
║   5. Restart later:         cd $SCRIPT_DIR && docker compose up -d
║
║ Data persists at: server/data/qdrant/
║ Edit configuration: server/.env
║
║ Shell:
║   $_profile_hint
╚═════════════════════════════════════════════════════════════════════╝
EOF
