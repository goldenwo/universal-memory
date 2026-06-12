// server/lib/oauth/consent.mjs
//
// The human-facing trust boundary of the embedded OAuth flow (Gap-3 OAuth spec
// section 5): the consent cookie, the per-authorization CSRF token, and the
// consent page itself. Three security properties pinned here were CRITICAL
// findings in the spec review:
//
//   * The consent cookie is PURPOSE-BOUND. Its MAC covers a payload whose
//     first segment is the literal `consent`; a value valid for any other
//     purpose (even signed with the right hmacKey) is rejected. This stops a
//     cookie minted elsewhere in the AS from standing in as proof of consent.
//   * The cookie expires (15min, OAUTH_TTLS.cookieMs) and carries a random
//     nonce so two consents are never byte-identical.
//   * The CSRF token is bound to ONE pending authorization id. authzId pins
//     client_id + redirect_uri + code_challenge in the pending record, so a
//     token minted for one authorization cannot drive consent for another.
//     Single-use is enforced upstream by the pending record being consumed;
//     this module only guarantees the binding.
//
// All MAC comparisons are timing-safe (crypto.timingSafeEqual on equal-length
// buffers, with a required length pre-check — timingSafeEqual throws on a
// length mismatch, and the length here is a public constant, not a secret).
//
// renderConsentPage routes EVERY interpolation through esc(): clientName is
// attacker-controlled (it arrives via DCR / CIMD client registration), so a
// `<script>` name must render inert. The page also displays redirectHost
// prominently — a spec-mandated mitigation against a CIMD client impersonating
// a localhost redirect.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAUTH_TTLS } from './state-store.mjs';

const COOKIE_NAME = 'um_consent';
const COOKIE_PURPOSE = 'consent';

function hmacB64url(hmacKeyHex, message) {
  return createHmac('sha256', Buffer.from(hmacKeyHex, 'hex')).update(message).digest('base64url');
}

// Constant-time equality of two base64url MAC strings. The length pre-check is
// required (timingSafeEqual throws on unequal lengths) and leaks nothing —
// MAC length is a fixed public constant, never secret-dependent.
function macEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- purpose-bound consent cookie ----------------------------------------

export function signConsentCookie(hmacKeyHex, now = Date.now()) {
  const exp = now + OAUTH_TTLS.cookieMs;
  const nonce = randomBytes(16).toString('hex');
  const payload = `${COOKIE_PURPOSE}.${exp}.${nonce}`;
  const mac = hmacB64url(hmacKeyHex, payload);
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

export function verifyConsentCookie(hmacKeyHex, value, now = Date.now()) {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return false; // exactly one separator
  const payloadB64 = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!payloadB64 || !mac) return false;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  // Recompute the MAC over the decoded payload and compare timing-safely BEFORE
  // trusting any field. A tampered payload or a wrong key fails right here.
  if (!macEqual(mac, hmacB64url(hmacKeyHex, payload))) return false;

  const parts = payload.split('.');
  if (parts.length !== 3) return false;
  const [purpose, expStr] = parts;
  if (purpose !== COOKIE_PURPOSE) return false; // purpose binding
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false; // expiry
  return true;
}

export function consentCookieHeader(value) {
  const maxAge = OAUTH_TTLS.cookieMs / 1000;
  return `${COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=/oauth; HttpOnly; Secure; SameSite=Strict`;
}

// ---- per-authorization CSRF token ----------------------------------------

export function mintCsrf(hmacKeyHex, authzId) {
  return hmacB64url(hmacKeyHex, `csrf.${authzId}`);
}

export function verifyCsrf(hmacKeyHex, authzId, token) {
  if (typeof token !== 'string') return false;
  return macEqual(token, mintCsrf(hmacKeyHex, authzId));
}

// ---- consent page --------------------------------------------------------

// HTML-entity escape for ALL interpolated, attacker-influenced text. & first.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderConsentPage({ clientName, redirectHost, authzId, csrf, needsToken, error }) {
  const errorBlock = error
    ? `<div class="error">${esc(error)}</div>`
    : '';
  const tokenField = needsToken
    ? `<label>Operator token
        <input type="password" name="operator_token" autocomplete="off" required>
      </label>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize access</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 1.5rem; }
    .host { font-weight: 600; }
    .error { background: #fde8e8; color: #9b1c1c; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
    label { display: block; margin: 1rem 0; }
    input[type=password] { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button { padding: 0.6rem 1.2rem; border-radius: 6px; border: 1px solid #888; cursor: pointer; }
    button.allow { background: #1c64f2; color: #fff; border-color: #1c64f2; }
  </style>
</head>
<body>
  <div class="card">
    ${errorBlock}
    <h1>Authorize <strong>${esc(clientName)}</strong></h1>
    <p><strong>${esc(clientName)}</strong> is requesting access to your vault and will
      redirect to <span class="host">${esc(redirectHost)}</span> after you decide.</p>
    <form action="/oauth/consent" method="post">
      <input type="hidden" name="authz_id" value="${esc(authzId)}">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      ${tokenField}
      <div class="actions">
        <button class="allow" type="submit" name="decision" value="allow">Allow</button>
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}
