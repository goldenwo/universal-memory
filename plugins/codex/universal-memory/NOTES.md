# Codex plugin — implementation notes + TBDs

Companion to `.codex-plugin/plugin.json` and `.mcp.json`. Captures schema
ambiguities that the E1 research (`docs/codex-integration-notes.md`) could not
confirm from first-party docs. Review these before shipping the plugin outside
alpha.

## Schema TBDs (carry over from E1 research)

### `.mcp.json` — schema shape
- **Status:** `<TBD: verify against a first-party Codex plugin>`
- **What we assumed:** `.mcp.json` mirrors the `[mcp_servers.<name>]` table
  structure from `~/.codex/config.toml` (researched in `docs/codex-integration-notes.md`
  section 7), wrapped in a JSON object keyed by `mcpServers`. E1 notes this
  exact schema was not published by OpenAI — only the filename convention.
- **Fields we used:** `url` (for streamable HTTP transport), `startup_timeout_sec`,
  `tool_timeout_sec`. These map 1:1 to the TOML keys documented in `config-reference`.
- **Risk:** Codex may accept a different JSON shape (flat `{name, url}` array
  instead of nested `mcpServers.<name>` object), or may not support HTTP transport
  via plugin-bundled `.mcp.json` at all. If so, the fallback is to document the
  equivalent `~/.codex/config.toml` block in README.md and drop `.mcp.json`
  from the plugin manifest.
- **Confirm by:** Scaffold one plugin with Codex's built-in `$plugin-creator`
  skill, or read a published first-party plugin (Notion / Linear / Slack) and
  diff against this file.

### `plugin.json` — `interface` block
- **Status:** Omitted in v0.3.0-alpha.
- **Why:** E1 notes list the `interface` block fields (`displayName`, `category`,
  `capabilities`, `brandColor`, etc.) as optional — plugin loads without them.
  Skipping keeps the alpha small and avoids guessing valid `category` values.
- **Risk:** low. When Codex's plugin directory becomes self-serve we'll likely
  want this block, but alpha users install via local marketplace only.

### `plugin.json` — `author` field shape
- **Status:** Used object form `{name, url}`; E1 notes this is valid.
- **Risk:** low. If the manifest schema is strictly `{name, email, url}` with
  required `email`, the plugin will fail to load and we'll add a placeholder.

## Codex custom-instructions entry point
- **Status:** `<TBD: confirm where to paste the routing rubric>`
- **What we know from E1:** Codex uses `~/.codex/config.toml` for config, and
  hooks for dynamic context. Neither is the equivalent of ChatGPT Custom
  Instructions or Claude's system prompt.
- **Risk:** medium. The README tells the user to paste the rubric into "Codex's
  equivalent of custom instructions". If no such surface exists in v0.121, the
  rubric is effectively undeliverable through static config — the user would
  need to paste it into every session manually, or we wait for v0.4's hook
  support. Research during D2 verification turned up AGENTS.md as one option
  (project-local instructions file for Codex agent runs) but confirmation
  pending.

## Install-path confirmation
- **Status:** Install path `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`
  comes from E1 research (section 3/6). For locally-installed plugins,
  `$VERSION = "local"`.
- **What `install.sh` does:** Uses the simpler `~/.codex/plugins/universal-memory/`
  path — the documented *personal marketplace* form. The user can alternately
  register via `~/.agents/plugins/marketplace.json` with `source.path` pointing
  at the repo checkout (documented in README.md Installation §b).
- **Risk:** low — if Codex rejects the simple path, `install.sh` writes a
  fallback marketplace.json entry. T13 exercises the path landing; T14
  exercises the skip-when-Codex-absent branch.

## What to verify before promoting past alpha
1. Install the plugin on a live Codex CLI instance (macOS or Linux, since
   Windows hooks are disabled — irrelevant here since we ship no hooks).
2. Confirm `~/.codex/plugins/universal-memory/` is picked up at session start.
3. Confirm the MCP server from `.mcp.json` is launched — check
   `codex mcp list` shows `universal-memory`.
4. Confirm tool list contains the 4 default UM read tools via "what tools do you have?" (plus the 6 writes when `UM_MCP_WRITE_ENABLED=true` on the server).
5. Run `memory_state(project: "test")` — returns `null` or state body.
6. Confirm the rubric paste-in surface the README recommends actually steers
   Codex. If not, file a follow-up to ship rubric as AGENTS.md or to wait for
   v0.4 hook support.

## What explicitly is NOT in this plugin
- No hooks (`hooks.json` / session-start / session-end / stop / user-prompt-submit).
  Deferred to v0.4. Three upstream blockers per E1:
  1. No `SessionEnd` event in Codex v0.121.
  2. Plugin manifest has no `hooks` field — user would need to edit
     `~/.codex/hooks.json` manually.
  3. Hooks disabled on Windows in Codex v0.121.
- No CLI wrappers, file-watchers, or summarization code. UM's summarization
  pipeline stays Claude-Code-only in v0.3.
