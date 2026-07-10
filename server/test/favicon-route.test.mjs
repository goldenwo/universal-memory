/**
 * /favicon.svg + /favicon.ico dispatch (Task 3 — spec §4 public-release-polish).
 *
 * Pins:
 *   1. GET /favicon.svg -> 200, content-type image/svg+xml, byte-equal to the
 *      repo asset.
 *   2. GET /favicon.ico -> 200, content-type image/x-icon, byte-equal to the
 *      repo asset (compared as raw Buffers — the ico embeds PNG bytes, which
 *      utf-8 text collection would mangle).
 *   3. Both succeed with UM_AUTH_TOKEN set and NO Authorization header (public).
 *   4. Both succeed with UM_OAUTH_ENABLED unset (flag-independent).
 *
 * Uses the same boot-a-server-with-mocked-SDK harness as
 * server/test/metrics-endpoint.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAVICON_SVG_PATH = path.resolve(__dirname, '../assets/brand/favicon.svg');
const FAVICON_ICO_PATH = path.resolve(__dirname, '../assets/brand/favicon.ico');

const fakeMemory = {
  getAll: async () => ({
    results: [{ id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 't' } }],
  }),
};

// Start a server with the named env overrides applied. Returns
// { close, url } — url(p) builds a loopback URL. Mirrors the
// metrics-endpoint.test.mjs harness exactly.
async function startServer({ env = {}, memory = fakeMemory, token = 'secret-token' } = {}) {
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) {
    prevEnv[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  prevEnv.UM_AUTH_TOKEN = process.env.UM_AUTH_TOKEN;
  if (token !== null) process.env.UM_AUTH_TOKEN = token;

  const srv = createServer(createRequestHandler({ memory }));
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

// Collect the response body as raw bytes (not utf-8 text) — required for
// the .ico asset, which embeds PNG bytes that would be mangled by text
// decoding.
async function bodyBytes(res) {
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

test('GET /favicon.svg -> 200, image/svg+xml, byte-equal to repo asset', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/favicon.svg'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    const body = await bodyBytes(r);
    assert.deepEqual(body, readFileSync(FAVICON_SVG_PATH));
  } finally { await close(); }
});

test('GET /favicon.ico -> 200, image/x-icon, byte-equal to repo asset', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/favicon.ico'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/x-icon');
    const body = await bodyBytes(r);
    assert.deepEqual(body, readFileSync(FAVICON_ICO_PATH));
  } finally { await close(); }
});

test('favicon routes are public — succeed with UM_AUTH_TOKEN set and no Authorization header', async () => {
  const { close, url } = await startServer({ token: 'secret-token' });
  try {
    const rSvg = await fetch(url('/favicon.svg'));
    assert.equal(rSvg.status, 200);
    await rSvg.arrayBuffer();
    const rIco = await fetch(url('/favicon.ico'));
    assert.equal(rIco.status, 200);
    await rIco.arrayBuffer();
  } finally { await close(); }
});

test('favicon routes are flag-independent — succeed with UM_OAUTH_ENABLED unset', async () => {
  const { close, url } = await startServer({ env: { UM_OAUTH_ENABLED: null } });
  try {
    const rSvg = await fetch(url('/favicon.svg'));
    assert.equal(rSvg.status, 200);
    await rSvg.arrayBuffer();
    const rIco = await fetch(url('/favicon.ico'));
    assert.equal(rIco.status, 200);
    await rIco.arrayBuffer();
  } finally { await close(); }
});
