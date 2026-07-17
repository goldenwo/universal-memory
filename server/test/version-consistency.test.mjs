/**
 * Cross-manifest version-drift gate.
 *
 * Mechanizes the #86 release-audit check: v1.1.0 was nearly tagged with
 * server/package.json frozen, and the v1.2.0 flip review caught the claude-code
 * plugin manifest stale at 1.1.0 — both found by MANUAL audit, not CI. This test
 * fails CI if a release artifact's version drifts from the server's single source.
 *
 * Policy (which manifests track the server release version):
 *   - server/package.json                                      → the single source (server/lib/version.mjs reads it)
 *   - plugins/claude-code/.../.claude-plugin/plugin.json       → MUST track (user-installed; bumped at every prior tag)
 *   - .claude-plugin/marketplace.json (universal-memory entry)  → MUST track (what `claude plugin install` advertises — #159 T8)
 *   - plugins/codex/.../.codex-plugin/plugin.json              → intentionally EXCLUDED (tracks v0.7, config-only — issue #17)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const versionOf = (rel) => JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')).version;

test('version drift gate: claude-code plugin manifest tracks server/package.json', () => {
  const server = versionOf('server/package.json');
  const ccPlugin = versionOf('plugins/claude-code/universal-memory/.claude-plugin/plugin.json');
  assert.equal(
    ccPlugin,
    server,
    `claude-code plugin.json version (${ccPlugin}) must equal server/package.json (${server}). ` +
    `Bump it on every release — this gate mechanizes the #86 / v1.2 release-audit finding.`,
  );
});

test('version drift gate: marketplace.json plugin entry tracks server/package.json', () => {
  const server = versionOf('server/package.json');
  const marketplace = JSON.parse(
    readFileSync(resolve(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
  );
  const entry = marketplace.plugins.find((p) => p.name === 'universal-memory');
  assert.ok(entry, 'marketplace.json must list the universal-memory plugin');
  assert.equal(
    entry.version,
    server,
    `marketplace.json universal-memory entry version (${entry?.version}) must equal ` +
    `server/package.json (${server}) — a stale marketplace entry advertises the wrong release to installers.`,
  );
});
