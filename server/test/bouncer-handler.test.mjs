import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleToolCall } from '../mem0-mcp-http.mjs';

// Mock memory client (the ctx.memory DI seam doSearch honors). Returns full-shape rows.
const mockMemory = (results) => ({ search: async () => ({ results }) });
const rows = [
  { id: 'A', score: 0.4, memory: 'body A', metadata: { id: 'A', title: 'A', project: 'x' } },
  { id: 'B', score: 0.3, memory: 'body B', metadata: { id: 'B', title: 'B', project: 'y' } },
];
// Injected bounce stub via ctx._bounceTopHit — flags whatever topItem it is GIVEN.
const flagStub = (seen) => async (_q, topItem) => { seen.push(topItem); return { answered: false, ok: true, graded: true }; };

test('recall-safety: results identical with bouncer on vs off (only `answered` differs)', async () => {
  const ctx = { memory: mockMemory(rows) };
  const off = JSON.parse(await handleToolCall('memory_search', { query: 'q', full: true }, ctx));
  const on = JSON.parse(await handleToolCall('memory_search', { query: 'q', full: true }, { ...ctx, _bounceTopHit: async () => ({ answered: false, ok: true, graded: true }) }));
  assert.deepEqual(on.results, off.results);            // items/order/length unchanged
  assert.equal(on.answered, false);
  assert.equal('answered' in off, false);
});

test('flag↔surfaced: with filters.project=y the flag describes the SURFACED top (B), not A', async () => {
  const seen = [];
  const ctx = { memory: mockMemory(rows), _bounceTopHit: flagStub(seen) };
  const out = JSON.parse(await handleToolCall('memory_search', { query: 'q', full: true, filters: { project: 'y' } }, ctx));
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, 'B');                 // A filtered out
  assert.equal(seen[0].id, 'B');                        // graded the SURFACED hit, not A
  assert.equal(out.answered, false);
});

test('answered outcome emits NO sibling', async () => {
  const ctx = { memory: mockMemory(rows), _bounceTopHit: async () => ({ answered: true, ok: true, graded: true }) };
  const out = JSON.parse(await handleToolCall('memory_search', { query: 'q', full: true }, ctx));
  assert.equal('answered' in out, false);
});

test('empty results: no flag, results stay [], helper not called', async () => {
  const ctx = { memory: mockMemory([]), _bounceTopHit: async () => { throw new Error('should not be called'); } };
  const out = JSON.parse(await handleToolCall('memory_search', { query: 'q', full: true }, ctx));
  assert.deepEqual(out.results, []);
  assert.equal('answered' in out, false);
});

test('only_superseded is NOT bounced', async () => {
  const sup = [{ id: 'S', score: 0.4, memory: 'b', metadata: { id: 'S', status: 'superseded' } }];
  const ctx = { memory: mockMemory(sup), _bounceTopHit: async () => { throw new Error('should not be called'); } };
  const out = JSON.parse(await handleToolCall('memory_search', { query: 'q', only_superseded: true, full: true }, ctx));
  assert.equal('answered' in out, false);               // helper never invoked
});
