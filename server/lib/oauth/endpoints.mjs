// server/lib/oauth/endpoints.mjs
//
// The OAuth HTTP handlers — authorize (GET), consent (POST), token (POST),
// register (POST DCR) and revoke (POST, loopback-only operator revocation)
// (Gap-3 OAuth spec sections 4.1, 4.2, 4.3, 5, 6). These are
// the door of the embedded single-operator authorization server: authorize
// validates the request and renders the consent page; consent is the trust
// boundary (operator-token or presence-cookie gated, CSRF + Origin enforced,
// globally throttled per section 6 item 9); token redeems a PKCE-bound code or
// rotates a refresh token. Handlers are dispatched by the main server in Task
// 2.7 — here they are driven by tests with a real node:http server.
//
// Security contract pinned here:
//   * NEVER 3xx to an unvalidated redirect_uri — client + exact redirect match
//     happen before any redirect can be emitted (spec section 4.5).
//   * PKCE S256 is a hard requirement: no code_challenge → 400 (section 6 #3).
//   * Authorize delivery is content-negotiated: a programmatic cross-origin
//     fetch (ChatGPT) gets 200 JSON {consent_url}, never a bare cross-origin
//     302 — the better-auth-1.5-class failure (section 4.2).
//   * resource (RFC 8707) defaults to `${baseUrl}/mcp` when absent (Claude
//     often omits it) and is carried code → aud → access-token (section 4.2).
//   * Pending authorizations are an in-memory per-instance Map (authz ≠ code);
//     codes live in the shared store and are single-use / atomically consumed.

import { randomBytes } from 'node:crypto';
import { OAUTH_TTLS, sha256hex } from './state-store.mjs';
import { negotiateScopes } from './scopes.mjs';
import { redirectMatches } from './redirects.mjs';
import { verifyS256 } from './pkce.mjs';
import {
  mintCsrf, verifyCsrf, renderConsentPage,
  signConsentCookie, verifyConsentCookie, consentCookieHeader,
} from './consent.mjs';
import { isAllowedRegistrationRedirect, MAX_REDIRECT_URIS } from './redirects.mjs';
import { compareTokens } from '../auth.mjs';
import { makeOperatorPolicy } from './idp/policy.mjs';
import { createConsentThrottle } from './throttle.mjs';

const MAX_FORM_BYTES = 64 * 1024; // body-size cap shared by consent + token

// RFC 7591 DCR limits.
const MAX_CLIENT_NAME = 120;        // display-only; TRUNCATE rather than reject
const MAX_REGISTERED_CLIENTS = 100; // store-wide cap (prune runs before rejecting)
const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

// ---- thin response/body helpers ------------------------------------------

function sendJson(res, status, obj, extraHeaders = {}) {
  const payload = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// Collect a urlencoded body, capped at MAX_FORM_BYTES, into a URLSearchParams.
// Resolves { params } on success, { tooLarge: true } if the cap is exceeded.
function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false, settled = false;
    req.on('data', (c) => {
      if (tooLarge) return; // past the cap: drop further chunks, keep draining
      size += c.length;
      if (size > MAX_FORM_BYTES) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    // Resolve on `end` whether or not the cap tripped — draining (rather than
    // destroying) the socket lets the handler still deliver a clean 400 instead
    // of resetting the connection; the cap already bounds buffered bytes.
    req.on('end', () => {
      if (settled) return; settled = true;
      if (tooLarge) return resolve({ tooLarge: true });
      resolve({ params: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) });
    });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

// Collect a JSON body, capped at MAX_FORM_BYTES, and parse it. Mirrors readForm's
// drain-don't-destroy discipline so an over-cap or malformed body still yields a
// clean 400 rather than a connection reset. Resolves { value } on a parsed JSON
// value, { tooLarge: true } if the cap tripped, or { invalid: true } if the body
// is empty or not parseable JSON. The DCR handler narrows `value` to an object.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false, settled = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_FORM_BYTES) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return; settled = true;
      if (tooLarge) return resolve({ tooLarge: true });
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve({ value: JSON.parse(text) }); }
      catch { resolve({ invalid: true }); }
    });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

// Host of a redirect URI for the consent page's prominent display; falls back
// to the raw string if it is somehow unparseable (it is allowlist-validated
// upstream, so this is belt-and-suspenders).
function hostOf(uri) {
  try { return new URL(uri).host; } catch { return uri; }
}

function isFormContentType(req) {
  const ct = req.headers['content-type'] ?? '';
  return ct.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

// Parse one named cookie out of a raw Cookie header.
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// A request is a NON-NAVIGATION programmatic fetch when Sec-Fetch-Mode is
// present and not 'navigate', OR Accept asks for JSON without HTML. Such a
// request must receive JSON {consent_url}, never a cross-origin 302 (the
// ChatGPT gotcha, spec section 4.2).
function wantsJsonDelivery(req) {
  const sfm = req.headers['sec-fetch-mode'];
  if (typeof sfm === 'string' && sfm !== 'navigate') return true;
  const accept = (req.headers.accept ?? '').toLowerCase();
  if (accept.includes('application/json') && !accept.includes('text/html')) return true;
  return false;
}

// A client_id is a CIMD candidate when it parses as an https URL (spec §3 Q5).
// Non-URL ids (DCR umcl_, seeded manual) keep the store path; the resolver
// itself re-validates the allowlist, so this is only a cheap routing predicate.
function isHttpsUrl(s) {
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}

export function createOAuthHandlers({ store, baseUrl, operatorToken, throttle, now = Date.now, pendingCap = 500, onRegistration = () => {}, onConsent = () => {}, onTokenGrant = () => {}, cimdResolver = null, operatorPolicy = makeOperatorPolicy({}), registry = { get: () => undefined, list: () => [] }, callbackThrottle = createConsentThrottle(), onIdpOutcome = () => {} }) {
  const base = baseUrl.replace(/\/+$/, '');
  const canonicalResource = `${base}/mcp`;
  const baseOrigin = new URL(base).origin;

  // Per-handlers-instance pending-authorization map (authz ≠ code). Entries
  // expire (pendingAuthzMs) and are dropped on read via takePending; they are
  // ALSO hard-capped at `pendingCap` so a flood of authorize requests that
  // never reach consent cannot grow the map without bound. On insert at the
  // cap we first sweep expired entries, then — if still full — evict the
  // oldest (insertion-ordered Map → first key). Single operator, so the cap is
  // generous; the eviction is a safety floor, not a steady-state path.
  const pending = new Map();
  function putPending(rec) {
    if (pending.size >= pendingCap) {
      const t = now();
      for (const [id, r] of pending) {
        if (r.exp <= t) pending.delete(id);
      }
      if (pending.size >= pendingCap) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
    }
    const id = randomBytes(16).toString('hex');
    pending.set(id, rec);
    return id;
  }
  function takePending(id) {
    const rec = pending.get(id);
    if (!rec) return undefined;
    if (rec.exp <= now()) { pending.delete(id); return undefined; }
    return rec;
  }
  // Read-only liveness check: returns the live pending record WITHOUT consuming it
  // (the IdP login→callback round-trip peeks the same authz twice). Pure read — it
  // never mutates the map; expired entries are left for prune/cap.
  function peekPending(id) {
    const rec = pending.get(id);
    if (!rec || rec.exp <= now()) return undefined;
    return rec;
  }

  // ---- GET /oauth/authorize ----------------------------------------------
  // async because the CIMD branch awaits an out-of-process metadata fetch
  // (spec §3 Q5 / PR-4). The dispatcher already awaits handler calls.
  async function handleAuthorize(req, res) {
    const url = new URL(req.url, base);
    const q = url.searchParams;
    const responseType = q.get('response_type');
    const clientId = q.get('client_id');
    const redirectUri = q.get('redirect_uri');
    const codeChallenge = q.get('code_challenge');
    const method = q.get('code_challenge_method');
    const state = q.get('state') ?? undefined;
    const scope = q.get('scope') ?? undefined;
    const resourceParam = q.get('resource');

    // Client + redirect validation FIRST — never 3xx to an unvalidated URI.
    // A URL-shaped client_id is a CIMD client (spec §3 Q5 / PR-4): resolve it
    // out-of-band (allowlist-first, SSRF-guarded) instead of the store. A null
    // resolution — off-allowlist, fetch failure, bad doc — maps to the SAME
    // invalid_client path (retriable by the vendor; never a silent fallback to
    // the store). A URL client_id with NO resolver configured (CIMD off) also
    // lands here as invalid_client, never a crash.
    let client;
    if (clientId && isHttpsUrl(clientId)) {
      client = cimdResolver ? await cimdResolver(clientId) : null;
    } else {
      client = clientId ? store.getClient(clientId) : undefined;
    }
    if (!client) return sendJson(res, 400, { error: 'invalid_client', error_description: 'unknown client_id' });
    const storedUris = client.redirect_uris ?? [];
    if (!redirectUri || !storedUris.some((u) => redirectMatches(u, redirectUri))) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri mismatch' });
    }

    if (responseType !== 'code') {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'response_type must be code' });
    }
    // PKCE hard requirement (S256 only).
    if (!codeChallenge || method !== 'S256') {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'S256 code_challenge required' });
    }
    // resource: absent → default canonical (Claude omits it); present must match.
    const resource = resourceParam ?? canonicalResource;
    if (resource !== canonicalResource) {
      return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource is not this server' });
    }

    const { granted, offlineAccess } = negotiateScopes(scope);
    // Refresh is issued when offline_access was negotiated OR the client registered
    // the refresh_token grant (spec §4.2). DCR clients carry grant_types; seeded
    // manual clients have none (→ unchanged, scope-only behaviour).
    const grantRefresh = (client.grant_types ?? []).includes('refresh_token');
    // Carry the resolved display name in the pending record so the wrong-token
    // re-render can show it even for CIMD clients (which are NOT in the store —
    // a store.getClient(clientId) on retry would return undefined).
    const clientName = client.client_name ?? clientId;
    const authzId = putPending({
      clientId, clientName, redirectUri, codeChallenge, resource, scope: granted,
      offlineAccess: offlineAccess || grantRefresh, state,
      exp: now() + OAUTH_TTLS.pendingAuthzMs,
    });

    // Programmatic fetch → JSON {consent_url} pointing at the same authorize URL
    // (a navigable browser URL), never a cross-origin 302.
    if (wantsJsonDelivery(req)) {
      const consentUrl = `${base}/oauth/authorize?${url.searchParams.toString()}`;
      return sendJson(res, 200, { consent_url: consentUrl });
    }

    const hasCookie = verifyConsentCookie(store.getHmacKey(), readCookie(req, 'um_consent'), now());
    const html = renderConsentPage({
      clientName,
      redirectHost: hostOf(redirectUri),
      authzId,
      csrf: mintCsrf(store.getHmacKey(), authzId),
      needsToken: !hasCookie,
      providers: registry.list().map((a) => ({ id: a.id, label: a.label })),
    });
    return sendHtml(res, 200, html);
  }

  // Mint a single-use code bound to the authorization, persist the resolved
  // identity `sub`, write the consent cookie if one was minted, and 302 back to
  // the connector with code + echoed connector state. Shared by the token-paste
  // consent path (this task) and the IdP callback path (a later task); each
  // caller supplies its own `sub` and `setCookie`.
  function completeAllowedAuthorization({ rec, sub, res, setCookie }) {
    const code = randomBytes(32).toString('base64url');
    store.putCode(sha256hex(code), {
      clientId: rec.clientId, redirectUri: rec.redirectUri, codeChallenge: rec.codeChallenge,
      resource: rec.resource, scope: rec.scope, offlineAccess: rec.offlineAccess,
      sub, exp: now() + OAUTH_TTLS.codeMs,
    });
    const loc = new URL(rec.redirectUri);
    loc.searchParams.set('code', code);
    if (rec.state !== undefined) loc.searchParams.set('state', rec.state);
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    return redirect(res, loc.toString());
  }

  // Same-origin / same-site trust boundary (spec section 5), shared by the consent
  // POST and the IdP login POST: a live cookie must not let a cross-origin page
  // auto-submit. Returns null when acceptable, else a short reason for the 403.
  function verifyOrigin(req) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== baseOrigin) return 'cross-origin';
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string' && sfs !== 'same-origin' && sfs !== 'none') return 'cross-site';
    return null;
  }

  // ---- POST /oauth/consent -----------------------------------------------
  // Observability (spec §6 item 12): onConsent(outcome, method) fires at every
  // terminal path with a bounded outcome ∈ {'allow','deny','bad_token','throttled',
  // 'csrf_reject'} and method='token' (all paths through this handler are the
  // operator-token-paste / presence-cookie path). The trust-boundary rejects
  // (cross-origin/cross-site Origin, non-form body, missing/over-cap body, no
  // pending authz, forged CSRF) all collapse to 'csrf_reject' — they are the
  // anti-forgery family of "this is not a legitimate consent submission" and keep
  // the enum bounded. The metric inc itself lives in the dispatcher (this module
  // stays metrics-free, like its siblings); here we only call the injected callback.
  async function handleConsent(req, res) {
    // All emissions from this handler carry method='token' (operator-token-paste /
    // presence-cookie path). The IdP callback success path calls onConsent directly
    // with method='idp'. Having a local wrapper ensures every branch in this
    // function gets the right method without risk of a missing-label throw.
    const onConsentToken = (outcome) => onConsent(outcome, 'token');

    // Origin / Sec-Fetch-Site enforcement FIRST (spec section 5): a live cookie
    // must not let a cross-origin page auto-submit a consent.
    const originReject = verifyOrigin(req);
    if (originReject) {
      onConsentToken('csrf_reject');
      return sendJson(res, 403, { error: 'access_denied', error_description: originReject });
    }
    if (!isFormContentType(req)) {
      onConsentToken('csrf_reject');
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'form-urlencoded only' });
    }
    // Global throttle (IP-independent, spec section 6 item 9).
    if (!throttle.admitted(now())) {
      onConsentToken('throttled');
      return sendJson(res, 429, { error: 'slow_down' }, { 'Retry-After': String(throttle.retryAfterSec(now())) });
    }

    const { params, tooLarge } = await readForm(req);
    if (tooLarge) {
      onConsentToken('csrf_reject');
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'body too large' });
    }

    const authzId = params.get('authz_id');
    const csrf = params.get('csrf');
    const operatorTokenForm = params.get('operator_token');
    const decision = params.get('decision');

    const rec = authzId ? takePending(authzId) : undefined;
    if (!rec) {
      onConsentToken('csrf_reject');
      return sendJson(res, 403, { error: 'access_denied', error_description: 'no pending authorization' });
    }
    if (!verifyCsrf(store.getHmacKey(), authzId, csrf)) {
      onConsentToken('csrf_reject');
      return sendJson(res, 403, { error: 'access_denied', error_description: 'bad csrf' });
    }

    // Auth: a valid presence cookie skips the paste; otherwise the operator
    // token must match (timing-safe, reusing auth.mjs).
    const hasCookie = verifyConsentCookie(store.getHmacKey(), readCookie(req, 'um_consent'), now());
    const tokenOk = typeof operatorTokenForm === 'string' && compareTokens(operatorTokenForm, operatorToken);
    if (!hasCookie && !tokenOk) {
      // Wrong/missing token + no cookie → engage throttle and re-render with a
      // notice (single operator, no per-account lockout — spec section 5). The
      // pending record was consumed by takePending, so re-issue a fresh authz
      // id for the retry and bind a new CSRF token to it.
      throttle.fail(now());
      onConsentToken('bad_token');
      const retryId = putPending({ ...rec });
      const rerendered = renderConsentPage({
        clientName: rec.clientName ?? rec.clientId,
        redirectHost: hostOf(rec.redirectUri),
        authzId: retryId,
        csrf: mintCsrf(store.getHmacKey(), retryId),
        needsToken: true,
        error: 'Incorrect operator token.',
        providers: registry.list().map((a) => ({ id: a.id, label: a.label })),
      });
      return sendHtml(res, 200, rerendered);
    }

    // Authenticated. A correct token paste mints/refreshes the presence cookie.
    const setCookie = tokenOk
      ? consentCookieHeader(signConsentCookie(store.getHmacKey(), now()))
      : undefined;
    if (tokenOk) throttle.success();

    // Deny → consume + redirect with access_denied.
    if (decision !== 'allow') {
      onConsentToken('deny');
      const loc = new URL(rec.redirectUri);
      loc.searchParams.set('error', 'access_denied');
      if (rec.state !== undefined) loc.searchParams.set('state', rec.state);
      if (setCookie) res.setHeader('Set-Cookie', setCookie);
      return redirect(res, loc.toString());
    }

    // Allow → mint single-use code bound to the authorization, then redirect.
    onConsentToken('allow');
    return completeAllowedAuthorization({ rec, sub: operatorPolicy.operatorSub(), res, setCookie });
  }

  // ---- POST /oauth/idp/<provider>/login ----------------------------------
  // The consent page's "Continue with <provider>" button posts the consent form
  // (authz_id + csrf) here. Re-check the consent trust boundary (Origin/Sec-Fetch
  // + CSRF), confirm the pending authorization is still live (PEEK, not consume —
  // the callback needs it), mint a single-use IdP-hop state bound to {authzId,
  // provider}, and 302 to the provider's authorize URL.
  async function handleIdpLogin(req, res, provider) {
    const originReject = verifyOrigin(req);
    if (originReject) return sendJson(res, 403, { error: 'access_denied', error_description: originReject });
    // No throttle here (unlike handleConsent): the login leg checks no
    // brute-forceable secret — auth happens at the provider. A caller without the
    // HMAC secret can't pass verifyCsrf below (cheap 403, no state minted), and
    // putIdpState is capped. The wrong-operator brute-force surface is the CALLBACK
    // leg, gated by a dedicated callbackThrottle (Task 2.9).
    if (!isFormContentType(req)) return sendJson(res, 400, { error: 'invalid_request', error_description: 'form-urlencoded only' });
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return sendJson(res, 400, { error: 'invalid_request', error_description: 'body too large' });
    const authzId = params.get('authz_id');
    const csrf = params.get('csrf');
    if (!authzId || !verifyCsrf(store.getHmacKey(), authzId, csrf)) {
      return sendJson(res, 403, { error: 'access_denied', error_description: 'bad csrf' });
    }
    const rec = peekPending(authzId);
    if (!rec) return sendJson(res, 403, { error: 'access_denied', error_description: 'no pending authorization' });
    const adapter = registry.get(provider); // registry is the provider allowlist: an unknown/injection-y provider → undefined → 404 here, BEFORE provider reaches putIdpState or the redirect URL
    if (!adapter) return sendJson(res, 404, { error: 'invalid_request', error_description: 'unknown provider' });
    const state = store.putIdpState({ authzId, provider });
    const redirectUri = `${base}/oauth/idp/${provider}/callback`;
    return redirect(res, adapter.buildAuthorizeUrl({ state, redirectUri }));
  }

  // ---- GET /oauth/idp/<provider>/callback --------------------------------
  // The provider redirects the browser here with ?code&state. The `state` is the
  // CSRF/replay defense (single-use, provider-bound, bound to the pending authz),
  // so there is NO Origin/CSRF form check on this top-level GET. We consume the
  // state, confirm the pending connector authz is still live, exchange the code
  // for the identity at the provider, verify it is THE operator, then complete the
  // original connector authorization with the canonical sub + a fresh presence
  // cookie. A dedicated callbackThrottle (separate from the consent token-paste
  // throttle) rate-limits wrong-operator floods without locking the paste path.
  async function handleIdpCallback(req, res, provider) {
    if (!callbackThrottle.admitted(now())) {
      return sendJson(res, 429, { error: 'slow_down' }, { 'Retry-After': String(callbackThrottle.retryAfterSec(now())) });
    }
    const q = new URL(req.url, base).searchParams;
    // Provider denial (user declined at the IdP): the provider redirects with
    // ?error and no code. Surface a clean access_denied instead of letting the
    // empty-code exchange fail as a misleading 502. (No state consumed — the flow
    // is already dead; the single-use state simply expires.)
    if (q.get('error')) {
      onIdpOutcome(provider, 'denied');
      return sendJson(res, 403, { error: 'access_denied', error_description: 'authorization was denied at the identity provider' });
    }
    const code = q.get('code') ?? '';
    const stateParam = q.get('state') ?? '';
    const idp = store.consumeIdpState(stateParam, provider); // single-use, provider-bound
    if (!idp) return sendJson(res, 400, { error: 'invalid_request', error_description: 'invalid or expired state' });
    const pending = peekPending(idp.authzId); // login PEEKED (didn't consume) — must still be live
    if (!pending) return sendJson(res, 400, { error: 'invalid_request', error_description: 'authorization expired' });
    const adapter = registry.get(provider); // registry = provider allowlist
    if (!adapter) return sendJson(res, 404, { error: 'invalid_request', error_description: 'unknown provider' });

    let identity;
    try {
      const redirectUri = `${base}/oauth/idp/${provider}/callback`;
      const { credentials } = await adapter.exchangeCode({ code, redirectUri });
      identity = await adapter.fetchIdentity({ credentials });
    } catch {
      // Never leak the provider error or any secret/token; the vendor login is retriable.
      onIdpOutcome(provider, 'error');
      return sendJson(res, 502, { error: 'temporarily_unavailable', error_description: 'identity provider error; please retry' });
    }

    if (!operatorPolicy.isOperator(provider, identity)) {
      callbackThrottle.fail(now());
      onIdpOutcome(provider, 'mismatch');
      return sendJson(res, 403, { error: 'access_denied', error_description: 'not the operator account' });
    }

    callbackThrottle.success();
    onIdpOutcome(provider, 'success');
    // Emit the unified consent counter for the idp method so ops can see the
    // full allow-mix (token vs idp) in a single metric.
    onConsent('allow', 'idp');
    // `pending` is intentionally NOT consumed here (peekPending is a pure read):
    // the token-paste consent path likewise leaves it live (takePending does not
    // delete a live record), so both paths behave identically. Re-completing the
    // same authz requires operator credentials (a fresh CSRF-bound login or a valid
    // operator token), so it is not an escalation in the single-operator model.
    const sub = operatorPolicy.subForIdentity(provider, identity);
    const setCookie = consentCookieHeader(signConsentCookie(store.getHmacKey(), now()));
    return completeAllowedAuthorization({ rec: pending, sub, res, setCookie });
  }

  // ---- POST /oauth/token --------------------------------------------------
  // Observability (spec §6 item 12): onTokenGrant(grantType, outcome) fires at
  // every terminal path. grantType ∈ {'authorization_code','refresh_token',
  // 'unknown'}; 'unknown' is used for the pre-parse guards (non-form body,
  // over-cap body) and the unsupported_grant_type path (the parsed grant_type is
  // attacker-controlled, so labelling it 'unknown' keeps cardinality bounded
  // rather than echoing arbitrary strings). outcome ∈ {'issued','invalid_grant',
  // 'reuse_blocked','invalid_client','invalid_request','unsupported'}. The inc
  // lives in the dispatcher (this module stays metrics-free).
  async function handleToken(req, res) {
    if (!isFormContentType(req)) {
      onTokenGrant('unknown', 'invalid_request');
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'form-urlencoded only' });
    }
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) {
      onTokenGrant('unknown', 'invalid_request');
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'body too large' });
    }

    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') return tokenAuthCode(res, params);
    if (grantType === 'refresh_token') return tokenRefresh(res, params);
    onTokenGrant('unknown', 'unsupported');
    return sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  function tokenResponse(res, issued, scope) {
    sendJson(res, 200, {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresInSec,
      ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {}),
      scope: scope.join(' '),
    });
  }

  function tokenAuthCode(res, params) {
    const code = params.get('code') ?? '';
    const rec = store.consumeCode(sha256hex(code)); // atomic single-use consume
    if (!rec) {
      onTokenGrant('authorization_code', 'invalid_grant');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code invalid or expired' });
    }
    if (params.get('client_id') !== rec.clientId) {
      onTokenGrant('authorization_code', 'invalid_grant');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' });
    }
    if (params.get('redirect_uri') !== rec.redirectUri) {
      onTokenGrant('authorization_code', 'invalid_grant');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    if (!verifyS256(params.get('code_verifier') ?? '', rec.codeChallenge)) {
      onTokenGrant('authorization_code', 'invalid_grant');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const resourceParam = params.get('resource');
    if (resourceParam !== null && resourceParam !== rec.resource) {
      // invalid_target is a request-parameter problem; folded into the bounded
      // 'invalid_request' outcome (invalid_target is not in the metric enum).
      onTokenGrant('authorization_code', 'invalid_request');
      return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource mismatch' });
    }
    const issued = store.issueTokens({
      sub: rec.sub, aud: rec.resource, scope: rec.scope, offlineAccess: rec.offlineAccess, clientId: rec.clientId,
    });
    onTokenGrant('authorization_code', 'issued');
    return tokenResponse(res, issued, rec.scope);
  }

  function tokenRefresh(res, params) {
    const plaintext = params.get('refresh_token') ?? '';
    const formClientId = params.get('client_id');
    // RFC 6749 §6: a public client's refresh token MUST be bound to it. Check
    // client_id BEFORE rotating — rotateRefresh consumes the token, so rotating
    // and only then rejecting a typo'd client_id would burn the caller's good
    // token. peekRefreshClientId is read-only; if it returns undefined (the
    // hash is unknown OR already rotated-away) we fall through to rotateRefresh
    // so the reuse tripwire still fires.
    const boundClientId = store.peekRefreshClientId(plaintext);
    if (boundClientId !== undefined && formClientId !== boundClientId) {
      // Wire error stays the non-oracle invalid_grant, but the metric records the
      // true cause (client-binding failure, RFC 6749 §6) as 'invalid_client'.
      onTokenGrant('refresh_token', 'invalid_client');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' });
    }
    const out = store.rotateRefresh(plaintext); // PLAINTEXT in; store hashes
    if (out.reuse || out.notFound) {
      // Reuse → family already revoked by the store; both collapse to one
      // non-oracle error shape on the wire (spec section 6 item 6). The metric
      // still distinguishes them: a reuse-tripwire trip is the security-relevant
      // signal ('reuse_blocked'); a plain unknown/expired token is 'invalid_grant'.
      onTokenGrant('refresh_token', out.reuse ? 'reuse_blocked' : 'invalid_grant');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token invalid' });
    }
    onTokenGrant('refresh_token', 'issued');
    return tokenResponse(res, out, out.scope ?? []);
  }

  // ---- POST /oauth/register (RFC 7591 DCR) -------------------------------
  // Public, own rate limit (applied by the dispatcher). Validates client
  // metadata, enforces the registration-time redirect allowlist (NOTHING is
  // stored on any rejection), caps the store at MAX_REGISTERED_CLIENTS (pruning
  // stale never-used DCR clients first), and on success persists a public
  // (token_endpoint_auth_method:'none') client with a umcl_ id. Metric outcomes
  // flow out through the injected onRegistration callback so this module stays
  // metrics-free like its siblings (the dispatcher owns the prom-client inc).
  async function handleRegister(req, res) {
    const reject = (outcome, error, error_description) => {
      onRegistration(outcome);
      return sendJson(res, 400, error_description ? { error, error_description } : { error });
    };

    const { value, tooLarge, invalid } = await readJson(req);
    // Body must be a JSON object. Non-JSON / over-cap / array / null → metadata error.
    if (tooLarge || invalid || typeof value !== 'object' || value === null || Array.isArray(value)) {
      return reject('rejected_metadata', 'invalid_client_metadata', 'body must be a JSON object');
    }

    // redirect_uris: required, non-empty, length-capped array; EVERY entry allowlisted.
    const redirectUris = value.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS
      || !redirectUris.every((u) => typeof u === 'string' && isAllowedRegistrationRedirect(u))) {
      return reject('rejected_redirect', 'invalid_redirect_uri', 'one or more redirect_uris are not permitted');
    }

    // token_endpoint_auth_method: absent or 'none' only (public clients).
    const authMethod = value.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== 'none') {
      return reject('rejected_metadata', 'invalid_client_metadata', 'only token_endpoint_auth_method "none" is supported');
    }

    // grant_types: optional; if present must subset ['authorization_code','refresh_token'].
    let grantTypes = ['authorization_code'];
    if (value.grant_types !== undefined) {
      if (!Array.isArray(value.grant_types) || value.grant_types.length === 0
        || !value.grant_types.every((g) => ALLOWED_GRANT_TYPES.has(g))) {
        return reject('rejected_metadata', 'invalid_client_metadata', 'unsupported grant_types');
      }
      grantTypes = value.grant_types;
    }

    // client_name: optional; TRUNCATE (display-only, HTML-escaped at render).
    const clientName = typeof value.client_name === 'string' && value.client_name.length > 0
      ? value.client_name.slice(0, MAX_CLIENT_NAME)
      : '(unnamed client)';

    // Registration cap: prune stale never-used DCR clients, then re-check.
    if (store.countClients() >= MAX_REGISTERED_CLIENTS) {
      store.prune();
      if (store.countClients() >= MAX_REGISTERED_CLIENTS) {
        return reject('rejected_limit', 'invalid_client_metadata', 'registration limit reached');
      }
    }

    const clientId = 'umcl_' + randomBytes(32).toString('base64url');
    const t = now();
    store.putClient({
      client_id: clientId, client_name: clientName, redirect_uris: redirectUris,
      grant_types: grantTypes, created: t, lastUsed: t, source: 'dcr',
    });
    onRegistration('accepted');
    return sendJson(res, 201, {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: 'none',
    });
  }

  // ---- POST /oauth/revoke (operator revocation, spec §4.3) ---------------
  // Loopback-only by routing (the endpoint-class oauthRevokePolicy row 404s this
  // path off-loopback or when OAuth is off; the dispatcher only reaches here for
  // a loopback caller), so there is NO per-request auth here — physical loopback
  // access IS the authentication. JSON body:
  //   {all: true}            → nuke the whole grant graph (tokens + codes).
  //   {client_id: 'umcl_x'}  → drop ONE client's registration + its tokens/codes.
  // Exactly one of the two must be present.
  //
  // This is an ENDPOINT, not a file-editing CLI, because the running process
  // owns the in-process state: the mutation lands on the LIVE store instance the
  // verifier reads (same object, by construction), so a revoked token stops
  // authenticating immediately. A CLI editing oauth-state.json out-of-band would
  // race the server's own atomic write-temp-rename and be clobbered (spec §4.3).
  async function handleRevoke(req, res) {
    const { value, tooLarge, invalid } = await readJson(req);
    if (tooLarge || invalid || typeof value !== 'object' || value === null || Array.isArray(value)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'body must be a JSON object' });
    }

    const wantsAll = value.all === true;
    const clientId = typeof value.client_id === 'string' ? value.client_id : undefined;
    // Exactly one selector — neither, both, or a non-literal `all` is ambiguous.
    if (wantsAll === (clientId !== undefined)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'specify exactly one of {all:true} or {client_id}' });
    }

    if (wantsAll) {
      const counts = store.revokeAll();
      return sendJson(res, 200, { revoked: 'all', counts });
    }

    // client_id path: 404 if the registration is unknown (no silent no-op — the
    // operator gets told the id did not match anything).
    if (!store.getClient(clientId)) {
      return sendJson(res, 404, { error: 'not_found' });
    }
    const counts = store.revokeClient(clientId);
    return sendJson(res, 200, { revoked: 'client', client_id: clientId, counts });
  }

  return { handleAuthorize, handleConsent, handleToken, handleRegister, handleRevoke, handleIdpLogin, handleIdpCallback };
}
