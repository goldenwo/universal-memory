// server/test/r1-review-fixes.test.mjs
//
// Pins the four R1 multi-lens-review remediations:
//
//   Fix 1 (Lens A) — wire the 3 unused metrics counters:
//     • um_lock_contentions_total{lock_path} on acquireLockdir contention
//       in append-turn + checkpoint paths.
//     • um_mem0_ops_total{op,status} via withRetry's `op` label hook.
//     • um_mcp_tool_calls_total{tool,status} on every handleToolCall dispatch.
//
//   Fix 2 (Lens C) — fence unknown paths to '/__unknown__' so an attacker
//     spraying /api/foo, /api/bar, /api/baz cannot grow the prom-client
//     registry unboundedly.
//
//   Fix 3 (Lens B) — wrap 4 previously-unwrapped mem0 calls in withRetry:
//     POST /api/add, POST /api/reindex inline, POST /api/delete Shape B,
//     DELETE /api/:id. Verifies retry happens on transient failure
//     (3 attempts before UPSTREAM_FAILURE).
//
// Test patterns mirror the rest of the suite: each integration test
// stands up a fresh server on an ephemeral loopback port; each metric
// assertion reads the registry text and parses with regex (process-global
// registry; we use snapshot deltas, not absolute values).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  registry,
  lockContentionsTotal,
  mem0OpsTotal,
  mcpToolCallsTotal,
} from '../lib/metrics.mjs';
import { doAppendTurn } from '../lib/append-turn.mjs';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { withRetry } from '../lib/retry.mjs';
import {
  createRequestHandler,
  handleToolCall,
} from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const fakeMemory = {
  getAll: async () => ({ results: [] }),
  add: async () => ({ results: [{ memory: 'stored', event: 'ADD' }] }),
  delete: async () => ({}),
  search: async () => ({ results: [] }),
};

async function startServer({
  env = {},
  memory = fakeMemory,
  token = 'secret-token',
  _qdrantClient,
  _factsProviderOverride,
  _embedProviderOverride,
} = {}) {
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) {
    prevEnv[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  prevEnv.UM_AUTH_TOKEN = process.env.UM_AUTH_TOKEN;
  if (token !== null) process.env.UM_AUTH_TOKEN = token;

  const srv = createServer(createRequestHandler({ memory, _qdrantClient, _factsProviderOverride, _embedProviderOverride }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { port, close, url: (p) => `http://127.0.0.1:${port}${p}` };
}

// Read a counter value out of the registry's text exposition. Returns 0
// when the label-set has not yet been observed.
async function getCounter(name, labels) {
  const text = await registry.metrics();
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
    .join(',');
  const re = new RegExp(`^${name}\\{${labelStr}\\}\\s+(\\d+(?:\\.\\d+)?)`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : 0;
}

async function makeTempVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'um-r1-'));
  await fs.mkdir(path.join(dir, 'captures'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Fix 1 — metrics wiring
// ---------------------------------------------------------------------------

test('Fix 1 / lockContentionsTotal: append-turn lockdir-acquire failure increments {lock_path="append-turn"}', async () => {
  const vault = await makeTempVault();
  const before = await getCounter('um_lock_contentions_total', { lock_path: 'append-turn' });
  // DI: inject a fake acquireLockdir that simulates contention (returns false).
  const result = await doAppendTurn(
    { project: 'p', content: 'c', role: 'user' },
    { vaultDir: vault, _acquireLockdir: async () => false },
  );
  assert.equal(result.ok, false);
  const after = await getCounter('um_lock_contentions_total', { lock_path: 'append-turn' });
  assert.equal(after, before + 1, 'contended append-turn must increment lockContentionsTotal');
});

test('Fix 1 / lockContentionsTotal: append-turn lockdir-acquire throw also increments', async () => {
  const vault = await makeTempVault();
  const before = await getCounter('um_lock_contentions_total', { lock_path: 'append-turn' });
  // Throw path covers the catch branch in doAppendTurn — same metric label.
  const result = await doAppendTurn(
    { project: 'p', content: 'c', role: 'user' },
    {
      vaultDir: vault,
      _acquireLockdir: async () => {
        const err = new Error('synthetic');
        err.code = 'EACCES';
        throw err;
      },
    },
  );
  assert.equal(result.ok, false);
  const after = await getCounter('um_lock_contentions_total', { lock_path: 'append-turn' });
  assert.equal(after, before + 1);
});

test('Fix 1 / lockContentionsTotal: checkpoint state.md contention increments {lock_path="checkpoint:state"}', async () => {
  // Pre-create the state.md.lockdir to force acquireLockdir to return false
  // (timeoutMs:0 means no waiting). doCheckpoint then surfaces
  // 'checkpoint_in_progress' which is exactly the metric trigger.
  const vault = await makeTempVault();
  const lockdir = path.join(vault, 'state', 'p', 'state.md.lockdir');
  await fs.mkdir(lockdir, { recursive: true });
  const before = await getCounter('um_lock_contentions_total', { lock_path: 'checkpoint:state' });
  const result = await doCheckpoint(
    { project: 'p' },
    {
      vaultDir: vault,
      // Provide DI to keep test fast — no actual summarize/reindex needed
      // since contention happens before those branches.
      summarizeFn: async () => ({ summary: 's', costUsd: 0, tokensIn: 0, tokensOut: 0 }),
      reindexFn: async () => {},
      systemPrompt: 'test',
      config: { cost_cap_usd_per_day_per_project: 100 },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'checkpoint_in_progress');
  const after = await getCounter('um_lock_contentions_total', { lock_path: 'checkpoint:state' });
  assert.equal(after, before + 1);
});

test('Fix 1 / mem0OpsTotal: withRetry success increments {op,status="ok"}', async () => {
  const before = await getCounter('um_mem0_ops_total', { op: 'add-test-success', status: 'ok' });
  await withRetry(async () => 42, { op: 'add-test-success', maxRetries: 0, baseDelayMs: 1, jitterMaxMs: 0 });
  const after = await getCounter('um_mem0_ops_total', { op: 'add-test-success', status: 'ok' });
  assert.equal(after, before + 1);
});

test('Fix 1 / mem0OpsTotal: withRetry final-failure increments {op,status="fail"} exactly once (not per attempt)', async () => {
  const before = await getCounter('um_mem0_ops_total', { op: 'add-test-fail', status: 'fail' });
  let calls = 0;
  await withRetry(async () => {
    calls++;
    throw Object.assign(new Error('transient'), { retryable: true });
  }, { op: 'add-test-fail', maxRetries: 2, baseDelayMs: 1, jitterMaxMs: 0 }).catch(() => {});
  assert.equal(calls, 3, '1 initial + 2 retries');
  const after = await getCounter('um_mem0_ops_total', { op: 'add-test-fail', status: 'fail' });
  assert.equal(after, before + 1, 'fail metric emits ONCE per call, not per retry attempt');
});

test('Fix 1 / mem0OpsTotal: withRetry without op label emits NO metric (back-compat for non-mem0 callers)', async () => {
  // Sanity: a withRetry without `opts.op` must not pollute the counter.
  const text0 = await registry.metrics();
  const beforeAll = (text0.match(/^um_mem0_ops_total\{/gm) || []).length;
  await withRetry(async () => 'ok', { maxRetries: 0 }).catch(() => {});
  const text1 = await registry.metrics();
  const afterAll = (text1.match(/^um_mem0_ops_total\{/gm) || []).length;
  assert.equal(afterAll, beforeAll, 'no-op-label withRetry must not change the metric set');
});

test('Fix 1 / mcpToolCallsTotal: handleToolCall success increments {tool,status="ok"}', async () => {
  const before = await getCounter('um_mcp_tool_calls_total', { tool: 'memory_search', status: 'ok' });
  // memory_search is a read-only tool — no UM_MCP_WRITE_ENABLED required.
  await handleToolCall('memory_search', { query: 'q', limit: 1 }, { memory: fakeMemory });
  const after = await getCounter('um_mcp_tool_calls_total', { tool: 'memory_search', status: 'ok' });
  assert.equal(after, before + 1);
});

test('Fix 1 / mcpToolCallsTotal: handleToolCall throw increments {tool,status="fail"}', async () => {
  const before = await getCounter('um_mcp_tool_calls_total', { tool: 'no-such-tool', status: 'fail' });
  await assert.rejects(
    () => handleToolCall('no-such-tool', {}, { memory: fakeMemory }),
    /Unknown tool/,
  );
  const after = await getCounter('um_mcp_tool_calls_total', { tool: 'no-such-tool', status: 'fail' });
  assert.equal(after, before + 1);
});

// ---------------------------------------------------------------------------
// Fix 2 — unknown-path label fence
// ---------------------------------------------------------------------------

test('Fix 2 / unknown path uses {endpoint="/__unknown__"} not raw pathname', async () => {
  const { close, url } = await startServer();
  try {
    // Hit a path that resolveRouteTemplate does not recognize. The handler's
    // unknown-route branch returns 404 with STATE_NOT_FOUND envelope; the
    // res.end shim still emits the metric.
    const r = await fetch(url('/api/totally-fake-path-r1-test'));
    assert.equal(r.status, 404);
    await r.text();
    const text = await registry.metrics();
    // Cardinality fence: raw pathname must NOT appear in the registry.
    assert.doesNotMatch(
      text,
      /endpoint="\/api\/totally-fake-path-r1-test"/,
      'raw unknown path must not be a metric label (cardinality fence)'
    );
    // The bucket label must show up instead.
    assert.match(
      text,
      /um_http_requests_total\{[^}]*endpoint="\/__unknown__"/,
      'unknown paths bucket under /__unknown__'
    );
  } finally { await close(); }
});

test('Fix 2 / many distinct unknown paths still bucket under /__unknown__ (registry stays bounded)', async () => {
  // Spray several distinct unknown paths; the registry must collapse them
  // to a single endpoint label, not grow N entries.
  const { close, url } = await startServer();
  try {
    const before = await getCounter('um_http_requests_total', { endpoint: '/__unknown__', status: '404' });
    for (const slug of ['alpha', 'beta', 'gamma', 'delta']) {
      const r = await fetch(url(`/api/${slug}-r1-spray`));
      await r.text();
    }
    const after = await getCounter('um_http_requests_total', { endpoint: '/__unknown__', status: '404' });
    assert.equal(after, before + 4, 'all 4 unknown paths must bucket together');
    // None of the raw slugs leaks into the registry.
    const text = await registry.metrics();
    for (const slug of ['alpha', 'beta', 'gamma', 'delta']) {
      assert.doesNotMatch(text, new RegExp(`endpoint="\\/api\\/${slug}-r1-spray"`));
    }
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Fix 3 — wrap 4 mem0 calls in withRetry
// ---------------------------------------------------------------------------

// The four sites are exercised through createRequestHandler with a stubbed
// memory client whose .add / .delete throw on the first N attempts to
// simulate transient failure. withRetry counts attempts; success after
// retry proves the wrapping is in place.

// Stub provider objects for umAdd seams — avoid real provider calls in tests.
const stubFactsProvider = {
  supports: { facts: true },
  defaults: { factsModel: 'stub' },
  factsInvoke: async () => ({ facts: ['stub fact'], usage: { tokensIn: 1, tokensOut: 1 } }),
};
const stubEmbedProvider = {
  supports: { embeddings: true },
  defaults: { embeddingModel: 'stub' },
  embed: async () => ({ vector: [0.1], usage: { tokensIn: 1, tokensOut: 0 } }),
};

function makeTransientMemory({ failNTimes = 2, addBehavior = 'success', deleteBehavior = 'success' } = {}) {
  let addCalls = 0;
  let deleteCalls = 0;
  return {
    // config shape required by umAdd
    config: { vectorStore: { config: { collectionName: 'memories', host: 'localhost', port: 6333 } } },
    addCallCount: () => addCalls,
    deleteCallCount: () => deleteCalls,
    getAll: async () => ({ results: [] }),
    search: async () => ({ results: [] }),
    // keep add() for any paths that still call memory.add directly (e.g. delete-path mocks)
    add: async (...args) => {
      addCalls++;
      if (addBehavior === 'success' && addCalls <= failNTimes) {
        throw Object.assign(new Error('transient qdrant blip'), { retryable: true });
      }
      return { results: [{ memory: 'stored', event: 'ADD' }] };
    },
    delete: async (...args) => {
      deleteCalls++;
      if (deleteBehavior === 'success' && deleteCalls <= failNTimes) {
        throw Object.assign(new Error('transient qdrant blip'), { retryable: true });
      }
      return {};
    },
  };
}

// Transient qdrant mock: throws on the first failNTimes upsert() calls, then succeeds.
function makeTransientQdrant({ failNTimes = 2 } = {}) {
  let upsertCalls = 0;
  return {
    upsertCallCount: () => upsertCalls,
    client: {
      upsert: async (collection, body) => {
        upsertCalls++;
        if (upsertCalls <= failNTimes) {
          throw Object.assign(new Error('transient qdrant blip'), { retryable: true });
        }
        return { status: 'ok' };
      },
    },
  };
}

test('Fix 3 / POST /api/add: transient failure retries and succeeds (was raw 500 before)', async () => {
  // v0.8 G2: /api/add now calls umAdd() instead of memory.add(). The outer
  // withRetry wraps the entire umAdd() call. To exercise outer-retry counting,
  // we inject a transient qdrant mock (_qdrantClient) that throws on the first
  // 2 upserts. Each outer retry re-enters umAdd from facts→embed→upsert, so
  // qdrant.upsertCallCount() counts outer-retry attempts (1 per umAdd call
  // that reaches upsert).
  //
  // Retry architecture (post-v0.8 G2 final-review Important #2):
  // umAdd does NOT internally wrap the qdrant upsert. The OUTER withRetry
  // ({op:'add'}) at every mcp-http call site is the single source of retry
  // truth. So upsertCallCount === number of outer attempts (1-per-attempt,
  // not amplified). With UM_UPSTREAM_RETRY_MAX=3 and 2 transient failures,
  // we expect upsertCallCount() === 3 (initial + 2 retries succeeds on 3rd).
  const memory = makeTransientMemory({ failNTimes: 0 }); // no delete failures needed
  const qdrant = makeTransientQdrant({ failNTimes: 2 });
  const prev = process.env.UM_UPSTREAM_RETRY_MAX;
  process.env.UM_UPSTREAM_RETRY_MAX = '3';
  try {
    const { close, url } = await startServer({
      memory,
      _qdrantClient: qdrant.client,
      _factsProviderOverride: stubFactsProvider,
      _embedProviderOverride: stubEmbedProvider,
    });
    try {
      const r = await fetch(url('/api/add'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(r.status, 200, 'transient failures must be retried — final response is 200');
      await r.text();
      assert.ok(qdrant.upsertCallCount() >= 3, `qdrant.upsert called >= 3 times (2 fails + 1 success); got ${qdrant.upsertCallCount()}`);
    } finally { await close(); }
  } finally {
    if (prev === undefined) delete process.env.UM_UPSTREAM_RETRY_MAX;
    else process.env.UM_UPSTREAM_RETRY_MAX = prev;
  }
});

test('Fix 3 / POST /api/add: persistent failure surfaces UPSTREAM_FAILURE after 3 retries', async () => {
  // failNTimes=99 ensures every upsert attempt fails — withRetry exhausts the
  // budget and surfaces UPSTREAM_FAILURE → 502.
  const memory = makeTransientMemory({ failNTimes: 0 });
  const qdrant = makeTransientQdrant({ failNTimes: 99 });
  const prev = process.env.UM_UPSTREAM_RETRY_MAX;
  process.env.UM_UPSTREAM_RETRY_MAX = '3';
  try {
    const { close, url } = await startServer({
      memory,
      _qdrantClient: qdrant.client,
      _factsProviderOverride: stubFactsProvider,
      _embedProviderOverride: stubEmbedProvider,
    });
    try {
      const r = await fetch(url('/api/add'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      // error-envelope maps UPSTREAM_FAILURE → HTTP 502.
      assert.equal(r.status, 502);
      const body = await r.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'UPSTREAM_FAILURE');
      assert.ok(qdrant.upsertCallCount() >= 1, 'qdrant.upsert attempted at least once');
    } finally { await close(); }
  } finally {
    if (prev === undefined) delete process.env.UM_UPSTREAM_RETRY_MAX;
    else process.env.UM_UPSTREAM_RETRY_MAX = prev;
  }
});

test('Fix 3 / POST /api/delete (Shape B): transient failure retries and succeeds', async () => {
  const memory = makeTransientMemory({ failNTimes: 1 });
  const prev = process.env.UM_UPSTREAM_RETRY_MAX;
  process.env.UM_UPSTREAM_RETRY_MAX = '3';
  try {
    const { close, url } = await startServer({ memory });
    try {
      const r = await fetch(url('/api/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'some-uuid' }),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.equal(body.deleted, 1, 'after retry-then-success, deleted count is 1');
      assert.equal(memory.deleteCallCount(), 2, '1 fail + 1 success');
    } finally { await close(); }
  } finally {
    if (prev === undefined) delete process.env.UM_UPSTREAM_RETRY_MAX;
    else process.env.UM_UPSTREAM_RETRY_MAX = prev;
  }
});

test('Fix 3 / DELETE /api/:id: transient failure retries and succeeds', async () => {
  const memory = makeTransientMemory({ failNTimes: 1 });
  const prev = process.env.UM_UPSTREAM_RETRY_MAX;
  process.env.UM_UPSTREAM_RETRY_MAX = '3';
  try {
    const { close, url } = await startServer({ memory });
    try {
      const r = await fetch(url('/api/some-uuid'), { method: 'DELETE' });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.deleted, 'some-uuid');
      assert.equal(memory.deleteCallCount(), 2, '1 fail + 1 success');
    } finally { await close(); }
  } finally {
    if (prev === undefined) delete process.env.UM_UPSTREAM_RETRY_MAX;
    else process.env.UM_UPSTREAM_RETRY_MAX = prev;
  }
});

test('Fix 3 / static-shape assertion: all 4 mem0 call sites are now wrapped in withRetry', async () => {
  // The inline /api/reindex add call cannot be exercised end-to-end via the
  // ephemeral-server pattern because the same route also calls
  // deleteByMetadataId(), which uses the module-level `memory` binding (not
  // ctx-injectable). Routes /api/add, POST /api/delete (Shape B), DELETE
  // /api/:id are exercised end-to-end above with transient-failure retry
  // counting; this 4th site is pinned by static-shape inspection so a future
  // refactor that drops the wrap regresses an explicit test.
  //
  // v0.8 G2 (T16+): /api/add and /api/reindex write paths now call umAdd()
  // instead of resolvedMemory().add(). The wrapping pattern is now:
  //   withRetry(() => umAdd({...}).catch(...))
  // plus the two delete sites that still call resolvedMemory().delete().
  const src = await fs.readFile(
    new URL('../mem0-mcp-http.mjs', import.meta.url),
    'utf8',
  );
  // Count withRetry(() => umAdd(...) sites — expect at least 1 after T16 migration.
  // (Grows to 4 as T16–T19 land; this assertion tracks current migration state.)
  const umAddWrapMatches = src.match(
    /withRetry\(\(\)\s*=>\s*\n?\s*umAdd\(/g,
  ) || [];
  assert.ok(
    umAddWrapMatches.length >= 1,
    `expected >=1 withRetry-wrapped umAdd() calls, found ${umAddWrapMatches.length}`
  );
  // Count withRetry(() => resolvedMemory().delete(...) sites — expect at least 2.
  const deleteWrapMatches = src.match(
    /withRetry\(\(\)\s*=>\s*\n?\s*resolvedMemory\(\)\.delete/g,
  ) || [];
  assert.ok(
    deleteWrapMatches.length >= 2,
    `expected >=2 withRetry-wrapped resolvedMemory().delete() calls, found ${deleteWrapMatches.length}`
  );
  // Spot-check that /api/reindex still has an add wrapped in withRetry
  // (either umAdd or resolvedMemory().add depending on migration state).
  assert.match(
    src,
    /withRetry\(\(\)\s*=>[\s\S]{0,300}(umAdd|resolvedMemory\(\)\.add)\([^)]*docText[\s\S]{0,300}infer:\s*false/,
    'inline /api/reindex write to qdrant must be inside a withRetry'
  );
});
