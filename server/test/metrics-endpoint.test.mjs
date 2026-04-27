/**
 * /metrics endpoint + counter-finish wiring (Task C.5 — spec §4.2).
 *
 * Pins:
 *   1. /metrics handler emits Prometheus text exposition (not JSON).
 *      content-type: 'text/plain; ...'.
 *   2. Endpoint-class branches all reachable through the live handler:
 *      - loopback-only + loopback IP → 200 + bypass auth + bypass rate-limit
 *      - loopback-only + non-loopback (forwarded header) → 404 (don't advertise)
 *      - loopback-only=false + auth required + valid token → 200
 *      - loopback-only=false + auth NOT required → 200 unauth
 *   3. Counter-finish wiring: every non-/health, non-/metrics request
 *      increments um_http_requests_total{endpoint, status} and observes
 *      um_http_request_duration_seconds{endpoint}.
 *   4. endpoint label is the route TEMPLATE
 *      (/api/recent/:project — never /api/recent/<slug>) — cardinality cap N1.
 *   5. /metrics itself does NOT emit metrics (recursive scraping artifact).
 *   6. /health does NOT emit metrics (preserve §4.2.0 budget).
 *
 * Each test starts a fresh server on an ephemeral port (matches B.6 pattern).
 * The shared metrics Registry is process-global, so we read snapshot deltas
 * (before/after) rather than absolute values to stay independent of ordering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../mem0-mcp-http.mjs';
import { registry, httpRequestsTotal } from '../lib/metrics.mjs';

const fakeMemory = {
  getAll: async () => ({
    results: [{ id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 't' } }],
  }),
};

// Start a server with the named env overrides applied. Returns
// { close, url } — url(p) builds a loopback URL.
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

// Pull the current value of um_http_requests_total{endpoint,status}
// from the registry. Returns 0 when the label combo hasn't been seen.
async function counterValue(endpoint, status) {
  const text = await registry.metrics();
  const re = new RegExp(`^um_http_requests_total\\{endpoint="${endpoint.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}",status="${status}"\\}\\s+(\\d+(?:\\.\\d+)?)`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// Part A — /metrics handler (4 endpoint-class branches)
// ---------------------------------------------------------------------------

test('GET /metrics from loopback (default UM_METRICS_LOOPBACK_ONLY=true) → 200 + Prometheus text', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/metrics'));
    assert.equal(r.status, 200);
    const ct = r.headers.get('content-type') || '';
    assert.match(ct, /text\/plain/);
    const body = await r.text();
    // Exposition-format markers + at least one of our metrics.
    assert.match(body, /# HELP um_http_requests_total/);
    assert.match(body, /# TYPE um_http_requests_total counter/);
  } finally { await close(); }
});

test('GET /metrics: returnStatus 404 short-circuit honored by handler (synthetic non-loopback)', async () => {
  // endpoint-class returns {returnStatus: 404} when loopback-only=true
  // AND sourceIp is non-loopback. The unit test (endpoint-class.test.mjs)
  // pins the policy decision; this integration test pins that the
  // handler's short-circuit branch (route.returnStatus → res.writeHead +
  // res.end + return) actually fires when the policy says 404.
  //
  // Because fetch from 127.0.0.1 always presents a loopback socket, we
  // can't fake non-loopback at the socket layer. Instead we exercise the
  // logically-equivalent path: a request to a route whose endpoint-class
  // policy *would* return some non-200 short-circuit. Currently the only
  // returnStatus row is /metrics with non-loopback — so this test
  // doubles as a regression guard that policy stays wire-able through
  // endpointClassRoute → handler step 3a, and that the response carries
  // no body (privacy: don't advertise the endpoint exists).
  //
  // We simulate by directly calling createRequestHandler with a stubbed
  // req.socket.remoteAddress — which is exactly what production code
  // reads. This proves the handler's short-circuit fires on the policy
  // signal, end-to-end, without needing socket-level IP spoofing.
  const handler = createRequestHandler({ memory: fakeMemory });
  const prevLoopOnly = process.env.UM_METRICS_LOOPBACK_ONLY;
  process.env.UM_METRICS_LOOPBACK_ONLY = 'true';
  try {
    const req = {
      url: '/metrics',
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '10.0.0.5' }, // non-loopback
    };
    let writtenStatus = null;
    let writtenHeaders = null;
    let endedBody = '';
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader: () => {},
      writeHead(status, headers) { writtenStatus = status; writtenHeaders = headers; this.statusCode = status; this.headersSent = true; },
      end(body) { if (body) endedBody += String(body); },
    };
    await handler(req, res);
    assert.equal(writtenStatus, 404, 'returnStatus 404 short-circuit must fire');
    assert.equal(endedBody, '', 'no body — must not advertise the endpoint exists');
  } finally {
    if (prevLoopOnly === undefined) delete process.env.UM_METRICS_LOOPBACK_ONLY;
    else process.env.UM_METRICS_LOOPBACK_ONLY = prevLoopOnly;
  }
});

test('GET /metrics with UM_METRICS_LOOPBACK_ONLY=false + auth required + missing token → 401', async () => {
  // public mode + auth-required (default) → fall through to bearer auth.
  // No token + forwarded header (suppress loopback bypass) → 401.
  const { close, url } = await startServer({
    env: { UM_METRICS_LOOPBACK_ONLY: 'false', UM_METRICS_AUTH_REQUIRED: 'true' },
  });
  try {
    const r = await fetch(url('/metrics'), { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('GET /metrics with UM_METRICS_LOOPBACK_ONLY=false + auth required + valid token → 200', async () => {
  const { close, url } = await startServer({
    env: { UM_METRICS_LOOPBACK_ONLY: 'false', UM_METRICS_AUTH_REQUIRED: 'true' },
  });
  try {
    const r = await fetch(url('/metrics'), {
      headers: { 'Authorization': 'Bearer secret-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /# HELP um_http_requests_total/);
  } finally { await close(); }
});

test('GET /metrics with UM_METRICS_LOOPBACK_ONLY=false + UM_METRICS_AUTH_REQUIRED=false → 200 unauth', async () => {
  // Ops opted out of auth — must bypass and return text exposition.
  const { close, url } = await startServer({
    env: { UM_METRICS_LOOPBACK_ONLY: 'false', UM_METRICS_AUTH_REQUIRED: 'false' },
  });
  try {
    const r = await fetch(url('/metrics'), { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /# HELP um_http_requests_total/);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Part B — counter-finish wiring (extends C.3 res.end shim)
// ---------------------------------------------------------------------------

test('after /api/list, um_http_requests_total{/api/list,200} increments by 1', async () => {
  const { close, url } = await startServer();
  try {
    const before = await counterValue('/api/list', '200');
    const r1 = await fetch(url('/api/list'));
    assert.equal(r1.status, 200);
    // Drain the body so the response is fully closed before scraping.
    await r1.text();
    const after = await counterValue('/api/list', '200');
    assert.equal(after, before + 1, `expected +1 increment, got before=${before} after=${after}`);
  } finally { await close(); }
});

test('endpoint label is route template — /api/recent/:project NOT raw slug', async () => {
  // Hit /api/recent/some-project; the counter must label it as the
  // template ('/api/recent/:project'), never the expanded slug.
  // Cardinality cap N1.
  const tmpVault = await mkdtemp(path.join(tmpdir(), 'um-c5-recent-'));
  await mkdir(path.join(tmpVault, 'authored', 'some-project'), { recursive: true });
  const prevVault = process.env.UM_VAULT_DIR;
  process.env.UM_VAULT_DIR = tmpVault;
  try {
    const { close, url } = await startServer();
    try {
      const before = await counterValue('/api/recent/:project', '200');
      const r = await fetch(url('/api/recent/some-project'));
      // /api/recent/:project may return 200 with empty list or 404 if
      // no such project — either way the counter should fire on the
      // routeTemplate, not the slug. The status the counter records
      // matches the actual response status.
      await r.text();
      const after = await counterValue('/api/recent/:project', String(r.status));
      assert.equal(after, before + 1, `template counter should bump regardless of status (got status=${r.status})`);
      // Cardinality assert: the raw-slug form never appears as a label.
      const text = await registry.metrics();
      assert.doesNotMatch(
        text,
        /um_http_requests_total\{[^}]*endpoint="\/api\/recent\/some-project"/,
        'raw slug must not be used as endpoint label (cardinality cap N1)'
      );
    } finally { await close(); }
  } finally {
    if (prevVault === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = prevVault;
  }
});

test('histogram observes request duration after handler', async () => {
  const { close, url } = await startServer();
  try {
    const r = await fetch(url('/api/list'));
    assert.equal(r.status, 200);
    await r.text();
    const text = await registry.metrics();
    // At least one bucket line for /api/list must exist after the request.
    assert.match(
      text,
      /um_http_request_duration_seconds_bucket\{[^}]*endpoint="\/api\/list"/,
      'expected histogram bucket lines for /api/list'
    );
  } finally { await close(); }
});

test('/health does NOT emit metrics (preserve §4.2.0 liveness budget)', async () => {
  const { close, url } = await startServer();
  try {
    const before = await counterValue('/health', '200');
    const r = await fetch(url('/health'));
    assert.equal(r.status, 200);
    await r.text();
    const after = await counterValue('/health', '200');
    assert.equal(after, before, '/health must not increment um_http_requests_total');
  } finally { await close(); }
});

test('/metrics does NOT emit metrics for itself (no recursive scrape artifact)', async () => {
  const { close, url } = await startServer();
  try {
    const before = await counterValue('/metrics', '200');
    const r = await fetch(url('/metrics'));
    assert.equal(r.status, 200);
    await r.text();
    const after = await counterValue('/metrics', '200');
    assert.equal(after, before, '/metrics must not increment its own counter');
  } finally { await close(); }
});

test('counter increments are observed across two scrapes (snapshot delta)', async () => {
  // Hit /api/list twice; um_http_requests_total{/api/list,200} bumps by exactly 2.
  const { close, url } = await startServer();
  try {
    const before = await counterValue('/api/list', '200');
    const r1 = await fetch(url('/api/list'));
    await r1.text();
    const r2 = await fetch(url('/api/list'));
    await r2.text();
    const after = await counterValue('/api/list', '200');
    assert.equal(after, before + 2);
  } finally { await close(); }
});
