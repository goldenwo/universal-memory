// server/test/control-session.test.mjs
// U2 — session store + cookie header + CSRF for the `/control` operator
// dashboard (Gap-171 Stage B, plan U2; spec §3). Pure, offline: no I/O, no
// vault writes. Pins A2a (session lifecycle: mint/lookup/expiry/bound) and
// A4a (forged/expired/unknown id -> null; expired ids are swept; map stays
// bounded). Route-layer behavior (A2b/A4b) is out of scope — that lands in U3.
//
// Test-isolation note: control-session.mjs is a module-level singleton (one
// Map for the whole process, matching there being exactly one /control
// surface per server — see the module header). Every test below starts by
// sweeping at CLEAN_SLATE, a `now` far beyond any expiresAt any test in this
// file can produce (all real test epochs stay under 100,000,000ms; even
// after adding CONTROL_SESSION_TTL_MS that tops out well under CLEAN_SLATE),
// so each test starts from a genuinely empty map regardless of run order or
// what earlier tests left behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_SESSION_TTL_MS,
  CONTROL_SESSION_MAX,
  createSession,
  getSession,
  expire,
  sweep,
  controlSessionCookieHeader,
  mintControlCsrf,
  verifyControlCsrf,
} from '../lib/control-session.mjs';

const CLEAN_SLATE = 10_000_000_000; // see file header

test('createSession + getSession: mint then look up a live session', () => {
  sweep(CLEAN_SLATE);
  const now = 1_000_000;
  const { id, expiresAt } = createSession(now);
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.equal(expiresAt, now + CONTROL_SESSION_TTL_MS);

  const rec = getSession(id, now);
  assert.deepEqual(rec, { createdAt: now, expiresAt: now + CONTROL_SESSION_TTL_MS });
});

test('createSession mints distinct, base64url-shaped ids', () => {
  sweep(CLEAN_SLATE);
  const now = 2_000_000;
  const a = createSession(now);
  const b = createSession(now);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[A-Za-z0-9_-]+$/);
});

test('getSession returns null for an unknown id', () => {
  sweep(CLEAN_SLATE);
  const now = 3_000_000;
  assert.equal(getSession('this-id-was-never-minted', now), null);
});

test('getSession returns null once a session has expired, and expiry is not sliding', () => {
  sweep(CLEAN_SLATE);
  const now = 4_000_000;
  const { id, expiresAt } = createSession(now);
  // One ms before expiry — still live.
  assert.notEqual(getSession(id, expiresAt - 1), null);
  // Exactly at / after expiresAt — dead. Fixed TTL, no sliding renewal: the
  // prior getSession call above must not have pushed expiresAt out.
  assert.equal(getSession(id, expiresAt), null);
  assert.equal(getSession(id, expiresAt + 1), null);
});

test('expire() forces a session to die immediately, independent of TTL', () => {
  sweep(CLEAN_SLATE);
  const now = 5_000_000;
  const { id } = createSession(now);
  assert.notEqual(getSession(id, now), null);
  expire(id);
  assert.equal(getSession(id, now), null);
});

test('expire() on an unknown id is a harmless no-op', () => {
  sweep(CLEAN_SLATE);
  assert.doesNotThrow(() => expire('never-existed'));
});

test('sweep(now) removes expired sessions so a subsequent bound check has full room', () => {
  sweep(CLEAN_SLATE);
  const base = 6_000_000;
  // Fill to the bound with sessions that will all expire together.
  for (let i = 0; i < CONTROL_SESSION_MAX; i++) {
    createSession(base + i);
  }
  const past = base + CONTROL_SESSION_TTL_MS + 1;
  sweep(past); // direct sweep call, not via createSession/getSession

  // Prove the sweep actually freed all CONTROL_SESSION_MAX slots (not just
  // some of them): a full fresh batch must mint without any eviction.
  const freshIds = [];
  for (let i = 0; i < CONTROL_SESSION_MAX; i++) {
    freshIds.push(createSession(past + i).id);
  }
  for (const id of freshIds) {
    assert.notEqual(getSession(id, past + CONTROL_SESSION_MAX), null);
  }
});

test('the map stays bounded: filling past CONTROL_SESSION_MAX evicts the oldest', () => {
  sweep(CLEAN_SLATE);
  const base = 7_000_000;
  const ids = [];
  for (let i = 0; i < CONTROL_SESSION_MAX; i++) {
    ids.push(createSession(base + i).id);
  }
  // One more, past the bound — must evict the single oldest (ids[0]).
  const extra = createSession(base + CONTROL_SESSION_MAX).id;

  assert.equal(getSession(ids[0], base + CONTROL_SESSION_MAX), null, 'oldest session must be evicted');
  for (let i = 1; i < CONTROL_SESSION_MAX; i++) {
    assert.notEqual(
      getSession(ids[i], base + CONTROL_SESSION_MAX),
      null,
      `session ${i} must survive the eviction`,
    );
  }
  assert.notEqual(getSession(extra, base + CONTROL_SESSION_MAX), null, 'the newly-created session must survive');
});

test('createSession/getSession/sweep throw a clear TypeError when `now` is missing — no implicit Date.now()', () => {
  assert.throws(() => createSession(), TypeError);
  assert.throws(() => createSession(undefined), TypeError);
  assert.throws(() => getSession('some-id'), TypeError);
  assert.throws(() => sweep(), TypeError);
  assert.throws(() => sweep(NaN), TypeError);
});

test('controlSessionCookieHeader emits the exact spec §3 flag set', () => {
  const header = controlSessionCookieHeader('OPAQUE_ID_VALUE');
  assert.equal(
    header,
    `um_control=OPAQUE_ID_VALUE; Max-Age=${CONTROL_SESSION_TTL_MS / 1000}; Path=/control; HttpOnly; Secure; SameSite=Strict`,
  );
  // Max-Age must be exactly TTL/1000 (R1 S-I3 — cookie and record derive from
  // the same constant so they cannot drift).
  assert.equal(CONTROL_SESSION_TTL_MS / 1000, 8 * 60 * 60);
});

test('mintControlCsrf produces a non-empty base64url token, distinct per call', () => {
  const a = mintControlCsrf();
  const b = mintControlCsrf();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});

test('verifyControlCsrf: matching cookie/field values verify', () => {
  const token = mintControlCsrf();
  assert.equal(verifyControlCsrf(token, token), true);
});

test('verifyControlCsrf: mismatched values fail', () => {
  const a = mintControlCsrf();
  const b = mintControlCsrf();
  assert.equal(verifyControlCsrf(a, b), false);
});

test('verifyControlCsrf: length mismatch fails without throwing', () => {
  assert.equal(verifyControlCsrf('short', 'a-much-longer-value-than-short'), false);
});

test('verifyControlCsrf: empty values fail (two empty strings must NOT verify as equal)', () => {
  assert.equal(verifyControlCsrf('', ''), false);
});

test('verifyControlCsrf: absent (undefined/null) values fail without throwing', () => {
  assert.equal(verifyControlCsrf(undefined, undefined), false);
  assert.equal(verifyControlCsrf(null, null), false);
  const token = mintControlCsrf();
  assert.equal(verifyControlCsrf(token, undefined), false);
  assert.equal(verifyControlCsrf(undefined, token), false);
  assert.equal(verifyControlCsrf(token, null), false);
});
