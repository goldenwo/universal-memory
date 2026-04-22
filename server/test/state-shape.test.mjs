/**
 * state-shape.test.mjs — DI-based guard for /api/state/{project} response shape.
 *
 * Guards against B.1 accidentally reshaping /api/state/{project} to a compact
 * shape (which would break session-start.sh's state.md injection — spec §7.4
 * session-continuity pillar).
 *
 * Tests doState() exported from mem0-mcp-http.mjs directly, using the same DI
 * pattern as search-quality.test.mjs. The server is never started — IS_MAIN
 * guards prevent bootstrap on import.
 *
 * Coverage:
 *   - full body returned via state:{body} for a seeded project (not a snippet)
 *   - no 'snippet' field leaked into state or top-level response
 *   - state:null returned for an unknown project (ENOENT path preserved)
 *   - invalid project name rejected with a clear error message
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { doState } from '../mem0-mcp-http.mjs';

async function withTempVault(fn) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-state-shape-'));
  const prev = process.env.UM_VAULT_DIR;
  process.env.UM_VAULT_DIR = vault;
  try { await fn(vault); }
  finally {
    if (prev === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = prev;
    await fs.rm(vault, { recursive: true, force: true });
  }
}

test('doState returns full body via state:{body} for seeded project', async () => {
  await withTempVault(async (vault) => {
    const stateFile = path.join(vault, 'state', 'test-proj', 'state.md');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(
      stateFile,
      '---\nvalid_from: 2026-04-21\n---\nbody content here\n',
    );

    const result = JSON.parse(await doState('test-proj'));
    assert.strictEqual(result.ok, true);
    assert.ok(result.state && typeof result.state === 'object',
      'state must be an object for a seeded project');
    assert.strictEqual(typeof result.state.body, 'string',
      'state.body must be a string (full body, not a snippet)');
    // Guard against compact-shape leak from /api/search + /api/list.
    assert.ok(!('snippet' in result.state),
      'state must NOT emit a snippet field');
    assert.ok(!('snippet' in result),
      'top-level response must NOT emit a snippet field');
  });
});

test('doState returns state:null for unknown project (ENOENT path preserved)', async () => {
  await withTempVault(async () => {
    const result = JSON.parse(await doState('nonexistent-project-xyz'));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state, null);
    assert.strictEqual(result.valid_from, null);
  });
});

test('doState rejects invalid project name', async () => {
  await withTempVault(async () => {
    await assert.rejects(
      () => doState('../escape'),
      /Invalid project name/,
    );
  });
});
