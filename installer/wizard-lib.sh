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
  [[ $DETECTED_PYTHON3 -eq 1 ]] && echo "  ✓ python3" || echo "  ✗ python3 not found (required for \`um\` CLI)"
  [[ $DETECTED_PYYAML -eq 1 ]] && echo "  ✓ python3-yaml" || echo "  ✗ python3-yaml not found (required for \`um\` CLI)"
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
  eval "export $var=\"\$val\""
}

wizard_validate_api_key() {
  # wizard_validate_api_key <provider> <var_name>
  # Side-effect: prompts user for key on stdin; on valid input, sets <var_name>
  # in env via eval+export; returns 0. On invalid format: re-prompts (loop).
  # On EOF / empty input: returns 1, does NOT set the variable.
  # Recognized providers: openai (sk-*), anthropic (sk-ant-*), google (AIza*).
  # Unknown provider arg → return 1, error message to stderr.
  # shellcheck disable=SC2034,SC2086,SC2154  # eval + var-by-name pattern, intentional
  local provider="$1" var="$2"
  local prompt="${provider} API key (Ctrl-C to cancel): "
  local key
  while true; do
    read -r -p "$prompt" key || return 1
    if [[ -z "$key" ]]; then return 1; fi
    # Provider list MUST stay in sync with server/lib/provider/registry.mjs.
    # When adding a new provider with an API-key surface, add a case branch
    # here and a corresponding test in wizard.test.sh. Bash can't import the
    # JS registry; this comment + grep is the manual synchronization aid.
    case "$provider" in
      openai)    [[ "$key" == sk-* && "$key" != sk-ant-* ]] && break || echo "Expected sk-* prefix (not sk-ant-*).";;
      anthropic) [[ "$key" == sk-ant-* ]] && break || echo "Expected sk-ant-* prefix.";;
      google)    [[ "$key" == AIza* ]]    && break || echo "Expected AIza* prefix.";;
      *) echo "Unknown provider: $provider" >&2; return 1;;
    esac
  done
  eval "$var=\"$key\""
  # shellcheck disable=SC2163  # var-by-name export is intentional (the value of $var IS the variable name we want to export)
  export "${var?}"
  return 0
}

wizard_probe_ollama() {
  # wizard_probe_ollama <host>
  # Returns: 0 if reachable, non-zero otherwise.
  local host="$1"
  curl -fsS --max-time 5 "${host%/}/api/tags" >/dev/null
}

wizard_confirm() {
  # Y/n confirm with default Y
  local prompt="$1"
  local answer
  read -r -p "$prompt [Y/n]: " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

wizard_select() {
  # wizard_select <var> <prompt> <opt1> [opt2 ...]
  # Side-effect: assigns selected value to <var> via eval (var-by-name pattern,
  # matches wizard_prompt / wizard_validate_api_key convention).
  # Returns: 0 on selection, 1 on EOF/abort, 2 on empty opts. Loops until a
  # valid choice is given.
  # shellcheck disable=SC2034,SC2086,SC2154  # eval intentional for var-by-name pattern
  local var="$1" prompt="$2"
  shift 2
  local opts=("$@")
  if (( ${#opts[@]} == 0 )); then
    echo "wizard_select: no options provided" >&2
    return 2
  fi
  local i=1
  echo "$prompt"
  for opt in "${opts[@]}"; do
    echo "  $i) $opt"
    i=$((i+1))
  done
  local choice
  while true; do
    read -r -p "Choose [1-${#opts[@]}]: " choice || { echo "Aborted." >&2; return 1; }
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#opts[@]} )); then
      eval "$var=\"\${opts[\$((choice-1))]}\""
      return 0
    fi
    echo "Invalid choice. Try again."
  done
}

wizard_collect_keys() {
  # wizard_collect_keys
  # Reads UM_*_PROVIDER vars from env, walks the unique set of providers,
  # prompts for any whose API key is not already in env. Skips ollama.
  #
  # The plan-doc snippet uses `done <<< "$providers"`, which redirects the
  # entire while-loop body's stdin to the provider list herestring — that
  # would prevent wizard_validate_api_key (called inside the loop) from
  # reading the user's key off the original stdin. We use FD 3 instead so
  # the loop reads providers from FD 3 while validate continues to read
  # the API key from FD 0 (stdin) as expected.
  local providers
  providers=$(echo "$UM_EMBEDDING_PROVIDER $UM_SUMMARIZER_PROVIDER $UM_FACTS_PROVIDER" | tr ' ' '\n' | sort -u)
  while IFS= read -r p <&3; do
    case "$p" in
      openai)    [[ -n "${UM_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}" ]]    || wizard_validate_api_key openai    OPENAI_API_KEY ;;
      anthropic) [[ -n "${UM_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}" ]] || wizard_validate_api_key anthropic ANTHROPIC_API_KEY ;;
      google)    [[ -n "${UM_GOOGLE_API_KEY:-${GOOGLE_API_KEY:-${GEMINI_API_KEY:-}}}" ]] || wizard_validate_api_key google GOOGLE_API_KEY ;;
      ollama)    : ;;  # no key needed
    esac
  done 3<<< "$providers"
}

wizard_menu_providers() {
  # wizard_menu_providers
  # Top-level provider picker (4 paths) per design §7.1.
  # Side-effects: exports UM_EMBEDDING_PROVIDER, UM_SUMMARIZER_PROVIDER,
  # UM_FACTS_PROVIDER (and OLLAMA_HOST for path 3); calls wizard_collect_keys
  # for paths 1+2 to gather missing API keys; calls wizard_probe_ollama for
  # path 3; writes .env from .env.example for path 4 (if available).
  #
  # Per-surface provider lists are hardcoded to match the JS registry at
  # server/lib/provider/registry.mjs (anthropic.supports.embeddings === false
  # is the only asymmetry today). Bash can't import the JS registry; this
  # comment + grep is the manual synchronization aid — same convention as
  # wizard_validate_api_key.
  # shellcheck disable=SC2034  # vars are exported for caller via export below
  local choice=""
  local embed_opts=(openai google ollama)              # NOT anthropic — no embeddings API
  local summ_opts=(openai anthropic google ollama)
  local facts_opts=(openai anthropic google ollama)

  echo ""
  echo "Provider setup:"
  echo "  1) OpenAI for everything    [recommended for first-time setup; one API key]"
  echo "  2) Mix providers            [pick per surface — e.g. Anthropic + OpenAI embeds]"
  echo "  3) Local-only (Ollama)      [no API keys, runs offline]"
  echo "  4) Skip — I'll edit .env myself"
  while true; do
    read -r -p "Choose [1-4]: " choice || return 1
    [[ "$choice" =~ ^[1-4]$ ]] && break
    echo "Invalid choice; enter a number 1-4."
  done

  case "$choice" in
    1)
      UM_EMBEDDING_PROVIDER=openai
      UM_SUMMARIZER_PROVIDER=openai
      UM_FACTS_PROVIDER=openai
      export UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER
      wizard_collect_keys
      ;;
    2)
      # Sub-pickers per surface. embed_opts EXCLUDES anthropic by design.
      wizard_select UM_EMBEDDING_PROVIDER  "Embeddings provider:"  "${embed_opts[@]}" || return 1
      wizard_select UM_SUMMARIZER_PROVIDER "Summarizer provider:"  "${summ_opts[@]}"  || return 1
      wizard_select UM_FACTS_PROVIDER      "Fact-extraction provider:" "${facts_opts[@]}" || return 1
      export UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER
      wizard_collect_keys
      ;;
    3)
      UM_EMBEDDING_PROVIDER=ollama
      UM_SUMMARIZER_PROVIDER=ollama
      UM_FACTS_PROVIDER=ollama
      export UM_EMBEDDING_PROVIDER UM_SUMMARIZER_PROVIDER UM_FACTS_PROVIDER
      wizard_prompt OLLAMA_HOST "Ollama host" "http://localhost:11434"
      if ! wizard_probe_ollama "$OLLAMA_HOST"; then
        echo "Ollama not reachable at $OLLAMA_HOST — install/start Ollama (https://ollama.com) and re-run." >&2
        return 1
      fi
      ;;
    4)
      # Skip — best-effort copy of .env.example to .env if available; otherwise
      # just succeed silently. The wizard's path 4 is the deliberate
      # "I know what I'm doing" escape hatch (design §7.3, last paragraph).
      local example=""
      if [[ -f .env.example ]]; then
        example=".env.example"
      elif [[ -f server/.env.example ]]; then
        example="server/.env.example"
      fi
      if [[ -n "$example" && ! -f .env ]]; then
        cp "$example" .env
      fi
      return 0
      ;;
  esac
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
