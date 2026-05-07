# Plugin marketplace listing — submission notes

**Status (2026-05-07):** plugin manifest is listing-ready. Submission deferred until repo flips public per the v1.0 plan (W5.3).

This document captures the research from v1.0 plan W5.1 + W5.2 so the maintainer doesn't have to re-derive it at submission time. Sources cited inline.

## Manifest readiness check

`plugins/claude-code/universal-memory/.claude-plugin/plugin.json` carries all the fields the marketplace listing schema asks for:

| Field | Required by schema | Status |
|---|---|---|
| `$schema` | recommended for editor validation | ✅ Set to `https://json.schemastore.org/claude-code-plugin-manifest.json` |
| `name` | yes | ✅ `universal-memory` (kebab-case unique identifier) |
| `version` | recommended | ✅ Bumps with each release tag (currently `0.7.0-alpha`; bump to `1.0.0` at v1.0 tag time per W7.1) |
| `description` | recommended | ✅ Single-paragraph elevator pitch |
| `author` | recommended | ✅ `name` + `url` + GitHub-noreply `email` |
| `homepage` | recommended | ✅ Points at the public repo URL |
| `repository` | recommended | ✅ Same |
| `license` | recommended | ✅ `MIT` (matches root LICENSE; W4.5-audited) |
| `keywords` | recommended | ✅ 10 lowercase-hyphenated terms (memory, mem0, context, cross-session, self-hosted, markdown, mcp, session-continuity, claude-code, rag) |

**Email choice:** the `author.email` field uses the GitHub-noreply form (`68965162+goldenwo@users.noreply.github.com`) rather than a personal email. Rationale: the W4.1 secrets audit confirmed no personal email is in repo history (a prior `git filter-repo` pass scrubbed it). Using the noreply form keeps the public-by-design surface that's already exposed via commit author metadata; adding a personal email would re-introduce a leak.

## What's intentionally NOT in plugin.json

Per the official Claude Code plugin manifest schema (verified 2026-05-07):

- **`categories` / `tags`** — not yet supported in plugin.json. These are marketplace-level, not manifest-level. Discovery tags live in `keywords`.
- **`screenshots` / `iconUrl`** — not yet supported in plugin.json (2026-05-07).
- **`minimumClaudeCodeVersion`** — not in the schema. Version-pinning is handled by the marketplace, not the manifest.

If any of these become first-class manifest fields in a future Claude Code release, this doc gets updated and the plugin.json gets the additions.

## Submission flow (when repo is public)

Per [code.claude.com/docs/en/plugins.md](https://code.claude.com/docs/en/plugins.md), submission is form-driven:

- **Claude.ai (web):** [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit)
- **Console:** [platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit)

Either form should accept the existing GitHub repo URL + the `plugins/claude-code/universal-memory/` path. No formal review process is publicly documented beyond the form itself.

## Pre-submission validation

Run before submitting:

```bash
# 1. Validate the plugin manifest from inside a Claude Code session
/plugin validate

# 2. Or via the CLI (if available in your Claude Code version)
claude plugin validate plugins/claude-code/universal-memory/

# 3. Make sure the plugin README is current
cat plugins/claude-code/universal-memory/README.md
```

The README inside the plugin dir is what marketplace browsers see; it should:

- Open with the elevator pitch (matches `description`)
- Document install (the plugin marketplace will provide the install command, but a fallback `extraKnownMarketplaces` snippet helps users with custom marketplace routes)
- Document configuration env vars (`UM_ENDPOINT`, `UM_VAULT_DIR`, `UM_AUTH_TOKEN`, `UM_OPENAI_API_KEY`)
- Link to the project root `README.md` for the full surface (server install, MCP tools, CLI, etc.)
- Link to `LICENSE` (MIT)

The current `plugins/claude-code/universal-memory/README.md` covers the first three; double-check the top-level README link before submission.

## What happens if the marketplace conventions change

The Claude Code plugin marketplace is a moving target. Re-read the current docs at submission time:

- `https://code.claude.com/docs/en/plugins.md` — main plugin guide
- `https://code.claude.com/docs/en/plugins-reference.md` — manifest schema
- `https://code.claude.com/docs/en/plugin-marketplaces.md` — marketplace distribution

If any new field is required by the latest schema, add it to plugin.json before submitting.

## Tracking

| v1.0 plan task | Status |
|---|---|
| W5.1 — read marketplace conventions | ✅ Done (this doc captures the findings) |
| W5.2 — verify plugin.json schema match | ✅ Done — `$schema` + `author.url` + `author.email` (noreply) + 4 keywords added |
| W5.3 — submit / register | Deferred until repo public (W4-flip-dependent) |
