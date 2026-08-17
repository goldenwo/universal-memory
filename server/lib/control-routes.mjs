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
//   * The cookie read is an OCCURRENCE COUNTER, because `readCookie` returns
//     the FIRST match and structurally cannot see a shadowing duplicate (spec
//     §3, R2-S-I5). Both are built on the SAME `cookiePairs` tokenizer in
//     ../http-form.mjs, so the value the auth path trusts and the count the
//     duplicate guard trusts cannot be produced by two divergent parsers
//     (R3-S-N1) — enforced by construction and by a differential test, not by
//     a comment claiming the two agree.
//   * `isFormContentType` / `MAX_FORM_BYTES` / `readForm` ARE reused — lifted
//     into the shared ../http-form.mjs rather than re-implemented (R2-C-N3).
//   * `compareTokens` is the same hardened timing-safe comparator the bearer
//     path uses (lib/auth.mjs), and the session/CSRF primitives are U2's
//     lib/control-session.mjs.
//
// The authenticated branch renders the REAL /control document (U4a/U4b's
// control-page.mjs, wired in by U5): buildStats() runs IN-PROCESS — no HTTP
// self-call, no loopback request — strictly AFTER the session check passes
// (spec §2 ordering / A1). Every OTHER path in this module (the unlock form,
// its failure re-renders, the u=1 panel, the duplicate-cookie rejection, the
// 405 notice) still performs ZERO data reads — buildStats() is called from
// exactly one call site, inside the `live` branch of handleGet.

import { randomBytes } from 'node:crypto';
import { compareTokens, FORWARDED_HEADERS } from './auth.mjs';
import {
  createSession, getSession, expire,
  controlSessionCookieHeader, mintControlCsrf, verifyControlCsrf,
} from './control-session.mjs';
import { createConsentThrottle } from './oauth/throttle.mjs';
import { isFormContentType, readForm, cookiePairs } from './http-form.mjs';
import { esc } from './escape-html.mjs';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';
import { buildStats } from './stats-payload.mjs';
import { renderControlPage } from './control-page.mjs';

const CONTROL_SESSION_COOKIE = 'um_control';
const CONTROL_CSRF_COOKIE = 'um_control_csrf';

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
 * FIRST occurrence's value — i.e. exactly what `readCookie` would have
 * returned, plus the multiplicity `readCookie` structurally cannot report.
 *
 * Shares `cookiePairs` (http-form.mjs) with `readCookie`, so the two cannot
 * tokenize differently (spec §3 R3-S-N1); a differential test over an
 * adversarial corpus pins the agreement.
 *
 * @returns {{count: number, value: string|undefined}}
 */
export function cookieOccurrences(raw, name) {
  let count = 0;
  let value;
  for (const [n, v] of cookiePairs(raw)) {
    if (n !== name) continue;
    count += 1;
    if (count === 1) value = v;
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
 * reject every legitimate unlock. The double-submit CSRF token is the
 * independent second control.
 *
 * The comparison target is the `Host` header ONLY. `X-Forwarded-Host` is
 * deliberately NOT consulted (spec §3 step 4): Tailscale Serve preserves `Host`,
 * so it buys nothing, while accepting it would let any client that can set an
 * arbitrary header nominate the host its own `Origin` is compared against —
 * turning the check into a self-signed assertion.
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
  const host = req.headers?.host;
  return typeof host === 'string' && host !== '' && host === originHost;
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
 *
 * All THREE shapes Node's remoteAddress reports are accepted, including the
 * IPv4-mapped-in-IPv6 form a dual-stack socket produces (see the isLoopbackIp
 * note in endpoint-class.mjs:32-34). shouldBypassLoopback covers only two;
 * inheriting that gap here would silently deny the operator their recovery
 * path on a dual-stack listener — a fail-CLOSED bug, invisible until the day
 * it matters.
 */
export function isTrustedLoopback(req) {
  const ip = req.socket?.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') return false;
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
 * (R2-S-I2). A per-path header block is the shape that leaks one uncovered
 * response, so the invariant is the choke point itself, not a count: EVERY
 * byte of HTML this surface emits leaves through here. Six shapes route
 * through it today — unlock form, page, failure re-render, the `u=1` panel,
 * the duplicate-cookie rejection, the 405 notice — and each is enumerated in
 * the A14 test, which is where a seventh must also be added.
 *
 * The nonce is generated by the CALLER and passed in, because the caller has
 * already rendered `<style nonce=…>` with it — this function cannot mint one
 * after the fact (R3-C-N1).
 */
function sendControlHtml(res, status, html, nonce) {
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
const METHOD_NOT_ALLOWED_NOTICE = 'That method is not allowed on this route.';

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
        <input type="password" name="operator_token" required>
      </label>
      <button type="submit">Unlock</button>
    </form>
    <p class="muted">Read-only operational telemetry. This page stores only an opaque session cookie — the token itself is not kept by this page.</p>`,
  });
}

/**
 * A form-LESS message page. Used only by the 405 branch, which must set no
 * cookie at all (F7/C3): with no CSRF pair to mint or reuse, rendering a form
 * whose hidden field matches nothing would be a broken affordance. A 405 is
 * never reached by a browser submitting this page's forms, so a link back to
 * `/control` — which mints the pair — is the honest response.
 */
function renderNotice({ nonce, message }) {
  return shell({
    nonce,
    title: 'universal-memory — control',
    body: `    <h1>universal-memory control</h1>
    <div class="error">${esc(message)}</div>
    <p><a href="/control">Back to unlock</a></p>`,
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

// 303 See Other with no body. `setCookie` is optional (the unlock mints a
// session, the logout clears one, the u=1 strip touches no cookie at all).
function sendRedirect(res, location, setCookie = null) {
  dropCors(res);
  res.statusCode = 303;
  res.setHeader('Location', location);
  if (setCookie) res.setHeader('Set-Cookie', setCookie);
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
  //
  // `requestCtx` carries the per-request data-source seam (U5): `memory`,
  // `userId`, `endpoint` and (test-only) `readCounters` — threaded in from
  // the caller (mem0-mcp-http.mjs's `control.handle(req, res, url, {...})`)
  // rather than bound at `createControlHandlers()` construction time, so a
  // test can vary them per server instance exactly like it already varies
  // `ctx.memory` via `createRequestHandler`.
  async function handleGet(req, res, url, requestCtx = {}) {
    // HEAD is served wherever GET is: it is the same resource with the body
    // suppressed by Node, so a monitor probing HEAD must not see a 405 that
    // GET would not give.
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD');

    const raw = req.headers.cookie;
    const session = cookieOccurrences(raw, CONTROL_SESSION_COOKIE);
    const csrf = cookieOccurrences(raw, CONTROL_CSRF_COOKIE);

    // Duplicate/shadowed cookie ⇒ reject to the unlock form (spec §3, A22).
    // A shadow can forge neither a 256-bit session id nor a matching CSRF pair,
    // so this is DoS-only — but it must never be resolved by silently picking
    // one of the two.
    if (session.count > 1 || csrf.count > 1) {
      return renderForm(req, res, 200, { notice: DUPLICATE_COOKIE_NOTICE });
    }

    // Session validation strictly precedes anything else (A1/S-I7). Nothing
    // above this point reads the corpus or the counters db — buildStats() is
    // called ONLY inside the `live` branch just below, never on the way here.
    const live = session.value ? getSession(session.value, now()) : null;
    if (live) {
      // `u=1` is a ONE-SHOT post-unlock marker, not a page mode: strip it as
      // soon as a session proves the cookie was accepted. Otherwise the URL the
      // operator bookmarks (or reloads) still carries it, and when that session
      // later expires normally the reload would render the "your browser
      // rejected the cookie" panel — a false diagnosis of a healthy deployment.
      if (url.searchParams.get('u') === '1') return sendRedirect(res, '/control');
      // U5 / A1: the ONLY data reads this module ever performs, and they run
      // strictly AFTER the session check above. `endpoint` defaults to
      // '/control' so a direct unit call (no requestCtx) still labels the
      // in-process build correctly rather than inheriting '/api/stats'.
      const {
        memory, userId, endpoint = '/control', readCounters, listAll,
      } = requestCtx;
      const nonce = newNonce();
      const token = ensureCsrf(req, res);
      const stats = await buildStats({
        now: now(), memory, userId, endpoint, readCounters, listAll,
      });
      return sendControlHtml(res, 200, renderControlPage({ stats, nonce, csrf: token }), nonce);
    }

    // `u=1` with no valid session = the browser silently discarded the Secure
    // session cookie (plain-HTTP non-loopback). Say so, instead of re-rendering
    // a bare form that is indistinguishable from a wrong token (spec §3 S-I2).
    // Reachable ONLY straight off the unlock 303, thanks to the strip above.
    if (url.searchParams.get('u') === '1') {
      return renderForm(req, res, 200, { notice: COOKIE_REJECTED_NOTICE });
    }
    return renderForm(req, res, 200, {});
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
    if (!isFormContentType(req)) return renderForm(req, res, 400, { error: GENERIC_ERROR });

    // 3. Body cap — the over-cap body is rejected BEFORE any field, and in
    //    particular before the token, is read.
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return renderForm(req, res, 400, { error: GENERIC_ERROR });

    // 4. Origin / Sec-Fetch-Site (default-DENY when both are absent).
    if (verifyControlOrigin(req) !== null) {
      return renderForm(req, res, 403, { error: GENERIC_ERROR });
    }

    // 5. Double-submit CSRF. The duplicate-cookie guard is part of this step:
    //    with two `um_control_csrf` cookies the pair is ambiguous, so the
    //    comparison must not be attempted at all.
    const raw = req.headers.cookie;
    const csrfCookie = cookieOccurrences(raw, CONTROL_CSRF_COOKIE);
    const sessionCookie = cookieOccurrences(raw, CONTROL_SESSION_COOKIE);
    if (csrfCookie.count > 1 || sessionCookie.count > 1) {
      return renderForm(req, res, 403, { notice: DUPLICATE_COOKIE_NOTICE });
    }
    if (!verifyControlCsrf(csrfCookie.value, params.get('csrf'))) {
      return renderForm(req, res, 403, { error: GENERIC_ERROR });
    }
    // From here the submitted pair is VERIFIED — so `ensureCsrf` inside every
    // failure re-render below finds a usable cookie, reuses it, and sets NO
    // cookie. That is what makes the A3 ↔ A3b responses byte-identical down to
    // the header set while still handing back a form that retries correctly.

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
        return renderForm(req, res, 429, { error: GENERIC_ERROR });
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
      return renderForm(req, res, 401, { error: GENERIC_ERROR });
    }

    // 8. Timing-safe compare — the same comparator the bearer path uses.
    if (!compareTokens(params.get('operator_token'), expected)) {
      noteFailure(t);
      logUnlock('unlock_failed', { trusted });
      return renderForm(req, res, 401, { error: GENERIC_ERROR });
    }

    throttle.success();
    const { id } = createSession(t);
    logUnlock('unlock_success', { trusted });
    // `?u=1` is the ONE-SHOT marker the GET branch reads to tell "the browser
    // discarded the Secure cookie" apart from "no session yet" (spec §3 S-I2);
    // the authenticated branch strips it immediately.
    return sendRedirect(res, '/control?u=1', controlSessionCookieHeader(id));
  }

  // ---- POST /control/logout ---------------------------------------------
  // The revocation path the opaque-id session design exists to enable. Same
  // Origin + CSRF boundary as unlock: without it a cross-site page could
  // force-log-out the operator (R2-S-N4). Not throttled — it guesses nothing.
  async function handleLogout(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
    if (!isFormContentType(req)) return renderForm(req, res, 400, { error: GENERIC_ERROR });
    const { params, tooLarge } = await readForm(req);
    if (tooLarge) return renderForm(req, res, 400, { error: GENERIC_ERROR });
    if (verifyControlOrigin(req) !== null) {
      return renderForm(req, res, 403, { error: GENERIC_ERROR });
    }
    const raw = req.headers.cookie;
    const csrfCookie = cookieOccurrences(raw, CONTROL_CSRF_COOKIE);
    const sessionCookie = cookieOccurrences(raw, CONTROL_SESSION_COOKIE);
    if (csrfCookie.count > 1 || sessionCookie.count > 1) {
      return renderForm(req, res, 403, { notice: DUPLICATE_COOKIE_NOTICE });
    }
    if (!verifyControlCsrf(csrfCookie.value, params.get('csrf'))) {
      return renderForm(req, res, 403, { error: GENERIC_ERROR });
    }
    if (sessionCookie.value) expire(sessionCookie.value);
    return sendRedirect(res, '/control', CLEARED_SESSION_COOKIE);
  }

  // ---- shared response helpers ------------------------------------------

  // 405 sets NO cookie (F7/C3) — a wrong-method request is never a browser
  // following this page's forms, so it gets a form-less notice instead of an
  // affordance that would need a CSRF pair minted for it.
  function sendMethodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    const nonce = newNonce();
    return sendControlHtml(res, 405, renderNotice({ nonce, message: METHOD_NOT_ALLOWED_NOTICE }), nonce);
  }

  /**
   * MINT-IF-ABSENT, never rotate-per-render (spec §3 step 5): a usable
   * `um_control_csrf` cookie is REUSED and no `Set-Cookie` is emitted; only a
   * missing, duplicated or malformed one is replaced.
   *
   * Rotating on every render is the shape that breaks a second tab and races a
   * concurrent reload — the newest render's cookie invalidates the pair the
   * older tab is still holding — and it is what would otherwise put a
   * `Set-Cookie` on the A3 failure re-render.
   */
  function ensureCsrf(req, res) {
    const existing = cookieOccurrences(req.headers?.cookie, CONTROL_CSRF_COOKIE);
    if (existing.count === 1 && isCsrfShaped(existing.value)) return existing.value;
    const token = mintControlCsrf();
    res.setHeader('Set-Cookie', csrfCookieHeader(token));
    return token;
  }

  function renderForm(req, res, status, { error = null, notice = null }) {
    const nonce = newNonce();
    const token = ensureCsrf(req, res);
    return sendControlHtml(res, status, renderUnlockForm({ nonce, csrf: token, error, notice }), nonce);
  }

  /**
   * Path+method dispatch for the whole surface. Returns a promise; the caller
   * (mem0-mcp-http.mjs) awaits it and returns.
   *
   * `requestCtx` (U5) is forwarded ONLY to the GET branch — it is the
   * `{ memory, userId, endpoint, readCounters }` seam buildStats() needs, and
   * the unlock/logout POSTs never read those sources at all.
   */
  async function handle(req, res, url, requestCtx = {}) {
    // Defense in depth: the endpoint-class rows already 404 every /control path
    // when the flag is off, but this module must not be unlockable if a future
    // dispatch edit reaches it another way.
    if (!controlEnabled()) return sendNotFound(res);
    switch (url.pathname) {
      case '/control': return handleGet(req, res, url, requestCtx);
      case '/control/unlock': return handleUnlock(req, res);
      case '/control/logout': return handleLogout(req, res);
      default: return sendNotFound(res); // /control/ and unknown subpaths (row-level too)
    }
  }

  return { handle };
}
