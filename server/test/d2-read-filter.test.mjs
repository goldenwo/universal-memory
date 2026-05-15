/**
 * server/test/d2-read-filter.test.mjs — D2 lane/persona read filter tests.
 *
 * Covers spec §8 T19–T22 for the qdrant-backed `memory_search` MCP tool
 * and REST `POST /api/search` endpoint. Pre-D2 points (no lane/persona
 * key on the metadata) MUST be excluded when an explicit filter is set
 * — that's the operator-visible new behavior documented in
 * `docs/mcp-tools.md`.
 *
 * Uses the same ephemeral-port HTTP harness as
 * `test/mcp-wire-shape.test.mjs`; mocks `memory.search` to return canned
 * results so the test exercises ONLY the post-filter logic at
 * mem0-mcp-http.mjs:~748 (MCP) and `:~2156` (REST).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

async function startServer(ctx) {
  const handler = createRequestHandler(ctx);
  const srv = createServer(handler);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

// 4 canned results: pre-D2 point (no lane / persona), work-engineer,
// personal-engineer, work-parent. Mock memory.search returns all four
// regardless of args.
function makeMockMemoryWithFourPoints() {
  return {
    search: async () => ({
      results: [
        {
          id: 'pre-d2-point',
          memory: 'legacy fact',
          metadata: { id: 'doc-legacy', title: 'Legacy doc', project: 'p' },
          score: 0.91,
        },
        {
          id: 'doc-work-eng',
          memory: 'I write Go at work',
          metadata: { id: 'doc-work-eng', title: 'Work Eng', project: 'p', lane: 'work', persona: 'engineer' },
          score: 0.88,
        },
        {
          id: 'personal-engineer-point',
          memory: 'I write Rust on weekends',
          metadata: { id: 'doc-personal-eng', title: 'Personal Eng', project: 'p', lane: 'personal', persona: 'engineer' },
          score: 0.85,
        },
        {
          id: 'doc-work-parent',
          memory: 'I picked up daughter from daycare',
          metadata: { id: 'doc-work-parent', title: 'Work Parent', project: 'p', lane: 'work', persona: 'parent' },
          score: 0.80,
        },
      ],
    }),
  };
}

async function callMcpSearch(origin, filters) {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'test', limit: 10, full: true, filters } },
    }),
  });
  assert.equal(res.status, 200);
  const env = await res.json();
  // text content block → inner JSON envelope
  const inner = JSON.parse(env.result.content[0].text);
  return inner.results;
}

async function callRestSearch(origin, filters) {
  const res = await fetch(`${origin}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test', limit: 10, full: true, filters }),
  });
  assert.equal(res.status, 200);
  const env = await res.json();
  return env.results;
}

test('T19: MCP memory_search filters.lane returns only matching points (AND-combined with project)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const items = await callMcpSearch(origin, { lane: 'work' });
    const ids = items.map((r) => r.id).sort();
    assert.deepEqual(ids, ['doc-work-eng', 'doc-work-parent'].sort(),
      'lane=work must return both work-* points; legacy + personal must be excluded');
  } finally {
    await close();
  }
});

test('T20: MCP memory_search WITHOUT filters returns ALL points (no implicit filter)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const items = await callMcpSearch(origin, undefined);
    assert.equal(items.length, 4, 'no filter → all 4 points');
  } finally {
    await close();
  }
});

test('T21: explicit filters.lane excludes legacy points (no lane key on payload)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const items = await callMcpSearch(origin, { lane: 'work' });
    const ids = items.map((r) => r.id);
    assert.ok(!ids.includes('doc-legacy'),
      'pre-D2 point (no lane key) must be excluded when filters.lane is set');
  } finally {
    await close();
  }
});

test('T22a: persona filter AND-combines with lane filter (only intersection)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const items = await callMcpSearch(origin, { lane: 'work', persona: 'engineer' });
    const ids = items.map((r) => r.id);
    assert.deepEqual(ids, ['doc-work-eng'],
      'lane=work AND persona=engineer must match only work-engineer-point');
  } finally {
    await close();
  }
});

test('T22b: invalid lane slug → INPUT_INVALID (write-side validator parity)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'memory_search',
          arguments: { query: 'test', filters: { lane: 'work/bad' } },
        },
      }),
    });
    assert.equal(res.status, 200, 'MCP wraps errors in 200 + JSON-RPC error');
    const env = await res.json();
    // MCP tools/call error path: result.isError = true with message in content[0].text
    assert.ok(env.result?.isError || /INPUT_INVALID|lane must match/.test(JSON.stringify(env)),
      `expected INPUT_INVALID for bad lane slug; got ${JSON.stringify(env)}`);
  } finally {
    await close();
  }
});

test('T22c: REST POST /api/search supports body.filters.lane post-filter (parity with MCP)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const items = await callRestSearch(origin, { lane: 'work', persona: 'parent' });
    const ids = items.map((r) => r.id);
    assert.deepEqual(ids, ['doc-work-parent'],
      'REST POST /api/search body.filters.{lane,persona} must AND-combine');
  } finally {
    await close();
  }
});

test('T22d: REST POST /api/search rejects bad lane slug with 400 INPUT_INVALID', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithFourPoints() });
  try {
    const res = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', filters: { lane: 'work/bad' } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    // errorResponse() shape: { ok: false, error: { code, message, retryable } }
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'INPUT_INVALID');
    assert.match(body.error.message, /lane must match/);
  } finally {
    await close();
  }
});
