/**
 * server/test/d3-read-filter.test.mjs — D3 superseded-status read-filter regression guards.
 *
 * Pins the three behaviors D3 auto-supersession depends on (spec D3.1 T1.5):
 *
 *   (a) A `status:'superseded'` atomic fact is EXCLUDED from the default
 *       `memory_search` / `doSearch` path.
 *   (b) The SAME fact IS returned when `include_superseded:true`.
 *   (c) A fact with NO `status` key (pre-D3 point) is ALWAYS returned on the
 *       default path — absence-tolerance regression guard. This has teeth: it
 *       would fail if the filter were `md.status !== 'current'` instead of the
 *       strict `=== 'superseded'` guard that actually lives in the code.
 *
 * Uses the same ephemeral-port HTTP harness as `d2-read-filter.test.mjs`:
 * `createRequestHandler(ctx)` with `ctx.memory` mocked to return canned qdrant
 * records.  Tests exercise the REAL `doSearch` post-filter at
 * mem0-mcp-http.mjs:1541-1551 — not a stub that returns hand-filtered data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

// ── Shared HTTP harness (identical to d2-read-filter.test.mjs) ──────────────

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

/**
 * Three canned qdrant records:
 *
 *   - "superseded-point"  — metadata.status === 'superseded'  (D3 post-supersession state)
 *   - "current-point"     — metadata.status === 'current'     (normal D3 active fact)
 *   - "pre-d3-point"      — no `status` key at all             (pre-D3 legacy fact)
 *
 * Mock memory.search returns all three regardless of args — the interesting
 * behavior is entirely in doSearch's post-filter logic, which we want to
 * exercise directly.
 */
function makeMockMemoryWithThreePoints() {
  return {
    search: async () => ({
      results: [
        {
          id: 'superseded-uuid',
          memory: 'I used to prefer tabs',
          metadata: {
            id: 'superseded-point',
            title: 'Indentation preference (old)',
            project: 'p',
            status: 'superseded',
            supersededBy: 'current-uuid',
            supersededAt: '2026-05-16T00:00:00Z',
          },
          score: 0.92,
        },
        {
          id: 'current-uuid',
          memory: 'I prefer spaces',
          metadata: {
            id: 'current-point',
            title: 'Indentation preference (current)',
            project: 'p',
            status: 'current',
          },
          score: 0.91,
        },
        {
          id: 'pre-d3-uuid',
          memory: 'legacy fact with no status key',
          metadata: {
            id: 'pre-d3-point',
            title: 'Pre-D3 legacy fact',
            project: 'p',
            // intentionally no `status` key — simulates a point written before D3
          },
          score: 0.85,
        },
      ],
    }),
  };
}

// ── MCP + REST helpers (mirrored from d2-read-filter.test.mjs) ───────────────

async function callMcpSearch(origin, extraArgs = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: { query: 'test', limit: 10, full: true, ...extraArgs },
      },
    }),
  });
  assert.equal(res.status, 200);
  const env = await res.json();
  // text content block → inner JSON envelope (same decoding as d2-read-filter)
  const inner = JSON.parse(env.result.content[0].text);
  return inner.results;
}

async function callRestSearch(origin, extraParams = {}) {
  const res = await fetch(`${origin}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test', limit: 10, full: true, ...extraParams }),
  });
  assert.equal(res.status, 200);
  const env = await res.json();
  return env.results;
}

// ── Test (a) — superseded fact is EXCLUDED on the default path ───────────────

test('T25a-mcp: status=superseded fact is excluded from default memory_search (MCP)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callMcpSearch(origin);
    const ids = items.map((r) => r.id);
    assert.ok(
      !ids.includes('superseded-point'),
      `superseded-point must be excluded on default path; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});

test('T25a-rest: status=superseded fact is excluded from default POST /api/search (REST)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callRestSearch(origin);
    const ids = items.map((r) => r.id);
    assert.ok(
      !ids.includes('superseded-point'),
      `superseded-point must be excluded on default REST path; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});

// ── Test (b) — superseded fact IS returned with include_superseded:true ──────

test('T25b-mcp: status=superseded fact IS returned with include_superseded:true (MCP)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callMcpSearch(origin, { include_superseded: true });
    const ids = items.map((r) => r.id);
    assert.ok(
      ids.includes('superseded-point'),
      `superseded-point must appear when include_superseded:true; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});

test('T25b-rest: status=superseded fact IS returned with include_superseded:true (REST)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callRestSearch(origin, { include_superseded: true });
    const ids = items.map((r) => r.id);
    assert.ok(
      ids.includes('superseded-point'),
      `superseded-point must appear when include_superseded:true via REST; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});

// ── Test (c) — no-status (pre-D3) fact is ALWAYS returned (absence-tolerance) ─
//
// This test has teeth: if the filter logic used `md.status !== 'current'`
// (opposite polarity — exclude everything that isn't explicitly 'current')
// instead of the strict `md.status === 'superseded'` exclusion, the pre-D3
// point (md.status === undefined) would be wrongly excluded and BOTH these
// sub-tests would fail.  The current code's explicit-equality guards mean
// absence ≠ exclusion, which is the load-bearing backward-compat property.

test('T25c-default: pre-D3 fact (no status key) is returned on default path (MCP)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callMcpSearch(origin);
    const ids = items.map((r) => r.id);
    assert.ok(
      ids.includes('pre-d3-point'),
      `pre-D3 point (no status key) must always be returned on default path; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});

test('T25c-include: pre-D3 fact (no status key) is returned with include_superseded:true (MCP)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callMcpSearch(origin, { include_superseded: true });
    const ids = items.map((r) => r.id);
    assert.ok(
      ids.includes('pre-d3-point'),
      `pre-D3 point must also be present with include_superseded:true; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});

// ── Bonus: confirm current-point (status:'current') is returned by default ───
// Belt-and-suspenders: proves the filter does not over-exclude active facts.

test('T25d: status=current fact is NOT excluded on default path (sanity)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callMcpSearch(origin);
    const ids = items.map((r) => r.id);
    assert.ok(
      ids.includes('current-point'),
      `current-point must always be visible on default path; got ids: ${ids.join(', ')}`,
    );
  } finally {
    await close();
  }
});
