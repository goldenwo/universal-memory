#!/usr/bin/env bash
# wizard-lib.sh — interactive helpers sourced by install.sh wizard mode

wizard_header() {
  # ASCII-safe fallback when terminal doesn't handle box-drawing cleanly
  # (Windows cmd.exe / PowerShell without `chcp 65001`; some CI log viewers).
  # Detect by checking if LC_ALL or LANG mentions UTF-8, else fall back to ASCII.
  if [[ "${LC_ALL:-}${LANG:-}" == *UTF-8* || "${LC_ALL:-}${LANG:-}" == *utf8* ]]; then
    cat <<'EOF'
╔════════════════════════════════════════════╗
║  universal-memory v0.5.0 installer         ║
╚════════════════════════════════════════════╝
EOF
  else
    cat <<'EOF'
+--------------------------------------------+
|  universal-memory v0.5.0 installer         |
+--------------------------------------------+
EOF
  fi
}

wizard_detect_env() {
  # Print detected state: Docker, ~/.claude, ~/.codex, bash, python3, pyyaml
  # Returns via globals: DETECTED_DOCKER, DETECTED_CC, DETECTED_CODEX, etc.
  DETECTED_DOCKER=$(command -v docker >/dev/null 2>&1 && echo 1 || echo 0)
  DETECTED_CC=$([[ -d "$HOME/.claude" ]] && echo 1 || echo 0)
  DETECTED_CODEX=$([[ -d "$HOME/.codex" ]] && echo 1 || echo 0)
  DETECTED_PYTHON3=$(command -v python3 >/dev/null 2>&1 && echo 1 || echo 0)
  DETECTED_PYYAML=$(python3 -c 'import yaml' 2>/dev/null && echo 1 || echo 0)
  DETECTED_BASH_VERSION=$(bash --version | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)

  echo "Detected environment:"
  [[ $DETECTED_DOCKER -eq 1 ]] && echo "  ✓ Docker" || echo "  ✗ Docker not found"
  [[ $DETECTED_CC -eq 1 ]] && echo "  ✓ ~/.claude (Claude Code)" || echo "  ✗ ~/.claude (Claude Code not found)"
  [[ $DETECTED_CODEX -eq 1 ]] && echo "  ✓ ~/.codex (Codex)" || echo "  ✗ ~/.codex (Codex not found — will skip)"
  echo "  bash $DETECTED_BASH_VERSION"
}

wizard_menu_main() {
  # Presents 5-item menu; returns choice via global WIZARD_CHOICE (1-5)
  # Uses numeric-only input (no select w/ arrow keys — Windows Git Bash compat)
  while true; do
    echo ""
    echo "What would you like to install?"
    echo "  1) Everything detected (recommended for first-time)"
    echo "  2) Just Claude Code plugin"
    echo "  3) Just the standalone \`um\` CLI (point at remote server)"
    echo "  4) Just the server (headless / VPS)"
    echo "  5) Custom — I'll pick components"
    read -r -p "Choose [1-5]: " WIZARD_CHOICE
    [[ "$WIZARD_CHOICE" =~ ^[1-5]$ ]] && break
    echo "Invalid choice; enter a number 1-5."
  done
}

wizard_prompt() {
  # wizard_prompt <var> <question> <default>
  local var="$1" question="$2" default="$3"
  read -r -p "$question [${default:-skip}]: " val
  val="${val:-$default}"
  # Trim leading/trailing whitespace
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  eval "$var=\"\$val\""
}

wizard_validate_openai_key() {
  # wizard_validate_openai_key <var> <question> <default>
  # Like wizard_prompt but re-prompts if value doesn't start with sk- (unless it's the defer placeholder).
  local var="$1" question="$2" default="$3"
  local _defer_placeholder="<paste later into .env>"
  while true; do
    wizard_prompt "$var" "$question" "$default"
    local _val
    eval "_val=\"\${$var}\""
    # Accept the defer placeholder or any sk- prefixed value
    if [ "$_val" = "$_defer_placeholder" ] || [[ "$_val" == sk-* ]]; then
      break
    fi
    # Non-empty value that doesn't start with sk- — warn and re-prompt
    if [ -n "$_val" ]; then
      echo "Warning: OpenAI API keys should start with 'sk-'. Got: ${_val:0:8}... — please re-enter or press Enter to defer." >&2
    else
      break
    fi
  done
}

wizard_confirm() {
  # Y/n confirm with default Y
  local prompt="$1"
  local answer
  read -r -p "$prompt [Y/n]: " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

wizard_summarize() {
  # Show install summary before execution
  echo ""
  echo "About to install:"
  [[ $INSTALL_SERVER -eq 1 ]] && echo "  - Server (Docker stack)"
  [[ $INSTALL_PLUGIN_CC -eq 1 ]] && echo "  - Claude Code plugin"
  [[ $INSTALL_PLUGIN_CODEX -eq 1 ]] && echo "  - Codex plugin"
  [[ $INSTALL_CLI -eq 1 ]] && echo "  - CLI (\`um\`)"
  echo ""
  if [[ -n "${UM_VAULT_DIR:-}" ]]; then echo "  Vault: $UM_VAULT_DIR"; fi
  if [[ -n "${UM_SERVER_URL:-}" ]]; then echo "  Server URL: $UM_SERVER_URL"; fi
  echo ""
}
