#!/usr/bin/env bash
# install-plugin-cc.sh — standalone Claude Code plugin installer
#
# Extracted from server/install.sh (v0.5). Can be run standalone or via
# installer/install.sh --plugin-cc.
#
# Usage:
#   bash installer/install-plugin-cc.sh [--yes]
#
# Environment overrides:
#   CLAUDE_PLUGINS_DIR   Override ~/.claude/plugins
#   _UM_REPO_ROOT        Override repo root detection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${_UM_REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$SCRIPT_DIR")")}"

info()  { printf '\033[1;34m[install-plugin-cc]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-plugin-cc]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-plugin-cc]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-plugin-cc]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── CLI args ────────────────────────────────────────────────────────────────
for _arg in "$@"; do
  case "$_arg" in
    --yes|-y) UM_NONINTERACTIVE=1 ;;
  esac
done

# ─── Preflight ───────────────────────────────────────────────────────────────
if [ -z "${HOME:-}" ] && [ -z "${CLAUDE_PLUGINS_DIR:-}" ]; then
  fail "Neither HOME nor CLAUDE_PLUGINS_DIR is set — cannot determine plugin directory"
fi

_PLUGIN_SRC="$REPO_ROOT/plugins/claude-code/universal-memory"
_PLUGIN_TARGET_BASE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
_PLUGIN_TARGET="$_PLUGIN_TARGET_BASE/universal-memory"

if [ ! -d "$_PLUGIN_SRC" ]; then
  fail "Plugin source not found at $_PLUGIN_SRC — is this a full repo checkout?"
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────
_read_plugin_version() {
  local dir="$1"
  local pjson
  if [ -f "$dir/.claude-plugin/plugin.json" ]; then
    pjson="$dir/.claude-plugin/plugin.json"
  elif [ -f "$dir/plugin.json" ]; then
    pjson="$dir/plugin.json"
  else
    return 0
  fi
  grep '"version"' "$pjson" 2>/dev/null | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1
}

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

# ─── Install ─────────────────────────────────────────────────────────────────
_install_plugin() {
  local src="$_PLUGIN_SRC"
  local target="$_PLUGIN_TARGET"

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

  # Before overwriting a directory target, back it up if it has local modifications
  # (files present in target that are NOT in source indicate local edits).
  _backup_target_if_modified() {
    local src_dir="$1"
    local tgt_dir="$2"
    if [ ! -d "$tgt_dir" ]; then return; fi
    local local_only=()
    while IFS= read -r -d '' f; do
      local rel="${f#$tgt_dir/}"
      if [ ! -e "$src_dir/$rel" ]; then
        local_only+=("$rel")
      fi
    done < <(find "$tgt_dir" -type f -print0 2>/dev/null)
    if [ ${#local_only[@]} -gt 0 ]; then
      warn "existing plugin dir $tgt_dir has local modifications:"
      local shown=0
      for f in "${local_only[@]}"; do
        if [ $shown -lt 5 ]; then
          warn "  $f"
          shown=$((shown + 1))
        fi
      done
      if [ ${#local_only[@]} -gt 5 ]; then
        warn "  ... and $((${#local_only[@]} - 5)) more"
      fi
      local bak="$tgt_dir.bak-$(date +%s)"
      warn "Existing dir will be backed up to $bak"
      mv "$tgt_dir" "$bak"
    fi
  }

  case "$_action" in
    [lL]*)
      if [ -L "$target" ]; then rm -f "$target"
      elif [ -d "$target" ]; then _backup_target_if_modified "$src" "$target"; rm -rf "$target" 2>/dev/null || true; fi
      if ln -s "$src" "$target" 2>/dev/null; then
        ok "Plugin symlinked: $target -> $src"
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
      if [ -L "$target" ]; then rm -f "$target"
      elif [ -d "$target" ]; then _backup_target_if_modified "$src" "$target"; rm -rf "$target" 2>/dev/null || true; fi
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

# ─── Prompt-file distribution ─────────────────────────────────────────────────
# NEW in v0.5: distribute canonical prompts to plugin-local dir so
# hooks/lib/summarize.sh + update-state.sh can resolve them at runtime
# without a server round-trip.
_install_prompts() {
  local prompt_src="$REPO_ROOT/server/config/prompts"
  local prompt_dst="$_PLUGIN_TARGET/hooks/lib/prompts"
  if [[ -d "$prompt_src" ]]; then
    mkdir -p "$prompt_dst"
    cp "$prompt_src/"*.txt "$prompt_dst/"
    info "Prompts installed to: $prompt_dst"
  else
    warn "server/config/prompts/ not found — hooks will fall back to their inlined prompts"
  fi
}
_install_prompts

# ─── Write UM_PROMPT_DIR to shell rc files ────────────────────────────────────
_write_prompt_dir_to_rc() {
  local _UM_PROMPT_DIR_VALUE="$_PLUGIN_TARGET/hooks/lib/prompts"
  # Source marker-block.sh from the same lib dir this script lives in.
  local _lib_dir
  _lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
  # shellcheck source=installer/lib/marker-block.sh
  source "$_lib_dir/marker-block.sh"

  local _RC_UPDATED=0
  local _sh="${SHELL:-}"
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
    case "$rc" in
      "${HOME}/.bashrc")
        [ -f "$rc" ] || [ "${_sh##*/}" = "bash" ] || continue
        ;;
      "${HOME}/.zshrc")
        [ -f "$rc" ] || [ "${_sh##*/}" = "zsh" ] || continue
        ;;
    esac
    touch "$rc"
    UM_PROMPT_DIR="$_UM_PROMPT_DIR_VALUE" _write_marker_block "$rc" "" ""
    ok "Shell profile updated with UM_PROMPT_DIR: $rc"
    _RC_UPDATED=$((_RC_UPDATED + 1))
  done

  if [ "$_RC_UPDATED" -eq 0 ]; then
    warn "Could not detect shell rc file — add manually: export UM_PROMPT_DIR='$_UM_PROMPT_DIR_VALUE'"
  fi
}
_write_prompt_dir_to_rc
