// server/lib/control-session.mjs
//
// Session store, cookie serializer, and stateless double-submit CSRF for the
// `/control` operator dashboard (Gap-171 Stage B, plan U2; spec §3). Pure and
// offline: in-memory only, zero I/O, zero vault writes. Sessions die on
// restart by design — correct for a single-operator ops page, where a
// restart is simply a re-login.
//
// Session store: id -> {createdAt, expiresAt}. Ids are
// crypto.randomBytes(32).toString('base64url') (256 bits; non-constant-time
// Map.get is not exploitable at this width — spec S-N8, recorded here so a
// later reviewer does not "harden" the lookup into something worse). Fixed
// TTL, NO sliding renewal: CONTROL_SESSION_TTL_MS is the SINGLE source of
// truth for both the record's expiresAt and the cookie's Max-Age (R1 S-I3),
// so the two cannot drift apart.
//
// Bounded + swept on access (precedent server/lib/rate-limit.mjs:38-51):
// every createSession/getSession call first sweeps expired entries; if the
// map is still at CONTROL_SESSION_MAX after sweeping (i.e. full of genuinely
// LIVE sessions), createSession evicts the single oldest one to make room.
// CONTROL_SESSION_MAX=32 is a deliberately small bound — this is a
// single-operator page, not a multi-tenant surface.
//
// This module is a process-lifetime SINGLETON (one `/control` surface per
// server -> one Map for the whole process), not a factory: callers import
// the functions directly rather than constructing an instance.
//
// Cookie serializer mirrors consentCookieHeader (server/lib/oauth/consent.mjs:87-92)
// but emits Path=/control (not /oauth) and an OPAQUE random id rather than a
// signed/stateless payload — spec §3's deliberate divergence: the control
// session must be revocable without rotating the master token
// (POST /control/logout), which a stateless MAC-based cookie cannot support.
// The divergence covers statefulness ONLY — CSRF and Origin defenses are not
// dropped (those live at the route layer, U3).
//
// Clock seam: every time-dependent function takes `now` (epoch ms) as an
// explicit parameter, matching the repo idiom in server/lib/stats.mjs
// (readCounterStats({now})) — no implicit Date.now(), so tests can freeze
// time deterministically.
//
// CSRF: stateless double-submit, no session and no server state involved.
// mintControlCsrf() hands out a random 32-byte token; the caller (U3, route
// layer) sets it as a cookie AND echoes it as a hidden form field.
// verifyControlCsrf compares the two SUBMITTED values in constant time. The
// CSRF cookie's own flags (HttpOnly; SameSite=Strict; Path=/control; NOT
// Secure — spec §3 step 5 / R2-S-I1) are set by the route layer (U3), not
// here.

import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'um_control';

// Single source of truth for BOTH the session record's expiresAt and the
// cookie's Max-Age (R1 S-I3) — never compute one without deriving from this.
export const CONTROL_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

// Bounded map (precedent rate-limit.mjs:38-51). Small on purpose: a single
// operator has no legitimate need for dozens of concurrent live sessions.
export const CONTROL_SESSION_MAX = 32;

const sessions = new Map(); // id -> { createdAt, expiresAt }

function assertNow(now, fnName) {
  if (!Number.isFinite(now)) {
    throw new TypeError(`${fnName}: \`now\` (epoch ms) is required — clock seam, no implicit Date.now()`);
  }
}

// Remove every expired record. A full scan is cheap at this bound (<=32
// entries) so it is not the per-request latency concern it would be for the
// rate limiter (which avoids periodic sweeps for exactly that reason).
export function sweep(now) {
  assertNow(now, 'sweep');
  for (const [id, rec] of sessions) {
    if (rec.expiresAt <= now) sessions.delete(id);
  }
}

// Evict the single oldest record (by createdAt — equivalent to earliest
// expiresAt under a fixed TTL) to enforce CONTROL_SESSION_MAX. Mirrors
// rate-limit.mjs's evictOneOldest; only reachable when sweep() has already
// reclaimed every genuinely-expired entry and the map is still full of LIVE
// sessions.
function evictOldest() {
  let oldestId = null;
  let oldestCreatedAt = Infinity;
  for (const [id, rec] of sessions) {
    if (rec.createdAt < oldestCreatedAt) {
      oldestCreatedAt = rec.createdAt;
      oldestId = id;
    }
  }
  if (oldestId !== null) sessions.delete(oldestId);
}

// Mint a new session. Fixed TTL, no sliding renewal — expiresAt is set once,
// here, and never extended by a later getSession call.
export function createSession(now) {
  assertNow(now, 'createSession');
  sweep(now);
  if (sessions.size >= CONTROL_SESSION_MAX) {
    evictOldest();
  }
  const id = randomBytes(32).toString('base64url');
  const expiresAt = now + CONTROL_SESSION_TTL_MS;
  sessions.set(id, { createdAt: now, expiresAt });
  return { id, expiresAt };
}

// Look up a session. Returns null for an unknown id AND for an expired one
// (forged/expired/unknown ids are indistinguishable to the caller — spec
// A4a). A defensive copy is returned so callers cannot mutate store state.
export function getSession(id, now) {
  assertNow(now, 'getSession');
  sweep(now);
  const rec = sessions.get(id);
  if (!rec) return null;
  return { createdAt: rec.createdAt, expiresAt: rec.expiresAt };
}

// Force a session to die immediately, independent of its TTL (the
// POST /control/logout revocation path this opaque-id design exists to
// enable). A no-op on an unknown id.
export function expire(id) {
  return sessions.delete(id);
}

// Set-Cookie value for the opaque session id. Mirrors consentCookieHeader's
// flag set (oauth/consent.mjs:87-92) with Path=/control instead of /oauth.
export function controlSessionCookieHeader(id) {
  const maxAgeSec = CONTROL_SESSION_TTL_MS / 1000;
  return `${COOKIE_NAME}=${id}; Max-Age=${maxAgeSec}; Path=/control; HttpOnly; Secure; SameSite=Strict`;
}

// ---- stateless double-submit CSRF -----------------------------------------

export function mintControlCsrf() {
  return randomBytes(32).toString('base64url');
}

// Constant-time compare of the two SUBMITTED values (cookie + form field).
// No server state, no session lookup. Length mismatch, empty, or absent
// values are all false WITHOUT throwing — timingSafeEqual throws on unequal
// lengths, and two empty strings would otherwise compare as trivially equal
// (a zero-length timingSafeEqual returns true), which must NOT count as a
// valid CSRF pair.
export function verifyControlCsrf(cookieValue, fieldValue) {
  if (typeof cookieValue !== 'string' || typeof fieldValue !== 'string') return false;
  if (cookieValue.length === 0 || fieldValue.length === 0) return false;
  const a = Buffer.from(cookieValue, 'utf8');
  const b = Buffer.from(fieldValue, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
