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

// ═══════════════════════════════════════════════════════════════════════════════
// T1.6 — only_superseded two-mode listing + pagination (D3.1)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rich mock used exclusively by T1.6 tests.
 *
 * Six qdrant records across two lanes ('work', 'personal') and one no-lane point:
 *
 *   sup-work-a    lane:work,    status:superseded, supersededAt:'2026-05-16T10:00:00Z'
 *   sup-work-b    lane:work,    status:superseded, supersededAt:'2026-05-16T08:00:00Z'
 *   sup-personal  lane:personal,status:superseded, supersededAt:'2026-05-16T06:00:00Z'
 *   cur-work      lane:work,    status:current
 *   pre-d3-work   lane:work,    no status key
 *   sup-tie-1     lane:work,    status:superseded, supersededAt:'2026-05-15T00:00:00Z', id-alpha-order:'sup-tie-1'
 *   sup-tie-2     lane:work,    status:superseded, supersededAt:'2026-05-15T00:00:00Z', id-alpha-order:'sup-tie-2'
 *
 * Mock always returns ALL records; real handler does ALL filtering/sorting.
 */
function makeMockMemoryForT16() {
  return {
    search: async () => ({
      results: [
        {
          id: 'sup-work-a-uuid',
          memory: 'We used tabs at work (old)',
          metadata: {
            id: 'sup-work-a',
            title: 'Work pref A (old)',
            project: 'p',
            lane: 'work',
            persona: 'engineer',
            status: 'superseded',
            supersededBy: 'cur-work-uuid',
            supersededAt: '2026-05-16T10:00:00Z',
          },
          score: 0.95,
        },
        {
          id: 'sup-work-b-uuid',
          memory: 'We used camelCase at work (old)',
          metadata: {
            id: 'sup-work-b',
            title: 'Work pref B (old)',
            project: 'p',
            lane: 'work',
            persona: 'engineer',
            status: 'superseded',
            supersededBy: 'cur-work-uuid',
            supersededAt: '2026-05-16T08:00:00Z',
          },
          score: 0.90,
        },
        {
          id: 'sup-personal-uuid',
          memory: 'I used VIM (old)',
          metadata: {
            id: 'sup-personal',
            title: 'Personal pref (old)',
            project: 'p',
            lane: 'personal',
            persona: 'hacker',
            status: 'superseded',
            supersededBy: 'some-uuid',
            supersededAt: '2026-05-16T06:00:00Z',
          },
          score: 0.88,
        },
        {
          id: 'cur-work-uuid',
          memory: 'We use spaces at work',
          metadata: {
            id: 'cur-work',
            title: 'Work pref current',
            project: 'p',
            lane: 'work',
            status: 'current',
          },
          score: 0.85,
        },
        {
          id: 'pre-d3-work-uuid',
          memory: 'legacy work fact',
          metadata: {
            id: 'pre-d3-work',
            title: 'Pre-D3 work fact',
            project: 'p',
            lane: 'work',
            // intentionally no status key
          },
          score: 0.80,
        },
        // Two tie-breaker points: same supersededAt → must order by id asc
        {
          id: 'sup-tie-2-uuid',
          memory: 'old pref 2',
          metadata: {
            id: 'sup-tie-2',
            title: 'Tie 2',
            project: 'p',
            lane: 'work',
            status: 'superseded',
            supersededBy: 'cur-work-uuid',
            supersededAt: '2026-05-15T00:00:00Z',
          },
          score: 0.70,
        },
        {
          id: 'sup-tie-1-uuid',
          memory: 'old pref 1',
          metadata: {
            id: 'sup-tie-1',
            title: 'Tie 1',
            project: 'p',
            lane: 'work',
            status: 'superseded',
            supersededBy: 'cur-work-uuid',
            supersededAt: '2026-05-15T00:00:00Z',
          },
          score: 0.71,
        },
      ],
    }),
  };
}

// ── Mode (a): only_superseded + lane filter ──────────────────────────────────

test('D3.1 only_superseded mode-a MCP: returns only superseded points in lane:work sorted supersededAt desc', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryForT16() });
  try {
    const items = await callMcpSearch(origin, {
      only_superseded: true,
      filters: { lane: 'work' },
    });
    // Must include all work-lane superseded points and no non-work or non-superseded
    const ids = items.map((r) => r.id);
    // cur-work and pre-d3-work must be excluded (not status:superseded)
    assert.ok(!ids.includes('cur-work'), `cur-work (status:current) must be excluded; got: ${ids.join(', ')}`);
    assert.ok(!ids.includes('pre-d3-work'), `pre-d3-work (no status) must be excluded; got: ${ids.join(', ')}`);
    // sup-personal (different lane) must be excluded
    assert.ok(!ids.includes('sup-personal'), `sup-personal (lane:personal) must be excluded; got: ${ids.join(', ')}`);
    // All work-lane superseded points must be present
    assert.ok(ids.includes('sup-work-a'), `sup-work-a must be present; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-work-b'), `sup-work-b must be present; got: ${ids.join(', ')}`);
    // Sort: supersededAt desc — sup-work-a (10:00) before sup-work-b (08:00)
    const idxA = ids.indexOf('sup-work-a');
    const idxB = ids.indexOf('sup-work-b');
    assert.ok(idxA < idxB, `sup-work-a (10:00) must appear before sup-work-b (08:00); order: ${ids.join(', ')}`);
  } finally {
    await close();
  }
});

test('D3.1 only_superseded mode-a REST: returns only superseded lane:work points (REST parity)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryForT16() });
  try {
    const items = await callRestSearch(origin, {
      only_superseded: true,
      filters: { lane: 'work' },
    });
    const ids = items.map((r) => r.id);
    assert.ok(!ids.includes('cur-work'), `cur-work must not appear; got: ${ids.join(', ')}`);
    assert.ok(!ids.includes('sup-personal'), `sup-personal (wrong lane) must not appear; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-work-a'), `sup-work-a must appear; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-work-b'), `sup-work-b must appear; got: ${ids.join(', ')}`);
  } finally {
    await close();
  }
});

// ── Mode (b): only_superseded, no lane/persona ────────────────────────────────

test('D3.1 only_superseded mode-b MCP: returns ALL superseded across partitions, rows expose lane/persona/supersededBy', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryForT16() });
  try {
    const items = await callMcpSearch(origin, { only_superseded: true });
    const ids = items.map((r) => r.id);
    // All superseded points (work + personal + ties) must appear
    assert.ok(ids.includes('sup-work-a'), `sup-work-a missing; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-work-b'), `sup-work-b missing; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-personal'), `sup-personal missing; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-tie-1'), `sup-tie-1 missing; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-tie-2'), `sup-tie-2 missing; got: ${ids.join(', ')}`);
    // Non-superseded must NOT appear
    assert.ok(!ids.includes('cur-work'), `cur-work (status:current) must be excluded; got: ${ids.join(', ')}`);
    assert.ok(!ids.includes('pre-d3-work'), `pre-d3-work (no status) must be excluded; got: ${ids.join(', ')}`);
    // Each row must expose lane, persona, supersededBy from metadata
    const supWorkA = items.find((r) => r.id === 'sup-work-a');
    assert.ok(supWorkA, 'sup-work-a must be present');
    assert.equal((supWorkA.metadata || {}).lane, 'work', 'row must expose lane');
    assert.equal((supWorkA.metadata || {}).persona, 'engineer', 'row must expose persona');
    assert.ok((supWorkA.metadata || {}).supersededBy, 'row must expose supersededBy');
    const supPersonal = items.find((r) => r.id === 'sup-personal');
    assert.equal((supPersonal.metadata || {}).lane, 'personal', 'sup-personal row must expose lane:personal');
  } finally {
    await close();
  }
});

test('D3.1 only_superseded mode-b REST: all superseded across partitions exposed (REST parity)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryForT16() });
  try {
    const items = await callRestSearch(origin, { only_superseded: true });
    const ids = items.map((r) => r.id);
    assert.ok(ids.includes('sup-work-a'), `sup-work-a missing; got: ${ids.join(', ')}`);
    assert.ok(ids.includes('sup-personal'), `sup-personal missing; got: ${ids.join(', ')}`);
    assert.ok(!ids.includes('cur-work'), `cur-work must be excluded; got: ${ids.join(', ')}`);
  } finally {
    await close();
  }
});

// ── Pagination / stability contract (R5-G1) ───────────────────────────────────

test('D3.1 only_superseded pagination MCP: limit:2 returns 2 newest; offset:2 returns 3rd (cross-partition)', async () => {
  // Use a mock with exactly 3 superseded points to test pagination cleanly.
  // supersededAt order: sup-work-a (10:00) > sup-work-b (08:00) > sup-personal (06:00)
  const { origin, close } = await startServer({ memory: {
    search: async () => ({
      results: [
        {
          id: 'sup-work-a-uuid',
          memory: 'old A',
          metadata: { id: 'sup-work-a', title: 'A', project: 'p', lane: 'work',
            status: 'superseded', supersededBy: 'x', supersededAt: '2026-05-16T10:00:00Z' },
          score: 0.9,
        },
        {
          id: 'sup-work-b-uuid',
          memory: 'old B',
          metadata: { id: 'sup-work-b', title: 'B', project: 'p', lane: 'work',
            status: 'superseded', supersededBy: 'x', supersededAt: '2026-05-16T08:00:00Z' },
          score: 0.8,
        },
        {
          id: 'sup-personal-uuid',
          memory: 'old C',
          metadata: { id: 'sup-personal', title: 'C', project: 'p', lane: 'personal',
            status: 'superseded', supersededBy: 'x', supersededAt: '2026-05-16T06:00:00Z' },
          score: 0.7,
        },
      ],
    }),
  }});
  try {
    // Page 1: limit=2, offset=0 → 2 newest (sup-work-a, sup-work-b)
    const page1 = await callMcpSearch(origin, { only_superseded: true, limit: 2, offset: 0 });
    const ids1 = page1.map((r) => r.id);
    assert.deepEqual(ids1, ['sup-work-a', 'sup-work-b'],
      `page1 must be [sup-work-a, sup-work-b] (newest first); got: ${ids1.join(', ')}`);

    // Page 2: limit=2, offset=2 → only 3rd (sup-personal)
    const page2 = await callMcpSearch(origin, { only_superseded: true, limit: 2, offset: 2 });
    const ids2 = page2.map((r) => r.id);
    assert.deepEqual(ids2, ['sup-personal'],
      `page2 (offset:2) must be [sup-personal] only; got: ${ids2.join(', ')}`);
  } finally {
    await close();
  }
});

test('D3.1 only_superseded tie-break stability MCP: equal supersededAt breaks by id asc, deterministic across calls', async () => {
  // Both ties have same supersededAt; id-asc tiebreak → sup-tie-1 before sup-tie-2
  const mock = {
    search: async () => ({
      results: [
        {
          id: 'sup-tie-2-uuid',
          memory: 'tie 2',
          metadata: { id: 'sup-tie-2', title: 'Tie 2', project: 'p', lane: 'work',
            status: 'superseded', supersededBy: 'x', supersededAt: '2026-05-15T00:00:00Z' },
          score: 0.9,
        },
        {
          id: 'sup-tie-1-uuid',
          memory: 'tie 1',
          metadata: { id: 'sup-tie-1', title: 'Tie 1', project: 'p', lane: 'work',
            status: 'superseded', supersededBy: 'x', supersededAt: '2026-05-15T00:00:00Z' },
          score: 0.8,
        },
      ],
    }),
  };
  const { origin, close } = await startServer({ memory: mock });
  try {
    // Call twice to verify determinism
    const items1 = await callMcpSearch(origin, { only_superseded: true });
    const items2 = await callMcpSearch(origin, { only_superseded: true });
    const ids1 = items1.map((r) => r.id);
    const ids2 = items2.map((r) => r.id);
    // id asc tiebreak: 'sup-tie-1' < 'sup-tie-2' lexicographically
    assert.deepEqual(ids1, ['sup-tie-1', 'sup-tie-2'],
      `id-asc tie-break: sup-tie-1 must precede sup-tie-2; got: ${ids1.join(', ')}`);
    assert.deepEqual(ids1, ids2, `order must be deterministic across calls; call1=${ids1.join(', ')} call2=${ids2.join(', ')}`);
  } finally {
    await close();
  }
});

// ── Default limit=50 when unset ────────────────────────────────────────────────

test('D3.1 only_superseded default-limit MCP: omitted limit uses default 50 (not 5 or 10)', async () => {
  // Build a mock returning 12 superseded points
  const results = Array.from({ length: 12 }, (_, i) => ({
    id: `sup-${i}-uuid`,
    memory: `old fact ${i}`,
    metadata: {
      id: `sup-${String(i).padStart(2, '0')}`,
      title: `Sup ${i}`,
      project: 'p',
      status: 'superseded',
      supersededBy: 'x',
      supersededAt: `2026-05-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
    },
    score: 0.9 - i * 0.01,
  }));
  const { origin, close } = await startServer({ memory: { search: async () => ({ results }) } });
  try {
    // Pass only_superseded without a limit in extraArgs (the harness adds limit:10 by default
    // via callMcpSearch; to test the default-50 we need to call WITHOUT the harness limit).
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'memory_search',
          arguments: { query: 'test', full: true, only_superseded: true },
          // Note: no `limit` field — default-50 path
        },
      }),
    });
    assert.equal(res.status, 200);
    const env = await res.json();
    const inner = JSON.parse(env.result.content[0].text);
    // 12 superseded points < 50 → all 12 must be returned
    assert.equal(inner.results.length, 12,
      `default limit=50 should return all 12 superseded points; got ${inner.results.length}`);
  } finally {
    await close();
  }
});

// ── Inert regression: only_superseded absent → T1.5 default path unchanged ────
// (The T25a-T25d tests above already cover this; this is an explicit belt-and-suspenders
//  assertion that mode-b with only_superseded:false is identical to the default path.)

test('D3.1 only_superseded inert: only_superseded:false → same as default path (no superseded returned)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const withFalse = await callMcpSearch(origin, { only_superseded: false });
    const withoutFlag = await callMcpSearch(origin);
    // Both should exclude superseded-point
    const ids1 = withFalse.map((r) => r.id);
    const ids2 = withoutFlag.map((r) => r.id);
    assert.ok(!ids1.includes('superseded-point'), `only_superseded:false must exclude superseded; got: ${ids1.join(', ')}`);
    assert.deepEqual(ids1.sort(), ids2.sort(), `only_superseded:false must be identical to omitting the flag`);
  } finally {
    await close();
  }
});

// ── only_superseded + include_superseded both set: only_superseded wins ────────

test('D3.1 only_superseded wins over include_superseded when both set (MCP)', async () => {
  const { origin, close } = await startServer({ memory: makeMockMemoryWithThreePoints() });
  try {
    const items = await callMcpSearch(origin, { only_superseded: true, include_superseded: true });
    const ids = items.map((r) => r.id);
    // only_superseded wins → ONLY superseded records returned; current + pre-d3 excluded
    assert.ok(ids.includes('superseded-point'), `superseded-point must be present; got: ${ids.join(', ')}`);
    assert.ok(!ids.includes('current-point'), `current-point must be excluded when only_superseded wins; got: ${ids.join(', ')}`);
    assert.ok(!ids.includes('pre-d3-point'), `pre-d3-point (no status) must be excluded when only_superseded wins; got: ${ids.join(', ')}`);
  } finally {
    await close();
  }
});
