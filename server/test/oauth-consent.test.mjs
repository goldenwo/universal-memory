// server/test/oauth-consent.test.mjs — consent cookie (purpose-bound) + CSRF
// + page-render pins (Gap-3 OAuth spec section 5). CSRF + cookie semantics were
// CRITICAL spec-review findings; these tests pin the exact security contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { OAUTH_TTLS } from '../lib/oauth/state-store.mjs';
import {
  signConsentCookie,
  verifyConsentCookie,
  consentCookieHeader,
  mintCsrf,
  verifyCsrf,
  renderConsentPage,
} from '../lib/oauth/consent.mjs';

const key = () => randomBytes(32).toString('hex');

// ---- cookie round-trip + the four rejection paths
test('cookie: round-trip verifies true', () => {
  const k = key();
  const v = signConsentCookie(k);
  assert.equal(verifyConsentCookie(k, v), true);
});

test('cookie: expired (now advanced past 15min) rejected', () => {
  const k = key();
  const t0 = Date.now();
  const v = signConsentCookie(k, t0);
  assert.equal(verifyConsentCookie(k, v, t0 + OAUTH_TTLS.cookieMs + 1), false);
  // still live one ms before expiry
  assert.equal(verifyConsentCookie(k, v, t0 + OAUTH_TTLS.cookieMs - 1), true);
});

test('cookie: tampered payload rejected', () => {
  const k = key();
  const v = signConsentCookie(k);
  const [payload, mac] = v.split('.');
  const flipped = Buffer.from(payload, 'base64url');
  flipped[0] ^= 0x01;
  const tampered = `${flipped.toString('base64url')}.${mac}`;
  assert.equal(verifyConsentCookie(k, tampered), false);
});

test('cookie: MAC from a different key rejected', () => {
  const v = signConsentCookie(key());
  assert.equal(verifyConsentCookie(key(), v), false);
});

test('cookie: wrong purpose rejected (right key, evil purpose)', () => {
  const k = key();
  const exp = Date.now() + OAUTH_TTLS.cookieMs;
  const nonce = randomBytes(16).toString('hex');
  const payload = `evil.${exp}.${nonce}`;
  const mac = createHmac('sha256', Buffer.from(k, 'hex')).update(payload).digest('base64url');
  const value = `${Buffer.from(payload).toString('base64url')}.${mac}`;
  assert.equal(verifyConsentCookie(k, value), false);
});

test('cookie: malformed values rejected', () => {
  const k = key();
  for (const bad of ['', 'nodot', 'a.b.c', '...', null, undefined, 42, 'x.y']) {
    assert.equal(verifyConsentCookie(k, bad), false);
  }
});

// ---- Set-Cookie header shape
test('header: contains all required attributes with Max-Age derived from TTL', () => {
  const h = consentCookieHeader('VAL');
  assert.match(h, /um_consent=VAL/);
  assert.match(h, new RegExp(`Max-Age=${OAUTH_TTLS.cookieMs / 1000}`));
  assert.match(h, /Max-Age=900/);
  assert.match(h, /Path=\/oauth/);
  assert.match(h, /HttpOnly/);
  assert.match(h, /Secure/);
  assert.match(h, /SameSite=Strict/);
});

// ---- CSRF bound to one pending authorization
test('csrf: round-trip verifies true', () => {
  const k = key();
  const t = mintCsrf(k, 'authz-A');
  assert.equal(verifyCsrf(k, 'authz-A', t), true);
});

test('csrf: token minted for authz A fails verify for authz B', () => {
  const k = key();
  const t = mintCsrf(k, 'authz-A');
  assert.equal(verifyCsrf(k, 'authz-B', t), false);
});

test('csrf: tampered token rejected', () => {
  const k = key();
  const t = mintCsrf(k, 'authz-A');
  const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyCsrf(k, 'authz-A', bad), false);
});

test('csrf: wrong key rejected', () => {
  const t = mintCsrf(key(), 'authz-A');
  assert.equal(verifyCsrf(key(), 'authz-A', t), false);
});

test('csrf: malformed token rejected', () => {
  const k = key();
  for (const bad of ['', null, undefined, 42]) {
    assert.equal(verifyCsrf(k, 'authz-A', bad), false);
  }
});

// ---- consent page render (HTML escaping is the trust boundary)
const baseArgs = {
  clientName: 'Acme MCP',
  redirectHost: 'claude.ai',
  authzId: 'authz-123',
  csrf: 'csrf-token-xyz',
  needsToken: false,
};

test('page: escapes <script> in clientName (XSS from attacker DCR)', () => {
  const html = renderConsentPage({ ...baseArgs, clientName: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw <script> must be absent');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form must be present');
});

test('page: shows redirectHost prominently (CIMD impersonation mitigation)', () => {
  const html = renderConsentPage(baseArgs);
  assert.ok(html.includes('claude.ai'));
});

test('page: form posts to /oauth/consent with hidden authz_id + csrf', () => {
  const html = renderConsentPage(baseArgs);
  assert.match(html, /action="\/oauth\/consent"/);
  assert.match(html, /method="post"/i);
  assert.match(html, /name="authz_id"[^>]*value="authz-123"/);
  assert.match(html, /name="csrf"[^>]*value="csrf-token-xyz"/);
});

test('page: has allow + deny decision buttons', () => {
  const html = renderConsentPage(baseArgs);
  assert.match(html, /name="decision"[^>]*value="allow"/);
  assert.match(html, /name="decision"[^>]*value="deny"/);
});

test('page: operator_token input present iff needsToken', () => {
  const without = renderConsentPage({ ...baseArgs, needsToken: false });
  assert.ok(!without.includes('operator_token'));
  const withTok = renderConsentPage({ ...baseArgs, needsToken: true });
  assert.match(withTok, /name="operator_token"/);
  assert.match(withTok, /type="password"/);
  // autocomplete=current-password lets the operator's browser password manager
  // save + autofill the token, so re-consents aren't a re-hunt for the secret.
  assert.match(withTok, /autocomplete="current-password"/);
});

test('page: csrf/authzId interpolations are escaped', () => {
  const html = renderConsentPage({ ...baseArgs, csrf: '"><x', authzId: 'a"b' });
  assert.ok(!html.includes('"><x'));
  assert.ok(html.includes('&quot;&gt;&lt;x'));
});

test('page: error notice rendered + escaped when set, absent otherwise', () => {
  const none = renderConsentPage(baseArgs);
  assert.ok(!/class="error"/.test(none));
  const withErr = renderConsentPage({ ...baseArgs, error: 'Bad <token>' });
  assert.match(withErr, /class="error"/);
  assert.ok(withErr.includes('Bad &lt;token&gt;'));
  assert.ok(!withErr.includes('Bad <token>'));
});

test('consent page: with providers, renders a formaction login button + token fallback in <details> (token NOT required)', () => {
  const html = renderConsentPage({ clientName: 'Claude', redirectHost: 'claude.ai', authzId: 'a1', csrf: 'c1', needsToken: true, providers: [{ id: 'github', label: 'GitHub' }] });
  assert.match(html, /formaction="\/oauth\/idp\/github\/login"/);
  assert.match(html, /Continue with GitHub/);
  assert.match(html, /<details/);                                  // token fallback disclosure
  assert.match(html, /name="operator_token"/);                     // token still present (as fallback)
  assert.doesNotMatch(html, /name="operator_token"[^>]*\brequired\b/); // NOT required when providers are offered
  assert.match(html, /<form action="\/oauth\/consent" method="post">/); // form stays POST to /oauth/consent
});

test('consent page: no providers → unchanged (token primary + required, no provider button, no <details>)', () => {
  const html = renderConsentPage({ clientName: 'Claude', redirectHost: 'claude.ai', authzId: 'a1', csrf: 'c1', needsToken: true, providers: [] });
  assert.doesNotMatch(html, /formaction=/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /name="operator_token"[^>]*\brequired\b/);    // required when it's the sole auth path
});

test('consent page: provider label is HTML-escaped', () => {
  const html = renderConsentPage({ clientName: 'Claude', redirectHost: 'claude.ai', authzId: 'a1', csrf: 'c1', needsToken: true, providers: [{ id: 'github', label: '<script>x</script>' }] });
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('consent page: provider id is HTML-escaped in the formaction attribute', () => {
  const html = renderConsentPage({ clientName: 'C', redirectHost: 'h', authzId: 'a', csrf: 'c', needsToken: true, providers: [{ id: 'g"x', label: 'L' }] });
  assert.doesNotMatch(html, /formaction="\/oauth\/idp\/g"x\/login"/); // a raw quote would break out of the attribute
  assert.match(html, /&quot;/);                                        // it is escaped instead
});
