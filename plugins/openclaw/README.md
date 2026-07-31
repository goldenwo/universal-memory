# OpenClaw integration

Optional addon for users running [OpenClaw](https://openclaw.dev). Augments the existing `openclaw-mem0` plugin with markdown-first capture and a workspace consolidation skill.

**Skip this directory entirely if you don't use OpenClaw.** The core Claude Code plugin and memory server do not depend on anything here.

## What it adds

- **`reaction-producer/`** — a standalone, read-only Discord gateway listener that
  delivers late-arriving emoji reactions to the memory server's `POST /api/reaction`
  (the producer half of reaction salience). It reuses the gateway's existing bot token
  via a second gateway session with its own read-only intents — no second Discord app,
  no code changes to OpenClaw or its plugins (the OpenClaw plugin bus exposes no
  reaction event, hence the sidecar). Zero npm dependencies (Node ≥ 22 native
  WebSocket). Install per the header of `reaction-producer/reaction-producer.service`;
  the full request/retry contract is in the server's `openapi.yaml` under
  `/api/reaction`.
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
