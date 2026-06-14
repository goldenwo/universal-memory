// server/test/oauth-idp-github.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubAdapter } from '../lib/oauth/idp/github.mjs';

const env = { UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid', UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec' };
const gh = createGithubAdapter(env);

// Response-like mock mirroring server/test/oauth-cimd.test.mjs makeResponse:
// the adapter consumes { status, headers.get(name), async text() } — NOT json().
function makeResponse({ status = 200, headers = {}, body } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    async text() { return text; },
  };
}

test('buildAuthorizeUrl: fixed host, client_id, state, redirect_uri, NO scope param', () => {
  const u = new URL(gh.buildAuthorizeUrl({ state: 'st', redirectUri: 'https://um/cb' }));
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://um/cb');
  assert.equal(u.searchParams.has('scope'), false); // omitted entirely, not scope=
});

test('exchangeCode posts to the token host and returns opaque credentials', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return makeResponse({ body: { access_token: 'gho_x', token_type: 'bearer' } });
  };
  const out = await gh.exchangeCode({ code: 'c', redirectUri: 'https://um/cb', fetchImpl: fakeFetch });
  assert.equal(new URL(calls[0].url).host, 'github.com');
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.equal(out.credentials.accessToken, 'gho_x');
});

test('fetchIdentity returns {subject,displayName}; missing/non-int id → throws (deny)', async () => {
  const okFetch = async () => makeResponse({ body: { id: 5550123, login: 'goldenwo' } });
  const id = await gh.fetchIdentity({ credentials: { accessToken: 'gho_x' }, fetchImpl: okFetch });
  assert.deepEqual(id, { subject: '5550123', displayName: 'goldenwo' }); // id coerced to string

  const badFetch = async () => makeResponse({ body: { login: 'x' } }); // no id
  await assert.rejects(() => gh.fetchIdentity({ credentials: { accessToken: 'gho_x' }, fetchImpl: badFetch }));
});

test('exchangeCode rejects a non-2xx from GitHub', async () => {
  const bad = async () => makeResponse({ status: 500, body: {} });
  await assert.rejects(() => gh.exchangeCode({ code: 'c', redirectUri: 'https://um/cb', fetchImpl: bad }));
});

test('adapter exposes a display label', () => { assert.equal(gh.label, 'GitHub'); });

test('fetchIdentity: non-2xx from /user → throws (deny)', async () => {
  const bad = async () => makeResponse({ status: 500, body: {} });
  await assert.rejects(() => gh.fetchIdentity({ credentials: { accessToken: 'gho_x' }, fetchImpl: bad }));
});

test('fetchIdentity: id <= 0 → throws (no non-positive subject)', async () => {
  const zero = async () => makeResponse({ body: { id: 0, login: 'x' } });
  await assert.rejects(() => gh.fetchIdentity({ credentials: { accessToken: 'gho_x' }, fetchImpl: zero }));
});

test('exchangeCode: 200 with an error body (no access_token) → throws', async () => {
  const errBody = async () => makeResponse({ body: { error: 'bad_verification_code' } });
  await assert.rejects(() => gh.exchangeCode({ code: 'c', redirectUri: 'https://um/cb', fetchImpl: errBody }));
});

// Social-login PR-3 — adapter thrown errors must never embed the client secret
// (env above is { ...CLIENT_SECRET: 'sec' }) or the access token: a throw here
// is mapped by the callback handler to a retriable error page that leaks nothing.
test('exchangeCode failure error message does not contain the client secret', async () => {
  const bad = async () => makeResponse({ status: 500, body: {} });
  await gh.exchangeCode({ code: 'c', redirectUri: 'https://um/cb', fetchImpl: bad }).then(
    () => assert.fail('should reject'),
    (e) => assert.ok(!String(e.message).includes('sec')),
  );
});

test('fetchIdentity failure error message does not contain the access token', async () => {
  const bad = async () => makeResponse({ status: 500, body: {} });
  // obvious placeholder (not a real credential) — the assertion only needs a
  // distinctive string the thrown error must not echo back.
  const fakeToken = 'gho_' + 'EXAMPLE-NOT-A-REAL-TOKEN';
  await gh.fetchIdentity({ credentials: { accessToken: fakeToken }, fetchImpl: bad }).then(
    () => assert.fail('should reject'),
    (e) => assert.ok(!String(e.message).includes(fakeToken)),
  );
});
