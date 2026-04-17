# Claude Code plugin — universal-memory

Markdown-first capture and cross-session recall for Claude Code, wired to a universal-memory server.

**Status:** 🚧 Scaffold. Current working hooks live at `~/.claude/scripts/mem0-hook-context.sh` and `mem0-hook-stop.sh` on the maintainer's machine and will be lifted into this plugin.

## What it does

- **SessionStart hook** — queries the memory server for context relevant to the current project and injects results as `additionalContext`.
- **Stop hook** — writes each session's key facts to an append-only markdown capture file first, then POSTs to the memory server for indexing.
- **`/adr` slash command + `create-adr` skill** — records architectural decisions in the current project's `docs/decisions/`, commits, and triggers index update.
- **MCP server registration** — exposes `memory_search`, `memory_add`, `memory_list`, `memory_delete` tools to the agent.
- **`init-project` script** — one-time setup per new project: `git init` on the per-project memory dir, `.gitignore` scaffold, initial commit.

## Install

```bash
# Add the marketplace
# (exact command TBD as plugin format stabilizes)
```

Then enable `universal-memory` and set required config:

```json
{
  "universal-memory": {
    "endpoint": "http://localhost:6335",
    "userId": "your-id",
    "mode": "self-hosted"
  }
}
```

## Configuration

| Key | Required | Description |
|---|---|---|
| `endpoint` | ✅ | URL of your memory server. E.g. `http://localhost:6335` or `https://your-pi.taile....ts.net:6335` |
| `userId` | ✅ | Namespace for your memories |
| `mode` | ✅ | `self-hosted` (server above) or `cloud` (mem0.ai) |
| `autoInitGit` | ❌ | Default `true`. Init git in per-project memory dirs on first use. |
| `captureDir` | ❌ | Where raw session captures go. Default: per-project memory dir. |

No default endpoint is provided. You must configure your own.

## Compatibility

- Claude Code v2.1.59+ (required for autoDream compatibility)
- Works alongside existing `autoDreamEnabled: true` — does not conflict.
