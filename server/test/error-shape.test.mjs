/**
 * Cross-cutting error-shape tests (Task B.13 — spec §5.1).
 *
 * Pins the v0.6 unified error envelope across every /api/* and /mcp error path:
 *
 *   {
 *     "ok": false,
 *     "error": {
 *       "code": "<AUTH|INPUT|STATE|LIMIT|UPSTREAM|SERVER>_*",
 *       "message": "<human-readable>",
 *       "retryable": <boolean>
 *     }
 *   }
 *
 * Catches regressions where a future handler forgets to migrate from the
 * legacy {error: 'string'} shape. Companion to error-envelope.test.mjs (which
 * tests the helper in isolation) — this file exercises the full HTTP boundary
 * via createRequestHandler, with a stub mem0 client.
 *
 * For /mcp (JSON-RPC dual-shape):
 *   - OUTER `error.code` is a numeric -32xxx code (mapped from the stable
 *     string code via lib/jsonrpc-errors.mjs).
 *   - INNER `result.content[0].text` (when soft-error inside a tool result)
 *     wraps the same v0.6 unified envelope.
 *
 * Test pattern matches middleware-chain.test.mjs — ephemeral port + injected
 * stub memory + forwarded-header to bypass loopback auth-skip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Stub memory client + ephemeral-port server harness
// ---------------------------------------------------------------------------

const fakeMemory = {
  search: async () => ({ results: [] }),
  getAll: async () => ({ results: [] }),
  add: async () => ({ results: [] }),
  delete: async () => ({}),
};

async function startServer({ writes = false, memory = fakeMemory } = {}) {
  const prevToken = process.env.UM_AUTH_TOKEN;
  const prevWrites = process.env.UM_MCP_WRITE_ENABLED;
  process.env.UM_AUTH_TOKEN = 'test-tok';
  if (writes) process.env.UM_MCP_WRITE_ENABLED = 'true';
  else delete process.env.UM_MCP_WRITE_ENABLED;
  const srv = createServer(createRequestHandler({ memory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prevToken === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prevToken;
    if (prevWrites === undefined) delete process.env.UM_MCP_WRITE_ENABLED;
    else process.env.UM_MCP_WRITE_ENABLED = prevWrites;
  };
  return { port, close, url: (p) => `http://127.0.0.1:${port}${p}` };
}

/**
 * Assert that `body` matches the §5.1 unified envelope shape. Intentionally
 * strict — any 4xx/5xx response from any handler MUST conform to this.
 */
function assertUnifiedErrorEnvelope(body, ctx = '') {
  assert.equal(body.ok, false, `${ctx}: ok must be false`);
  assert.ok(body.error && typeof body.error === 'object', `${ctx}: error must be an object`);
  assert.match(
    body.error.code ?? '',
    /^(AUTH|INPUT|STATE|LIMIT|UPSTREAM|SERVER)_/,
    `${ctx}: error.code must use a §5.2 prefix, got: ${body.error.code}`,
  );
  assert.equal(typeof body.error.message, 'string', `${ctx}: error.message must be string`);
  assert.equal(typeof body.error.retryable, 'boolean', `${ctx}: error.retryable must be boolean`);
}

// Forwarded-header pair so the loopback-bypass doesn't mask auth/error paths.
// Loopback bypass kicks in unless a forwarded header is present (§4.2 default-deny).
const AUTH_HEADERS = {
  'Authorization': 'Bearer test-tok',
  'X-Forwarded-For': '203.0.113.42',
};

// ---------------------------------------------------------------------------
// /api/search — POST + GET
// ---------------------------------------------------------------------------

test('POST /api/search with malformed JSON body → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: '{ this is not json',
    });
    assert.ok(r.status >= 400, `expected 4xx, got ${r.status}`);
    assertUnifiedErrorEnvelope(await r.json(), 'POST /api/search bad JSON');
  } finally { await close(); }
});

test('POST /api/search with missing query → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'POST /api/search missing query');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

test('GET /api/search with missing q parameter → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/search'), { headers: AUTH_HEADERS });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'GET /api/search missing q');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/state/:project — INPUT_INVALID
// ---------------------------------------------------------------------------

test('GET /api/state/<bad-project> → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    // Slash inside the project segment is path-traversal-shaped; safe-name regex rejects
    const r = await fetch(url('/api/state/has%20space'), { headers: AUTH_HEADERS });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'GET /api/state bad project');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/recent/:project — INPUT_INVALID
// ---------------------------------------------------------------------------

test('GET /api/recent/<bad-project> → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/recent/has%20space'), { headers: AUTH_HEADERS });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'GET /api/recent bad project');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/reindex — INPUT_INVALID + STATE_NOT_FOUND
// ---------------------------------------------------------------------------

test('POST /api/reindex with malformed JSON → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/reindex'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: '{ broken',
    });
    assert.equal(r.status, 400);
    assertUnifiedErrorEnvelope(await r.json(), 'POST /api/reindex bad JSON');
  } finally { await close(); }
});

test('POST /api/reindex with missing path → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/reindex'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'POST /api/reindex missing path');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

test('POST /api/reindex with non-existent path → STATE_NOT_FOUND envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/reindex'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ path: 'authored/_does_not_exist_/zzzz.md' }),
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'POST /api/reindex missing file');
    assert.equal(body.error.code, 'STATE_NOT_FOUND');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/append-turn — INPUT_INVALID
// ---------------------------------------------------------------------------

test('POST /api/append-turn with malformed JSON → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/append-turn'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: 'not json',
    });
    assert.equal(r.status, 400);
    assertUnifiedErrorEnvelope(await r.json(), 'POST /api/append-turn bad JSON');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/checkpoint — INPUT_INVALID
// ---------------------------------------------------------------------------

test('POST /api/checkpoint with malformed JSON → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/checkpoint'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: 'not json',
    });
    assert.equal(r.status, 400);
    assertUnifiedErrorEnvelope(await r.json(), 'POST /api/checkpoint bad JSON');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/delete — INPUT_INVALID
// ---------------------------------------------------------------------------

test('POST /api/delete with malformed JSON → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: 'not json',
    });
    assert.equal(r.status, 400);
    assertUnifiedErrorEnvelope(await r.json(), 'POST /api/delete bad JSON');
  } finally { await close(); }
});

test('POST /api/delete with both metadata and id → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ metadata: { id: 'a' }, id: 'b' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'POST /api/delete both shapes');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

test('POST /api/delete with neither metadata nor id → INPUT_INVALID envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'POST /api/delete neither shape');
    assert.equal(body.error.code, 'INPUT_INVALID');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /api/add — caller-supplied reserved metadata field is a CLIENT error.
// Regression pin: ReservedMetadataFieldError (add.mjs:154 guard) used to carry
// no stable code, so the /api/add outer catch fell through to SERVER_INTERNAL
// /500 — mislabeling a client input error as a server fault and marking it
// retryable. It MUST surface as INPUT_INVALID / 400 / retryable:false, the
// same class as the sibling validateLanePersonaSlug guard on this same path.
// ---------------------------------------------------------------------------

// umAdd's reserved-field guard runs AFTER its collectionName guard, so the
// injected memory must carry a vectorStore config for the request to reach
// assertNoReservedFields. fakeMemory deliberately lacks it (other endpoints
// never need it); this is the minimum shape that lets the guard fire.
const addCapableMemory = {
  ...fakeMemory,
  config: { vectorStore: { config: { collectionName: 'memories', host: 'localhost', port: 6333 } } },
};

test('POST /api/add with a reserved metadata field → INPUT_INVALID envelope (4xx, not 500)', async () => {
  const { close, url } = await startServer({ memory: addCapableMemory });
  try {
    const r = await fetch(url('/api/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      // Any RESERVED_METADATA_FIELDS member triggers the guard; use the
      // D1-era `systemMigration` (the dedup-bypass smuggle field) so this
      // regression pin holds regardless of later additions to the set.
      body: JSON.stringify({ text: 'hello world', metadata: { systemMigration: true } }),
    });
    assert.equal(r.status, 400, `reserved-field violation is a client error; expected 400, got ${r.status}`);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'POST /api/add reserved metadata field');
    assert.equal(body.error.code, 'INPUT_INVALID');
    assert.match(body.error.message, /reserved/i);
    assert.equal(body.error.retryable, false, 'a reserved-field client error must not be retryable');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// 404 — Not Found path
// ---------------------------------------------------------------------------

test('GET /api/this-route-does-not-exist → STATE_NOT_FOUND envelope', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/totally-bogus-route'), { headers: AUTH_HEADERS });
    assert.equal(r.status, 404);
    const body = await r.json();
    assertUnifiedErrorEnvelope(body, 'unknown /api/* route');
    assert.equal(body.error.code, 'STATE_NOT_FOUND');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /mcp dual-shape:
//   - tool error returned via `result.content[0].text` (soft error) is the
//     same v0.6 envelope (string code + retryable bool).
//   - parse error / method not found → outer error.code is -32xxx numeric.
// ---------------------------------------------------------------------------

test('POST /mcp with non-JSON body → outer JSON-RPC error.code is numeric -32xxx', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: 'broken json {',
    });
    // Outer transport: HTTP 200 with JSON-RPC error block, OR HTTP 400 with
    // unified envelope (parse-error treatment varies). Either is acceptable.
    if (r.status === 200) {
      const body = await r.json();
      assert.ok(body.error, 'expected JSON-RPC error block on 200 parse-error');
      assert.ok(
        typeof body.error.code === 'number' && body.error.code <= -32000 && body.error.code >= -32999,
        `expected -32xxx numeric code, got ${body.error.code}`,
      );
    } else {
      assert.ok(r.status >= 400);
      assertUnifiedErrorEnvelope(await r.json(), 'POST /mcp bad JSON (HTTP-level)');
    }
  } finally { await close(); }
});

test('POST /mcp tools/call unknown tool → tool-result soft error with unified envelope inside text block', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'totally_made_up_tool', arguments: {} },
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    // The tool throws → handleMcpMessage catches → result.content[0].text wraps the envelope
    assert.ok(j.result, 'expected result on tools/call');
    assert.ok(Array.isArray(j.result.content), 'result.content must be an array');
    assert.equal(j.result.isError, true, 'isError must be true on tool error');
    const text = j.result.content[0].text;
    // After B.13: text should be a JSON-stringified unified envelope, not a free-form
    // "Error: <message>" string. Old shape: text === "Error: Unknown tool: ...".
    // New shape: JSON.parse(text) is { ok: false, error: { code, message, retryable } }.
    let inner;
    try { inner = JSON.parse(text); }
    catch {
      throw new Error(`expected text content block to be JSON-encoded envelope, got: ${text}`);
    }
    assertUnifiedErrorEnvelope(inner, '/mcp tool error inner envelope');
  } finally { await close(); }
});

test('POST /mcp tools/call memory_capture without writes-enabled → unified envelope inside text block', async () => {
  // writes=false (default) → memory_capture errors with "MCP writes disabled".
  // Code: AUTH_INVALID is wrong (it's a config issue not auth).
  // Spec §5.2: nearest fit is INPUT_INVALID (caller should set env) — picked
  // by Step 3 below; this test just asserts the SHAPE is unified.
  const { close, url } = await startServer({ writes: false });
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'memory_capture', arguments: { content: 'x', metadata: { type: 't', id: 'i', title: 't' } } },
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    // Per B.13: writes-disabled comes back as a tool result whose text is the
    // unified envelope (NOT isError:true — these are recoverable config errors,
    // returned via the tool's normal return value path).
    assert.ok(j.result, 'expected result on tools/call');
    const text = j.result.content[0].text;
    let inner;
    try { inner = JSON.parse(text); }
    catch { throw new Error(`expected JSON envelope text, got: ${text}`); }
    assertUnifiedErrorEnvelope(inner, '/mcp memory_capture writes-disabled inner envelope');
  } finally { await close(); }
});

test('POST /mcp invalid method → outer JSON-RPC error.code is -32601 (method not found)', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nonsense/method' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.error, 'expected JSON-RPC error block');
    // -32601 is "method not found" — already a JSON-RPC standard, not subject to
    // our string→numeric mapping. Pinned for regression visibility.
    assert.equal(j.error.code, -32601, 'method-not-found must use -32601');
  } finally { await close(); }
});
