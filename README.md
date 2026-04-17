# universal-memory

Self-hosted, markdown-first memory for LLM agents — works across devices, agents, and projects.

**Status:** 🚧 Early development. Private repo while the shape stabilizes.

---

## What it gives you

- **Cross-session memory** — capture decisions and facts in one session, recall them in the next, across any device.
- **Cross-device sync** — your markdown sources travel with you; every device sees the same knowledge.
- **Works with multiple agents** — Claude Code, Claude Desktop, OpenClaw, or anything that speaks MCP or plain HTTP.
- **Markdown as source of truth** — no vendor lock-in. If any part of the stack dies, your knowledge survives as readable files under git.
- **ADR workflow** — first-class support for recording architectural decisions per project, with automatic cross-project synthesis.
- **Karpathy-inspired architecture** — three roles: source markdown (authoritative), LLM-compiled synthesis (regenerable), and vector/graph indexes (regenerable caches). See [docs/architecture.md](docs/architecture.md).

## Who this is for

You run Claude Code (CLI or the VS Code / JetBrains extension) and want cross-session, cross-device memory without vendor lock-in.

- **Standalone users.** You don't run OpenClaw. The core (memory server + Claude Code plugin) works by itself. Docker + an OpenAI key is all you need. The `plugins/openclaw/` and `integrations/openclaw/` directories don't apply to you — skip them.
- **OpenClaw users.** You already run OpenClaw for Discord auto-capture / agent workspace / etc. The optional addons in `plugins/openclaw/` integrate universal-memory with your existing setup (workspace-dream, autoCapture retrofit).

**OpenClaw is never a prerequisite.** The memory server has zero OpenClaw code, dependencies, or assumptions. The server and Claude Code plugin can be installed and run without OpenClaw existing anywhere on your machine.

See the [roadmap](ROADMAP.md) for what's shipped and what's planned.

## Two deployment modes

| Mode | Who it's for | Setup time |
|---|---|---|
| **Cloud** | Quick try, no infra hassle | ~60 seconds — sign up at mem0.ai, paste API key |
| **Self-hosted** | Privacy, cost control, power users | ~5 minutes — `docker-compose up` on any Docker host |

Both modes use the same plugins. Switching is a config change.

## Quickstart (self-hosted)

```bash
# 1. Clone and start the memory server
git clone https://github.com/goldenwo/universal-memory
cd universal-memory/server
cp .env.example .env   # add OPENAI_API_KEY, set a userId
docker-compose up -d

# 2. Install the Claude Code plugin (from any dev machine)
# (plugin install instructions — TBD as plugin stabilizes)
```

See [docs/quickstart.md](docs/quickstart.md) for full instructions.

## Repository layout

```
universal-memory/
├── server/                      Self-hostable backend (Qdrant + mem0 HTTP + cron jobs)
├── plugins/
│   ├── claude-code/             Claude Code plugin (hooks, skills, MCP config)
│   └── openclaw/                Optional addon for OpenClaw users
├── docs/
│   ├── architecture.md          Design principles and the three-role model
│   ├── quickstart.md            Install walkthroughs
│   └── decisions/               ADRs about the system itself (dogfooding)
├── examples/                    Reference configs for different setups
└── .github/workflows/           CI for portability verification
```

## Design principles

1. **Markdown is the only authoritative substrate.** Vector stores and graphs are regenerable caches.
2. **Every fact has a markdown source.** If it only lives in the index, it's at risk.
3. **Zero required infrastructure for basic use.** Cloud mode works with just an API key.
4. **Generic by default, personal by config.** No hardcoded hostnames, user IDs, or paths.
5. **Portability is tested, not claimed.** CI verifies clean-install works.

## Status and roadmap

See [docs/decisions/](docs/decisions/) for the architecture decisions driving the current shape.

## License

MIT — see [LICENSE](LICENSE).
