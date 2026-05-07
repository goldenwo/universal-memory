# Security policy

This document describes how to report security vulnerabilities, which versions receive security fixes, what's in scope, and the project's currently accepted limitations.

For the broader threat model and design rationale, see `docs/decisions/` (gitignored, internal). This file is the externally-visible surface.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/goldenwo/universal-memory/security/advisories/new) to disclose privately. This is the preferred channel — it keeps the report visible to the maintainer without exposing details until a fix ships.

When reporting, please include:

- A clear description of the issue and the impact
- Steps to reproduce (a minimal proof-of-concept is ideal)
- Affected version(s) — git SHA or release tag
- The component(s) involved (memory server, MCP layer, plugin hooks, installer, bridge, etc.)
- Suggested mitigation, if you have one

If the report contains sensitive material (logs with real tokens, full vault dumps, etc.), state that in the report and the maintainer will arrange an alternate channel before details are exchanged.

## Response expectations

- **Acknowledgment:** within 5 business days of report
- **Initial assessment:** within 10 business days — severity classification, scope confirmation, and an estimated fix timeline
- **Fix shipped:** depends on severity. Critical issues (auth bypass, RCE, secret exposure) prioritized over feature work; lower-severity issues batched into the next planned release

Communication is best-effort — universal-memory is maintained part-time by a single author. Reports are not ignored, but the timeline is human-paced.

## Coordinated disclosure

The maintainer prefers coordinated disclosure:

- **Hold public details** until a fix has shipped and users have had a reasonable window to upgrade (typically 30 days for self-hosted deployments).
- **Credit** is offered in the release notes and the GitHub Security Advisory unless the reporter prefers anonymity.
- **CVE assignment** via GitHub's advisory flow if the issue warrants it.

If the maintainer is unresponsive for >30 days after acknowledgment without a documented reason, the reporter is welcome to disclose publicly.

## Supported versions

universal-memory is in `-alpha` until v1.0 ships. Security fixes target the latest tagged release.

| Version | Supported |
|---|---|
| `v0.8.0-alpha` (latest) | Yes |
| `v0.7.0-alpha` and earlier | No — please upgrade |

**Post-v1.0** the support window will widen — typically the latest minor + one previous minor for ~6 months. This document will be updated when v1.0 ships.

## In scope

Security issues affecting any of the following are in scope:

- **Memory server** (`server/`) — REST endpoints under `/api/*`, MCP HTTP layer at `/mcp`, `/metrics`, `/health`, OpenAPI spec at `/openapi.yaml`
- **Authentication** — bearer-token auth on `/api/*` and `/mcp`, loopback-bypass logic, header forwarding rules
- **Vault writes** — path traversal, symlink bypass, race conditions, frontmatter injection, untrusted-content boundaries
- **Bridge contract** — `<external-summary>` markers, REJECT-on-literal-marker logic, third-party-source injection
- **Plugin hooks** — Claude Code / Codex CLI hooks under `plugins/`, command injection in hook scripts, arbitrary file writes
- **Installer** — `installer/install*.sh`, `server/install.sh`, privilege escalation, arbitrary file writes outside the install target, secret exposure in process listings
- **CLI tools** — `bin/um`, `um-tunnel`, `um-bridge-claude-mem`, `um-preview` and friends; same shape concerns as the installer
- **Container surface** — image build, entrypoint guards, root+rw+writes refusal, Dockerfile package versions

## Out of scope

The following are **not** in scope for this project's security policy. Report them to the appropriate upstream:

- **mem0 OSS itself** — report to [mem0ai/mem0](https://github.com/mem0ai/mem0)
- **Qdrant** — report to [qdrant/qdrant](https://github.com/qdrant/qdrant)
- **LLM providers** (OpenAI, Anthropic, Google, Ollama) — report to the provider directly
- **Node, Docker, system packages** — report upstream
- **Attacks requiring an attacker-controlled vault directory** — the threat model assumes the operator trusts the configured vault root. An attacker who can write arbitrary files to the vault is already inside the trust boundary.
- **DoS via legitimate request volume** — universal-memory ships a per-IP token-bucket rate limiter with conservative defaults. If you exhaust it from a non-malicious workload, that is a configuration question, not a security report.
- **Issues only reproducible against `UM_MCP_WRITE_ENABLED=true`** when the operator has explicitly opted into the write surface — write tools are gated behind that flag for exactly this reason.
- **Theoretical concerns without a concrete failure mode** — a plausible-sounding "this could be unsafe" without a demonstrated attack path is not actionable.

## Known limitations

The items below are accepted limitations of the current release. They are documented here so operators can choose a deployment shape that compensates for them; they are not bugs.

**Qdrant write-access threat (v0.7+):** the embedding-provider stamp is stored as a doc inside the active Qdrant collection (`metadata.id: '_um_embedding_stamp'`). An actor with Qdrant write access can rewrite this stamp to bypass the §6.2 startup-guard mismatch detection. v0.7 ships without Qdrant auth; the assumed deployment shape is local-network or container-isolated Qdrant. When Qdrant auth lands (planned post-v1.0), this document will be updated and a signed-stamp scheme considered.

## Hardening notes for operators

If you are deploying universal-memory and want to minimize attack surface:

- **Bearer auth on by default** — set `UM_AUTH_TOKEN` to a strong random value. Don't expose `/api/*` or `/mcp` on a public network without a token.
- **`/metrics` is loopback-only by default** — keep it that way unless you have a specific reason. If you must expose it externally, put it behind your own auth proxy.
- **Run the container as a non-root user** matched to the vault directory's owner — set `UM_CONTAINER_USER` to your host UID. The container entrypoint refuses root + read-write + writes by default for exactly this reason.
- **Pin a release tag** rather than tracking `latest` in production. Review the changelog before upgrading.
- **Audit the vault directory** for unexpected files or stale frontmatter. Markdown is the source of truth; the vector store is a replaceable cache.

See [docs/architecture.md](docs/architecture.md) and [docs/observability.md](docs/observability.md) for the full operational picture.

## Contact

GitHub Private Vulnerability Reporting is the canonical channel. For non-security questions, open a regular issue.
