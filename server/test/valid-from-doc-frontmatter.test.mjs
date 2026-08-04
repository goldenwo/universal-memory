/**
 * Tests for the doc-frontmatter `valid_from` default (spec step 3).
 *
 * Run with: node --test server/test/valid-from-doc-frontmatter.test.mjs
 *
 * Docs are the one class of point the write-side stamp deliberately does NOT
 * touch — a doc's event time is owned by its own frontmatter. That only holds
 * if the server default actually survives, and it did not: both builders
 * spread the caller's metadata AFTER the default, so `valid_from: null` from a
 * caller silently won and the doc landed with no usable event time —
 * permanently ungradeable by temporal ranking, which reads this field and
 * nothing else.
 *
 * These route through handleToolCall against a real temp vault rather than
 * unit-testing an extracted helper, because the frontmatter objects are built
 * inline in the handlers and the ordering IS the behaviour under test.
 * reindexDoc fails harmlessly here (no qdrant) and the handler tolerates that
 * by design — `indexed: false` — so the vault write still happens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from './helpers/tmpdir.mjs';
import { handleToolCall } from '../mem0-mcp-http.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { isUsableDate } from '../lib/ranking.mjs';

/** Run `fn` with a throwaway vault and MCP writes enabled. */
async function withVault(fn) {
  const dir = tempDir('um-vf-doc-');
  const savedVault = process.env.UM_VAULT_DIR;
  const savedWrite = process.env.UM_MCP_WRITE_ENABLED;
  process.env.UM_VAULT_DIR = dir;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  try {
    return await fn(dir);
  } finally {
    if (savedVault === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = savedVault;
    if (savedWrite === undefined) delete process.env.UM_MCP_WRITE_ENABLED;
    else process.env.UM_MCP_WRITE_ENABLED = savedWrite;
  }
}

const readFm = async (dir, rel) =>
  parseFrontmatter(await fs.readFile(path.join(dir, rel), 'utf8')).frontmatter;

async function capture(metadata, content = 'body text') {
  return JSON.parse(await handleToolCall('memory_capture', { content, metadata }, {}));
}

// ── memory_capture ──────────────────────────────────────────────────────────

test('capture: caller valid_from:null does NOT defeat the server default', async () => {
  await withVault(async (dir) => {
    const out = await capture({ type: 'fact', id: 'vf-null', title: 'T', project: 'p', valid_from: null });
    const fm = await readFm(dir, out.path);
    assert.ok(isUsableDate(fm.valid_from), `expected a usable date, got ${JSON.stringify(fm.valid_from)}`);
  });
});

test('capture: caller valid_from:"" does NOT defeat the server default', async () => {
  await withVault(async (dir) => {
    const out = await capture({ type: 'fact', id: 'vf-empty', title: 'T', project: 'p', valid_from: '' });
    const fm = await readFm(dir, out.path);
    assert.ok(isUsableDate(fm.valid_from), `expected a usable date, got ${JSON.stringify(fm.valid_from)}`);
  });
});

test('capture: a USABLE caller valid_from still wins', async () => {
  await withVault(async (dir) => {
    const supplied = '2019-05-06T07:08:09.000Z';
    const out = await capture({ type: 'fact', id: 'vf-keep', title: 'T', project: 'p', valid_from: supplied });
    const fm = await readFm(dir, out.path);
    assert.equal(fm.valid_from, supplied);
  });
});

test('capture: no valid_from at all → server default applied', async () => {
  await withVault(async (dir) => {
    const out = await capture({ type: 'fact', id: 'vf-absent', title: 'T', project: 'p' });
    const fm = await readFm(dir, out.path);
    assert.ok(isUsableDate(fm.valid_from));
  });
});

// ── memory_supersede ────────────────────────────────────────────────────────

/** Seed an old doc, then supersede it with `newDoc`. Returns both frontmatters. */
async function supersedePair(dir, newDoc) {
  const old = await capture({ type: 'fact', id: 'vf-old', title: 'Old', project: 'p' });
  const raw = await handleToolCall(
    'memory_supersede',
    { old_id: 'vf-old', new_doc: { type: 'fact', title: 'New', content: 'new body', project: 'p', ...newDoc } },
    {},
  );
  const out = JSON.parse(raw);
  assert.notEqual(out.error, true, `supersede failed: ${raw}`);
  return { newFm: await readFm(dir, out.path ?? `authored/p/${newDoc.id}.md`), oldFm: await readFm(dir, old.path) };
}

test('supersede: caller valid_from:null does NOT defeat the server default', async () => {
  await withVault(async (dir) => {
    const { newFm } = await supersedePair(dir, { id: 'vf-new-null', valid_from: null });
    assert.ok(isUsableDate(newFm.valid_from), `expected a usable date, got ${JSON.stringify(newFm.valid_from)}`);
  });
});

test('supersede: a USABLE caller valid_from still wins', async () => {
  await withVault(async (dir) => {
    const supplied = '2019-05-06T07:08:09.000Z';
    const { newFm } = await supersedePair(dir, { id: 'vf-new-keep', valid_from: supplied });
    assert.equal(newFm.valid_from, supplied);
  });
});

test('supersede: supersedes:[old_id] survives the reordering', async () => {
  // `supersedes` is deliberately last in the object so a caller cannot override
  // it. Moving the default below the spread must not disturb that. It is
  // openapi-declared but was previously untested.
  await withVault(async (dir) => {
    const { newFm } = await supersedePair(dir, { id: 'vf-new-link', valid_from: null });
    assert.deepEqual(newFm.supersedes, ['vf-old']);
  });
});

test('supersede: a caller cannot override supersedes', async () => {
  await withVault(async (dir) => {
    const { newFm } = await supersedePair(dir, { id: 'vf-new-evil', supersedes: ['not-the-old-doc'] });
    assert.deepEqual(newFm.supersedes, ['vf-old'], 'server-owned linkage must win');
  });
});

test('supersede: the defaulted valid_from reuses the SAME now as invalidated_at', async () => {
  // Both come from one clock read on purpose — the new doc becoming valid and
  // the old one being invalidated are the same instant, and a second
  // Date.now() would let them disagree.
  await withVault(async (dir) => {
    const { newFm, oldFm } = await supersedePair(dir, { id: 'vf-new-now', valid_from: null });
    assert.equal(newFm.valid_from, oldFm.invalidated_at);
  });
});
