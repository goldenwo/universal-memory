// server/lib/oauth/cimd.mjs
//
// CIMD — Client ID Metadata Documents (Gap-3 OAuth spec §3 Q5 + §6 item 3,
// plan Task 4.1). This is ChatGPT's preferred registration path: a CIMD
// client_id IS an https URL, and the AS fetches that URL to learn the client's
// metadata instead of going through DCR. Resolution happens per-authorize; the
// in-memory cache IS the persistence (CIMD clients are never written to the
// state store, unlike DCR clients).
//
// The security posture is layered, in this exact order:
//   1. ALLOWLIST FIRST (spec §3 Q5) — default-closed. The client_id URL must be
//      https and its host must be (or be a subdomain of) an allowlisted vendor
//      host BEFORE any fetch fires. An off-allowlist or non-https client_id is
//      rejected with ZERO network egress — the first SSRF guard.
//   2. SSRF-SAFE FETCH (spec §6 item 3) — redirect:'manual' (3xx → reject, never
//      follow a redirect off a trusted host), a 5s abort timeout, and a 64KB
//      body cap (Content-Length AND actual text length).
//   3. STRICT DOCUMENT VALIDATION — the doc must self-identify (client_id ===
//      the fetched URL), carry only allowlisted redirect_uris, and be a public
//      client (token_endpoint_auth_method absent or 'none'); grant_types are
//      subset-validated exactly like DCR.
//   4. BOUNDED CACHE — header-driven positive TTL clamped to [300s, 86400s];
//      failures negative-cached 60s so a transient outage or a malicious URL
//      cannot be hammered into a fetch storm.
//
// A null return is the resolver's only failure signal; the caller (handleAuthorize)
// maps it to a spec-shaped invalid_client — retriable by the vendor, never a
// silent fallback to another client-resolution path (spec §6 item 3).

import { isAllowedRegistrationRedirect, MAX_REDIRECT_URIS } from './redirects.mjs';

// The default vendor allowlist (spec §3 Q5). Frozen — extension is via the
// UM_OAUTH_CIMD_HOSTS env, not mutation.
export const DEFAULT_CIMD_HOSTS = Object.freeze(['claude.ai', 'chatgpt.com', 'openai.com']);

const MAX_BODY_BYTES = 64 * 1024;       // body-size cap (spec §6 item 3)
const FETCH_TIMEOUT_MS = 5000;          // abort budget — well inside the vendor 10s budget
const MAX_CLIENT_NAME = 120;            // display-only; TRUNCATE (mirrors DCR)
const CACHE_TTL_FLOOR_S = 300;          // 5 min (spec §6 item 3)
const CACHE_TTL_CEIL_S = 86_400;        // 24 h (spec §6 item 3)
const NEGATIVE_TTL_MS = 60_000;         // failures cached ~60s (spec §6 item 3)
const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

// Build the effective allowlist: DEFAULT_CIMD_HOSTS plus comma-separated
// UM_OAUTH_CIMD_HOSTS entries (trimmed, lowercased, empties dropped).
function allowedHosts(env) {
  const extra = String(env.UM_OAUTH_CIMD_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_CIMD_HOSTS, ...extra]);
}

// Allowlist gate (spec §3 Q5): https only; host must equal an allowlisted host
// OR be a subdomain of one (endsWith '.'+host). The dot-prefix is what stops
// the `chatgpt.com.evil.com` lookalike — its host ends with 'evil.com', and
// `chatgpt.com.evil.com`.endsWith('.chatgpt.com') is false.
function hostAllowed(clientIdUrl, hosts) {
  let u;
  try { u = new URL(clientIdUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  for (const h of hosts) {
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}

// Parse Cache-Control max-age into a clamped TTL (ms). Missing/unparseable →
// the 300s floor. Clamp keeps a hostile or fat-fingered header inside bounds.
function cacheTtlMs(cacheControl) {
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '');
  const raw = m ? Number(m[1]) : CACHE_TTL_FLOOR_S;
  const clamped = Math.min(Math.max(raw, CACHE_TTL_FLOOR_S), CACHE_TTL_CEIL_S);
  return clamped * 1000;
}

// Validate the fetched document and shape the client record, or null. Mirrors
// the DCR metadata rules (endpoints.mjs handleRegister) so CIMD and DCR clients
// are indistinguishable downstream except for `source`.
function buildClientRecord(doc, clientIdUrl) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;

  // Self-consistency: the doc must claim exactly the URL we fetched.
  if (doc.client_id !== clientIdUrl) return null;

  // redirect_uris: required non-empty, length-capped array; EVERY entry allowlisted.
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS
    || !redirectUris.every((u) => typeof u === 'string' && isAllowedRegistrationRedirect(u))) {
    return null;
  }

  // token_endpoint_auth_method: absent or 'none' (public clients only).
  const authMethod = doc.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') return null;

  // grant_types: optional; if present must subset the supported set.
  let grantTypes = ['authorization_code'];
  if (doc.grant_types !== undefined) {
    if (!Array.isArray(doc.grant_types) || doc.grant_types.length === 0
      || !doc.grant_types.every((g) => ALLOWED_GRANT_TYPES.has(g))) {
      return null;
    }
    grantTypes = doc.grant_types;
  }

  // client_name: optional; TRUNCATE (HTML-escaped at consent render).
  const clientName = typeof doc.client_name === 'string' && doc.client_name.length > 0
    ? doc.client_name.slice(0, MAX_CLIENT_NAME)
    : '(unnamed client)';

  return {
    client_id: clientIdUrl,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    source: 'cimd',
  };
}

// Fetch + guard + validate (no cache). Returns the client record or null.
async function fetchAndValidate(fetchImpl, clientIdUrl) {
  let res;
  try {
    res = await fetchImpl(clientIdUrl, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null; // transient (timeout / network / abort) — caller negative-caches
  }
  // 3xx are NOT followed (redirect:'manual' surfaces them as the response);
  // only a 200 is acceptable. Anything else → reject.
  if (res.status !== 200) return null;

  // Size cap: trust a present Content-Length first, then the actual body length.
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return null;

  let text;
  try { text = await res.text(); } catch { return null; }
  if (text.length > MAX_BODY_BYTES) return null;

  let doc;
  try { doc = JSON.parse(text); } catch { return null; }

  const record = buildClientRecord(doc, clientIdUrl);
  if (!record) return null;

  const ttlMs = cacheTtlMs(res.headers.get('cache-control'));
  return { record, ttlMs };
}

// Factory (plan 4.1). Returns resolveCimdClient(clientIdUrl) → client record or
// null. fetchImpl/env/now are injectable for tests (NEVER real network in unit
// tests). The cache is per-resolver (one resolver lives for the server's life).
export function createCimdResolver({ fetchImpl = fetch, env = process.env, now = Date.now } = {}) {
  const hosts = allowedHosts(env);
  const cache = new Map(); // url -> { value: record|null, exp: epochMs }

  return async function resolveCimdClient(clientIdUrl) {
    // Allowlist FIRST — reject (and DO NOT fetch) anything off-allowlist.
    if (!hostAllowed(clientIdUrl, hosts)) return null;

    const cached = cache.get(clientIdUrl);
    if (cached && cached.exp > now()) return cached.value;

    const result = await fetchAndValidate(fetchImpl, clientIdUrl);
    if (!result) {
      cache.set(clientIdUrl, { value: null, exp: now() + NEGATIVE_TTL_MS });
      return null;
    }
    cache.set(clientIdUrl, { value: result.record, exp: now() + result.ttlMs });
    return result.record;
  };
}
