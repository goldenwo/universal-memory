import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doList } from '../mem0-mcp-http.mjs';

// Stub memory client so the unit test does not require live mem0 env.
const fakeMemory = { getAll: async () => ({ results: [{ id: 'a', memory: 'hello', metadata: { id: 'a', title: 't' } }] }) };
// #231 mem0 3.x seam: doList enumerates through ctx._umGetAll (native qdrant
// scroll in production) instead of memory.getAll — bridge it back onto the
// same stub so the envelope contract below is unchanged.
const ctx = { memory: fakeMemory, _umGetAll: async (m, a) => m.getAll(a) };

test('/api/list handler returns {results:[...]} envelope', async () => {
  const items = await doList(false, 5, ctx);
  assert.ok(typeof items === 'object' && !Array.isArray(items), 'response must be object, not bare array');
  assert.ok(Array.isArray(items.results), 'must have results array');
});

test('/api/list handler ?full=1 preserves envelope', async () => {
  const items = await doList(true, 5, ctx);
  assert.ok(Array.isArray(items.results));
});
