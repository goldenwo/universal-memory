/**
 * search-quality.test.mjs — DI-based tests for GET /api/recent/{project}.
 *
 * Tests the doRecent() function exported from mem0-mcp-http.mjs directly,
 * using the DI pattern established by decay-integration.test.mjs. The server
 * is never started — IS_MAIN guards prevent bootstrap on import.
 *
 * Coverage:
 *   - compact shape by default (id, title, snippet — no body)
 *   - full body returned when full=true
 *   - limit honored
 *   - recency order (mtime desc)
 *   - invalid project name rejected
 *   - unknown project returns empty array
 *   - snippet length honors N from snippet-design.json fixture
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNIPPET_DESIGN = JSON.parse(readFileSync(
  path.resolve(__dirname, 'fixtures/snippet-design.json'),
  'utf8'
));
const SNIPPET_N = SNIPPET_DESIGN.snippet.N;

import { doRecent } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempVault(fn) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-recent-'));
  const prev = process.env.UM_VAULT_DIR;
  process.env.UM_VAULT_DIR = vault;
  try { await fn(vault); }
  finally {
    if (prev === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = prev;
    await fs.rm(vault, { recursive: true, force: true });
  }
}

async function seedMemory(vault, project, filename, title, body, mtime) {
  const filePath = path.join(vault, 'authored', project, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = `---\nid: ${filename.replace(/\.md$/, '')}\ntitle: ${title}\n---\n${body}\n`;
  await fs.writeFile(filePath, content);
  if (mtime) await fs.utimes(filePath, mtime, mtime);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('doRecent returns compact shape (id, title, snippet, no body) by default', async () => {
  await withTempVault(async (vault) => {
    await seedMemory(vault, 'test-proj', 'old-note.md', 'Old Note',
      'Body of old note '.repeat(30), new Date('2026-01-01'));
    await seedMemory(vault, 'test-proj', 'new-note.md', 'New Note',
      'Body of new note '.repeat(30), new Date('2026-04-20'));
    await seedMemory(vault, 'test-proj', 'newest-note.md', 'Newest Note',
      'Body of newest note '.repeat(30), new Date('2026-04-21'));

    const result = await doRecent('test-proj', 3, false);
    assert.ok(Array.isArray(result.results), 'results must be an array');
    assert.strictEqual(result.results.length, 3, 'limit=3 should return 3');

    // Recency order: newest first
    assert.strictEqual(result.results[0].id, 'newest-note');
    assert.strictEqual(result.results[1].id, 'new-note');
    assert.strictEqual(result.results[2].id, 'old-note');

    for (const r of result.results) {
      assert.ok(r.id, 'id must be present');
      assert.ok(r.title, 'title must be present');
      assert.ok(r.snippet, 'snippet must be present');
      assert.strictEqual(typeof r.snippet, 'string');
      assert.ok(!('body' in r), 'body must NOT be present without full=true');
    }
  });
});

test('doRecent returns full body when full=true', async () => {
  await withTempVault(async (vault) => {
    await seedMemory(vault, 'test-proj', 'note.md', 'Note', 'Full body text here.', new Date());
    const result = await doRecent('test-proj', 1, true);
    assert.strictEqual(result.results.length, 1);
    assert.ok(result.results[0].body, 'body must be present with full=true');
    assert.strictEqual(typeof result.results[0].body, 'string');
  });
});

test('doRecent honors limit', async () => {
  await withTempVault(async (vault) => {
    for (let i = 0; i < 5; i++) {
      await seedMemory(vault, 'test-proj', `note-${i}.md`, `Note ${i}`, 'body', new Date(Date.now() - i * 1000));
    }
    const result = await doRecent('test-proj', 2, false);
    assert.strictEqual(result.results.length, 2);
  });
});

test('doRecent rejects invalid project name', async () => {
  await assert.rejects(
    () => doRecent('../escape', 5, false),
    /Invalid project name/,
  );
});

test('doRecent returns empty for unknown project', async () => {
  await withTempVault(async () => {
    const result = await doRecent('nonexistent-project', 5, false);
    assert.ok(Array.isArray(result.results));
    assert.strictEqual(result.results.length, 0);
  });
});

test('snippet honors N from snippet-design.json fixture', async () => {
  await withTempVault(async (vault) => {
    const longBody = 'x'.repeat(SNIPPET_N * 3);
    await seedMemory(vault, 'test-proj', 'long.md', 'Long Memory', longBody, new Date());
    const result = await doRecent('test-proj', 1, false);
    assert.strictEqual(result.results.length, 1);
    // snippet = title + N chars of body (format per snippet-design.json)
    // Body "xxxx..." has no meaningful shape to trim — assert length constraint only.
    const snippet = result.results[0].snippet;
    assert.ok(snippet.length <= SNIPPET_N + 'Long Memory'.length + 10,
      `snippet length ${snippet.length} should be ~≤ N+title+ellipsis`);
  });
});
