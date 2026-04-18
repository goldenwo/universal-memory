#!/usr/bin/env bash
# install.sh — universal-memory server interactive installer.
# Usage: ./install.sh          (interactive)
#        UM_NONINTERACTIVE=1 ./install.sh  (read all values from env, no prompts)
#
# Exits non-zero on any error. Prints what it does. Never installs Docker
# for you — if Docker is missing it points at the upstream install docs
# and exits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

info()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Prereq checks ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "Docker not found. Install Docker Engine first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 not found. Update Docker Desktop or install the compose plugin."
docker info >/dev/null 2>&1 || fail "Docker daemon not reachable. Start Docker Desktop (or the docker service) and re-run."

[ -f "$ENV_EXAMPLE" ] || fail "Not finding $ENV_EXAMPLE — are you running this from the repo's server/ directory or via ./install.sh?"
[ -f "$COMPOSE_FILE" ] || fail "Not finding $COMPOSE_FILE."

ok "Docker is running and server files are present."

# ─── pyyaml availability ─────────────────────────────────────────────────
# Shell hooks (Phase C) use python3 + pyyaml to parse session frontmatter.
# Flag missing pyyaml now so users don't hit cryptic errors at hook time.
python3 -c 'import yaml' 2>/dev/null || {
	fail "pyyaml is not available. Install it with: pip install pyyaml"
}
ok "pyyaml is available."

# ─── Collect required values ─────────────────────────────────────────────
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
	: "${OPENAI_API_KEY:?UM_NONINTERACTIVE=1 but OPENAI_API_KEY is not set}"
	: "${MEM0_USER_ID:?UM_NONINTERACTIVE=1 but MEM0_USER_ID is not set}"
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
[[ "$MEM0_USER_ID" =~ [[:space:]] ]] && fail "MEM0_USER_ID contains whitespace — refusing to write to .env."
[[ "$UM_VAULT_DIR" =~ [[:space:]] ]] && fail "UM_VAULT_DIR contains whitespace — refusing to write to .env."
[[ "$UM_SUMMARY_ENABLED" =~ ^(true|false)$ ]] || fail "UM_SUMMARY_ENABLED must be 'true' or 'false'. Got: $UM_SUMMARY_ENABLED"
[[ "$UM_TEMPORAL_DECAY" =~ ^(true|false)$ ]] || fail "UM_TEMPORAL_DECAY must be 'true' or 'false'. Got: $UM_TEMPORAL_DECAY"

# Create vault directory (idempotent)
mkdir -p "$UM_VAULT_DIR" || fail "Could not create vault directory: $UM_VAULT_DIR"
ok "Vault directory ready: $UM_VAULT_DIR"

info "Collected: user=$MEM0_USER_ID port=$MEM0_MCP_PORT  (API key hidden)"

# ─── Write .env ──────────────────────────────────────────────────────────
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

# ─── Start stack ─────────────────────────────────────────────────────────
info "Pulling / building images..."
docker compose -f "$COMPOSE_FILE" up -d 2>&1 | sed 's/^/[compose] /'

# ─── Poll /health until ready ────────────────────────────────────────────
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

# ─── Success banner ──────────────────────────────────────────────────────
cat <<EOF

╔═════════════════════════════════════════════════════════════════════╗
║ universal-memory server is running at http://localhost:$MEM0_MCP_PORT
║
║ Next steps:
║   1. Verify with the smoke test:   bash test/smoke.sh
║   2. Install the Claude Code plugin and point it at this endpoint:
║        endpoint: http://localhost:$MEM0_MCP_PORT
║        userId:   $MEM0_USER_ID
║   3. Stop the stack:               docker compose down
║   4. Restart later:                docker compose up -d
║
║ Data persists at: server/data/qdrant/
║ Edit configuration: server/.env
║
║ IMPORTANT — shell profile:
║   The UM_OPENAI_API_KEY value written to .env is only loaded by
║   docker-compose. Hooks that run outside the container (Phase C)
║   inherit env from the shell that spawned Claude Code, not from .env.
║   To make hooks work, add this line to ~/.bashrc or ~/.zshrc
║   (or set it as a Windows environment variable):
║
║     export UM_OPENAI_API_KEY="<your-key>"
║
╚═════════════════════════════════════════════════════════════════════╝
EOF
