// server/test/oauth-state-store.test.mjs — unit tests for the embedded OAuth
// authorization-server JSON state store (Gap-3 OAuth spec 4.2-4.3, plan Task
// 2.4). Single operator, single vault, no DB: an in-memory object persisted
// atomically to <dir>/oauth-state.json after every mutation. Every test uses
// a fresh mkdtemp dir and an injectable `now` (a `let t` advanced by hand) so
// TTL/expiry behaviour is exercised without sleeping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  OAUTH_TTLS,
  sha256hex,
  createStateStore,
} from '../lib/oauth/state-store.mjs';

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'um-oauth-state-'));
}
const STATE_FILE = (dir) => path.join(dir, 'oauth-state.json');
function readRaw(dir) {
  return fs.readFileSync(STATE_FILE(dir), 'utf8');
}
function readParsed(dir) {
  return JSON.parse(readRaw(dir));
}

// A simple advanceable clock. `t` is a plain ms counter the test mutates.
function clock(start = 1_700_000_000_000) {
  const ref = { t: start };
  return { ref, now: () => ref.t };
}

function sampleClient(over = {}) {
  return {
    client_id: 'cid-123',
    client_name: 'Test Connector',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    created: 1,
    lastUsed: 1,
    source: 'dcr',
    ...over,
  };
}

// ---------------------------------------------------------------- TTLs

test('OAUTH_TTLS exposes the spec-canonical lifetimes and is frozen', () => {
  assert.equal(OAUTH_TTLS.codeMs, 60_000);
  assert.equal(OAUTH_TTLS.accessMs, 30 * 60_000);
  assert.equal(OAUTH_TTLS.refreshIdleMs, 90 * 24 * 3600_000);
  assert.equal(OAUTH_TTLS.cookieMs, 15 * 60_000);
  assert.equal(OAUTH_TTLS.pendingAuthzMs, 10 * 60_000);
  assert.ok(Object.isFrozen(OAUTH_TTLS));
});

test('sha256hex returns the 64-char hex digest of the utf8 string', () => {
  // Known vector: sha256("") = e3b0c442...
  assert.equal(
    sha256hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  const h = sha256hex('hello');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, sha256hex('hello')); // deterministic
});

// ---------------------------------------------------------- initialization

test('fresh dir initialization writes schema 1 + a 64-hex random hmacKey', async () => {
  const dir = await tmpDir();
  const store = createStateStore(dir, { now: () => 1 });
  const raw = readParsed(dir);
  assert.equal(raw.schema, 1);
  assert.match(raw.hmacKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(raw.clients, {});
  assert.deepEqual(raw.codes, {});
  assert.deepEqual(raw.accessTokens, {});
  assert.deepEqual(raw.refreshTokens, {});
  assert.equal(store.getHmacKey(), raw.hmacKey);
});

test('re-opening the same dir keeps the SAME hmacKey (no rotation)', async () => {
  const dir = await tmpDir();
  const a = createStateStore(dir, { now: () => 1 });
  const keyA = a.getHmacKey();
  const b = createStateStore(dir, { now: () => 1 });
  assert.equal(b.getHmacKey(), keyA);
});

test('corrupt/unparseable existing file → createStateStore THROWS, never regenerates', async () => {
  const dir = await tmpDir();
  fs.writeFileSync(STATE_FILE(dir), '{nope');
  assert.throws(
    () => createStateStore(dir, { now: () => 1 }),
    (e) => /oauth-state\.json/.test(e.message) && /refusing to start/.test(e.message),
  );
});

test('unknown schema value → throws (migration reserved)', async () => {
  const dir = await tmpDir();
  fs.writeFileSync(
    STATE_FILE(dir),
    JSON.stringify({ schema: 99, hmacKey: 'ab'.repeat(32), clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} }),
  );
  assert.throws(
    () => createStateStore(dir, { now: () => 1 }),
    (e) => /oauth-state\.json/.test(e.message) && /refusing to start/.test(e.message),
  );
});

// ----------------------------------------------------------- client CRUD

test('client put/get/delete round-trips and persists', async () => {
  const dir = await tmpDir();
  const store = createStateStore(dir, { now: () => 1 });
  const c = sampleClient();
  store.putClient(c);
  assert.deepEqual(store.getClient('cid-123'), c);
  // persisted
  assert.deepEqual(readParsed(dir).clients['cid-123'], c);
  // survives reload
  const reopened = createStateStore(dir, { now: () => 1 });
  assert.deepEqual(reopened.getClient('cid-123'), c);
  // delete
  store.deleteClient('cid-123');
  assert.equal(store.getClient('cid-123'), undefined);
  assert.equal(readParsed(dir).clients['cid-123'], undefined);
});

// ------------------------------------------------------------- codes

function sampleCode(now, over = {}) {
  return {
    clientId: 'cid-123',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: 'x'.repeat(43),
    resource: 'https://um.example/mcp',
    scope: ['vault'],
    offlineAccess: false,
    sub: 'owner',
    exp: now + OAUTH_TTLS.codeMs,
    ...over,
  };
}

test('consumeCode returns the record ONCE then undefined (atomic consume)', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const rec = sampleCode(c.now());
  store.putCode('code-1', rec);
  assert.deepEqual(store.consumeCode('code-1'), rec);
  assert.equal(store.consumeCode('code-1'), undefined);
  // deleted from disk
  assert.equal(readParsed(dir).codes['code-1'], undefined);
});

test('expired code consume → undefined and deleted', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  store.putCode('code-x', sampleCode(c.now()));
  c.ref.t += OAUTH_TTLS.codeMs + 1; // now > exp
  assert.equal(store.consumeCode('code-x'), undefined);
  assert.equal(readParsed(dir).codes['code-x'], undefined);
});

// ----------------------------------------------------------- tokens

test('issueTokens shape: umat_/umrt_ prefixes, 43-char access body, expiresInSec 1800', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const out = store.issueTokens({ sub: 'owner', aud: 'https://um/mcp', scope: ['vault'], offlineAccess: true });
  assert.match(out.accessToken, /^umat_[A-Za-z0-9_-]{43}$/);
  assert.match(out.refreshToken, /^umrt_[A-Za-z0-9_-]+$/);
  assert.equal(out.expiresInSec, 1800);
  // store holds only digests — no plaintext token substring in the file
  const raw = readRaw(dir);
  assert.equal(raw.includes('umat_'), false);
  assert.equal(raw.includes('umrt_'), false);
  // access token record indexed by hash
  const ah = sha256hex(out.accessToken);
  assert.ok(readParsed(dir).accessTokens[ah]);
});

test('issueTokens without offlineAccess → no refreshToken, no refresh record', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const out = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: false });
  assert.match(out.accessToken, /^umat_/);
  assert.equal(out.refreshToken, undefined);
  assert.deepEqual(readParsed(dir).refreshTokens, {});
});

test('findAccessToken honors exp via injected now, pruning the expired entry', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const out = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: false });
  const h = sha256hex(out.accessToken);
  assert.ok(store.findAccessToken(h));
  c.ref.t += OAUTH_TTLS.accessMs + 1;
  assert.equal(store.findAccessToken(h), undefined);
  assert.equal(readParsed(dir).accessTokens[h], undefined);
});

// ------------------------------------------------------- refresh rotation

test('rotateRefresh happy path: old hash dead, new pair live', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const first = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true });
  const rotated = store.rotateRefresh(first.refreshToken);
  assert.match(rotated.accessToken, /^umat_/);
  assert.match(rotated.refreshToken, /^umrt_/);
  assert.equal(rotated.expiresInSec, 1800);
  // new refresh is live
  const second = store.rotateRefresh(rotated.refreshToken);
  assert.match(second.accessToken, /^umat_/);
});

test('REUSE tripwire: replaying a rotated-away refresh revokes the whole family', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const first = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true });
  const rotated = store.rotateRefresh(first.refreshToken); // first.refreshToken now in prevHashes
  // the rotated pair is currently live
  const liveAccessHash = sha256hex(rotated.accessToken);
  const liveRefreshHash = sha256hex(rotated.refreshToken);
  assert.ok(store.findAccessToken(liveAccessHash));
  // replay the rotated-AWAY (dead) refresh = theft signal
  const res = store.rotateRefresh(first.refreshToken);
  assert.deepEqual(res, { reuse: true, familyRevoked: true });
  // entire family dead: current access + current refresh both gone
  assert.equal(store.findAccessToken(liveAccessHash), undefined);
  assert.deepEqual(store.rotateRefresh(rotated.refreshToken), { reuse: false, notFound: true });
  assert.equal(readParsed(dir).refreshTokens[liveRefreshHash], undefined);
});

test('rotateRefresh on an unknown hash → notFound', async () => {
  const dir = await tmpDir();
  const store = createStateStore(dir, { now: () => 1 });
  assert.deepEqual(store.rotateRefresh('umrt_does-not-exist'), { reuse: false, notFound: true });
});

test('rotateRefresh success echoes the bound clientId (RFC 6749 §6)', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const first = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true, clientId: 'cid-123' });
  const rotated = store.rotateRefresh(first.refreshToken);
  assert.equal(rotated.clientId, 'cid-123');
});

test('peekRefreshClientId: clientId for live, undefined for rotated-away/unknown', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const first = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true, clientId: 'cid-123' });
  // live refresh → bound clientId, no mutation
  assert.equal(store.peekRefreshClientId(first.refreshToken), 'cid-123');
  assert.equal(store.peekRefreshClientId(first.refreshToken), 'cid-123'); // idempotent (read-only)
  // rotate it away → the old refresh is no longer live
  const rotated = store.rotateRefresh(first.refreshToken);
  assert.equal(store.peekRefreshClientId(first.refreshToken), undefined); // rotated-away
  assert.equal(store.peekRefreshClientId(rotated.refreshToken), 'cid-123'); // new pair live
  // unknown hash
  assert.equal(store.peekRefreshClientId('umrt_does-not-exist'), undefined);
});

// --------------------------------------------------------------- prune

test('prune drops expired codes, expired access tokens, and idle refresh families', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  store.putCode('old-code', sampleCode(c.now()));
  const tok = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true });
  const ah = sha256hex(tok.accessToken);
  const rh = sha256hex(tok.refreshToken);
  // advance past every TTL
  c.ref.t += OAUTH_TTLS.refreshIdleMs + 1;
  store.prune();
  const p = readParsed(dir);
  assert.equal(p.codes['old-code'], undefined);
  assert.equal(p.accessTokens[ah], undefined);
  assert.equal(p.refreshTokens[rh], undefined);
});

test('prune drops never-used dcr clients older than 30 days', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  const old = c.now() - (31 * 24 * 3600_000);
  store.putClient(sampleClient({ client_id: 'stale', source: 'dcr', created: old, lastUsed: old }));
  store.putClient(sampleClient({ client_id: 'fresh', source: 'dcr', created: c.now(), lastUsed: c.now() }));
  store.putClient(sampleClient({ client_id: 'manual', source: 'manual', created: old, lastUsed: old }));
  store.prune();
  const p = readParsed(dir);
  assert.equal(p.clients['stale'], undefined, 'stale dcr client pruned');
  assert.ok(p.clients['fresh'], 'fresh dcr client kept');
  assert.ok(p.clients['manual'], 'manual client never pruned by age');
});

// ----------------------------------------------------------- revocation

test('revokeAll clears codes + tokens but keeps clients', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  store.putClient(sampleClient());
  store.putCode('code-1', sampleCode(c.now()));
  const tok = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true });
  store.revokeAll();
  const p = readParsed(dir);
  assert.deepEqual(p.codes, {});
  assert.deepEqual(p.accessTokens, {});
  assert.deepEqual(p.refreshTokens, {});
  assert.ok(p.clients['cid-123'], 'clients survive revokeAll');
  assert.equal(store.findAccessToken(sha256hex(tok.accessToken)), undefined);
});

test('revokeClient removes the client, its codes, and its tokens', async () => {
  const dir = await tmpDir();
  const c = clock();
  const store = createStateStore(dir, { now: c.now });
  store.putClient(sampleClient({ client_id: 'A' }));
  store.putClient(sampleClient({ client_id: 'B' }));
  store.putCode('codeA', sampleCode(c.now(), { clientId: 'A' }));
  store.putCode('codeB', sampleCode(c.now(), { clientId: 'B' }));
  const tokA = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true, clientId: 'A' });
  const tokB = store.issueTokens({ sub: 'owner', aud: 'a', scope: ['vault'], offlineAccess: true, clientId: 'B' });

  store.revokeClient('A');
  const p = readParsed(dir);
  assert.equal(p.clients['A'], undefined);
  assert.ok(p.clients['B'], 'other client untouched');
  assert.equal(p.codes['codeA'], undefined);
  assert.ok(p.codes['codeB'], 'other client code untouched');
  assert.equal(store.findAccessToken(sha256hex(tokA.accessToken)), undefined);
  assert.ok(store.findAccessToken(sha256hex(tokB.accessToken)), 'other client token survives');
});
