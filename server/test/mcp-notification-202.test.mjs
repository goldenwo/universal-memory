/**
 * Streamable-HTTP transport contract for JSON-RPC notifications on POST /mcp.
 *
 * A JSON-RPC message with no `id` is a notification; the MCP streamable-HTTP
 * transport requires the server to answer it with HTTP 202 Accepted and NO
 * body. Before this test, `/mcp` answered `notifications/initialized` with
 * 200 + Content-Type application/json + an EMPTY body — a well-formed HTTP
 * response that is not a well-formed JSON document. Strict clients that
 * deserialise every application/json body failed on it: OpenAI Codex CLI's
 * rmcp client logged `Deserialize error: EOF while parsing a value at line 1
 * column 0, when send initialized notification` and dropped the server, so
 * no memory tools were available in Codex. (context7's server answers the
 * same message with 202 and connects fine.)
 *
 * Pins:
 *   1. `notifications/initialized` → 202, empty body, no Content-Type.
 *   2. ANY id-less message (not only initialized) → 202, empty body.
 *   3. `initialize` (a request, has an id) → 200 application/json, unchanged.
 *   4. Unknown method WITH an id → 200 JSON-RPC -32601, unchanged.
 *
 * Harness mirrors mcp-wire-shape.test.mjs: ephemeral-port server around
 * createRequestHandler(); no memory client is touched on these paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

async function startServer(ctx = {}) {
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

async function postMcp(origin, message) {
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
}

test('POST /mcp notifications/initialized → 202 Accepted, empty body, no Content-Type', async () => {
  const { origin, close } = await startServer();
  try {
    const res = await postMcp(origin, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202, 'notifications must be acknowledged with 202 Accepted');
    assert.equal(res.headers.get('content-type'), null, 'no Content-Type on an empty acknowledgement');
    assert.equal(await res.text(), '', 'body must be empty — an empty application/json body is unparseable');
  } finally {
    await close();
  }
});

test('POST /mcp any id-less JSON-RPC message (not only initialized) → 202, empty body', async () => {
  const { origin, close } = await startServer();
  try {
    for (const method of ['notifications/cancelled', 'notifications/progress', 'tools/list']) {
      const res = await postMcp(origin, { jsonrpc: '2.0', method, params: {} });
      assert.equal(res.status, 202, `${method} without an id is a notification → 202`);
      assert.equal(res.headers.get('content-type'), null, `${method}: no Content-Type`);
      assert.equal(await res.text(), '', `${method}: empty body`);
    }
  } finally {
    await close();
  }
});

test('POST /mcp initialize (a request, has an id) still → 200 application/json with a result', async () => {
  const { origin, close } = await startServer();
  try {
    const res = await postMcp(origin, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const rpc = JSON.parse(await res.text());
    assert.equal(rpc.jsonrpc, '2.0');
    assert.equal(rpc.id, 1);
    assert.equal(rpc.result.protocolVersion, '2024-11-05');
    assert.equal(rpc.result.serverInfo.name, 'universal-memory');
    assert.ok(rpc.result.capabilities.tools, 'tools capability advertised');
  } finally {
    await close();
  }
});

test('POST /mcp unknown method WITH an id still → 200 JSON-RPC -32601 (requests unchanged)', async () => {
  const { origin, close } = await startServer();
  try {
    const res = await postMcp(origin, { jsonrpc: '2.0', id: 7, method: 'no/such/method' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const rpc = JSON.parse(await res.text());
    assert.equal(rpc.id, 7);
    assert.equal(rpc.error.code, -32601);
  } finally {
    await close();
  }
});
