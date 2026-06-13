// server/lib/oauth/state-store.mjs
//
// JSON state store backing the embedded OAuth authorization server (Gap-3
// OAuth spec 4.2-4.3, plan Task 2.4). Single operator, single vault, no DB:
// the entire grant graph lives in one in-memory object persisted to
// <dir>/oauth-state.json. Node is single-threaded, so every public method is
// SYNCHRONOUS — a logical check (e.g. "is this code live?") and the mutation
// that follows (delete it) cannot be interleaved by another request, which is
// what makes consumeCode / rotateRefresh atomic with no lock (spec 6 item 10).
//
// Persistence is write-temp-then-renameSync after each mutation: a partial
// write can never be observed because rename is atomic on the same filesystem.
//
// Security posture:
//   * Tokens are returned in plaintext ONCE; the store keeps ONLY their
//     sha256 hex digests. A read of the raw file never exposes a usable token.
//   * Refresh rotation is single-use with a reuse tripwire: replaying a
//     rotated-away refresh revokes the entire token family (RFC 6819 §5.2.2.3).
//   * A corrupt or unknown-schema file makes createStateStore THROW rather
//     than silently regenerate. Regenerating would mint a new hmacKey and
//     orphan every live cookie/grant; the documented panic-revoke recovery is
//     for the operator to delete the file deliberately.
//
// Contract deviation noted for reviewers: issueTokens accepts an optional
// `clientId`, stored on both access and refresh records, so revokeClient (PR 5)
// can drop a single client's tokens. The base spec shape keys tokens only by
// hash; this additive field does not change persisted key layout.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OAUTH_TTLS = Object.freeze({
  codeMs: 60_000,
  accessMs: 30 * 60_000,
  refreshIdleMs: 90 * 24 * 3600_000,
  cookieMs: 15 * 60_000,
  pendingAuthzMs: 10 * 60_000,
});

const SCHEMA = 1;
const FILE_NAME = 'oauth-state.json';
const DCR_CLIENT_MAX_AGE_MS = 30 * 24 * 3600_000;
const ACCESS_BODY_BYTES = 32; // 32 bytes base64url = 43 chars (the spec-pinned length)
const REFRESH_BODY_BYTES = 32;

export function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function freshState() {
  return {
    schema: SCHEMA,
    hmacKey: randomBytes(32).toString('hex'),
    clients: {},
    codes: {},
    accessTokens: {},
    refreshTokens: {},
  };
}

function loadOrInit(file) {
  if (!fs.existsSync(file)) {
    const state = freshState();
    persist(file, state);
    return state;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${FILE_NAME}: corrupt or unparseable — refusing to start (delete the file to deliberately panic-revoke all grants)`);
  }
  if (parsed?.schema !== SCHEMA) {
    throw new Error(`${FILE_NAME}: unknown schema ${parsed?.schema} — refusing to start (migration reserved)`);
  }
  return parsed;
}

function persist(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

export function createStateStore(dir, { now = Date.now } = {}) {
  const file = path.join(dir, FILE_NAME);
  const state = loadOrInit(file);
  const save = () => persist(file, state);

  // Drop everything that has aged out. Cheap to run on every mutation at
  // single-user scale; also runs once on load to bound startup memory.
  function prune() {
    const t = now();
    let changed = false;
    for (const [id, c] of Object.entries(state.codes)) {
      if (c.exp <= t) { delete state.codes[id]; changed = true; }
    }
    for (const [h, a] of Object.entries(state.accessTokens)) {
      if (a.exp <= t) { delete state.accessTokens[h]; changed = true; }
    }
    for (const [h, r] of Object.entries(state.refreshTokens)) {
      if (t - r.lastUsed > OAUTH_TTLS.refreshIdleMs) { delete state.refreshTokens[h]; changed = true; }
    }
    for (const [id, cl] of Object.entries(state.clients)) {
      if (cl.source === 'dcr' && cl.created === cl.lastUsed && t - cl.created > DCR_CLIENT_MAX_AGE_MS) {
        delete state.clients[id];
        changed = true;
      }
    }
    if (changed) save();
  }

  prune(); // bound memory on every cold start

  function mintAccess({ sub, aud, scope, familyId, clientId }) {
    const plain = 'umat_' + randomBytes(ACCESS_BODY_BYTES).toString('base64url');
    state.accessTokens[sha256hex(plain)] = {
      sub, aud, scope, exp: now() + OAUTH_TTLS.accessMs, familyId, clientId,
    };
    return plain;
  }

  function mintRefresh({ sub, aud, scope, familyId, clientId, prevHashes = [] }) {
    const plain = 'umrt_' + randomBytes(REFRESH_BODY_BYTES).toString('base64url');
    state.refreshTokens[sha256hex(plain)] = {
      sub, aud, scope, offlineAccess: true, familyId, lastUsed: now(), prevHashes, clientId,
    };
    return plain;
  }

  // Revoke a whole token family: its current refresh record plus every access
  // token sharing the familyId. Used on reuse-detection and as the unit of
  // refresh rotation cleanup.
  function revokeFamily(familyId) {
    for (const [h, r] of Object.entries(state.refreshTokens)) {
      if (r.familyId === familyId) delete state.refreshTokens[h];
    }
    for (const [h, a] of Object.entries(state.accessTokens)) {
      if (a.familyId === familyId) delete state.accessTokens[h];
    }
  }

  return {
    getHmacKey() { return state.hmacKey; },

    // ---- clients
    putClient(client) { state.clients[client.client_id] = client; save(); },
    getClient(clientId) { return state.clients[clientId]; },
    deleteClient(clientId) { delete state.clients[clientId]; save(); },
    // Count of registered clients — read-only; the DCR handler uses it to enforce
    // the registration cap (RFC 7591) without reaching into store internals.
    countClients() { return Object.keys(state.clients).length; },

    // ---- authorization codes (single-use, atomic consume)
    putCode(codeId, rec) { state.codes[codeId] = rec; save(); },
    consumeCode(codeId) {
      const rec = state.codes[codeId];
      if (rec === undefined) return undefined;
      delete state.codes[codeId]; // consume: gone whether live or expired
      save();
      if (rec.exp <= now()) return undefined;
      return rec;
    },

    // ---- token issuance
    issueTokens({ sub, aud, scope, offlineAccess, clientId }) {
      const familyId = randomBytes(16).toString('hex');
      const accessToken = mintAccess({ sub, aud, scope, familyId, clientId });
      let refreshToken;
      if (offlineAccess) {
        refreshToken = mintRefresh({ sub, aud, scope, familyId, clientId });
      }
      save();
      return { accessToken, refreshToken, expiresInSec: OAUTH_TTLS.accessMs / 1000 };
    },

    findAccessToken(hash) {
      const rec = state.accessTokens[hash];
      if (rec === undefined) return undefined;
      if (rec.exp <= now()) { delete state.accessTokens[hash]; save(); return undefined; }
      return rec;
    },

    // Read-only client-binding peek (RFC 6749 §6): returns the clientId bound to
    // a LIVE refresh record, or undefined if the hash is not currently live
    // (unknown OR already rotated-away). No mutation — the caller MUST still
    // call rotateRefresh on an undefined result so the reuse tripwire fires for
    // rotated-away hashes. Lets the token endpoint reject a client_id mismatch
    // BEFORE rotation, so a typo'd client_id never burns the caller's token.
    peekRefreshClientId(plaintextRefresh) {
      return state.refreshTokens[sha256hex(plaintextRefresh)]?.clientId;
    },

    // ---- refresh rotation with reuse tripwire
    rotateRefresh(plaintextRefresh) {
      const hash = sha256hex(plaintextRefresh);
      const live = state.refreshTokens[hash];
      if (live) {
        // Happy path: mint a fresh pair, retire the old hash into prevHashes,
        // delete the consumed refresh record.
        delete state.refreshTokens[hash];
        const { sub, aud, scope, familyId, clientId, prevHashes } = live;
        const accessToken = mintAccess({ sub, aud, scope, familyId, clientId });
        const refreshToken = mintRefresh({
          sub, aud, scope, familyId, clientId, prevHashes: [...prevHashes, hash],
        });
        save();
        // scope + clientId are echoed so the token endpoint can populate the
        // refresh-grant response's `scope` field and confirm the form's
        // client_id matched without a second lookup (the grant is opaque to the
        // caller otherwise). clientId mirrors the scope echo (RFC 6749 §6).
        return { accessToken, refreshToken, expiresInSec: OAUTH_TTLS.accessMs / 1000, scope, clientId };
      }
      // Reuse detection: is this a refresh we already rotated away?
      for (const r of Object.values(state.refreshTokens)) {
        if (r.prevHashes.includes(hash)) {
          revokeFamily(r.familyId);
          save();
          return { reuse: true, familyRevoked: true };
        }
      }
      return { reuse: false, notFound: true };
    },

    prune,

    // ---- revocation (PR 5)
    // Both return a {accessTokens, refreshTokens, codes} count of what was
    // dropped, captured BEFORE the delete so the loopback /oauth/revoke endpoint
    // can report it (spec §4.3). Counts are additive to the base contract; the
    // persisted key layout is unchanged. revokeAll keeps clients (it nukes the
    // grant graph, not registrations); revokeClient also drops the registration.
    revokeAll() {
      const counts = {
        accessTokens: Object.keys(state.accessTokens).length,
        refreshTokens: Object.keys(state.refreshTokens).length,
        codes: Object.keys(state.codes).length,
      };
      state.codes = {};
      state.accessTokens = {};
      state.refreshTokens = {};
      save();
      return counts;
    },
    revokeClient(clientId) {
      const counts = { accessTokens: 0, refreshTokens: 0, codes: 0 };
      delete state.clients[clientId];
      for (const [id, c] of Object.entries(state.codes)) {
        if (c.clientId === clientId) { delete state.codes[id]; counts.codes++; }
      }
      for (const [h, a] of Object.entries(state.accessTokens)) {
        if (a.clientId === clientId) { delete state.accessTokens[h]; counts.accessTokens++; }
      }
      for (const [h, r] of Object.entries(state.refreshTokens)) {
        if (r.clientId === clientId) { delete state.refreshTokens[h]; counts.refreshTokens++; }
      }
      save();
      return counts;
    },
  };
}
