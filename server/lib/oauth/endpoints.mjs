// server/lib/oauth/endpoints.mjs
//
// The OAuth HTTP handlers — authorize (GET), consent (POST), token (POST) plus
// register/revoke stubs (Gap-3 OAuth spec sections 4.1, 4.2, 5, 6). These are
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
import { compareTokens } from '../auth.mjs';

const MAX_FORM_BYTES = 64 * 1024; // body-size cap shared by consent + token

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

export function createOAuthHandlers({ store, baseUrl, operatorToken, throttle, now = Date.now, pendingCap = 500 }) {
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

  // ---- GET /oauth/authorize ----------------------------------------------
  function handleAuthorize(req, res) {
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
    const client = clientId ? store.getClient(clientId) : undefined;
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
    const authzId = putPending({
      clientId, redirectUri, codeChallenge, resource, scope: granted, offlineAccess, state,
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
      clientName: client.client_name ?? clientId,
      redirectHost: hostOf(redirectUri),
      authzId,
      csrf: mintCsrf(store.getHmacKey(), authzId),
      needsToken: !hasCookie,
    });
    return sendHtml(res, 200, html);
  }

  // ---- POST /oauth/consent -----------------------------------------------
  async function handleConsent(req, res) {
    // Origin / Sec-Fetch-Site enforcement FIRST (spec section 5): a live cookie
    // must not let a cross-origin page auto-submit a consent.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== baseOrigin) {
      return sendJson(res, 403, { error: 'access_denied', error_description: 'cross-origin' });
    }
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string' && sfs !== 'same-origin' && sfs !== 'none') {
      return sendJson(res, 403, { error: 'access_denied', error_description: 'cross-site' });
    }
    if (!isFormContentType(req)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'form-urlencoded only' });
    }
    // Global throttle (IP-independent, spec section 6 item 9).
    if (!throttle.admitted(now())) {
      return sendJson(res, 429, { error: 'slow_down' }, { 'Retry-After': String(throttle.retryAfterSec(now())) });
    }

    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return sendJson(res, 400, { error: 'invalid_request', error_description: 'body too large' });

    const authzId = params.get('authz_id');
    const csrf = params.get('csrf');
    const operatorTokenForm = params.get('operator_token');
    const decision = params.get('decision');

    const rec = authzId ? takePending(authzId) : undefined;
    if (!rec) return sendJson(res, 403, { error: 'access_denied', error_description: 'no pending authorization' });
    if (!verifyCsrf(store.getHmacKey(), authzId, csrf)) {
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
      const retryId = putPending({ ...rec });
      const rerendered = renderConsentPage({
        clientName: store.getClient(rec.clientId)?.client_name ?? rec.clientId,
        redirectHost: hostOf(rec.redirectUri),
        authzId: retryId,
        csrf: mintCsrf(store.getHmacKey(), retryId),
        needsToken: true,
        error: 'Incorrect operator token.',
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
      const loc = new URL(rec.redirectUri);
      loc.searchParams.set('error', 'access_denied');
      if (rec.state !== undefined) loc.searchParams.set('state', rec.state);
      if (setCookie) res.setHeader('Set-Cookie', setCookie);
      return redirect(res, loc.toString());
    }

    // Allow → mint single-use code bound to the authorization, then redirect.
    const code = randomBytes(32).toString('base64url');
    store.putCode(sha256hex(code), {
      clientId: rec.clientId, redirectUri: rec.redirectUri, codeChallenge: rec.codeChallenge,
      resource: rec.resource, scope: rec.scope, offlineAccess: rec.offlineAccess,
      sub: 'owner', exp: now() + OAUTH_TTLS.codeMs,
    });
    const loc = new URL(rec.redirectUri);
    loc.searchParams.set('code', code);
    if (rec.state !== undefined) loc.searchParams.set('state', rec.state);
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    return redirect(res, loc.toString());
  }

  // ---- POST /oauth/token --------------------------------------------------
  async function handleToken(req, res) {
    if (!isFormContentType(req)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'form-urlencoded only' });
    }
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return sendJson(res, 400, { error: 'invalid_request', error_description: 'body too large' });

    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') return tokenAuthCode(res, params);
    if (grantType === 'refresh_token') return tokenRefresh(res, params);
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
    if (!rec) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code invalid or expired' });
    if (params.get('client_id') !== rec.clientId) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' });
    }
    if (params.get('redirect_uri') !== rec.redirectUri) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    if (!verifyS256(params.get('code_verifier') ?? '', rec.codeChallenge)) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const resourceParam = params.get('resource');
    if (resourceParam !== null && resourceParam !== rec.resource) {
      return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource mismatch' });
    }
    const issued = store.issueTokens({
      sub: 'owner', aud: rec.resource, scope: rec.scope, offlineAccess: rec.offlineAccess, clientId: rec.clientId,
    });
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
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' });
    }
    const out = store.rotateRefresh(plaintext); // PLAINTEXT in; store hashes
    if (out.reuse || out.notFound) {
      // Reuse → family already revoked by the store; both collapse to one
      // non-oracle error shape (spec section 6 item 6).
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token invalid' });
    }
    return tokenResponse(res, out, out.scope ?? []);
  }

  // ---- stubs (filled in later PRs) ---------------------------------------
  // PR 3 fills handleRegister (RFC 7591 DCR); PR 5 fills handleRevoke.
  function handleRegister(req, res) { return sendJson(res, 501, { error: 'temporarily_unavailable' }); }
  function handleRevoke(req, res) { return sendJson(res, 501, { error: 'temporarily_unavailable' }); }

  return { handleAuthorize, handleConsent, handleToken, handleRegister, handleRevoke };
}
