# Examples

Two dimensions of examples:

- **Developer integrations** — code showing how to call UM from external agent frameworks.
- **Deployment scenarios** — end-to-end setups for common environments. Scaffold; examples will be added as real-world configurations stabilize.

## Developer integrations

The OpenAI Assistants API example (shipped in v0.3.0-alpha) was removed in v1.30.0: OpenAI removed the Assistants API on 2026-08-26, so it could not run under any model.

### [`openai-agents-sdk/DEFERRED.md`](openai-agents-sdk/DEFERRED.md) — deferred to v0.4

The Agents SDK example was planned but deferred. A Responses-API variant is the likelier v0.4 shape. See the deferred note for reasoning.

## Deployment scenarios (planned)

These directories don't exist yet — they'll be added when real-world configurations stabilize enough to be reference-quality rather than aspirational:

- **`solo-developer/`** — one machine, one project, self-hosted server on the same laptop. Simplest possible install.
- **`multi-device/`** — Windows + Linux + mobile editor, sync via Syncthing, Pi hosts the server.
- **`cloud-mode/`** — no self-hosted infrastructure. mem0.ai platform mode with the plugin only.
- **`openclaw-full-stack/`** — full reference example with OpenClaw, Discord auto-capture, Pi-hosted server, and cross-device sync. This is the maintainer's own setup.
