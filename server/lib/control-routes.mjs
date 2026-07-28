// server/lib/control-routes.mjs
//
// The `/control` operator page's ENTIRE authentication surface (Gap-171
// Stage B, plan U3; spec §3 + §6): three routes, one session cookie, one
// stateless double-submit CSRF pair, an Origin/Sec-Fetch trust boundary, a
// dedicated global unlock throttle, and the one choke point every HTML byte
// leaves through.
//
//   GET  /control          — valid session ⇒ the page; otherwise the unlock form.
//   POST /control/unlock   — the spec-§3 sequence, in order (see handleUnlock).
//   POST /control/logout   — Origin + CSRF protected session revocation.
//
// The kill switch (`UM_CONTROL_ENABLED`, default false ⇒ 404) is enforced at
// the endpoint-class row (lib/endpoint-class.mjs) and re-checked here, so this
// module is safe to dispatch to unconditionally.
//
// WHAT LIVES HERE AND WHY IT IS NOT REUSED FROM oauth/:
//   * The origin check is written here, not imported. `verifyOrigin`
//     (oauth/endpoints.mjs:310) is a closure inside `createOAuthHandlers` over
//     `baseOrigin` — it does not exist when OAuth is off, which is the expected
//     Stage-B deployment — AND it is LOOSER than this surface requires: it
//     ACCEPTS a request with neither `Origin` nor `Sec-Fetch-Site`, whereas
//     /control/unlock must DENY that (spec §3 step 4, R1 S-B3).
//   * The cookie read is an OCCURRENCE COUNTER, not `readCookie`
//     (oauth/endpoints.mjs:134-143), which returns the FIRST match and
//     structurally cannot see a shadowing duplicate (spec §3, R2-S-I5). ONE
//     tokenizer (`cookieOccurrences`) both reads and counts, so the value the
//     auth path trusts and the count the duplicate guard trusts can never be
//     produced by two divergent parsers (R3-S-N1).
//   * `isFormContentType` / `MAX_FORM_BYTES` / `readForm` ARE reused — lifted
//     into the shared ../http-form.mjs rather than re-implemented (R2-C-N3).
//   * `compareTokens` is the same hardened timing-safe comparator the bearer
//     path uses (lib/auth.mjs), and the session/CSRF primitives are U2's
//     lib/control-session.mjs.
//
// The authenticated branch renders a FIXED stub until U4 ships the real page
// (R1 I10 / R2-C-N7) — the routes and their auth are testable before the page
// module exists, and this module performs ZERO data reads on any path (A1).

import { randomBytes } from 'node:crypto';
import { compareTokens, FORWARDED_HEADERS } from './auth.mjs';
import {
  createSession, getSession, expire,
  controlSessionCookieHeader, mintControlCsrf, verifyControlCsrf,
} from './control-session.mjs';
import { createConsentThrottle } from './oauth/throttle.mjs';
import { MAX_FORM_BYTES, isFormContentType, readForm } from './http-form.mjs';
import { esc } from './escape-html.mjs';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';

export const CONTROL_SESSION_COOKIE = 'um_control';
export const CONTROL_CSRF_COOKIE = 'um_control_csrf';

// The CSRF cookie is deliberately NOT `Secure` (spec §3 step 5 / R2-S-I1): on a
// plain-HTTP non-loopback deployment a Secure CSRF cookie would be discarded
// BEFORE the unlock POST, so the POST would die at the CSRF step and never
// reach the 303 that fires the `u=1` cookie-rejection panel — the panel would
// be dead on the exact deployment it exists to explain. Its integrity rests on
// the Origin check, which is the airtight backstop. The SESSION cookie IS
// Secure (control-session.mjs).
function csrfCookieHeader(value) {
  return `${CONTROL_CSRF_COOKIE}=${value}; Path=/control; HttpOnly; SameSite=Strict`;
}

// Clearing the session cookie must repeat the flags it was set with, or the
// browser treats it as a different cookie and the clear silently no-ops.
const CLEARED_SESSION_COOKIE =
  `${CONTROL_SESSION_COOKIE}=; Max-Age=0; Path=/control; HttpOnly; Secure; SameSite=Strict`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Count how many times `name` appears in a raw `Cookie` header, and return the
 * FIRST occurrence's value (the one `readCookie` would have returned).
 *
 * Tokenizes IDENTICALLY to oauth/endpoints.mjs:readCookie — split on `;`, take
 * the substring before the FIRST `=`, trim it, exact-compare the name — so a
 * cookie VALUE containing `um_control=` cannot inflate the count and
 * `um_control_csrf` can never be miscounted as `um_control` (spec §3, R3-S-N1).
 *
 * @returns {{count: number, value: string|undefined}}
 */
export function cookieOccurrences(raw, name) {
  if (typeof raw !== 'string' || raw === '') return { count: 0, value: undefined };
  let count = 0;
  let value;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;                       // valueless segment — readCookie skips it too
    if (part.slice(0, eq).trim() !== name) continue;
    count += 1;
    if (count === 1) value = part.slice(eq + 1).trim();
  }
  return { count, value };
}

/**
 * Same-origin trust boundary for the two POSTs. Returns null when acceptable,
 * else a short reason string.
 *
 * DEFAULT-DENY when BOTH `Origin` and `Sec-Fetch-Site` are absent (spec §3
 * step 4) — stricter than the OAuth consent helper, which accepts that case.
 * Every browser that can reach this page sends at least one of them on a form
 * POST; their joint absence is a non-browser or a stripped-header proxy, and
 * this surface guards a master credential.
 *
 * Only the HOST is compared, never the scheme: behind Tailscale Serve (the
 * supported deployment) TLS is terminated at the proxy, so the browser's Origin
 * is `https://…` while this process sees plain HTTP — a scheme comparison would
 * reject every legitimate unlock. `X-Forwarded-Host` is accepted alongside
 * `Host` for the same reason; neither is forgeable by the browser-driven
 * cross-site POST this check exists to stop, and the double-submit CSRF token
 * is the independent second control.
 */
export function verifyControlOrigin(req) {
  const origin = req.headers?.origin;
  const sfs = req.headers?.['sec-fetch-site'];
  const hasOrigin = typeof origin === 'string' && origin !== '';
  const hasSfs = typeof sfs === 'string' && sfs !== '';
  if (!hasOrigin && !hasSfs) return 'no-origin-signal';
  if (hasSfs && sfs !== 'same-origin' && sfs !== 'none') return 'cross-site';
  if (hasOrigin && !originMatchesHost(origin, req)) return 'cross-origin';
  return null;
}

function originMatchesHost(origin, req) {
  let originHost;
  // `Origin: null` (sandboxed iframe, some redirect chains) and any malformed
  // value throw here and are therefore DENIED — never treated as "absent".
  try { originHost = new URL(origin).host; } catch { return false; }
  if (!originHost) return false;
  const candidates = [req.headers?.host, req.headers?.['x-forwarded-host']];
  return candidates.some((h) => typeof h === 'string' && h !== '' && h === originHost);
}

/**
 * The operator-recovery carve-out for the dedicated throttle (spec §3 step 6b):
 * a request from `127.0.0.1`/`::1` carrying NO forwarded header is never HARD
 * blocked, so a global throttle armed by a remote attacker cannot lock the
 * operator out of their own console.
 *
 * The SHAPE of shouldBypassLoopback (auth.mjs:55-63) — reusing FORWARDED_HEADERS
 * so the header list cannot drift — but NOT the function: that one is
 * additionally gated on `UM_ALLOW_LOOPBACK_NOAUTH`, an unrelated bearer-auth
 * knob whose value must not decide whether the operator has a recovery path.
 */
export function isTrustedLoopback(req) {
  const ip = req.socket?.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1') return false;
  for (const h of FORWARDED_HEADERS) {
    if (req.headers && req.headers[h] !== undefined) return false;
  }
  return true;
}

// A CSRF value is echoed back into the re-rendered form only when it has the
// shape this server mints (base64url, bounded). esc() already makes any value
// inert in a double-quoted attribute; this is the belt to that suspenders —
// nothing attacker-shaped is ever reflected, not even inertly.
const CSRF_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
function isCsrfShaped(v) { return typeof v === 'string' && CSRF_SHAPE.test(v); }

// ---------------------------------------------------------------------------
// The HTML emit choke point (spec §6 / A14)
// ---------------------------------------------------------------------------

// The operator page is not a CORS-shared resource. The entrypoint sets a
// blanket `Access-Control-Allow-Origin: *` (+ Methods/Headers) for the machine
// API before dispatch; strip them on every /control response so no cross-origin
// script can read this document at all. Applied to EVERY /control emit — HTML,
// 303 and 404 alike.
function dropCors(res) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Methods');
  res.removeHeader('Access-Control-Allow-Headers');
}

function cspFor(nonce) {
  return `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; ` +
    `script-src 'none'; base-uri 'none'; form-action 'self'; ` +
    `frame-ancestors 'none'; object-src 'none'`;
}

/**
 * THE single owner of every `/control` HTML response's security headers
 * (R2-S-I2: five HTML paths — unlock form, page, failure re-render, the `u=1`
 * panel, the duplicate-cookie rejection). A per-path header block is the shape
 * that leaks one uncovered response.
 *
 * The nonce is generated by the CALLER and passed in, because the caller has
 * already rendered `<style nonce=…>` with it — this function cannot mint one
 * after the fact (R3-C-N1).
 */
export function sendControlHtml(res, status, html, nonce) {
  dropCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', cspFor(nonce));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(html);
}

function newNonce() { return randomBytes(16).toString('base64'); }

// ---------------------------------------------------------------------------
// Templates — constants only. ZERO untrusted interpolation: the sole
// interpolated values are the server-generated nonce, the server-generated (or
// shape-validated) CSRF token, and a message picked from the enum below. Every
// one still passes through esc() into a fully double-quoted attribute or
// element text, per escape-html.mjs's sink allowlist. No <script>, no `style=`
// attribute, no off-origin reference (A11).
// ---------------------------------------------------------------------------

// Every unlock failure — whatever step rejected it — renders THIS text, so the
// response body distinguishes no step from any other and, in particular,
// wrong-token from no-token-configured (A3/A3b).
const GENERIC_ERROR = 'Unable to unlock. Check the token and try again.';
const COOKIE_REJECTED_NOTICE =
  'Your browser rejected the session cookie because this connection is neither HTTPS nor localhost. '
  + 'Reach this page over Tailscale Serve (HTTPS on your tailnet name) or a loopback tunnel, then unlock again.';
const DUPLICATE_COOKIE_NOTICE =
  'A duplicate control cookie was sent with this request, so it was ignored. '
  + 'Clear cookies for this host and unlock again.';

const STYLE = `
    body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
    .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 1.5rem; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    .notice { background: #fff8c5; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
    .error { background: #fde8e8; color: #9b1c1c; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
    label { display: block; margin: 1rem 0; }
    input[type=password] { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { padding: 0.6rem 1.2rem; border-radius: 6px; border: 1px solid #1c64f2; background: #1c64f2; color: #fff; cursor: pointer; }
    .muted { color: #656d76; font-size: 0.9rem; }`;

function shell({ nonce, title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style nonce="${esc(nonce)}">${STYLE}
  </style>
</head>
<body>
  <div class="card">
${body}
  </div>
</body>
</html>
`;
}

/**
 * The unlock form — also the failure re-render, the `u=1` cookie-rejection
 * panel and the duplicate-cookie rejection, which differ ONLY by the banner
 * above the form. One template, so a new failure path cannot accidentally get
 * a differently-shaped (or unheadered) response.
 */
function renderUnlockForm({ nonce, csrf, error = null, notice = null }) {
  const banner = error
    ? `    <div class="error">${esc(error)}</div>\n`
    : (notice ? `    <div class="notice">${esc(notice)}</div>\n` : '');
  return shell({
    nonce,
    title: 'universal-memory — control',
    body: `    <h1>universal-memory control</h1>
${banner}    <form method="post" action="/control/unlock">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label>Operator token
        <input type="password" name="operator_token" autocomplete="current-password" required>
      </label>
      <button type="submit">Unlock</button>
    </form>
    <p class="muted">Read-only operational telemetry. The token is never stored in the browser.</p>`,
  });
}

// The authenticated branch until U4 lands the real page (R1 I10). It still
// carries its own double-submit CSRF pair, because the logout POST is Origin +
// CSRF protected exactly like unlock (R2-S-N4).
function renderStubPage({ nonce, csrf }) {
  return shell({
    nonce,
    title: 'universal-memory — control',
    body: `    <h1>universal-memory control</h1>
    <p>Session unlocked. The dashboard lands in PR 3 — this build ships the authentication surface only.</p>
    <form method="post" action="/control/logout">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button type="submit">Sign out</button>
    </form>`,
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function controlEnabled(env = process.env) {
  return (env.UM_CONTROL_ENABLED ?? 'false') === 'true';
}

function sendNotFound(res) {
  dropCors(res);
  res.statusCode = 404;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Build the `/control` request handlers.
 *
 * The throttle is created ONCE per server instance (mirroring the per-handler
 * `oauthAdmit`/`admit` limiters in the entrypoint) and is GLOBAL by design, not
 * per-IP: there is exactly one credential to guess, and per-IP is meaningless
 * behind a proxy's single egress IP (spec §3 step 6 / R1 S-B2b).
 */
export function createControlHandlers({ throttle = createConsentThrottle(), now = Date.now } = {}) {
  // One "block generation" per armed block window: bumped on every fail(), and
  // NOT bumped by blocked attempts (a blocked attempt never calls fail()). The
  // throttled warn line fires at most once per generation, so a sustained
  // attack cannot flood warn (A19) while a genuinely new block window still
  // gets its line.
  let blockGeneration = 0;
  let lastThrottleWarnGeneration = -1;

  function noteFailure(t) {
    throttle.fail(t);
    blockGeneration += 1;
  }

  function logUnlock(outcome, { trusted, extra = {} }) {
    const emit = () => {
      const line = {
        request_id: currentRequestId(),
        endpoint: '/control/unlock',
        source: trusted ? 'loopback' : 'remote',
        outcome,
        ...extra,
      };
      // Metadata ONLY (R2-S-N3): never the submitted operator_token, never the
      // csrf value, never the configured master token.
      if (outcome === 'unlock_success') getLogger().info(line, 'control unlock');
      else getLogger().warn(line, 'control unlock');
    };
    safeLog(emit, `log:control:${outcome}`);
  }

  // ---- GET /control ------------------------------------------------------
  function handleGet(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');

    const raw = req.headers.cookie;
    const session = cookieOccurrences(raw, CONTROL_SESSION_COOKIE);
    const csrf = cookieOccurrences(raw, CONTROL_CSRF_COOKIE);

    // Duplicate/shadowed cookie ⇒ reject to the unlock form (spec §3, A22).
    // A shadow can forge neither a 256-bit session id nor a matching CSRF pair,
    // so this is DoS-only — but it must never be resolved by silently picking
    // one of the two.
    if (session.count > 1 || csrf.count > 1) {
      return renderFormWithFreshCsrf(res, 200, { notice: DUPLICATE_COOKIE_NOTICE });
    }

    // Session validation strictly precedes anything else (A1/S-I7). Nothing on
    // any branch below reads the corpus or the counters db — the U3 page is a
    // constant, and U4's data reads land INSIDE this authenticated branch.
    const live = session.value ? getSession(session.value, now()) : null;
    if (live) {
      const nonce = newNonce();
      const token = mintControlCsrf();
      res.setHeader('Set-Cookie', csrfCookieHeader(token));
      return sendControlHtml(res, 200, renderStubPage({ nonce, csrf: token }), nonce);
    }

    // `u=1` with no valid session = the browser silently discarded the Secure
    // session cookie (plain-HTTP non-loopback). Say so, instead of re-rendering
    // a bare form that is indistinguishable from a wrong token (spec §3 S-I2).
    if (url.searchParams.get('u') === '1') {
      return renderFormWithFreshCsrf(res, 200, { notice: COOKIE_REJECTED_NOTICE });
    }
    return renderFormWithFreshCsrf(res, 200, {});
  }

  // ---- POST /control/unlock ---------------------------------------------
  //
  // The spec-§3 sequence, IN ORDER. Ordering is the whole point of this
  // function: a comparator that runs before the origin/CSRF/throttle gates is
  // the defect class this surface exists to prevent.
  async function handleUnlock(req, res) {
    // 1. Kill switch — endpoint-class row (re-checked in `handle`).
    // 2. Method + content type.
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    if (!isFormContentType(req)) return renderFormWithFreshCsrf(res, 400, { error: GENERIC_ERROR });

    // 3. Body cap — the over-cap body is rejected BEFORE any field, and in
    //    particular before the token, is read.
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return renderFormWithFreshCsrf(res, 400, { error: GENERIC_ERROR });

    // 4. Origin / Sec-Fetch-Site (default-DENY when both are absent).
    if (verifyControlOrigin(req) !== null) {
      return renderFormWithFreshCsrf(res, 403, { error: GENERIC_ERROR });
    }

    // 5. Double-submit CSRF. The duplicate-cookie guard is part of this step:
    //    with two `um_control_csrf` cookies the pair is ambiguous, so the
    //    comparison must not be attempted at all.
    const raw = req.headers.cookie;
    const csrfCookie = cookieOccurrences(raw, CONTROL_CSRF_COOKIE);
    const sessionCookie = cookieOccurrences(raw, CONTROL_SESSION_COOKIE);
    if (csrfCookie.count > 1 || sessionCookie.count > 1) {
      return renderFormWithFreshCsrf(res, 403, { notice: DUPLICATE_COOKIE_NOTICE });
    }
    const csrfField = params.get('csrf');
    if (!verifyControlCsrf(csrfCookie.value, csrfField)) {
      return renderFormWithFreshCsrf(res, 403, { error: GENERIC_ERROR });
    }
    // From here the submitted pair is VERIFIED, so failure responses echo it
    // instead of minting a new one: the client's cookie is unchanged and still
    // valid, so the retry works without a Set-Cookie — which is what makes the
    // A3 ↔ A3b responses byte-identical down to the header set.
    const echoCsrf = isCsrfShaped(csrfField) ? csrfField : null;

    // 6. Dedicated GLOBAL throttle. A trusted-loopback request is never HARD
    //    blocked (operator recovery) but is still logged, and still counts a
    //    failure below.
    const t = now();
    const trusted = isTrustedLoopback(req);
    if (!throttle.admitted(t)) {
      if (lastThrottleWarnGeneration !== blockGeneration) {
        lastThrottleWarnGeneration = blockGeneration;
        logUnlock('unlock_throttled', { trusted, extra: { hard_blocked: !trusted } });
      }
      if (!trusted) {
        res.setHeader('Retry-After', String(throttle.retryAfterSec(t)));
        return renderForm(res, 429, { error: GENERIC_ERROR, echoCsrf });
      }
    }

    // 7. Token configured — BEFORE any compare, so "no token configured" is
    //    literally the same code path as "wrong token" from here on. It also
    //    counts a throttle failure, so the two are indistinguishable in the
    //    throttle's state as well as on the wire (A3b).
    const expected = process.env.UM_AUTH_TOKEN;
    if (!expected) {
      noteFailure(t);
      logUnlock('unlock_failed', { trusted });
      return renderForm(res, 401, { error: GENERIC_ERROR, echoCsrf });
    }

    // 8. Timing-safe compare — the same comparator the bearer path uses.
    if (!compareTokens(params.get('operator_token'), expected)) {
      noteFailure(t);
      logUnlock('unlock_failed', { trusted });
      return renderForm(res, 401, { error: GENERIC_ERROR, echoCsrf });
    }

    throttle.success();
    const { id } = createSession(t);
    logUnlock('unlock_success', { trusted });
    dropCors(res);
    res.statusCode = 303;
    // `?u=1` is the marker the GET branch reads to tell "the browser discarded
    // the Secure cookie" apart from "no session yet" (spec §3 S-I2).
    res.setHeader('Location', '/control?u=1');
    res.setHeader('Set-Cookie', controlSessionCookieHeader(id));
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  }

  // ---- POST /control/logout ---------------------------------------------
  // The revocation path the opaque-id session design exists to enable. Same
  // Origin + CSRF boundary as unlock: without it a cross-site page could
  // force-log-out the operator (R2-S-N4). Not throttled — it guesses nothing.
  async function handleLogout(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    if (!isFormContentType(req)) return renderFormWithFreshCsrf(res, 400, { error: GENERIC_ERROR });
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return renderFormWithFreshCsrf(res, 400, { error: GENERIC_ERROR });
    if (verifyControlOrigin(req) !== null) {
      return renderFormWithFreshCsrf(res, 403, { error: GENERIC_ERROR });
    }
    const raw = req.headers.cookie;
    const csrfCookie = cookieOccurrences(raw, CONTROL_CSRF_COOKIE);
    const sessionCookie = cookieOccurrences(raw, CONTROL_SESSION_COOKIE);
    if (csrfCookie.count > 1 || sessionCookie.count > 1) {
      return renderFormWithFreshCsrf(res, 403, { notice: DUPLICATE_COOKIE_NOTICE });
    }
    if (!verifyControlCsrf(csrfCookie.value, params.get('csrf'))) {
      return renderFormWithFreshCsrf(res, 403, { error: GENERIC_ERROR });
    }
    if (sessionCookie.value) expire(sessionCookie.value);
    dropCors(res);
    res.statusCode = 303;
    res.setHeader('Location', '/control');
    res.setHeader('Set-Cookie', CLEARED_SESSION_COOKIE);
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  }

  // ---- shared response helpers ------------------------------------------

  function sendMethodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    return renderFormWithFreshCsrf(res, 405, { error: GENERIC_ERROR });
  }

  // Render the form/panel. `echoCsrf` non-null ⇒ the caller already VERIFIED
  // that pair, so it is echoed and NO cookie is set; null ⇒ mint a fresh pair
  // and set the cookie, because the client has none that works.
  function renderForm(res, status, { error = null, notice = null, echoCsrf = null }) {
    const nonce = newNonce();
    let token = echoCsrf;
    if (token === null) {
      token = mintControlCsrf();
      res.setHeader('Set-Cookie', csrfCookieHeader(token));
    }
    return sendControlHtml(res, status, renderUnlockForm({ nonce, csrf: token, error, notice }), nonce);
  }

  function renderFormWithFreshCsrf(res, status, opts) {
    return renderForm(res, status, { ...opts, echoCsrf: null });
  }

  /**
   * Path+method dispatch for the whole surface. Returns a promise; the caller
   * (mem0-mcp-http.mjs) awaits it and returns.
   */
  async function handle(req, res, url) {
    // Defense in depth: the endpoint-class rows already 404 every /control path
    // when the flag is off, but this module must not be unlockable if a future
    // dispatch edit reaches it another way.
    if (!controlEnabled()) return sendNotFound(res);
    switch (url.pathname) {
      case '/control': return handleGet(req, res, url);
      case '/control/unlock': return handleUnlock(req, res);
      case '/control/logout': return handleLogout(req, res);
      default: return sendNotFound(res); // /control/ and unknown subpaths (row-level too)
    }
  }

  return { handle };
}
