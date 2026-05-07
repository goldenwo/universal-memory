/**
 * CORS preflight tests — W6.4 hardening.
 *
 * Per the W6.4 security review: the previous preflight response only
 * advertised `Content-Type` in `Access-Control-Allow-Headers`. Browser-
 * origin clients sending `Authorization: Bearer <token>` would have their
 * preflight rejected by the browser before the request reached our auth
 * layer — a silent break for any web-based integration (Custom GPT
 * Actions, Claude.ai web connector, third-party browser tooling).
 *
 * This test pins the contract: `Authorization` must always appear in the
 * allow-headers list. If a future refactor narrows the list, this test
 * fails before the regression hits production.
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

test('CORS preflight advertises Authorization in Access-Control-Allow-Headers (W6.4)', async () => {
  const { origin, close } = await startServer({});
  try {
    const res = await fetch(`${origin}/api/search`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    assert.equal(res.status, 200, 'preflight should respond 200');
    const allowHeaders = res.headers.get('access-control-allow-headers') || '';
    assert.ok(
      /\bAuthorization\b/i.test(allowHeaders),
      `expected Authorization in Access-Control-Allow-Headers, got: ${JSON.stringify(allowHeaders)}`,
    );
    assert.ok(
      /\bContent-Type\b/i.test(allowHeaders),
      `expected Content-Type in Access-Control-Allow-Headers, got: ${JSON.stringify(allowHeaders)}`,
    );
  } finally {
    await close();
  }
});

test('CORS preflight responds with allowed methods and wildcard origin', async () => {
  const { origin, close } = await startServer({});
  try {
    const res = await fetch(`${origin}/api/search`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const allowMethods = res.headers.get('access-control-allow-methods') || '';
    for (const m of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      assert.ok(allowMethods.includes(m), `expected ${m} in Access-Control-Allow-Methods, got: ${allowMethods}`);
    }
  } finally {
    await close();
  }
});
