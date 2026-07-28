// server/test/control-routes-security.test.mjs — U3 (#171 Stage B): the
// security invariants of the /control auth surface.
//
// Covers (spec §3 + §6 + §8 acceptance):
//   • A14 — the exact security-header set on EVERY HTML response the surface
//     can emit, asserted one-by-one through the single sendControlHtml choke
//     point (six shapes today: unlock form, stub page, failure re-render, u=1
//     panel, duplicate-cookie rejection, 405 notice) plus a per-response nonce.
//     The enumeration is the point — a shape added without a row here is
//     exactly the uncovered response the choke point exists to prevent.
//   • A11 (U3 slice) — no active content on the auth-surface templates.
//   • A22 — duplicate um_control / um_control_csrf rejection via an
//     OCCURRENCE-COUNTING parse that tokenizes identically to readCookie.
//   • A10a — the SHARED per-IP limiter is not bypassed on loopback.
//   • A10b — the DEDICATED unlock throttle discriminates by source.
//   • A19 — structured, metadata-only warn logs; the throttled line rate-
//     limited to once per block window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { _setLogStreamForTest } from '../lib/logger.mjs';
import { createRequestHandler } from '../mem0-mcp-http.mjs';
import { createSession, expire } from '../lib/control-session.mjs';
import { cookieOccurrences, verifyControlOrigin, isTrustedLoopback } from '../lib/control-routes.mjs';
import { readCookie } from '../lib/http-form.mjs';

const TOKEN = 'control-master-token-abc123';
const FIXED_CSRF = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

const EXPECTED_CSP_PARTS = [
  "default-src 'none'",
  "img-src 'self'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
];

function makeExplodingMemory() {
  return {
    getAll: async () => { throw new Error('A1 violation: /control read the corpus'); },
    search: async () => { throw new Error('A1 violation: /control searched the corpus'); },
  };
}

async function startControl({ env = {}, sink } = {}) {
  const overrides = {
    UM_AUTH_TOKEN: TOKEN,
    UM_CONTROL_ENABLED: 'true',
    UM_RATE_LIMIT_RPM: '6000',
    UM_RATE_LIMIT_BURST: '1000',
    ...env,
  };
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (sink) _setLogStreamForTest(sink);
  const srv = createServer(createRequestHandler({ memory: makeExplodingMemory() }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (sink) _setLogStreamForTest(null);
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { close, port, origin: `http://127.0.0.1:${port}`, url: (p) => `http://127.0.0.1:${port}${p}` };
}

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}
function cookieNamed(res, name) {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

async function postForm(ctx, path, { token, csrf = FIXED_CSRF, origin = ctx.origin, cookie, headers = {} } = {}) {
  const params = new URLSearchParams();
  if (csrf !== null) params.set('csrf', csrf);
  if (token !== undefined) params.set('operator_token', token);
  const h = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers };
  if (origin !== null) h.Origin = origin;
  const cookies = [];
  if (csrf !== null) cookies.push(`um_control_csrf=${csrf}`);
  if (cookie) cookies.push(cookie);
  if (cookies.length) h.Cookie = cookies.join('; ');
  return fetch(ctx.url(path), { method: 'POST', headers: h, body: params.toString(), redirect: 'manual' });
}

function makeCaptureSink(captured) {
  return new Writable({
    write(chunk, enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try { captured.push(JSON.parse(line)); } catch { /* non-JSON noise */ }
      }
      cb();
    },
  });
}

// ---------------------------------------------------------------------------
// A14 — the header set on EVERY HTML response (six shapes today)
// ---------------------------------------------------------------------------

function assertControlHeaders(res, label) {
  assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/, `${label}: content-type`);
  assert.equal(res.headers.get('cache-control'), 'no-store', `${label}: Cache-Control`);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${label}: Referrer-Policy`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: X-Content-Type-Options`);
  // The operator page is not a CORS-shared resource: the blanket
  // Access-Control-Allow-Origin the machine API sets is dropped here, so no
  // cross-origin script can read this document at all.
  assert.equal(res.headers.get('access-control-allow-origin'), null, `${label}: no wildcard CORS`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, `${label}: CSP present`);
  for (const part of EXPECTED_CSP_PARTS) {
    assert.ok(csp.includes(part), `${label}: CSP must contain "${part}" — got ${csp}`);
  }
  const nonce = /style-src 'nonce-([^']+)'/.exec(csp);
  assert.ok(nonce, `${label}: style-src carries a nonce`);
  assert.match(nonce[1], /^[A-Za-z0-9+/=]{24}$/, `${label}: the nonce is 16 random bytes, base64`);
  return nonce[1];
}

test('A14: the exact header set is present on EVERY HTML response, each with its own nonce', async () => {
  const ctx = await startControl();
  const nonces = new Set();
  const bodies = {};
  try {
    // (1) unlock form
    const form = await fetch(ctx.url('/control'));
    nonces.add(assertControlHeaders(form, 'unlock form'));
    bodies.form = await form.text();

    // (2) the authenticated (stub) page
    const { id } = createSession(Date.now());
    const page = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } });
    nonces.add(assertControlHeaders(page, 'page'));
    bodies.page = await page.text();

    // (3) failure re-render
    const failed = await postForm(ctx, '/control/unlock', { token: 'wrong' });
    assert.equal(failed.status, 401);
    nonces.add(assertControlHeaders(failed, 'failure re-render'));
    bodies.failed = await failed.text();

    // (4) the u=1 cookie-rejection panel
    const panel = await fetch(ctx.url('/control?u=1'));
    nonces.add(assertControlHeaders(panel, 'u=1 panel'));
    bodies.panel = await panel.text();

    // (5) the duplicate-cookie rejection
    const dup = await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}; um_control=${id}` } });
    nonces.add(assertControlHeaders(dup, 'duplicate-cookie rejection'));
    bodies.dup = await dup.text();

    // (6) the 405 notice — the shape fix round 1 added (F7/C3). It renders no
    // form, so it is easy to forget; it is HTML all the same and must not be
    // the one uncovered response the choke point exists to prevent.
    const notice = await fetch(ctx.url('/control'), { method: 'PUT', redirect: 'manual' });
    assert.equal(notice.status, 405);
    nonces.add(assertControlHeaders(notice, '405 notice'));
    bodies.notice = await notice.text();

    assert.equal(nonces.size, 6, 'every response mints its OWN nonce (fresh per response, R3-S-N2)');

    // The nonce in the CSP header must be the one actually on the <style> block.
    for (const [label, html] of Object.entries(bodies)) {
      const styleNonce = /<style nonce="([^"]+)">/.exec(html);
      assert.ok(styleNonce, `${label}: the inline <style> carries a nonce attribute`);
      assert.ok(nonces.has(styleNonce[1]), `${label}: the rendered nonce is one of the emitted CSP nonces`);
    }
    expire(id);
  } finally { await ctx.close(); }
});

test('A11 (U3 slice): the auth-surface templates carry no active content', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    // All FIVE rendered shapes, plus the 405 notice — the sweep must cover
    // every template, not the four that were easiest to reach (C7).
    const pages = {
      form: await (await fetch(ctx.url('/control'))).text(),
      page: await (await fetch(ctx.url('/control'), { headers: { Cookie: `um_control=${id}` } })).text(),
      failed: await (await postForm(ctx, '/control/unlock', { token: 'wrong' })).text(),
      panel: await (await fetch(ctx.url('/control?u=1'))).text(),
      duplicate: await (await fetch(ctx.url('/control'), {
        headers: { Cookie: `um_control=${id}; um_control=${id}` },
      })).text(),
      notice405: await (await fetch(ctx.url('/control'), { method: 'PUT', redirect: 'manual' })).text(),
    };
    assert.match(pages.duplicate, /duplicate control cookie/i, 'the duplicate-cookie panel really rendered');
    assert.match(pages.notice405, /not allowed/i, 'the 405 notice really rendered');
    for (const [label, html] of Object.entries(pages)) {
      assert.doesNotMatch(html, /<script/i, `${label}: no <script>`);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${label}: no inline on* handler`);
      assert.doesNotMatch(html, /\sstyle\s*=/i, `${label}: no style= attribute (CSP nonce does not cover them)`);
      assert.doesNotMatch(html, /@import/i, `${label}: no CSS @import`);
      assert.doesNotMatch(html, /url\(/i, `${label}: no url() in CSS`);
      // The only asset reference permitted is the same-origin favicon.
      for (const m of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
        assert.ok(
          m[1] === '/favicon.svg' || m[1] === '/control' || m[1].startsWith('#'),
          `${label}: unexpected asset/URL reference ${m[1]}`,
        );
      }
      // Forms post to RELATIVE, same-origin paths only (form-action 'self').
      for (const m of html.matchAll(/action="([^"]*)"/g)) {
        assert.match(m[1], /^\/control(\/unlock|\/logout)?$/, `${label}: unexpected form action ${m[1]}`);
      }
    }
    expire(id);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A22 — duplicate-cookie rejection + the occurrence-counting parse
// ---------------------------------------------------------------------------

test('A22 (unit): cookieOccurrences tokenizes identically to readCookie and counts occurrences', () => {
  // Tokenization contract (R3-S-N1): split on ';', substring before the FIRST
  // '=', trim, exact name compare.
  assert.deepEqual(cookieOccurrences('um_control=abc', 'um_control'), { count: 1, value: 'abc' });
  assert.deepEqual(cookieOccurrences(' um_control = abc ', 'um_control'), { count: 1, value: 'abc' });
  assert.deepEqual(cookieOccurrences('a=1; um_control=abc; b=2', 'um_control'), { count: 1, value: 'abc' });
  assert.deepEqual(cookieOccurrences('um_control=a; um_control=b', 'um_control'), { count: 2, value: 'a' });
  assert.deepEqual(cookieOccurrences(undefined, 'um_control'), { count: 0, value: undefined });
  assert.deepEqual(cookieOccurrences('', 'um_control'), { count: 0, value: undefined });
  // A cookie VALUE containing "um_control=" must NOT inflate the count.
  assert.deepEqual(cookieOccurrences('other=um_control=zzz', 'um_control'), { count: 0, value: undefined });
  assert.deepEqual(
    cookieOccurrences('other=um_control=zzz; um_control=real', 'um_control'),
    { count: 1, value: 'real' },
  );
  // Boundary: um_control_csrf must NOT count as um_control (and vice versa).
  assert.deepEqual(cookieOccurrences('um_control_csrf=x', 'um_control'), { count: 0, value: undefined });
  assert.deepEqual(cookieOccurrences('um_control=x', 'um_control_csrf'), { count: 0, value: undefined });
  assert.deepEqual(
    cookieOccurrences('um_control_csrf=x; um_control=y; um_control_csrf=z', 'um_control_csrf'),
    { count: 2, value: 'x' },
  );
  // A valueless segment is skipped exactly as readCookie skips it.
  assert.deepEqual(cookieOccurrences('um_control; um_control=v', 'um_control'), { count: 1, value: 'v' });
  // An EMPTY value is still an occurrence.
  assert.deepEqual(cookieOccurrences('um_control=', 'um_control'), { count: 1, value: '' });
});

// C2: tokenizer identity is ENFORCED, not asserted in prose. Both parsers are
// built on the same `cookiePairs` generator in http-form.mjs; this differential
// test is the regression net for anyone who "optimizes" one of them apart. The
// corpus is deliberately adversarial: quoted values carrying a cookie-looking
// payload, names that are substrings/superstrings of each other, empty names,
// and whitespace variants.
test('C2 differential: cookieOccurrences agrees with readCookie on first-match, over an adversarial corpus', () => {
  const corpus = [
    '',
    'um_control=a',
    'um_control=a; um_control=b',
    ' um_control = a ; um_control=b',
    'um_control="value; with=quotes"',
    'decoy="um_control=injected"; um_control=real',
    'decoy=um_control=injected',
    'um_control_csrf=c; um_control=s',
    'um_controlx=1; um_control=2; xum_control=3',
    'um_control',
    'um_control=',
    '=orphan; um_control=v',
    ';;; um_control=v ;;;',
    'UM_CONTROL=upper; um_control=lower',
    'um_control=a=b=c',
  ];
  for (const raw of corpus) {
    for (const name of ['um_control', 'um_control_csrf', '', 'decoy']) {
      const viaReadCookie = readCookie({ headers: { cookie: raw } }, name);
      const { value } = cookieOccurrences(raw, name);
      assert.equal(
        value, viaReadCookie,
        `divergence on name=${JSON.stringify(name)} raw=${JSON.stringify(raw)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// C6 — pure-function units for the two hand-written predicates
// ---------------------------------------------------------------------------

const reqWith = (headers) => ({ headers });

test('C6 unit: verifyControlOrigin', () => {
  const host = 'pi-openclaw:6337';
  // Host match passes — scheme deliberately ignored (Serve terminates TLS).
  assert.equal(verifyControlOrigin(reqWith({ host, origin: `https://${host}` })), null);
  assert.equal(verifyControlOrigin(reqWith({ host, origin: `http://${host}` })), null);
  // Port is part of the host — a mismatch is a different origin.
  assert.equal(verifyControlOrigin(reqWith({ host, origin: 'https://pi-openclaw:9999' })), 'cross-origin');
  assert.equal(verifyControlOrigin(reqWith({ host, origin: 'https://pi-openclaw' })), 'cross-origin');
  // Sec-Fetch-Site alone is enough when Origin is absent.
  assert.equal(verifyControlOrigin(reqWith({ host, 'sec-fetch-site': 'same-origin' })), null);
  assert.equal(verifyControlOrigin(reqWith({ host, 'sec-fetch-site': 'none' })), null);
  assert.equal(verifyControlOrigin(reqWith({ host, 'sec-fetch-site': 'cross-site' })), 'cross-site');
  assert.equal(verifyControlOrigin(reqWith({ host, 'sec-fetch-site': 'same-site' })), 'cross-site');
  // …but it does NOT rescue a mismatched Origin: both signals must be clean.
  assert.equal(
    verifyControlOrigin(reqWith({ host, origin: 'https://evil.example', 'sec-fetch-site': 'none' })),
    'cross-origin',
    'Sec-Fetch-Site: none must not launder a cross-origin Origin',
  );
  // Both absent ⇒ default DENY (stricter than the oauth consent helper).
  assert.equal(verifyControlOrigin(reqWith({ host })), 'no-origin-signal');
  // Opaque / malformed Origin is denied, never treated as absent.
  assert.equal(verifyControlOrigin(reqWith({ host, origin: 'null' })), 'cross-origin');
  assert.equal(verifyControlOrigin(reqWith({ host, origin: 'not a url' })), 'cross-origin');
  // F2: X-Forwarded-Host is NOT a comparison candidate.
  assert.equal(
    verifyControlOrigin(reqWith({ host, origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })),
    'cross-origin',
    'an attacker-settable header must not nominate the host it is compared against',
  );
  // No Host header at all ⇒ nothing to match against ⇒ deny.
  assert.equal(verifyControlOrigin(reqWith({ origin: 'https://anything' })), 'cross-origin');
});

test('C6 unit: isTrustedLoopback', () => {
  const loopback = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
  assert.equal(isTrustedLoopback(loopback()), true);
  assert.equal(isTrustedLoopback({ socket: { remoteAddress: '::1' }, headers: {} }), true);
  // F3: the IPv4-mapped-in-IPv6 form a dual-stack listener reports.
  assert.equal(isTrustedLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }), true);
  // Non-loopback peers are never trusted.
  assert.equal(isTrustedLoopback({ socket: { remoteAddress: '100.123.173.116' }, headers: {} }), false);
  assert.equal(isTrustedLoopback({ socket: {}, headers: {} }), false);
  assert.equal(isTrustedLoopback({ headers: {} }), false);
  // A forwarded marker disqualifies loopback — that is a proxied peer wearing
  // the loopback address, not the operator's console.
  assert.equal(isTrustedLoopback(loopback({ 'x-forwarded-for': '9.9.9.9' })), false);
  assert.equal(isTrustedLoopback(loopback({ via: '1.1 proxy' })), false);
  assert.equal(isTrustedLoopback(loopback({ 'tailscale-user-login': 'op@example.com' })), false);
  // …even when the header is present but empty (presence, not truthiness).
  assert.equal(isTrustedLoopback(loopback({ 'x-real-ip': '' })), false);
});

test('A22 (wire): a duplicate um_control or um_control_csrf is rejected to the unlock form', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    const dupSession = await fetch(ctx.url('/control'), {
      headers: { Cookie: `um_control=${id}; um_control=forged` },
    });
    assert.equal(dupSession.status, 200);
    const html = await dupSession.text();
    assert.match(html, /name="operator_token"/, 'a shadowed session cookie falls back to the unlock form');
    assert.doesNotMatch(html, /unlocked/i, 'the shadow must NOT unlock the page');

    const dupCsrf = await fetch(ctx.url('/control'), {
      headers: { Cookie: `um_control=${id}; um_control_csrf=a; um_control_csrf=b` },
    });
    assert.match(await dupCsrf.text(), /name="operator_token"/, 'a shadowed csrf cookie is rejected too');

    // …and the unlock POST rejects a shadowed csrf rather than comparing an
    // ambiguous pair (the correct token is submitted — it must still fail).
    const unlock = await fetch(ctx.url('/control/unlock'), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: ctx.origin,
        Cookie: `um_control_csrf=${FIXED_CSRF}; um_control_csrf=${FIXED_CSRF}`,
      },
      body: new URLSearchParams({ csrf: FIXED_CSRF, operator_token: TOKEN }).toString(),
    });
    assert.equal(unlock.status, 403);
    assert.equal(cookieNamed(unlock, 'um_control'), undefined);
    expire(id);
  } finally { await ctx.close(); }
});

test('A22 (wire): a cookie VALUE containing um_control= does not trip the duplicate guard', async () => {
  const ctx = await startControl();
  try {
    const { id } = createSession(Date.now());
    const r = await fetch(ctx.url('/control'), {
      headers: { Cookie: `decoy=um_control=zzz; um_control=${id}` },
    });
    assert.match(await r.text(), /unlocked/i, 'the decoy value must not inflate the occurrence count');
    expire(id);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A10a / A10b — the two limiters
// ---------------------------------------------------------------------------

test('A10a: the SHARED per-IP limiter is NOT bypassed on loopback for /control rows', async () => {
  const ctx = await startControl({ env: { UM_RATE_LIMIT_RPM: '1', UM_RATE_LIMIT_BURST: '1' } });
  try {
    const first = await fetch(ctx.url('/control'));
    assert.equal(first.status, 200);
    const second = await fetch(ctx.url('/control'));
    assert.equal(second.status, 429, 'noLoopbackBypass must veto the loopback bypass at the shared-limiter site');
    assert.equal(typeof second.headers.get('retry-after'), 'string');
  } finally { await ctx.close(); }
});

test('A10b: the dedicated unlock throttle hard-blocks a forwarded source, never trusted loopback', async () => {
  const ctx = await startControl();
  try {
    // 1. One failed unlock from trusted loopback arms the global throttle.
    const armed = await postForm(ctx, '/control/unlock', { token: 'wrong-1' });
    assert.equal(armed.status, 401);

    // 2. A THROTTLEABLE source (carries a forwarded header) is hard-blocked.
    const blocked = await postForm(ctx, '/control/unlock', {
      token: 'wrong-2',
      headers: { 'X-Forwarded-For': '9.9.9.9' },
    });
    assert.equal(blocked.status, 429, 'a Serve/tunnel-proxied attacker is hard-blocked');
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, 'Retry-After comes from throttle.retryAfterSec()');
    assert.equal(cookieNamed(blocked, 'um_control'), undefined);

    // 3. Trusted loopback (no forwarded headers) is NEVER hard-blocked — the
    //    operator recovery path — and the CORRECT token still unlocks.
    const recovered = await postForm(ctx, '/control/unlock', { token: TOKEN });
    assert.equal(recovered.status, 303, 'the operator on the console always gets an attempt');
    expire(cookieNamed(recovered, 'um_control').split(';')[0].slice('um_control='.length));

    // 4. …and success resets the throttle for everyone.
    const after = await postForm(ctx, '/control/unlock', {
      token: 'wrong-3',
      headers: { 'X-Forwarded-For': '9.9.9.9' },
    });
    assert.equal(after.status, 401, 'throttle.success() cleared the block window');
  } finally { await ctx.close(); }
});

test('A10b: a non-loopback-shaped source is throttleable even without X-Forwarded-For', async () => {
  const ctx = await startControl();
  try {
    await postForm(ctx, '/control/unlock', { token: 'wrong-1' });
    // `Via` is in FORWARDED_HEADERS — any forwarded marker disqualifies the
    // trusted-loopback carve-out.
    const blocked = await postForm(ctx, '/control/unlock', { token: 'wrong-2', headers: { Via: '1.1 proxy' } });
    assert.equal(blocked.status, 429);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------
// A19 — structured, metadata-only logging
// ---------------------------------------------------------------------------

test('A19: a failed unlock warns with metadata ONLY — never the token or csrf', async () => {
  const captured = [];
  const ctx = await startControl({ sink: makeCaptureSink(captured) });
  try {
    const guess = 'someone-is-guessing-this-value';
    const r = await postForm(ctx, '/control/unlock', { token: guess });
    assert.equal(r.status, 401);
    const warn = captured.find((l) => l.outcome === 'unlock_failed');
    assert.ok(warn, 'a structured unlock_failed line is emitted');
    assert.equal(warn.level, 'warn', 'at warn level — "someone is guessing your master token"');
    assert.equal(warn.endpoint, '/control/unlock');
    assert.ok(warn.request_id, 'carries the request_id');
    assert.equal(warn.source, 'loopback', 'carries the coarse source class');
    const blob = JSON.stringify(captured);
    assert.ok(!blob.includes(guess), 'the submitted operator_token NEVER reaches the log sink');
    assert.ok(!blob.includes(FIXED_CSRF), 'nor the csrf value');
    assert.ok(!blob.includes(TOKEN), 'nor the configured master token');
  } finally { await ctx.close(); }
});

test('A19: success is logged distinctly from failure', async () => {
  const captured = [];
  const ctx = await startControl({ sink: makeCaptureSink(captured) });
  try {
    const r = await postForm(ctx, '/control/unlock', { token: TOKEN });
    assert.equal(r.status, 303);
    const ok = captured.find((l) => l.outcome === 'unlock_success');
    assert.ok(ok, 'a distinct unlock_success line is emitted');
    assert.equal(captured.find((l) => l.outcome === 'unlock_failed'), undefined);
    assert.ok(!JSON.stringify(captured).includes(TOKEN), 'the master token never reaches the sink on success either');
    expire(cookieNamed(r, 'um_control').split(';')[0].slice('um_control='.length));
  } finally { await ctx.close(); }
});

test('A19: the throttled-attempt line is rate-limited to once per block window', async () => {
  const captured = [];
  const ctx = await startControl({ sink: makeCaptureSink(captured) });
  try {
    await postForm(ctx, '/control/unlock', { token: 'wrong-1' }); // arms the throttle
    const fwd = { 'X-Forwarded-For': '9.9.9.9' };
    for (let i = 0; i < 5; i++) {
      const r = await postForm(ctx, '/control/unlock', { token: `flood-${i}`, headers: fwd });
      assert.equal(r.status, 429, 'every flooded attempt is blocked');
    }
    const throttled = captured.filter((l) => l.outcome === 'unlock_throttled');
    assert.equal(throttled.length, 1, 'five blocked attempts in one window emit exactly ONE warn line');
    assert.equal(throttled[0].source, 'remote');
  } finally { await ctx.close(); }
});
