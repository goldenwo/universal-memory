/**
 * HTTP wire-shape integration tests for the list-envelope endpoints.
 *
 * Addresses the R10-class gap surfaced in Phase A review:
 *   api-list-envelope.test.mjs only unit-tests doList() in isolation. If a
 *   future refactor ever forgets to JSON.stringify the response, re-wraps the
 *   shape, or drops the envelope somewhere in the handler chain, the unit
 *   tests pass but the wire regresses. These tests exercise the full
 *   request → createServer callback → socket → response.body path on a live
 *   HTTP server bound to an ephemeral port.
 *
 * Covered:
 *   1. GET /api/list                  — compact shape, enveloped
 *   2. GET /api/list?full=1           — full shape, enveloped
 *   3. GET /api/recent/:project       — filesystem-backed, enveloped
 *   4. POST /api/search               — vector-store-backed, enveloped
 *   5. Forward-compat sibling test — additive top-level fields on the
 *      memory-client return value propagate through doList to the wire
 *      response. Guards the §4.1 extensibility contract so future v0.7
 *      siblings (provider, latency_ms, etc.) are not silently dropped.
 *
 * No external dependencies: memory clients are stubbed and passed via the DI
 * ctx; /api/recent points at a temp vault dir populated with fixture files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Test harness — spin up the request handler on an ephemeral port with an
// injected memory stub, run one request, tear down. Isolated per test so
// concurrent `node --test` runs do not collide on a shared port.
// ---------------------------------------------------------------------------

/**
 * Listen on an ephemeral port with ctx.memory injected.
 * Returns { origin, close }. `origin` is `http://127.0.0.1:<port>`.
 */
async function startServer(ctx) {
  const handler = createRequestHandler(ctx);
  const srv = createServer(handler);
  // port 0 → OS-assigned ephemeral port (reliable on Windows and POSIX)
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// 1. GET /api/list — compact shape, enveloped
// ---------------------------------------------------------------------------

test('GET /api/list returns enveloped JSON over the wire (compact shape)', async () => {
  const fakeMemory = {
    getAll: async () => ({
      results: [
        { id: 'mem0-uuid-1', memory: 'hello world', metadata: { id: 'doc-1', title: 'Doc One' } },
        { id: 'mem0-uuid-2', memory: 'another fact', metadata: { id: 'doc-2', title: 'Doc Two' } },
      ],
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/api/list`);
    assert.equal(res.status, 200, 'HTTP status must be 200');
    assert.equal(res.headers.get('content-type'), 'application/json', 'Content-Type must be application/json');
    const raw = await res.text();
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed, 'object', 'body must be a JSON object, not bare array');
    assert.ok(!Array.isArray(parsed), 'body must not be a bare array');
    assert.ok(Array.isArray(parsed.results), 'body.results must be an array');
    assert.equal(parsed.results.length, 2, 'results length must match the stubbed memory');
    // Compact-shape projection: { id, title, snippet }
    const first = parsed.results[0];
    assert.ok('id' in first, 'compact item must have id');
    assert.ok('title' in first, 'compact item must have title');
    assert.ok('snippet' in first, 'compact item must have snippet');
    assert.equal(first.id, 'doc-1');
    assert.equal(first.title, 'Doc One');
    assert.ok(typeof first.snippet === 'string' && first.snippet.length > 0);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 2. GET /api/list?full=1 — full shape, enveloped
// ---------------------------------------------------------------------------

test('GET /api/list?full=1 returns enveloped JSON over the wire (full shape)', async () => {
  const fakeMemory = {
    getAll: async () => ({
      results: [
        { id: 'mem0-uuid-1', memory: 'hello world', metadata: { id: 'doc-1', title: 'Doc One' } },
      ],
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/api/list?full=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.results));
    assert.equal(parsed.results.length, 1);
    // Full shape: raw mem0 item passes through — body/metadata preserved
    const first = parsed.results[0];
    assert.ok('memory' in first || 'id' in first, 'full-shape item must preserve raw mem0 fields');
    assert.equal(first.metadata.title, 'Doc One');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 3. GET /api/recent/:project — filesystem-backed, enveloped
//
// doRecent reads from the vault filesystem (no memory client involved), so the
// "stub" here is a temp dir populated with a fixture .md file. We override
// UM_VAULT_DIR for the duration of this test.
// ---------------------------------------------------------------------------

test('GET /api/recent/:project returns enveloped JSON over the wire', async () => {
  const tmpVault = await mkdtemp(path.join(tmpdir(), 'um-wire-recent-'));
  const authored = path.join(tmpVault, 'authored', 'wire-test-project');
  await mkdir(authored, { recursive: true });
  const docContent = `---
type: note
id: recent-doc-1
title: Recent Doc One
---

This is the body of a test document used to verify the wire shape of
the /api/recent/:project endpoint.`;
  await writeFile(path.join(authored, 'recent-doc-1.md'), docContent, 'utf8');

  const prevVault = process.env.UM_VAULT_DIR;
  process.env.UM_VAULT_DIR = tmpVault;
  // doRecent does not use the memory client; pass an empty ctx to avoid
  // accidentally touching any module-level memory during unrelated routes.
  const { origin, close } = await startServer({});
  try {
    const res = await fetch(`${origin}/api/recent/wire-test-project?limit=5`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const parsed = JSON.parse(await res.text());
    assert.equal(typeof parsed, 'object');
    assert.ok(Array.isArray(parsed.results), 'body.results must be an array');
    assert.equal(parsed.results.length, 1, 'exactly one fixture doc is present');
    const item = parsed.results[0];
    assert.equal(item.id, 'recent-doc-1');
    assert.equal(item.title, 'Recent Doc One');
    assert.ok(typeof item.snippet === 'string' && item.snippet.includes('Recent Doc One'));
  } finally {
    await close();
    if (prevVault === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = prevVault;
    await rm(tmpVault, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. POST /api/search — vector-store-backed, enveloped
// ---------------------------------------------------------------------------

test('POST /api/search returns enveloped JSON over the wire', async () => {
  const fakeMemory = {
    search: async (_query, _opts) => ({
      results: [
        {
          id: 'mem0-uuid-1',
          memory: 'the quick brown fox jumps over the lazy dog',
          metadata: { id: 'search-doc-1', title: 'Search Doc One' },
          score: 0.87,
        },
      ],
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', limit: 5 }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const parsed = JSON.parse(await res.text());
    assert.equal(typeof parsed, 'object');
    assert.ok(Array.isArray(parsed.results), 'body.results must be an array');
    assert.equal(parsed.results.length, 1);
    const first = parsed.results[0];
    // Compact shape for /api/search (default, full not requested)
    assert.equal(first.id, 'search-doc-1');
    assert.equal(first.title, 'Search Doc One');
    assert.ok('score' in first);
    assert.ok(typeof first.snippet === 'string' && first.snippet.length > 0);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 5. Forward-compat sibling test — spec §4.1 additive-sibling contract.
//
// Spec §4.1 promises that additive top-level fields on the list envelope (e.g.,
// future v0.7 `provider` for multi-provider transparency and `latency_ms` for
// observability passthrough) DO NOT break existing parsers. But the promise is
// a two-way street: siblings that the memory client returns today must ALSO
// propagate through doList to the wire, otherwise v0.7 additions would be
// silently dropped upstream. This test pins that contract.
//
// Stub returns { results: [...], provider: 'mem0', latency_ms: 42 }. The wire
// response must still carry `provider` and `latency_ms` as top-level siblings
// alongside `results`.
// ---------------------------------------------------------------------------

test('GET /api/list propagates additive top-level siblings through to the wire (§4.1)', async () => {
  const fakeMemory = {
    getAll: async () => ({
      results: [
        { id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 'Title 1' } },
      ],
      provider: 'mem0',
      latency_ms: 42,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/api/list`);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.results), 'results envelope still present');
    // Sibling propagation — the load-bearing assertion for §4.1.
    assert.equal(parsed.provider, 'mem0', 'provider sibling must propagate');
    assert.equal(parsed.latency_ms, 42, 'latency_ms sibling must propagate');
  } finally {
    await close();
  }
});

test('GET /api/list?full=1 propagates additive top-level siblings through to the wire (§4.1)', async () => {
  const fakeMemory = {
    getAll: async () => ({
      results: [
        { id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 'Title 1' } },
      ],
      provider: 'mem0',
      latency_ms: 42,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/api/list?full=1`);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.results));
    assert.equal(parsed.provider, 'mem0');
    assert.equal(parsed.latency_ms, 42);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 6. Forward-compat sibling test — POST /api/search analogue of test #5.
//
// doSearch() must mirror doList() in propagating additive top-level siblings
// (e.g., future v0.7 `provider`, `latency_ms`) from the memory client's
// return value through to the wire response. Without this, the §4.1
// extensibility contract only holds for /api/list and /api/recent — /api/search
// silently drops siblings, breaking parity across list endpoints.
//
// The request uses `full: true` with no post-filters so the route handler
// passes the doSearch output directly without re-wrapping via listEnvelope(),
// isolating the assertion to the doSearch sibling-propagation layer (the same
// layer test #5 exercises for doList).
// ---------------------------------------------------------------------------

test('POST /api/search propagates additive top-level siblings through to the wire (§4.1)', async () => {
  const fakeMemory = {
    search: async (_query, _opts) => ({
      results: [
        {
          id: 'mem0-uuid-1',
          memory: 'the quick brown fox',
          metadata: { id: 'search-doc-1', title: 'Search Doc One' },
          score: 0.91,
        },
      ],
      provider: 'mem0',
      latency_ms: 42,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    const res = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', limit: 5, full: true }),
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.results), 'results envelope still present');
    assert.equal(parsed.results.length, 1);
    // Sibling propagation — the load-bearing assertion for §4.1.
    assert.equal(parsed.provider, 'mem0', 'provider sibling must propagate');
    assert.equal(parsed.latency_ms, 42, 'latency_ms sibling must propagate');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 7. Route-level re-wrap sibling test — POST /api/search compact-projection.
//
// Test #6 above uses `full: true`, which skips the route-level compact
// re-wrap entirely and lands directly on the doSearch output. This test
// pins the OTHER path: the default compact projection, where the route
// handler rebuilds the envelope via listEnvelope(compactItems, ...). Before
// the A.10 follow-up fix, that re-wrap dropped every sibling doSearch had
// propagated. With the fix, siblings survive the compact-projection step.
// ---------------------------------------------------------------------------
test('POST /api/search compact-projection preserves siblings through the route re-wrap (§4.1)', async () => {
  const fakeMemory = {
    search: async (_query, _opts) => ({
      results: [
        {
          id: 'mem0-uuid-1',
          memory: 'the quick brown fox',
          metadata: { id: 'search-doc-1', title: 'Search Doc One' },
          score: 0.91,
        },
      ],
      provider: 'mem0',
      latency_ms: 42,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    // No `full` key → compact projection path — exercises the route-level
    // re-wrap that previously dropped siblings.
    const res = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', limit: 5 }),
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.results), 'results envelope still present');
    assert.equal(parsed.results.length, 1);
    // Compact shape must still be produced…
    assert.equal(parsed.results[0].id, 'search-doc-1');
    assert.ok('snippet' in parsed.results[0], 'compact item must include snippet');
    // …AND siblings must survive the route-level re-wrap.
    assert.equal(parsed.provider, 'mem0', 'provider sibling must propagate through compact re-wrap');
    assert.equal(parsed.latency_ms, 42, 'latency_ms sibling must propagate through compact re-wrap');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 8. Route-level re-wrap sibling test — GET /api/search?type=… typeFilter.
//
// The GET handler has a second re-wrap site (the typeFilter post-filter
// branch) that is skipped on POST. This test exercises that specific path:
// a typeFilter is supplied AND `full=1` so the compact-projection re-wrap
// is bypassed — isolating the assertion to the typeFilter re-wrap. Before
// the fix, the typeFilter branch emitted `listEnvelope(items)` fresh and
// dropped every sibling. With the fix, siblings propagate via the
// `{ results: _, ...extras }` destructure forward.
// ---------------------------------------------------------------------------
test('GET /api/search?type=… typeFilter preserves siblings through the route re-wrap (§4.1)', async () => {
  const fakeMemory = {
    search: async (_query, _opts) => ({
      results: [
        {
          id: 'mem0-uuid-1',
          memory: 'matching doc',
          metadata: { id: 'note-1', title: 'Note One', type: 'note' },
          score: 0.82,
        },
        {
          id: 'mem0-uuid-2',
          memory: 'wrong-type doc',
          metadata: { id: 'state-1', title: 'State One', type: 'state' },
          score: 0.74,
        },
      ],
      provider: 'mem0',
      latency_ms: 42,
    }),
  };
  const { origin, close } = await startServer({ memory: fakeMemory });
  try {
    // type=note → the typeFilter re-wrap fires.
    // full=1    → the compact-projection re-wrap is skipped, so we isolate
    //             the assertion to the typeFilter re-wrap path.
    const res = await fetch(`${origin}/api/search?q=test&type=note&full=1`);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(await res.text());
    assert.ok(Array.isArray(parsed.results), 'results envelope still present');
    assert.equal(parsed.results.length, 1, 'typeFilter must drop the non-matching doc');
    assert.equal(parsed.results[0].metadata.type, 'note');
    // Siblings must survive the typeFilter re-wrap.
    assert.equal(parsed.provider, 'mem0', 'provider sibling must propagate through typeFilter re-wrap');
    assert.equal(parsed.latency_ms, 42, 'latency_ms sibling must propagate through typeFilter re-wrap');
  } finally {
    await close();
  }
});
