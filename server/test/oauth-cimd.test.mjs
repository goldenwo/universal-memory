// server/test/oauth-cimd.test.mjs — the CIMD (Client ID Metadata Document)
// resolver (Gap-3 OAuth spec §3 Q5 + §6 item 3, plan Task 4.1). A CIMD
// client_id IS an https URL; the AS fetches that URL to learn the client's
// metadata. The resolver is the ChatGPT-preferred registration path.
//
// Every test injects a fetchImpl SPY — NEVER real network. The security
// contract is allowlist-FIRST (no fetch for an off-allowlist or non-https
// client_id), SSRF-safe fetch (redirect:'manual', timeout, size cap, no
// redirect following), strict document validation (client_id self-consistency,
// allowlisted redirect_uris, public-client auth method), and a bounded
// header-driven cache (positive TTL clamped [300s,86400s]; negative 60s).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CIMD_HOSTS, createCimdResolver } from '../lib/oauth/cimd.mjs';

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector/oauth/abc123';
const CLIENT_URL = 'https://chatgpt.com/oauth/abc/client.json';

// A minimal valid CIMD document for CLIENT_URL.
function validDoc(overrides = {}) {
  return {
    client_id: CLIENT_URL,
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_REDIRECT],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

// Build a Response-like object the resolver consumes (status, headers.get,
// text()). headers keys are matched case-insensitively, mirroring fetch().
function makeResponse({ status = 200, headers = {}, body = '', bodyText } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  const text = bodyText ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    async text() { return text; },
  };
}

// A fetch spy: records calls, returns a queued/single response or throws.
function makeFetchSpy({ response, responses, throws } = {}) {
  const calls = [];
  const queue = responses ? [...responses] : null;
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (throws) throw throws;
    if (queue) return queue.shift();
    return response;
  };
  impl.calls = calls;
  return impl;
}

// A controllable clock for cache-TTL tests.
function clock(start = 1_000_000) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

// =========================================================================
// 1. Allowlist FIRST — no fetch for rejected client_ids (spec §3 Q5)
// =========================================================================

test('cimd: http:// client_id → null without fetch', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve('http://chatgpt.com/oauth/abc/client.json'), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('cimd: non-URL string → null without fetch', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve('not-a-url'), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('cimd: off-allowlist host → null without fetch', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve('https://evil.example/client.json'), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('cimd: lookalike chatgpt.com.evil.com → null without fetch (subdomain rule)', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve('https://chatgpt.com.evil.com/client.json'), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('cimd: exact allowlisted host (claude.ai) passes the allowlist gate', async () => {
  const url = 'https://claude.ai/client.json';
  const fetchImpl = makeFetchSpy({
    response: makeResponse({ body: validDoc({ client_id: url, redirect_uris: [CLAUDE_REDIRECT] }) }),
  });
  const resolve = createCimdResolver({ fetchImpl });
  const out = await resolve(url);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(out.client_id, url);
});

test('cimd: subdomain of an allowlisted host passes the allowlist gate', async () => {
  const url = 'https://api.openai.com/client.json';
  const fetchImpl = makeFetchSpy({
    response: makeResponse({ body: validDoc({ client_id: url }) }),
  });
  const resolve = createCimdResolver({ fetchImpl });
  const out = await resolve(url);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(out.client_id, url);
});

test('cimd: UM_OAUTH_CIMD_HOSTS extends the allowlist (trimmed, lowercased)', async () => {
  const url = 'https://connect.vendor.test/client.json';
  const fetchImpl = makeFetchSpy({
    response: makeResponse({ body: validDoc({ client_id: url }) }),
  });
  const resolve = createCimdResolver({ fetchImpl, env: { UM_OAUTH_CIMD_HOSTS: ' Vendor.Test , other.test ' } });
  const out = await resolve(url);
  assert.equal(fetchImpl.calls.length, 1, 'extended host should pass the allowlist');
  assert.equal(out.client_id, url);
});

test('cimd: DEFAULT_CIMD_HOSTS is the documented frozen vendor set', () => {
  assert.deepEqual(DEFAULT_CIMD_HOSTS, ['claude.ai', 'chatgpt.com', 'openai.com']);
  assert.throws(() => { DEFAULT_CIMD_HOSTS.push('x'); });
});

// =========================================================================
// 2. Fetch guards (spec §6 item 3)
// =========================================================================

test('cimd: fetch called with redirect:manual + abort signal', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  await resolve(CLIENT_URL);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, CLIENT_URL);
  assert.equal(opts.redirect, 'manual');
  assert.ok(opts.signal, 'an abort signal (timeout) must be supplied');
  assert.equal(typeof opts.signal.aborted, 'boolean');
});

test('cimd: 3xx redirect response → null (redirects NOT followed)', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ status: 302, headers: { location: 'https://evil.example/' } }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: non-200 (404) → null', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ status: 404, body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: Content-Length over 64KB → null', async () => {
  const fetchImpl = makeFetchSpy({
    response: makeResponse({ headers: { 'content-length': String(65536 + 1) }, body: validDoc() }),
  });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: body text over 64KB → null (no/lying Content-Length)', async () => {
  const huge = JSON.stringify({ ...validDoc(), pad: 'a'.repeat(65536) });
  const fetchImpl = makeFetchSpy({ response: makeResponse({ bodyText: huge }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: non-JSON body → null', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ bodyText: 'not json at all' }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

// =========================================================================
// 3. Document validation (spec §6 item 3, mirrors DCR shape rules)
// =========================================================================

test('cimd: doc.client_id !== requested URL → null', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc({ client_id: 'https://chatgpt.com/other.json' }) }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: missing/empty redirect_uris → null', async () => {
  const r1 = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ redirect_uris: [] }) }) }) });
  assert.equal(await r1(CLIENT_URL), null);
  const r2 = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ redirect_uris: undefined }) }) }) });
  assert.equal(await r2(CLIENT_URL), null);
});

test('cimd: a non-allowlisted redirect_uri → null', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc({ redirect_uris: ['https://evil.example/cb'] }) }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: redirect_uris over the length cap → null (PR-5 hardening)', async () => {
  // 11 individually-valid (loopback) callbacks — each allowlisted, but the
  // array exceeds MAX_REDIRECT_URIS (10), so the doc is rejected.
  const tooMany = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${3000 + i}/cb`);
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc({ redirect_uris: tooMany }) }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: token_endpoint_auth_method other than none → null', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc({ token_endpoint_auth_method: 'client_secret_basic' }) }) });
  const resolve = createCimdResolver({ fetchImpl });
  assert.equal(await resolve(CLIENT_URL), null);
});

test('cimd: absent token_endpoint_auth_method is accepted (public client)', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc({ token_endpoint_auth_method: undefined }) }) });
  const resolve = createCimdResolver({ fetchImpl });
  const out = await resolve(CLIENT_URL);
  assert.ok(out);
});

test('cimd: client_name truncated to 120 chars; absent → "(unnamed client)"', async () => {
  const longName = 'x'.repeat(200);
  const r1 = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ client_name: longName }) }) }) });
  const out1 = await r1(CLIENT_URL);
  assert.equal(out1.client_name.length, 120);
  const r2 = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ client_name: undefined }) }) }) });
  const out2 = await r2(CLIENT_URL);
  assert.equal(out2.client_name, '(unnamed client)');
});

test('cimd: grant_types intersected with supported; authorization_code required; default authorization_code', async () => {
  // No supported grant survives the intersection (client can't run our code
  // flow at all) → reject.
  const bad = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ grant_types: ['password'] }) }) }) });
  assert.equal(await bad(CLIENT_URL), null);
  // Declares refresh_token only — the code flow is impossible → reject.
  const noCode = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ grant_types: ['refresh_token'] }) }) }) });
  assert.equal(await noCode(CLIENT_URL), null);
  const good = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ grant_types: ['authorization_code', 'refresh_token'] }) }) }) });
  const out = await good(CLIENT_URL);
  assert.deepEqual(out.grant_types, ['authorization_code', 'refresh_token']);
  const dflt = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ grant_types: undefined }) }) }) });
  assert.deepEqual((await dflt(CLIENT_URL)).grant_types, ['authorization_code']);
});

test('cimd: vendor-declared extra grant types are tolerated, not fatal (claude.ai 2026-07 drift)', async () => {
  // Live regression: claude.ai's metadata document added
  // urn:ietf:params:oauth:grant-type:jwt-bearer alongside the supported
  // pair. Rejecting the WHOLE document on an unsupported extra broke the
  // connector with invalid_client/"unknown client_id" at /oauth/authorize.
  // Contract: intersect with the supported set (UM simply never issues the
  // extras) as long as authorization_code survives.
  const drifted = createCimdResolver({ fetchImpl: makeFetchSpy({ response: makeResponse({ body: validDoc({ grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] }) }) }) });
  const out = await drifted(CLIENT_URL);
  assert.ok(out, 'drifted metadata must still resolve');
  assert.deepEqual(out.grant_types, ['authorization_code', 'refresh_token'],
    'unsupported extras are dropped by intersection, not fatal');
});

// =========================================================================
// 4. Success shape (spec §6 item 3 / plan 4.1) — source:'cimd', not persisted
// =========================================================================

test('cimd: success returns the spec-shaped client record (source cimd)', async () => {
  const fetchImpl = makeFetchSpy({ response: makeResponse({ body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl });
  const out = await resolve(CLIENT_URL);
  assert.deepEqual(out, {
    client_id: CLIENT_URL,
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_REDIRECT],
    grant_types: ['authorization_code'],
    source: 'cimd',
  });
});

// =========================================================================
// 5. Cache (spec §6 item 3): header-driven TTL [300s,86400s], negative 60s
// =========================================================================

test('cimd: positive result cached — 2nd call within TTL does not re-fetch', async () => {
  const c = clock();
  const fetchImpl = makeFetchSpy({ response: makeResponse({ headers: { 'cache-control': 'max-age=600' }, body: validDoc() }) });
  const resolve = createCimdResolver({ fetchImpl, now: c.now });
  await resolve(CLIENT_URL);
  await resolve(CLIENT_URL);
  assert.equal(fetchImpl.calls.length, 1, 'second call within TTL must hit cache');
});

test('cimd: TTL floor 300s — missing Cache-Control caches 300s, re-fetch after', async () => {
  const c = clock();
  const fetchImpl = makeFetchSpy({ responses: [makeResponse({ body: validDoc() }), makeResponse({ body: validDoc() })] });
  const resolve = createCimdResolver({ fetchImpl, now: c.now });
  await resolve(CLIENT_URL);
  c.t += 299_000;
  await resolve(CLIENT_URL);
  assert.equal(fetchImpl.calls.length, 1, 'within 300s floor → cached');
  c.t += 2_000; // now > 300s
  await resolve(CLIENT_URL);
  assert.equal(fetchImpl.calls.length, 2, 'after floor expiry → re-fetch');
});

test('cimd: max-age below floor clamped up to 300s', async () => {
  const c = clock();
  const fetchImpl = makeFetchSpy({ responses: [makeResponse({ headers: { 'cache-control': 'max-age=10' }, body: validDoc() }), makeResponse({ body: validDoc() })] });
  const resolve = createCimdResolver({ fetchImpl, now: c.now });
  await resolve(CLIENT_URL);
  c.t += 60_000; // past the requested 10s, but under the 300s floor
  await resolve(CLIENT_URL);
  assert.equal(fetchImpl.calls.length, 1, 'max-age below floor is clamped to 300s');
});

test('cimd: max-age above ceiling clamped down to 86400s', async () => {
  const c = clock();
  const fetchImpl = makeFetchSpy({ responses: [makeResponse({ headers: { 'cache-control': 'max-age=999999999' }, body: validDoc() }), makeResponse({ body: validDoc() })] });
  const resolve = createCimdResolver({ fetchImpl, now: c.now });
  await resolve(CLIENT_URL);
  c.t += 86_400_000 + 1_000; // just past the 24h ceiling
  await resolve(CLIENT_URL);
  assert.equal(fetchImpl.calls.length, 2, 'max-age above ceiling is clamped to 86400s → re-fetch');
});

test('cimd: failure negative-cached 60s — no re-fetch within 60s, re-fetch after', async () => {
  const c = clock();
  // first: invalid doc → null; later: a valid doc to prove re-fetch happens.
  const fetchImpl = makeFetchSpy({ responses: [
    makeResponse({ status: 404 }),
    makeResponse({ status: 404 }),
    makeResponse({ body: validDoc() }),
  ] });
  const resolve = createCimdResolver({ fetchImpl, now: c.now });
  assert.equal(await resolve(CLIENT_URL), null);
  c.t += 59_000;
  assert.equal(await resolve(CLIENT_URL), null);
  assert.equal(fetchImpl.calls.length, 1, 'negative cache suppresses re-fetch within 60s');
  c.t += 2_000; // past 60s
  await resolve(CLIENT_URL);
  assert.equal(fetchImpl.calls.length, 2, 'after 60s negative TTL → re-fetch');
});

// =========================================================================
// 6. Transient fetch rejection (spec §6 item 3) → null + negative cache
// =========================================================================

test('cimd: fetchImpl throws → null + negative cache', async () => {
  const c = clock();
  const fetchImpl = makeFetchSpy({ throws: new Error('ECONNREFUSED') });
  const resolve = createCimdResolver({ fetchImpl, now: c.now });
  assert.equal(await resolve(CLIENT_URL), null);
  assert.equal(await resolve(CLIENT_URL), null);
  assert.equal(fetchImpl.calls.length, 1, 'transient failure is negative-cached (no re-fetch within 60s)');
});
