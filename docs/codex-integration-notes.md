# Codex CLI Integration — Research Notes (Task E1)

Research target: OpenAI Codex CLI (2025-era revival), canonical repo [`openai/codex`](https://github.com/openai/codex). This document grades whether Phase E of the v0.3 cross-platform plan can ship a full plugin, pivot to MCP connector docs, or defer.

---

## 1. Research date + sources consulted

- **Research date:** 2026-04-20
- **Worktree branch:** `v0.3-phase-c`
- **Primary sources (verbatim URLs):**
  - `https://github.com/openai/codex` — repo overview, current version
  - `https://developers.openai.com/codex/cli/features` — CLI feature index
  - `https://developers.openai.com/codex/changelog` — changelog
  - `https://developers.openai.com/codex/hooks` — hooks documentation
  - `https://developers.openai.com/codex/plugins` — plugins overview
  - `https://developers.openai.com/codex/plugins/build` — plugin authoring guide
  - `https://developers.openai.com/codex/mcp` — MCP documentation
  - `https://developers.openai.com/codex/config-reference` — config.toml reference
  - `https://developers.openai.com/codex/cli/reference` — CLI reference
  - `https://github.com/openai/codex/discussions/2150` — community discussion on hooks
- **Search queries used:** "OpenAI Codex CLI plugin hooks architecture 2026", "Codex CLI SessionEnd hook stop event session cleanup"
- **Unreachable / 404:** `github.com/openai/codex/blob/main/docs/hooks.md` — no docs for hooks in the repo tree; only the dev-portal page exists.

---

## 2. Codex CLI status

- **Product exists and is actively developed.** Not to be confused with the retired 2021 Codex model.
- **Current stable version (repo):** `0.121.0`, released 2026-04-15. 719 total releases. Written in Rust (95.3%).
- **Description (repo README):** "Lightweight coding agent that runs in your terminal."
- **Distribution:** npm, Homebrew, direct binary. License: Apache-2.0.
- **Active surfaces:** CLI, desktop app (`codex app`), VS Code / Cursor / Windsurf extensions, IDE integration.

---

## 3. Q1 — Plugin system

**Answer: YES, plugins exist and are documented.**

- **Introduction date:** 2026-03-25 (changelog): plugins introduced as "installable bundles that package skills, app integrations, and MCP server configuration for reusable workflows."
- **Manifest filename:** `.codex-plugin/plugin.json` (inside the plugin directory).
- **Canonical plugin install path:** `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`. For locally-installed plugins, `$VERSION` is the literal string `local`.
- **Required manifest fields:** `name` (kebab-case), `version`, `description`.
- **Optional manifest fields:** `author` (object: `name`, `email`, `url`), `homepage`, `repository`, `license`, `keywords`, `skills` (dir path), `mcpServers` (file path, conventionally `./.mcp.json`), `apps` (file path, conventionally `./.app.json`), `interface` (object with `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`, `capabilities`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`, `defaultPrompt`, `brandColor`, `composerIcon`, `logo`, `screenshots`).
- **Plugin directory structure:**
  ```
  my-plugin/
    .codex-plugin/
      plugin.json          (required manifest)
    skills/
      skill-name/
        SKILL.md           (optional, agentskills.io spec)
    .app.json              (optional, app/connector mappings)
    .mcp.json              (optional, MCP server config)
    assets/                (optional, icons/logos/screenshots)
  ```
- **Local install for testing:** supported via a marketplace JSON pointer file. Repo-scoped at `$REPO_ROOT/.agents/plugins/marketplace.json` or personal at `~/.agents/plugins/marketplace.json`, using `source.path` with a `./`-prefixed relative path to the plugin directory. Scaffolding is provided by the built-in skill `$plugin-creator`.
- **Registry / marketplace:** a "Plugin Directory" exists (browsable in app and CLI), but per the docs "Self-serve plugin publishing and management are coming soon." Today, third-party plugins rely on local marketplace files.

---

## 4. Q2 — Lifecycle hooks

**Answer: hooks exist but are experimental, incomplete, and currently disabled on Windows.**

Global status quote (`/codex/hooks`): *"Experimental. Hooks are under active development. Windows support temporarily disabled."* Must be enabled via feature flag in `config.toml`:

```toml
[features]
codex_hooks = true
```

Config reference says: `features.codex_hooks` — *"Enable lifecycle hooks loaded from hooks.json (under development; off by default)."*

Per-hook equivalence to Claude Code's four hooks:

| CC hook | Codex equivalent | Status | Notes |
|---|---|---|---|
| `session-start.sh` | **SessionStart** | Present | Matcher filters on `source` (`startup` \| `resume`). Can emit stdout as developer context. |
| `stop.sh` (per-turn) | **Stop** | Present | Doc: *"`Stop` run at turn scope."* Fires after each assistant turn, same granularity as CC's Stop. `decision: "block"` does *not* reject — it forces continuation with a new prompt. |
| `session-end.sh` | **NONE** | **Missing** | Docs list no SessionEnd event. No alternative cleanup event is documented. Closest workaround is accumulating state in Stop and flushing on next SessionStart with `source=startup`, but there is no clean end-of-session trigger. |
| `user-prompt-submit.sh` | **UserPromptSubmit** | Present | Fires on prompt submission. Can block or augment prompts before they reach history. Can emit stdout as developer context. |

Additional Codex hooks not present in the CC table: **PreToolUse** / **PostToolUse** (currently Bash-only, marked "Work in progress").

**Two initial triggers (SessionStart, Stop) merged experimentally in Codex v0.114 (March 2026)** per [`discussions/2150`](https://github.com/openai/codex/discussions/2150) — comment from `@etraut-openai`: *"We're building the hooks infrastructure and working the bugs out with these first two triggers."* UserPromptSubmit appears to have been added subsequently.

---

## 5. Q3 — Hook I/O surface

- **Input:** stdin JSON only. Doc quote: *"Every command hook receives one JSON object on `stdin`."* Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`. Turn-scoped hooks also get `turn_id`.
- **No env vars or argv** documented as input mechanisms.
- **Output channels:**
  - **stdout JSON** — primary mechanism; common fields include `continue`, `stopReason`, `systemMessage`, plus hook-specific shapes.
  - **stdout plain text** — for `SessionStart` and `UserPromptSubmit`, plain-text stdout is *"Added as developer context"* (this is the Codex analog of CC's `additionalContext` — same semantic, simpler format).
  - **Exit code 0** — success.
  - **Exit code 2** — blocks the action; reason read from stderr.
- **Transcript access:** Yes. `transcript_path` field in stdin JSON points to the session transcript file (or null).
- **CWD:** hooks execute with the session `cwd` as their working directory.

Mapping UM's existing CC hook scripts to Codex is close-to-trivial for I/O — `$CLAUDE_CWD` becomes the `cwd` field in stdin JSON; `additionalContext` becomes plain stdout text for SessionStart/UserPromptSubmit; Stop can still fast-append captures. The only semantic delta is the missing SessionEnd.

---

## 6. Q4 — Install path

- **Plugin install directory:** `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`
- **Local install without registry:** supported via `~/.agents/plugins/marketplace.json` (personal) or `$REPO_ROOT/.agents/plugins/marketplace.json` (repo) pointing at `source.path`.
- **Hook config (orthogonal to plugins):** `~/.codex/hooks.json` (user) or `<repo>/.codex/hooks.json` (repo).
- **Marketplace:** curated Plugin Directory exists in app + CLI. Public self-serve publishing "coming soon".

**Critical finding for our integration:** Per the `/codex/plugins/build` page, **plugins do not bundle hooks**. The plugin manifest has no `hooks` field. Hooks are discovered only in user-configured `hooks.json` files. A user installing a UM plugin would *also* need to separately edit `~/.codex/hooks.json` (or have our installer do it). This is a material divergence from CC's plugin model, where `hooks/hooks.json` inside the plugin is auto-registered.

---

## 7. Q5 — MCP support

**Answer: Yes, Codex CLI is a full MCP client.**

- **Protocols:** both STDIO and streamable HTTP MCP servers supported.
- **Config syntax** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.um]
  command = "npx"
  args = ["-y", "universal-memory-mcp"]  # or http equivalent
  startup_timeout_sec = 10
  tool_timeout_sec = 60

  [mcp_servers.um.env]
  UM_VAULT_DIR = "/path/to/vault"
  ```
  For HTTP: `url = "https://…/mcp"`, optional `http_headers = { Authorization = "Bearer …" }`.
- **CLI management:** `codex mcp add <name>`, `codex mcp list`, `codex mcp login/logout` (OAuth). Marked *experimental*.
- **Features page quote:** *"MCP servers launch automatically when sessions begin, exposing their tools alongside built-in capabilities."* → servers are per-session, started at session start. (Exact lifecycle details — refresh on resume vs. kill on end — are not documented clearly.)
- **Context injection:** MCP servers expose tools; the docs do not confirm that MCP can push context at session start without a tool call. For UM this means MCP gets us *recall on demand* (Codex calls `memory_search` when useful) but not the automatic rubric-injection-at-session-start behaviour that CC's SessionStart hook provides today.
- **Plugin-bundled MCP:** YES — a plugin's `.mcp.json` declares MCP servers that install along with the plugin. This is the cleanest integration path that plugins natively support.

---

## 8. Q6 — Stability + version context

- **Codex CLI stable version:** `0.121.0` (2026-04-15).
- **Plugin system:** introduced 2026-03-25. ~4 weeks old as of research date. Self-serve publishing "coming soon".
- **Hooks:** explicitly *"Experimental. Hooks are under active development."* Merged experimentally in Codex `v0.114` (March 2026). ~5-6 weeks old.
- **Windows:** *"Hooks are currently disabled on Windows."* This is a significant problem — UM's Claude Code plugin already supports Windows, and a Codex plugin that only works on macOS/Linux is a regression in platform coverage.
- **Breaking changes risk:** both plugins and hooks are very new, both marked experimental or "coming soon". High risk of manifest / hook-shape changes in the next 1-2 quarters.

---

## 9. Gap analysis vs Claude Code plugin

| Dimension | Claude Code | Codex CLI | Delta |
|---|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | Near-identical naming, trivial port |
| Skills | `commands/`, `skills/` | `skills/` (agentskills.io) | Minor format differences |
| MCP bundling | via plugin | via `.mcp.json` in plugin | **Equivalent — usable today** |
| SessionStart hook | yes | yes | Equivalent |
| Stop hook (per-turn) | yes | yes | Equivalent (Stop has a quirk: `block` decision = continue, not reject — different semantics but not blocking for UM) |
| UserPromptSubmit hook | yes | yes | Equivalent |
| **SessionEnd hook** | yes | **NO** | **Blocking gap for UM summary pipeline** |
| Hooks bundled with plugin | yes (plugin's `hooks/hooks.json` auto-registered) | **NO** (user must edit `~/.codex/hooks.json` separately) | **Blocking gap for one-click install** |
| Windows support for hooks | yes | **NO** (disabled) | **Blocking gap for cross-platform parity** |
| Hook stdin JSON + stdout context | yes | yes | Mapping is trivial |
| Transcript access | yes | yes (`transcript_path` field) | Equivalent |
| Plugin registry | CC marketplace | "coming soon" | No impact on local-install path |

Three blocking gaps for a faithful port of the CC plugin:
1. **No SessionEnd** — UM's synthesize-session-summary pipeline has no trigger.
2. **Hooks not plugin-bundled** — installer must touch user's global `hooks.json`, which is fragile and not one-click.
3. **No Windows hooks** — regression vs current UM platform coverage.

Non-blocking gap:
- Plugin registry / publishing is not self-serve yet, but local marketplace files work fine for alpha.

---

## 10. Recommendation — **PIVOT**

**Ship Phase E in v0.3.0-alpha as MCP-connector docs + a minimal plugin, not a full hook-driven plugin.**

Rationale:
- Codex *does* have plugins and MCP, so we are not shut out. A plugin is producible today.
- But the three blocking gaps (no SessionEnd, hooks not plugin-bundled, no Windows) mean a faithful port of the CC four-hook architecture is not achievable. Forcing it would ship a broken plugin — no session summaries, manual hooks.json editing, and no Windows support.
- MCP support is stable and well-documented. UM's MCP server already exists (port 6335, 11 tools). Codex users can connect UM as an MCP server via `config.toml` today with zero UM-side code.
- The pragmatic v0.3.0 shape for Codex is:
  - `plugins/codex/universal-memory/` directory with a `.codex-plugin/plugin.json` manifest + a `.mcp.json` that points at UM's MCP server. This is a **tiny plugin** — config only, no hooks, no scripts. Installs via the local-marketplace mechanism.
  - `plugins/codex/universal-memory/README.md` with MCP connector setup instructions (analogous to `docs/connecting-chatgpt-desktop.md` and `docs/connecting-claude-ai.md`).
  - Clear note in that README: captures + session-summary pipeline are Claude-Code-only today; Codex gets *recall* (via MCP tools) but not automatic capture/summary. Hooks revisit deferred to v0.3.1 or v0.4 once Codex's hooks exit experimental + support Windows + support plugin-bundled hooks.
- This also sets up a clean upgrade path: when Codex adds SessionEnd + plugin-bundled hooks + Windows support, we add the hook scripts to the same plugin directory without restructuring.

### Follow-ups to confirm before building the PIVOT plugin (non-blocking, can happen during Phase E implementation)

1. Confirm exact `.mcp.json` schema by scaffolding one plugin with the `$plugin-creator` skill or by reading a published plugin (e.g., the Notion/Linear/Slack first-party ones). Docs quote the filename but don't publish the schema.
2. Confirm MCP server lifecycle on `codex resume` — does Codex restart the server, or keep the previous instance? Matters for stateful MCP servers (UM is stateless, so probably OK).
3. Verify whether Codex's MCP client respects the `required = true` flag gracefully (so UM being down doesn't wedge the session).
4. Verify the local-marketplace install flow end-to-end on one real user machine before the alpha ships.
