/**
 * system-docs-filter-integration.test.mjs — integration tests for the
 * system-docs filter wired into all read paths (DE3).
 *
 * Spec §6.1 requires the embedding-stamp doc to be excluded from every
 * user-facing read path. Three helpers cover all six surfaces (REST + MCP
 * delegate to these):
 *
 *   doList   → /api/list, memory_list
 *   doSearch → /api/search, memory_search
 *   doRecent → /api/recent/:project (REST only — MCP equivalent may not exist)
 *
 * Test stub notes:
 *   - doList / doSearch call into a memory client (DI via ctx.memory). A
 *     plain object stub with the right method (getAll / search) is enough.
 *   - doRecent reads the vault filesystem directly (authored/<project>/*.md);
 *     no memory client is consulted. The stub-based pattern from the plan
 *     does not exercise that code path, so this test seeds a temp vault
 *     containing both a real authored doc and a doc that would impersonate
 *     the stamp (filename + frontmatter id = '_um_embedding_stamp'). The
 *     spirit of the test (return both → expect only the real one out) is
 *     preserved while the assertion runs against the actual filesystem
 *     read path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { doList, doSearch, doRecent } from '../mem0-mcp-http.mjs';

const stampDoc = { metadata: { id: '_um_embedding_stamp', stamp: { provider: 'openai' } }, memory: 'stamp text' };
const realDoc = { metadata: { id: 'real-uuid', title: 'Real' }, memory: 'real content' };

test('doList(full, limit, ctx) excludes stamp doc', async () => {
  const memory = { getAll: async () => [stampDoc, realDoc] };
  const r = await doList(false, null, { memory });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].id, 'real-uuid');
});

test('doList full=true mode also filters stamp', async () => {
  const memory = { getAll: async () => [stampDoc, realDoc] };
  const r = await doList(true, null, { memory });
  assert.ok(!r.results.some((d) => d.metadata?.id === '_um_embedding_stamp'));
  assert.equal(r.results.length, 1);
});

test('doSearch(query, limit, includeSuperseded, full, ctx) excludes stamp doc', async () => {
  const memory = { search: async () => ({ results: [stampDoc, realDoc] }) };
  const r = await doSearch('query', 10, false, false, { memory }); // 5 args, ctx last
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].id, 'real-uuid');
});

test('doRecent excludes stamp doc from authored vault listing', async () => {
  // doRecent walks the vault filesystem; seed both a real doc and a stamp-shaped
  // doc to verify the filter rejects the latter.
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-de3-'));
  const prev = process.env.UM_VAULT_DIR;
  process.env.UM_VAULT_DIR = vault;
  try {
    const project = 'default-project';
    const dir = path.join(vault, 'authored', project);
    await fs.mkdir(dir, { recursive: true });

    // Real doc
    await fs.writeFile(
      path.join(dir, 'real-note.md'),
      `---\nid: real-note\ntitle: Real Note\n---\nReal body.\n`,
    );
    // Stamp-shaped doc — same id as the system stamp
    await fs.writeFile(
      path.join(dir, '_um_embedding_stamp.md'),
      `---\nid: _um_embedding_stamp\ntitle: Stamp\n---\nStamp body.\n`,
    );

    const r = await doRecent(project, 10, false, {});
    assert.ok(!r.results.some((d) => d.id === '_um_embedding_stamp'),
      'stamp doc must not appear in /api/recent results');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].id, 'real-note');
  } finally {
    if (prev === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = prev;
    await fs.rm(vault, { recursive: true, force: true });
  }
});
