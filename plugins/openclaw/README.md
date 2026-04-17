# OpenClaw integration

Optional addon for users running [OpenClaw](https://openclaw.dev). Augments the existing `openclaw-mem0` plugin with markdown-first capture and a workspace consolidation skill.

**Skip this directory entirely if you don't use OpenClaw.** The core Claude Code plugin and memory server do not depend on anything here.

## What it adds

- **`workspace-dream` skill** — analog of Claude Code's autoDream for the Pi-side `~/.openclaw/workspace/*.md` files. Reads `workspace/raw/` + typed notes, consolidates into the canonical AGENTS.md / MEMORY.md / USER.md / etc.
- **autoCapture retrofit** — modifies the openclaw-mem0 plugin's capture path to write markdown (`workspace/raw/YYYY-MM-DD-<session>.md`) before POSTing to the memory server.
- **Install script** — adds systemd user timer for the workspace-dream cadence.

## Prerequisites

- OpenClaw installed and running
- `openclaw-mem0` plugin already enabled (open-source mode, pointing at your memory server)
- SSH access to wherever OpenClaw runs

## Install

```bash
# TBD — will ship a script that installs the skill + timer
./install.sh
```

## Status

🚧 Scaffold. Full implementation pending stabilization of the core plugin and server.
