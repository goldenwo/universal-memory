// server/test/control-routes.test.mjs — U3 (#171 Stage B): the /control
// authentication surface (routes + endpoint-class rows + the unlock sequence).
//
// Covers (spec §3 + §8 acceptance):
//   • endpoint-class rows: THREE EXACT rows (/control, /control/unlock,
//     /control/logout) — bypassAuth:true, bypassRateLimit:false,
//     noLoopbackBypass:true — gated by UM_CONTROL_ENABLED; the explicit 404
//     catch for /control/ + unknown subpaths ordered AFTER them; /control-panel
//     must NOT match; /api/stats untouched.
//   • A16 kill switch, A1 zero-stats-reads on the form path, A5(iv) a bearer
//     never unlocks /control, A4b forged/expired cookie ⇒ form.
//   • A2b unlock success (cookie flags + 303 → /control?u=1, no token echoed),
//     A3/A3b byte-identical generic errors, A13 Origin+CSRF, A18 method/
//     content-type/body-cap, A15 logout, A21 the u=1 panel.
//
// Route-test idiom: createRequestHandler over a real node:http server on an
// ephemeral port (api-stats.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { endpointClassRoute } from '../lib/endpoint-class.mjs';
import { createRequestHandler } from '../mem0-mcp-http.mjs';
import { createSession, expire, CONTROL_SESSION_TTL_MS } from '../lib/control-session.mjs';
import { MAX_FORM_BYTES } from '../lib/http-form.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const TOKEN = 'control-master-token-abc123';

// A fixed, base64url-shaped CSRF pair. The double-submit token is STATELESS —
// the client supplies both halves — so a test can pin the value and get
// byte-comparable responses out of two different servers (A3 ↔ A3b).
const FIXED_CSRF = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

// U5: the authenticated GET now calls the REAL buildStats(), which reads the
// counters db via readCounterStats() when a test doesn't inject its own
// `readCounters`. Without a per-test override, readCounterStats() falls back
// to countersDbPath()'s resolution — which, on a developer machine that runs
// its own UM instance, can be a REAL, non-empty db (verified while wiring this
// up: it rendered actual production surface names/counts). Every test in this
// file gets a guaranteed-missing db path by default so results stay hermetic
// and machine-independent; the few tests that need a REAL counters db seed
// their OWN tmp one and pass it via `env`.
function missingDbPath(label) {
  return path.join(os.tmpdir(), `um-control-routes-nodb-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// The authenticated page's unique marker (U5): the real control-page.mjs
// document's "Sign out" button. NOT "operational telemetry" — the unlock
// form's own muted blurb ("Read-only operational telemetry...") contains that
// exact phrase too, so it collided across both pages; "Sign out" appears only
// on the authenticated page's logout form (the unlock form's button says
// "Unlock").
const AUTHENTICATED_MARKER = /Sign out/;

// UTC day string, same convention as stats-payload.test.mjs — used by the A8
// wire tests below that seed a real counters db.
const TODAY = new Date().toISOString().slice(0, 10);

// Direct-SQL seeding, same T5 schema as stats-payload.test.mjs — used only by
// the A8/A6 wire tests below that need a REAL, readable counters db.
function seedCountersDb(dbPath, rows = []) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        day     TEXT    NOT NULL,
        surface TEXT    NOT NULL,
        project TEXT    NOT NULL,
        event   TEXT    NOT NULL,
        outcome TEXT    NOT NULL,
        count   INTEGER NOT NULL,
        PRIMARY KEY (day, surface, project, event, outcome)
      )
    `);
    db.pragma('user_version = 1');
    const stmt = db.prepare(`
      INSERT INTO counters (day, surface, project, event, outcome, count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, surface, project, event, outcome)
      DO UPDATE SET count = count + excluded.count
    `);
    for (const r of rows) {
      stmt.run(r.day, r.surface ?? 'claude-code', r.project ?? '', r.event, r.outcome ?? '', r.count ?? 1);
    }
  } finally {
    db.close();
  }
}

async function tempCountersDbPath(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `um-control-routes-${prefix}-`));
  return path.join(dir, 'um-counters.db');
}

// ---------- helpers ----------

// Memory client that DETONATES on any read. Injected into every /control test:
// the unlock form, the failure re-render, the u=1 panel and the authenticated
// page's OWN template are constants-only outside the one buildStats() call
// (A1/A5) — buildStats() itself catches a throwing memory.getAll() and turns
// it into a corpus-unavailable degraded render (see stats-payload.mjs), so
// this fixture still proves "untouched" on every path that must never call it
// at all, while remaining SAFE (non-crashing) on the one path that does.
function makeExplodingMemory() {
  return {
    getAll: async () => { throw new Error('A1 violation: /control read the corpus'); },
    search: async () => { throw new Error('A1 violation: /control searched the corpus'); },
  };
}

async function startControl({ env = {}, memory = makeExplodingMemory(), readCounters } = {}) {
  const overrides = {
    UM_AUTH_TOKEN: TOKEN,
    UM_CONTROL_ENABLED: 'true',
    // The shared limiter is deliberately NOT bypassed on loopback for these
    // rows (A10a) — give the ordinary tests plenty of headroom so only the
    // test that pins A10a observes it.
    UM_RATE_LIMIT_RPM: '6000',
    UM_RATE_LIMIT_BURST: '1000',
    // Hermetic by default (see missingDbPath's note above) — a test that wants
    // a real counters db passes its own UM_COUNTERS_DB_PATH via `env`, which
    // overrides this because it is spread AFTER.
    UM_COUNTERS_DB_PATH: missingDbPath('default'),
    ...env,
  };
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const srv = createServer(createRequestHandler({ memory, readCounters }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return {
    close,
    port,
    origin: `http://127.0.0.1:${port}`,
    url: (p) => `http://127.0.0.1:${port}${p}`,
  };
}

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function cookieNamed(res, name) {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

function csrfFieldOf(html) {
  const m = /name="csrf"[^>]*value="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

// POST a urlencoded unlock/logout body. `csrf` supplies BOTH halves of the
// double-submit pair unless cookieCsrf/fieldCsrf are given separately.
async function postForm(ctx, path, {
  token,
  csrf = FIXED_CSRF,
  cookieCsrf = csrf,
  fieldCsrf = csrf,
  origin = ctx.origin,
  secFetchSite,
  cookie,
  contentType = 'application/x-www-form-urlencoded',
  headers = {},
  rawBody,
  omitToken = false,
} = {}) {
  const params = new URLSearchParams();
  if (fieldCsrf !== null) params.set('csrf', fieldCsrf);
  if (!omitToken && token !== undefined) params.set('operator_token', token);
  const h = { ...headers };
  if (contentType !== null) h['Content-Type'] = contentType;
  if (origin !== null) h['Origin'] = origin;
  if (secFetchSite !== undefined) h['Sec-Fetch-Site'] = secFetchSite;
  const cookieParts = [];
  if (cookieCsrf !== null) cookieParts.push(`um_control_csrf=${cookieCsrf}`);
  if (cookie) cookieParts.push(cookie);
  if (cookieParts.length) h['Cookie'] = cookieParts.join('; ');
  return fetch(ctx.url(path), {
    method: 'POST',
    headers: h,
    body: rawBody ?? params.toString(),
    redirect: 'manual',
  });
}

// ---------------------------------------------------------------------------
// Endpoint-class rows (unit)
// ---------------------------------------------------------------------------

const CONTROL_PATHS = ['/control', '/control/unlock', '/control/logout'];

test('endpoint-class: the three EXACT /control rows are auth-bypassed, rate-limited, loopback-veto', () => {
  for (const p of CONTROL_PATHS) {
    const route = endpointClassRoute({ url: p }, { UM_CONTROL_ENABLED: 'true' }, '127.0.0.1');
    assert.deepEqual(
      route,
      { bypassAuth: true, bypassRateLimit: false, noLoopbackBypass: true },
      `${p}: bearer auth must not run; the shared limiter must, even on loopback`,
    );
    assert.equal(route.compat, undefined, '/control must not inherit the compat token scheme/dialect');
  }
});

test('A16: UM_CONTROL_ENABLED unset / != "true" ⇒ every /control row hard-404s', () => {
  for (const env of [{}, { UM_CONTROL_ENABLED: 'false' }, { UM_CONTROL_ENABLED: 'TRUE' }, { UM_CONTROL_ENABLED: '1' }]) {
    for (const p of CONTROL_PATHS) {
      assert.deepEqual(
        endpointClassRoute({ url: p }, env, '127.0.0.1'),
        { returnStatus: 404 },
        `${p} with env ${JSON.stringify(env)} must 404`,
      );
    }
  }
});

test('endpoint-class: EXACT match — /control-panel is NOT a control row', () => {
  const route = endpointClassRoute({ url: '/control-panel' }, { UM_CONTROL_ENABLED: 'true' }, '1.2.3.4');
  assert.deepEqual(route, { bypassAuth: false, bypassRateLimit: false },
    'startsWith("/control") would have swallowed this path into the control surface');
});

test('endpoint-class: /control/ and unknown subpaths 404 (ordered AFTER the exact rows)', () => {
  for (const env of [{ UM_CONTROL_ENABLED: 'true' }, {}]) {
    for (const p of ['/control/', '/control/unknown', '/control/unlock/extra', '/control/a/b/c']) {
      assert.deepEqual(endpointClassRoute({ url: p }, env, '127.0.0.1'), { returnStatus: 404 }, p);
    }
    // Dot-segments — raw AND percent-encoded — are normalized away by the URL
    // parser BEFORE the table is consulted, so a traversal attempt can neither
    // land on nor escape a /control row.
    for (const p of ['/control/../api/list', '/control/%2e%2e/api/list']) {
      assert.deepEqual(
        endpointClassRoute({ url: p }, env, '127.0.0.1'),
        { bypassAuth: false, bypassRateLimit: false },
        `the row table sees the NORMALIZED pathname (/api/list) for ${p}`,
      );
    }
    // …and the catch must not shadow the real routes (row ordering, R2-S-N10).
    const unlock = endpointClassRoute({ url: '/control/unlock' }, env, '127.0.0.1');
    if (env.UM_CONTROL_ENABLED === 'true') {
      assert.equal(unlock.bypassAuth, true, '/control/unlock must hit its own row, not the 404 catch');
    }
  }
});

test('endpoint-class: query strings do not change the /control row match', () => {
  const route = endpointClassRoute({ url: '/control?u=1' }, { UM_CONTROL_ENABLED: 'true' }, '127.0.0.1');
  assert.equal(route.bypassAuth, true);
});

test('A5 regression: the /api/stats row is untouched by the control rows', () => {
  assert.deepEqual(
    endpointClassRoute({ url: '/api/stats' }, { UM_CONTROL_ENABLED: 'true' }, '1.2.3.4'),
    { bypassAuth: false, bypassRateLimit: false, noLoopbackBypass: true },
  );
});

// ---------------------------------------------------------------------------
// A16 over the wire — the kill switch
// ---------------------------------------------------------------------------

test('A16 (wire): flag off ⇒ /control, /control/unlock, /control/logout all 404', async () => {
  const ctx = await startControl({ env: { UM_CONTROL_ENABLED: undefined } });
  try {
    const get = await fetch(ctx.url('/control'));
    assert.equal(get.status, 404);
    for (const p of ['/control/unlock', '/control/logout']) {
      const r = await postForm(ctx, p, { token: TOKEN });
      assert.equal(r.status, 404, `${p} must 404 with the flag off`);
      assert.equal(cookieNamed(r, 'um_control'), undefined, 'no session cookie from a killed route');
    }
  } finally { await ctx.close(); }
});

test('A16 (wire): unknown /control subpaths 404 even with the flag ON', async () => {
  const ctx = await startControl();
  try {
    for (const p of ['/control/', '/control/nope', '/control/unlock/x']) {
      const r = await fetch(ctx.url(p));
      assert.equal(r.status, 404, p);
    }
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A1 / A5(iv) / A4b — GET /control
// ---------------------------------------------------------------------------

test('A1: GET /control with no cookie renders the unlock form, sets a fresh CSRF pair, reads ZERO stats', async () => {
  const ctx = await startControl();
  try {
    const r = await fetch(ctx.url('/control'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /<form[^>]*action="\/control\/unlock"/, 'the unlock form posts to the RELATIVE path');
    assert.match(html, /name="operator_token"/);
    const field = csrfFieldOf(html);
    assert.ok(field && field.length >= 16, 'a hidden csrf field is rendered');
    const cookie = cookieNamed(r, 'um_control_csrf');
    assert.ok(cookie, 'the matching csrf cookie is set');
    assert.equal(cookie.split(';')[0], `um_control_csrf=${field}`, 'cookie and hidden field are the same value');
    assert.equal(cookieNamed(r, 'um_control'), undefined, 'no session cookie on the form path');
    // A1's real teeth: the injected memory client throws on any read, so a
    // 200 here proves session validation strictly precedes data access.
  } finally { await ctx.close(); }
});

test('A5 case (iv): a valid Authorization: Bearer <master> with no cookie STILL renders the unlock form', async () => {
  const ctx = await startControl();
  try {
    const r = await fetch(ctx.url('/control'), { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /name="operator_token"/, '/control never accepts a bearer — the browser holds no credential');
    assert.doesNotMatch(html, AUTHENTICATED_MARKER);
    assert.equal(cookieNamed(r, 'um_control'), undefined);
  } finally { await ctx.close(); }
});

test('A4b: forged / unknown / expired session cookie ⇒ the unlock form', async () => {
  const ctx = await startControl();
  try {
    for (const id of ['forged', 'x'.repeat(43), '']) {
      const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
      assert.equal(r.status, 200);
      assert.match(await r.text(), /name="operator_token"/, `id=${id || '(empty)'} must fall back to the form`);
    }
    // An EXPLICITLY expired (revoked) id behaves the same.
    const { id } = createSession(Date.now());
    expire(id);
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.match(await r.text(), /name="operator_token"/);
  } finally { await ctx.close(); }
});

test('A4b: a live session cookie renders the real control page (not the form)', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, AUTHENTICATED_MARKER, 'the authenticated branch renders the real control page');
    assert.doesNotMatch(html, /name="operator_token"/, 'the real page is not the unlock form');
    assert.match(html, /action="\/control\/logout"/, 'the page carries its own logout form');
    assert.ok(csrfFieldOf(html), 'the logout form carries its own CSRF pair');
    expire(id);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A2b — unlock success
// ---------------------------------------------------------------------------

test('A2b: correct token + valid CSRF + same-origin ⇒ 303 /control?u=1 with the full cookie flag set', async () => {
  const ctx = await startControl();
  try {
    const r = await postForm(ctx, '/control/unlock', { token: TOKEN });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/control?u=1');
    const cookie = cookieNamed(r, 'um_control');
    assert.ok(cookie, 'a session cookie is minted');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/control']) {
      assert.ok(cookie.includes(flag), `session cookie must carry ${flag} — got ${cookie}`);
    }
    assert.match(cookie, new RegExp(`Max-Age=${CONTROL_SESSION_TTL_MS / 1000}\\b`), 'Max-Age is single-sourced from the TTL');
    const body = await r.text();
    assert.ok(!body.includes(TOKEN), 'the master token appears nowhere in the response body');
    assert.ok(!r.headers.get('location').includes(TOKEN), 'nor in the redirect target');
    // The minted session actually works.
    const id = cookie.split(';')[0].slice('um_control='.length);
    const page = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.match(await page.text(), AUTHENTICATED_MARKER);
    expire(id);
  } finally { await ctx.close(); }
});

test('A2b: Sec-Fetch-Site: same-origin (no Origin header) also passes the origin gate', async () => {
  const ctx = await startControl();
  try {
    const r = await postForm(ctx, '/control/unlock', { token: TOKEN, origin: null, secFetchSite: 'same-origin' });
    assert.equal(r.status, 303);
    const id = cookieNamed(r, 'um_control').split(';')[0].slice('um_control='.length);
    expire(id);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A3 / A3b — indistinguishable failures
// ---------------------------------------------------------------------------

// The CSP nonce is per-request by mandate (spec §6 / R3-S-N2), so it differs
// between any two responses. It is fixed-length (base64 of 16 bytes = 24 chars)
// and carries zero information about the auth outcome, so byte-identity is
// asserted MODULO the nonce — everything else, Content-Length included, must
// match exactly.
const NONCE_RE = /[A-Za-z0-9+/]{22}==/g;
async function fingerprint(res) {
  const body = (await res.text()).replace(NONCE_RE, 'NONCE');
  const headers = [...res.headers.entries()]
    .filter(([k]) => k !== 'date' && k !== 'connection' && k !== 'keep-alive')
    .map(([k, v]) => `${k}: ${v.replace(NONCE_RE, 'NONCE')}`)
    .sort();
  return { status: res.status, body, headers, setCookie: setCookies(res) };
}

test('A3 / A3b: wrong token and no-token-configured are byte-identical, with NO cookie', async () => {
  const wrong = await startControl();
  let fpWrong;
  try {
    const r = await postForm(wrong, '/control/unlock', { token: 'not-the-master-token' });
    fpWrong = await fingerprint(r);
    assert.equal(fpWrong.setCookie.length, 0, 'a failed unlock sets NO cookie at all (A3)');
    assert.ok(!fpWrong.body.includes('not-the-master-token'), 'the submitted token is never echoed');
  } finally { await wrong.close(); }

  const unset = await startControl({ env: { UM_AUTH_TOKEN: undefined } });
  try {
    // The three A3b shapes: no operator_token field, an empty one, an arbitrary
    // one. All carry the SAME fixed CSRF pair + origin so only the credential
    // varies.
    const cases = [
      await postForm(unset, '/control/unlock', { omitToken: true }),
      await postForm(unset, '/control/unlock', { token: '' }),
      await postForm(unset, '/control/unlock', { token: 'anything-at-all' }),
    ];
    const fps = [];
    for (const r of cases) fps.push(await fingerprint(r));
    for (const fp of fps) {
      assert.equal(fp.setCookie.length, 0);
      assert.deepEqual(fp, fps[0], 'the three no-token-configured shapes are byte-identical to each other');
      assert.deepEqual(fp, fpWrong, 'no-token-configured is byte-identical to wrong-token');
    }
  } finally { await unset.close(); }
});

test('A3: the failure re-render carries a working CSRF pair so the operator can retry', async () => {
  const ctx = await startControl();
  try {
    const bad = await postForm(ctx, '/control/unlock', { token: 'nope' });
    assert.equal(bad.status, 401);
    const html = await bad.text();
    assert.match(html, /name="operator_token"/, 'the failure response re-renders the unlock form');
    assert.equal(csrfFieldOf(html), FIXED_CSRF, 'the already-verified pair is echoed (no Set-Cookie needed)');
    const good = await postForm(ctx, '/control/unlock', { token: TOKEN });
    assert.equal(good.status, 303, 'the retry with the same pair succeeds');
    expire(cookieNamed(good, 'um_control').split(';')[0].slice('um_control='.length));
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A13 — Origin / Sec-Fetch-Site + double-submit CSRF
// ---------------------------------------------------------------------------

test('A13: cross-origin / cross-site / both-headers-absent unlocks are rejected BEFORE the comparator', async () => {
  const ctx = await startControl();
  try {
    const cases = [
      { name: 'Origin mismatch', opts: { origin: 'https://evil.example' } },
      { name: 'Origin: null (sandboxed frame)', opts: { origin: 'null' } },
      { name: 'Sec-Fetch-Site: cross-site', opts: { origin: null, secFetchSite: 'cross-site' } },
      { name: 'Sec-Fetch-Site: same-site', opts: { origin: null, secFetchSite: 'same-site' } },
      { name: 'BOTH absent ⇒ default DENY', opts: { origin: null } },
      // F2: X-Forwarded-Host must NOT rescue a mismatched Origin — an
      // attacker-settable header cannot be allowed to nominate the host its own
      // Origin is compared against.
      {
        name: 'Origin mismatch + matching X-Forwarded-Host',
        opts: { origin: 'https://evil.example', headers: { 'X-Forwarded-Host': 'evil.example' } },
      },
    ];
    for (const { name, opts } of cases) {
      // The CORRECT token is submitted every time: if the origin gate ran
      // after the comparator, these would mint a session.
      const r = await postForm(ctx, '/control/unlock', { token: TOKEN, ...opts });
      assert.equal(r.status, 403, name);
      assert.equal(cookieNamed(r, 'um_control'), undefined, `${name}: no session cookie`);
      const body = await r.text();
      assert.ok(!body.includes(TOKEN), `${name}: no token echo`);
    }
  } finally { await ctx.close(); }
});

test('A13: missing / mismatched double-submit CSRF is rejected BEFORE the comparator', async () => {
  const ctx = await startControl();
  try {
    const cases = [
      { name: 'no csrf cookie', opts: { cookieCsrf: null } },
      { name: 'no csrf field', opts: { fieldCsrf: null } },
      { name: 'mismatched pair', opts: { cookieCsrf: FIXED_CSRF, fieldCsrf: 'ZZZZBBBBCCCCDDDDEEEEFFFFGGGGHHHH' } },
      { name: 'empty pair (a zero-length compare must not be "equal")', opts: { cookieCsrf: '', fieldCsrf: '' } },
    ];
    for (const { name, opts } of cases) {
      const r = await postForm(ctx, '/control/unlock', { token: TOKEN, ...opts });
      assert.equal(r.status, 403, name);
      assert.equal(cookieNamed(r, 'um_control'), undefined, `${name}: no session cookie`);
      assert.ok(!(await r.text()).includes(TOKEN), `${name}: no token echo`);
    }
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A18 — method / content-type / body cap
// ---------------------------------------------------------------------------

test('A18: non-POST to /control/unlock ⇒ 405 with Allow: POST and NO Set-Cookie', async () => {
  const ctx = await startControl();
  try {
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
      const r = await fetch(ctx.url('/control/unlock'), { method, redirect: 'manual' });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'POST');
      // F7/C3: a wrong-method request is never a browser following this page's
      // forms, so it must not be handed (or charged for) a CSRF pair.
      assert.deepEqual(setCookies(r), [], `${method}: the 405 branch sets no cookie at all`);
    }
  } finally { await ctx.close(); }
});

test('F6/C4: HEAD /control is served wherever GET is — 200 with the same headers', async () => {
  const ctx = await startControl();
  try {
    const head = await fetch(ctx.url('/control'), { method: 'HEAD' });
    assert.equal(head.status, 200, 'HEAD must not 405 on a resource GET serves');
    const get = await fetch(ctx.url('/control'));
    for (const h of ['content-type', 'cache-control', 'referrer-policy', 'x-content-type-options']) {
      assert.equal(head.headers.get(h), get.headers.get(h), `HEAD/GET disagree on ${h}`);
    }
    assert.ok(head.headers.get('content-security-policy'), 'HEAD carries the CSP too');
    assert.equal(await head.text(), '', 'HEAD carries no body');
    // …and a genuinely wrong method on the same route still 405s.
    const put = await fetch(ctx.url('/control'), { method: 'PUT', redirect: 'manual' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(setCookies(put), []);
  } finally { await ctx.close(); }
});

test('F7/C3: the CSRF cookie is mint-if-absent — two sequential GETs reuse one value', async () => {
  const ctx = await startControl();
  try {
    const first = await fetch(ctx.url('/control'));
    const minted = cookieNamed(first, 'um_control_csrf');
    assert.ok(minted, 'the first render mints');
    const value = minted.split(';')[0].slice('um_control_csrf='.length);
    assert.equal(csrfFieldOf(await first.text()), value);

    const second = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control_csrf=${value}` } });
    assert.deepEqual(setCookies(second), [], 'a usable pair is REUSED, never rotated per render');
    assert.equal(csrfFieldOf(await second.text()), value, 'the same value is echoed into the form');

    // A malformed/unusable cookie IS replaced (that is the "if-absent" half).
    const bad = await fetch(ctx.url('/control'), { headers: { Cookie: 'um_control_csrf=%%%' } });
    assert.ok(cookieNamed(bad, 'um_control_csrf'), 'a malformed pair is re-minted');
  } finally { await ctx.close(); }
});

test('F7/C3: the authenticated page also reuses an existing CSRF pair', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    const cookie = `um_control=${id}; um_control_csrf=${FIXED_CSRF}`;
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.deepEqual(setCookies(r), [], 'the page does not rotate a working pair either');
    assert.equal(csrfFieldOf(await r.text()), FIXED_CSRF, 'the logout form carries the existing pair');
    expire(id);
  } finally { await ctx.close(); }
});

test('A18: a non-form content-type ⇒ 400', async () => {
  const ctx = await startControl();
  try {
    const r = await postForm(ctx, '/control/unlock', {
      token: TOKEN,
      contentType: 'application/json',
      rawBody: JSON.stringify({ csrf: FIXED_CSRF, operator_token: TOKEN }),
    });
    assert.equal(r.status, 400);
    assert.equal(cookieNamed(r, 'um_control'), undefined);
    // …and a missing Content-Type entirely.
    const none = await postForm(ctx, '/control/unlock', { token: TOKEN, contentType: null });
    assert.equal(none.status, 400);
  } finally { await ctx.close(); }
});

test('A18: a body over MAX_FORM_BYTES is rejected BEFORE the token is read', async () => {
  const ctx = await startControl();
  try {
    const padding = 'x'.repeat(MAX_FORM_BYTES + 1024);
    const body = `csrf=${FIXED_CSRF}&operator_token=${encodeURIComponent(TOKEN)}&pad=${padding}`;
    const r = await postForm(ctx, '/control/unlock', { rawBody: body });
    assert.equal(r.status, 400, 'the over-cap body is rejected even though it carries the CORRECT token');
    assert.equal(cookieNamed(r, 'um_control'), undefined);
  } finally { await ctx.close(); }
});

test('A18: a form-urlencoded content-type with parameters (charset) is accepted', async () => {
  const ctx = await startControl();
  try {
    const r = await postForm(ctx, '/control/unlock', {
      token: TOKEN,
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    });
    assert.equal(r.status, 303);
    expire(cookieNamed(r, 'um_control').split(';')[0].slice('um_control='.length));
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A15 — logout
// ---------------------------------------------------------------------------

test('A15: POST /control/logout expires the session and clears the cookie', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    const r = await postForm(ctx, '/control/logout', { cookie: `um_control=${id}` });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/control');
    const cleared = cookieNamed(r, 'um_control');
    assert.ok(cleared, 'the session cookie is cleared explicitly');
    assert.match(cleared, /Max-Age=0\b/);
    // The subsequent GET renders the unlock form — the session is really gone.
    const after = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.match(await after.text(), /name="operator_token"/);
  } finally { await ctx.close(); }
});

test('A15: a cross-origin or CSRF-invalid logout is rejected WITHOUT expiring the session', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    const cases = [
      { name: 'cross-origin', opts: { origin: 'https://evil.example' } },
      { name: 'no origin signal at all', opts: { origin: null } },
      { name: 'csrf mismatch', opts: { fieldCsrf: 'ZZZZBBBBCCCCDDDDEEEEFFFFGGGGHHHH' } },
    ];
    for (const { name, opts } of cases) {
      const r = await postForm(ctx, '/control/logout', { cookie: `um_control=${id}`, ...opts });
      assert.equal(r.status, 403, name);
      const page = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
      assert.match(await page.text(), AUTHENTICATED_MARKER, `${name}: the session must SURVIVE a rejected logout`);
    }
    expire(id);
  } finally { await ctx.close(); }
});

test('A15: non-POST /control/logout ⇒ 405', async () => {
  const ctx = await startControl();
  try {
    const r = await fetch(ctx.url('/control/logout'), { method: 'GET', redirect: 'manual' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A21 — the u=1 cookie-rejection panel
// ---------------------------------------------------------------------------

test('A21: the CSRF cookie is NOT Secure, so a plain-HTTP unlock reaches the 303 → u=1 panel', async () => {
  const ctx = await startControl();
  try {
    // The whole test runs over plain http:// — the deployment the panel exists
    // for. If the csrf cookie were Secure the browser would drop it and the
    // unlock POST would die at the CSRF step, never reaching the redirect.
    const form = await fetch(ctx.url('/control'));
    const csrfCookie = cookieNamed(form, 'um_control_csrf');
    assert.ok(!/;\s*Secure/i.test(csrfCookie), 'um_control_csrf must NOT be Secure (spec §3 step 5 / R2-S-I1)');
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/control']) {
      assert.ok(csrfCookie.includes(flag), `csrf cookie must carry ${flag}`);
    }
    const value = csrfCookie.split(';')[0].slice('um_control_csrf='.length);

    const unlocked = await postForm(ctx, '/control/unlock', { token: TOKEN, csrf: value });
    assert.equal(unlocked.status, 303);
    assert.equal(unlocked.headers.get('location'), '/control?u=1');

    // Now follow the redirect WITHOUT the session cookie — exactly what a
    // browser that discarded the Secure cookie does.
    const panel = await fetch(ctx.url('/control?u=1'));
    assert.equal(panel.status, 200);
    const html = await panel.text();
    assert.match(html, /neither HTTPS nor localhost/i, 'the explicit cookie-rejection panel, not a bare form');
    assert.match(html, /name="operator_token"/, 'the panel still carries a usable unlock form');
    assert.ok(csrfFieldOf(html), 'with a fresh CSRF pair');
    expire(cookieNamed(unlocked, 'um_control').split(';')[0].slice('um_control='.length));
  } finally { await ctx.close(); }
});

test('C1: u=1 is a ONE-SHOT marker — the authenticated branch 303s it away', async () => {
  const ctx = await startControl();
  try {
    // Unlock, then follow the redirect WITH the session the browser accepted.
    const unlocked = await postForm(ctx, '/control/unlock', { token: TOKEN });
    assert.equal(unlocked.headers.get('location'), '/control?u=1');
    const id = cookieNamed(unlocked, 'um_control').split(';')[0].slice('um_control='.length);

    const landed = await fetch(ctx.url('/control?u=1'), {
      headers: { Cookie: `um_control=${id}` },
      redirect: 'manual',
    });
    assert.equal(landed.status, 303, 'a valid session strips the marker instead of rendering');
    assert.equal(landed.headers.get('location'), '/control');
    assert.deepEqual(setCookies(landed), [], 'the strip touches no cookie');
    // The bookmark-safe URL renders the page.
    const page = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.match(await page.text(), AUTHENTICATED_MARKER);

    // …and once that session expires normally, the SAME bookmarked /control
    // renders the plain form — never the cookie-rejection panel, which would be
    // a false diagnosis of a healthy deployment.
    expire(id);
    const after = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    const html = await after.text();
    assert.match(html, /name="operator_token"/);
    assert.doesNotMatch(html, /neither HTTPS nor localhost/i);

    // The genuine-rejection path is unchanged: u=1 with NO session still panels.
    const panel = await fetch(ctx.url('/control?u=1'));
    assert.match(await panel.text(), /neither HTTPS nor localhost/i);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// U5 — the in-process stats wire: A1 (seam ordering, both halves armed), A8
// (degraded rendering over the wire, incl. the total-blackout render deferred
// from U4b's review), A6 (route-level points_by_project COUNTS, not just
// presence — the other deferral).
// ---------------------------------------------------------------------------

// Call-counting fixtures, distinct from makeExplodingMemory above: these
// prove INVOCATION, which is what the authenticated-branch half of A1 needs
// (a throwing counters reader is NOT caught anywhere in buildStats — unlike
// memory.getAll — so it would turn "touched" into an opaque 500 instead of a
// clean, checkable signal; a spy proves the same fact without that noise).
function makeSpyMemory() {
  const state = { called: false };
  return {
    state,
    getAll: async () => { state.called = true; return { results: [] }; },
  };
}

function makeSpyReadCounters() {
  function fn() {
    fn.called = true;
    return {
      available: true, capture: {}, growth_7d: {}, growth_docs_7d: {},
      recall: { searches_today: 0, searches_7d: 0 },
    };
  }
  fn.called = false;
  return fn;
}

test('A1: memory + counters reads are wired to the AUTHENTICATED branch only — every earlier path touches neither', async () => {
  const memory = makeSpyMemory();
  const readCounters = makeSpyReadCounters();
  const ctx = await startControl({ memory, readCounters });
  try {
    // Unlock-form path — no cookie at all.
    const form = await fetch(ctx.url('/control'));
    assert.equal(form.status, 200);
    assert.equal(memory.state.called, false, 'the unlock-form path must not read the corpus');
    assert.equal(readCounters.called, false, 'the unlock-form path must not read the counters');

    // u=1 with no session ⇒ the cookie-rejection panel.
    const panel = await fetch(ctx.url('/control?u=1'));
    assert.equal(panel.status, 200);
    assert.equal(memory.state.called, false, 'the u=1 panel path must not read the corpus');
    assert.equal(readCounters.called, false, 'the u=1 panel path must not read the counters');

    // Duplicate session cookie ⇒ the rejection notice.
    const dup = await fetch(ctx.url('/control'), { headers: { Cookie: 'um_control=a; um_control=b' } });
    assert.equal(dup.status, 200);
    assert.equal(memory.state.called, false, 'the duplicate-cookie path must not read the corpus');
    assert.equal(readCounters.called, false, 'the duplicate-cookie path must not read the counters');

    // An unlock POST reject path (wrong token) — the whole spec-§3 sequence
    // runs and still touches neither source.
    const reject = await postForm(ctx, '/control/unlock', { token: 'nope' });
    assert.equal(reject.status, 401);
    assert.equal(memory.state.called, false, 'a rejected unlock must not read the corpus');
    assert.equal(readCounters.called, false, 'a rejected unlock must not read the counters');

    // NOW the authenticated branch — buildStats() must read BOTH sources.
    const { id } = createSession(Date.now());
    const authed = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.equal(authed.status, 200);
    assert.match(await authed.text(), AUTHENTICATED_MARKER);
    assert.equal(memory.state.called, true, 'the authenticated branch must read the corpus');
    assert.equal(readCounters.called, true, 'the authenticated branch must read the counters');
    expire(id);
  } finally { await ctx.close(); }
});

test('A5 regression: /api/stats keeps working after the readCounters seam lands (no override — the default)', async () => {
  const ctx = await startControl({ memory: { getAll: async () => ({ results: [] }) } });
  try {
    const r = await fetch(ctx.url('/api/stats'), { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schema_version, 1);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A8 — degraded rendering over the wire (route-level; deferred from U4b)
// ---------------------------------------------------------------------------

test('A8: counters-db absent ⇒ 200 with capture/growth/recall degraded, corpus stays live', async () => {
  const items = [
    { id: 'a', memory: 'm1', metadata: { project: 'um' } },
    { id: 'b', memory: 'm2', metadata: { project: 'edge' } },
  ];
  // Default env already routes UM_COUNTERS_DB_PATH at a guaranteed-missing
  // file (see missingDbPath's note) — no override needed for "counters absent".
  const ctx = await startControl({ memory: { getAll: async () => ({ results: items }) } });
  try {
    const { id } = createSession(Date.now());
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, AUTHENTICATED_MARKER);
    assert.match(html, /counters-unavailable/, 'the degraded flag names the dark source');
    assert.doesNotMatch(html, /corpus-unavailable/, 'qdrant is healthy — only counters are dark');
    assert.match(html, /cannot assess/i, 'the capture/growth/recall tiles show an empty/cannot-assess state');
    // Corpus itself stays live — the qdrant read did not fail.
    assert.match(html, /<th scope="row">Points<\/th><td>2<\/td>/);
    expire(id);
  } finally { await ctx.close(); }
});

test('A8: qdrant down (getAll throws) ⇒ corpus-unavailable, growth stays live off the counters db', async () => {
  const dbPath = await tempCountersDbPath('a8-corpus-down');
  seedCountersDb(dbPath, [{ day: TODAY, event: 'capture.extraction', outcome: 'stored', count: 4 }]);
  const ctx = await startControl({
    env: { UM_COUNTERS_DB_PATH: dbPath },
    memory: { getAll: async () => { throw new Error('qdrant down'); } },
  });
  try {
    const { id } = createSession(Date.now());
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, AUTHENTICATED_MARKER);
    assert.match(html, /corpus-unavailable/);
    assert.doesNotMatch(html, /counters-unavailable/, 'the counters db is healthy here');
    assert.match(html, /Cannot assess: the corpus is unavailable \(qdrant could not be read\)\./);
    // Growth is counters-derived (spec §5 C2) and stays live despite qdrant
    // being down — the opposite governance from the corpus tile.
    assert.match(html, new RegExp(`${TODAY}: 4`));
    expire(id);
  } finally { await ctx.close(); }
});

test('A8: both sources dark ⇒ a coherent ALL-GREY page — 200, no s-green/s-red, no polylines, no misleading zero figures', async () => {
  // Default env already routes UM_COUNTERS_DB_PATH at a missing file.
  const ctx = await startControl({ memory: { getAll: async () => { throw new Error('qdrant down'); } } });
  try {
    const { id } = createSession(Date.now());
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.equal(r.status, 200, 'a total blackout of both sources must still be a clean 200, never a crash');
    const html = await r.text();
    assert.match(html, AUTHENTICATED_MARKER);
    assert.match(html, /corpus-unavailable/);
    assert.match(html, /counters-unavailable/);
    assert.doesNotMatch(html, /class="s-green"/, 'no cell may read healthy while both sources are dark');
    assert.doesNotMatch(html, /class="s-red"/, 'no cell may read alarmed either — there is nothing left to measure');
    assert.doesNotMatch(html, /<polyline/, 'no sparkline draws over an unavailable series');
    assert.doesNotMatch(html, /0 extractions in 7d/, 'a dark counters db must not present as a confident zero');
    assert.doesNotMatch(html, /0 doc writes in 7d/, 'ditto for the doc-tier series');
    expire(id);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A6 (route-level) — points_by_project renders correct COUNTS through the
// real wire. U4b's control-page.test.mjs already covers hostile-key rendering
// at the page-unit level (presence-only); this pins the same guarantee
// end-to-end through the real route (deferred from U4b's review).
// ---------------------------------------------------------------------------

test('A6 (route-level): points_by_project renders correct COUNTS through the real wire, not just presence', async () => {
  const items = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `um-${i}`, memory: `m${i}`, metadata: { project: 'universal-memory' } })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `edge-${i}`, memory: `m${i}`, metadata: { project: 'edge-catcher' } })),
    { id: 'no-project', memory: 'no metadata.project' },
  ];
  const ctx = await startControl({ memory: { getAll: async () => ({ results: items }) } });
  try {
    const { id } = createSession(Date.now());
    const r = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<th scope="row">universal-memory<\/th><td>3<\/td>/);
    assert.match(html, /<th scope="row">edge-catcher<\/th><td>2<\/td>/);
    assert.match(html, /<th scope="row" class="unattributed">unattributed<\/th><td>1<\/td>/);
    assert.match(html, /<th scope="row">Points<\/th><td>6<\/td>/, 'the total is the SUM across all three buckets');
    expire(id);
  } finally { await ctx.close(); }
});
