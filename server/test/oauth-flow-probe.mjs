#!/usr/bin/env node
//
// oauth-flow-probe.mjs — Gap-3 OAuth PR-5 (plan Task 5.2): a LIVE end-to-end
// OAuth smoke probe. UNLIKE oauth-integration.test.mjs (which mounts the OAuth
// modules in-process via createRequestHandler), this is a standalone node
// script that drives the FULL flow over the wire against an ALREADY-RUNNING
// server — proving the discovery surface, the authorize/consent/token grant,
// PKCE S256, refresh rotation, and the reuse tripwire all line up end-to-end on
// a real boot. It is the OAuth analogue of the S2-S6 smoke probes in smoke.sh.
//
// It is intentionally NOT a node:test file (named *-probe.mjs, not *.test.mjs)
// so the `node --test test/*.test.mjs` suite glob never picks it up — it needs
// a live server, which the in-process suite does not provide. smoke.sh runs it
// behind UM_SMOKE_OAUTH=1 against the live stack.
//
// Env:
//   UM_PROBE_BASE_URL  base of the running server (default http://localhost:6335)
//   UM_AUTH_TOKEN      operator token pasted at the consent step (REQUIRED)
//
// Output contract: each step prints `[oauth-probe] step N <name> OK` on success;
// any failure throws → a `[oauth-probe] FAIL step N: <reason>` line on stderr and
// a nonzero exit. Exit 0 ONLY if all 8 steps pass.
//
// Stdlib only (node:http / node:https / node:crypto) — no deps, mirroring the
// zero-dependency discipline of the rest of server/test.
//
// CRITICAL TRAP (carried verbatim from oauth-integration.test.mjs's header):
// the server BYPASSES auth for a loopback request that carries NO forwarded
// header (shouldBypassLoopback — mem0-mcp-http.mjs step 4). The probe runs from
// localhost, so the /mcp call MUST send `X-Forwarded-For: 1.2.3.4` — otherwise
// the request takes the loopback bypass, never runs the OAuth verifier, and the
// probe proves nothing (a bare-loopback 200 would "pass" even with a garbage
// token). The forwarded header is applied ONLY to the /mcp request (step 6),
// where the bearer-auth gate lives: the discovery, register, authorize, consent
// and token endpoints are NOT protected by that gate (discovery is bypassAuth
// via the endpoint-class row; the /oauth/* dispatch carries its OWN validation —
// PKCE, operator-token + CSRF + global consent throttle), so they function
// identically over loopback. Sending the forwarded header on THOSE would only
// subject them to the per-IP rate limiter for no benefit; leaving it off lets
// them take the loopback rate-limit bypass and keeps a single clean run well
// inside any budget. The consent throttle (the real anti-guessing control) is
// IP-independent and still applies regardless.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.env.UM_PROBE_BASE_URL || 'http://localhost:6335').replace(/\/+$/, '');
const OPERATOR = process.env.UM_AUTH_TOKEN || '';

// X-Forwarded-For defeats shouldBypassLoopback so the OAuth verifier actually
// runs on /mcp (see the header trap above). Applied ONLY to the /mcp request.
const FWD = { 'X-Forwarded-For': '1.2.3.4' };

// A loopback redirect_uri — RFC 8252, on the registration allowlist
// (isAllowedRegistrationRedirect → isLoopbackRedirect). One literal string,
// reused verbatim at register/authorize/token: redirectMatches is port-agnostic
// for loopback but compares pathname+search exactly, so reusing the same string
// sidesteps any mismatch. 127.0.0.1 (not localhost) keeps it unambiguous.
const REDIRECT = 'http://127.0.0.1:8765/cb';

// ---- PKCE pair (identical construction to oauth-integration.test.mjs) -------
function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

// Pull authz_id + csrf out of the rendered consent page (same regex as the
// integration test's parseConsentForm).
function parseConsentForm(html) {
  const authzId = html.match(/name="authz_id" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  return { authzId, csrf };
}

// ---- minimal stdlib HTTP client --------------------------------------------
// Resolves { status, headers, body }. Never throws on non-2xx — callers assert
// on status. redirect:'manual' semantics by default (we never auto-follow; the
// consent 303 Location is parsed by hand, mirroring the integration test).
function httpReq(method, fullUrl, { headers = {}, body = null } = {}) {
  const u = new URL(fullUrl);
  const isHttps = u.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: { ...headers },
  };
  if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const r = requestFn(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

// NB: these helpers do NOT send the X-Forwarded-For trap header — the OAuth
// endpoints they hit are not behind the bearer-auth/loopback gate (see the
// header-trap note at the top). Only the step-6 /mcp call adds FWD, inline.
const getJson = async (path, headers = {}) => {
  const res = await httpReq('GET', `${BASE}${path}`, { headers });
  let json;
  try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { ...res, json };
};

const postForm = async (path, fields, headers = {}) => {
  const body = new URLSearchParams(fields).toString();
  const res = await httpReq('POST', `${BASE}${path}`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
  let json;
  try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { ...res, json };
};

const postJson = async (path, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  const res = await httpReq('POST', `${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  let json;
  try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { ...res, json };
};

// ---- assertion helper: throws a step-tagged failure ------------------------
function check(stepNo, cond, reason) {
  if (!cond) throw new Error(`[oauth-probe] FAIL step ${stepNo}: ${reason}`);
}

function ok(stepNo, name) {
  console.log(`[oauth-probe] step ${stepNo} ${name} OK`);
}

// --------------------------------------------------------------------------
async function main() {
  console.log(`[oauth-probe] target: ${BASE}`);
  if (!OPERATOR) {
    throw new Error('[oauth-probe] FAIL step 0: UM_AUTH_TOKEN (operator token for consent) is not set');
  }

  // ---- Step 1: discovery — the 3 well-knowns + RFC 9728/8414 MUST fields ---
  {
    const pr = await getJson('/.well-known/oauth-protected-resource');
    check(1, pr.status === 200, `protected-resource discovery returned ${pr.status} (expected 200; is UM_OAUTH_ENABLED=true?)`);
    check(1, pr.json?.resource === `${BASE}/mcp`, `protected-resource.resource must be ${BASE}/mcp, got ${pr.json?.resource}`);
    check(1, Array.isArray(pr.json?.authorization_servers) && pr.json.authorization_servers.includes(BASE),
      `protected-resource.authorization_servers must include ${BASE}, got ${JSON.stringify(pr.json?.authorization_servers)}`);

    // The /mcp-suffixed variant (the WWW-Authenticate resource_metadata target) must also resolve.
    const prMcp = await getJson('/.well-known/oauth-protected-resource/mcp');
    check(1, prMcp.status === 200, `protected-resource/mcp discovery returned ${prMcp.status} (expected 200)`);

    const as = await getJson('/.well-known/oauth-authorization-server');
    check(1, as.status === 200, `authorization-server discovery returned ${as.status} (expected 200)`);
    check(1, as.json?.issuer === BASE, `issuer must === base (${BASE}), got ${as.json?.issuer}`);
    check(1, Array.isArray(as.json?.code_challenge_methods_supported) && as.json.code_challenge_methods_supported.includes('S256'),
      `code_challenge_methods_supported must include S256, got ${JSON.stringify(as.json?.code_challenge_methods_supported)}`);
    check(1, typeof as.json?.registration_endpoint === 'string' && as.json.registration_endpoint.length > 0,
      'registration_endpoint must be present (DCR support)');
    check(1, as.json?.client_id_metadata_document_supported === true,
      'client_id_metadata_document_supported must be true (CIMD / ChatGPT path)');
  }
  ok(1, 'discovery');

  // ---- Step 2: DCR — register a public client with a loopback redirect_uri --
  let clientId;
  {
    const reg = await postJson('/oauth/register', {
      redirect_uris: [REDIRECT],
      client_name: 'oauth-flow-probe',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    check(2, reg.status === 201, `DCR /oauth/register returned ${reg.status} (expected 201); body=${reg.body.slice(0, 200)}`);
    clientId = reg.json?.client_id;
    check(2, typeof clientId === 'string' && clientId.startsWith('umcl_'),
      `DCR must mint a umcl_ client_id, got ${clientId}`);
  }
  ok(2, 'dcr-register');

  // ---- Step 3: authorize — render the consent page, parse authz_id + csrf ---
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(8).toString('hex');
  let authzId, csrf;
  {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'vault offline_access',
      state,
    }).toString();
    // Browser-navigation shape: Accept text/html + Sec-Fetch-Mode: navigate, so
    // the server renders the HTML consent page (carrying authz_id + csrf) rather
    // than the programmatic JSON {consent_url} path (wantsJsonDelivery). This is
    // exactly what a real operator's browser sends; the integration test uses a
    // raw http GET for the same reason (undici forces sec-fetch-mode:cors).
    const authz = await getJson(`/oauth/authorize?${q}`, {
      Accept: 'text/html',
      'Sec-Fetch-Mode': 'navigate',
    });
    check(3, authz.status === 200, `authorize should render consent HTML (200), got ${authz.status}; body=${authz.body.slice(0, 200)}`);
    ({ authzId, csrf } = parseConsentForm(authz.body));
    check(3, !!authzId && !!csrf, 'consent page must carry authz_id + csrf hidden fields');
  }
  ok(3, 'authorize');

  // ---- Step 4: consent — operator-token allow → 303 with ?code= ------------
  let code;
  {
    const consent = await postForm('/oauth/consent', {
      authz_id: authzId,
      csrf,
      operator_token: OPERATOR,
      decision: 'allow',
    }, {
      // Same-origin Origin so the cross-origin/cross-site guard admits the POST.
      Origin: BASE,
    });
    check(4, consent.status === 303,
      `consent allow should 303-redirect, got ${consent.status}; body=${consent.body.slice(0, 200)} (wrong UM_AUTH_TOKEN ⇒ a 200 re-render with "Incorrect operator token")`);
    const loc = consent.headers['location'];
    check(4, typeof loc === 'string' && loc.length > 0, 'consent 303 must carry a Location header');
    code = new URL(loc).searchParams.get('code');
    check(4, !!code, `redirect Location must carry the authorization code, got Location=${loc}`);
  }
  ok(4, 'consent');

  // ---- Step 5: token — authorization_code + PKCE verifier → umat_/umrt_ -----
  let accessToken, refreshToken;
  {
    const tok = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    check(5, tok.status === 200, `token exchange returned ${tok.status} (expected 200); body=${tok.body.slice(0, 200)}`);
    accessToken = tok.json?.access_token;
    refreshToken = tok.json?.refresh_token;
    check(5, typeof accessToken === 'string' && accessToken.startsWith('umat_'),
      `should mint a umat_ access token, got ${accessToken}`);
    check(5, typeof refreshToken === 'string' && refreshToken.startsWith('umrt_'),
      `should mint a umrt_ refresh token (offline_access negotiated), got ${refreshToken}`);
  }
  ok(5, 'token');

  // ---- Step 6: authenticated /mcp tools/list with the access token ---------
  // Asserts the OAuth token ACTUALLY authenticated — i.e. NOT a 401. The probe
  // deliberately asserts "status !== 401 and the body is not an auth-error
  // envelope" rather than "status === 200 with a tools array": tools/list is a
  // static getVisibleTools() with no mem0 dependency, so against a healthy stack
  // it returns 200 + tools — but the assertion is intentionally robust to a
  // mem0/Qdrant-less local boot. The point of this step is to prove the bearer
  // crossed the auth gate (step 4 of the request pipeline) and was NOT silently
  // accepted by the loopback bypass (which the X-Forwarded-For header defeats):
  // any non-401, non-auth-error outcome proves authentication succeeded. A 401
  // here means the OAuth token did NOT authenticate (or the loopback trap leaked
  // and a real auth failure was masked).
  {
    const res = await httpReq('POST', `${BASE}/mcp`, {
      headers: {
        ...FWD,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check(6, res.status !== 401,
      `authenticated /mcp tools/list returned 401 — the OAuth access token did NOT authenticate (or the X-Forwarded-For loopback-bypass trap leaked); body=${res.body.slice(0, 200)}`);
    // Defense-in-depth: even a non-401 must not be an AUTH_INVALID envelope.
    let body;
    try { body = JSON.parse(res.body); } catch { body = undefined; }
    const authErr = body?.error?.code === 'AUTH_INVALID'
      || body?.error?.data?._meta?.['mcp/www_authenticate']?.error === 'invalid_token';
    check(6, !authErr,
      `authenticated /mcp returned an auth-error envelope despite a non-401 status — token did not authenticate; body=${res.body.slice(0, 200)}`);
    // Informational: note whether real mem0 answered (200 + tools) or the call
    // returned a non-auth error (mem0 infra absent locally — STILL proves auth).
    if (res.status === 200 && Array.isArray(body?.result?.tools)) {
      console.log(`[oauth-probe]     step 6: /mcp tools/list returned ${body.result.tools.length} tools (real MCP result)`);
    } else {
      console.log(`[oauth-probe]     step 6: /mcp authenticated (status ${res.status}, non-auth) — token crossed the auth gate; mem0 result not asserted`);
    }
  }
  ok(6, 'mcp-authenticated');

  // ---- Step 7: refresh — rotate the refresh token → NEW access+refresh ------
  let newAccess, newRefresh;
  {
    const ref = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    check(7, ref.status === 200, `refresh exchange returned ${ref.status} (expected 200); body=${ref.body.slice(0, 200)}`);
    newAccess = ref.json?.access_token;
    newRefresh = ref.json?.refresh_token;
    check(7, typeof newAccess === 'string' && newAccess.startsWith('umat_') && newAccess !== accessToken,
      'refresh must mint a NEW umat_ access token (distinct from the original)');
    check(7, typeof newRefresh === 'string' && newRefresh.startsWith('umrt_') && newRefresh !== refreshToken,
      'refresh must ROTATE the refresh token (new umrt_, distinct from the original)');
  }
  ok(7, 'refresh-rotate');

  // ---- Step 8: reuse tripwire — replaying the OLD refresh token → 400 -------
  // The rotated-away (old) refresh token must now be rejected with invalid_grant.
  // Per RFC 6749 §6 + spec §6 item 6 the store ALSO revokes the whole family on a
  // reuse trip; here we only assert the non-oracle wire shape (400 invalid_grant).
  {
    const reuse = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken, // the ORIGINAL, already rotated by step 7
      client_id: clientId,
    });
    check(8, reuse.status === 400,
      `reused (rotated) refresh token must be rejected with 400, got ${reuse.status}; body=${reuse.body.slice(0, 200)}`);
    check(8, reuse.json?.error === 'invalid_grant',
      `reuse must return error=invalid_grant, got ${JSON.stringify(reuse.json)}`);
  }
  ok(8, 'reuse-tripwire');

  console.log('[oauth-probe] PASS: all 8 steps OK');
}

main().then(
  () => process.exit(0),
  (err) => {
    // The thrown Error message is already step-tagged ([oauth-probe] FAIL step N: …).
    console.error(err?.message ?? String(err));
    process.exit(1);
  },
);
