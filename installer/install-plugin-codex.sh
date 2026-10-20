#!/usr/bin/env bash
# install-plugin-codex.sh — Codex CLI plugin installer
#
# Codex installs plugins from a marketplace, and this repository's marketplace
# (.claude-plugin/marketplace.json) serves Codex the same plugin tree Claude
# Code gets, hooks included. This registers it through the `codex` CLI, with
# the same two commands the README gives:
#   codex plugin marketplace add goldenwo/universal-memory
#   codex plugin add universal-memory@universal-memory
# and moves an existing install forward: Codex has no `plugin update`, so it
# upgrades the marketplace and adds the plugin again, which installs the
# marketplace's current version. Each step is idempotent.
# Until 2026-10 it copied an MCP-only plugin (v0.7.0-alpha) into
# ~/.codex/plugins/universal-memory, a directory Codex never loads.
#
# One step stays with the user: Codex runs a plugin's hooks only after they are
# trusted. Interactive `codex` asks once at startup; `codex exec` never asks and
# runs none of them until then.
#
# Usage:
#   bash installer/install-plugin-codex.sh [--yes]
#
# Environment overrides:
#   UM_PLUGIN_MARKETPLACE  Marketplace source (default goldenwo/universal-memory;
#                          a local checkout path works too)
#   CODEX_HOME             Codex's home (default ~/.codex), as Codex reads it

set -euo pipefail

info()  { printf '\033[1;34m[install-plugin-codex]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[install-plugin-codex]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[install-plugin-codex]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[install-plugin-codex]\033[0m %s\n' "$*" >&2; exit 1; }

# ─── CLI args ────────────────────────────────────────────────────────────────
# --yes is accepted for the dispatcher's sake; nothing here prompts.
# --server-url is accepted and ignored: the hooks read ~/.um/endpoint.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ;;
    --server-url) shift ;;
    *) : ;;  # pass-through unknown flags silently
  esac
  shift
done

if [ -z "${HOME:-}" ] && [ -z "${CODEX_HOME:-}" ]; then
  fail "HOME is not set — cannot locate Codex's home (~/.codex)"
fi

_MARKETPLACE="${UM_PLUGIN_MARKETPLACE:-goldenwo/universal-memory}"
_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# ─── Plugin: the marketplace route ───────────────────────────────────────────
_print_commands() {
  warn "  codex plugin marketplace add $_MARKETPLACE"
  warn "  codex plugin add universal-memory@universal-memory"
}

_register_plugin() {
  if ! command -v codex >/dev/null 2>&1; then
    if [ -d "$_CODEX_HOME" ]; then
      warn "Codex's CLI (codex) is not on PATH. Install it (npm install -g @openai/codex), then run:"
      _print_commands
    else
      info "Codex CLI not detected (no codex on PATH, no $_CODEX_HOME) — skipping Codex plugin install."
    fi
    return 0
  fi
  info "Registering the plugin with Codex (marketplace: $_MARKETPLACE)..."
  # Creates Codex's home on a Codex that has never run.
  codex plugin marketplace add "$_MARKETPLACE" >/dev/null \
    || fail "codex plugin marketplace add $_MARKETPLACE failed"
  # An add that finds the marketplace already there does not refetch it, so pull
  # the newest revision. A local-path source is read live: Codex refuses to
  # upgrade one ("not configured as a Git marketplace").
  if [ ! -d "$_MARKETPLACE" ]; then
    codex plugin marketplace upgrade universal-memory >/dev/null \
      || warn "codex plugin marketplace upgrade universal-memory failed — installing from the copy already on disk"
  fi
  local out root
  out=$(codex plugin add universal-memory@universal-memory) \
    || fail "codex plugin add universal-memory@universal-memory failed"
  root=$(printf '%s\n' "$out" | sed -n 's/^Installed plugin root: //p' | tail -1)
  ok "Codex plugin installed${root:+ at $root}."
  ok "Next: start codex once and trust the universal-memory hooks when it lists them (\"Trust all and continue\"). Until then Codex runs none of them, and codex exec never asks."
}

# An install from the old copy route leaves an MCP-only plugin Codex does not
# load. Say so; don't delete the user's files.
_warn_old_copy() {
  local old="$_CODEX_HOME/plugins/universal-memory"
  if [ -e "$old" ] || [ -L "$old" ]; then
    warn "$old is a copy from an older installer; Codex does not load it."
    warn "  Remove it when convenient: rm -rf '$old'"
  fi
}

_register_plugin
_warn_old_copy
