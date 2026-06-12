// server/lib/oauth/redirects.mjs
//
// Redirect-URI validation (Gap-3 OAuth spec section 4.5): a REGISTRATION-time
// domain allowlist (which URIs a client may register at all) and
// AUTHORIZE-time matching (exact string equality against the stored URI).
// The chatgpt.com/connector/oauth/ PREFIX is a registration-time rule only —
// what is stored is the literal per-connector URI, and authorize-time
// matching is exact. The single exception is RFC 8252 loopback (Claude Code
// uses an ephemeral port): port-agnostic, and the two loopback literals
// localhost / 127.0.0.1 are treated as equivalent (the documented
// vendor-trap, research Q5-4).

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_LEGACY = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_PREFIX = 'https://chatgpt.com/connector/oauth/';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']); // [::1] deliberately omitted — no vendor emits it; fails closed (rejection at registration), add if Claude Code ever does

function parse(uri) {
  try { return new URL(uri); } catch { return null; }
}

export function isLoopbackRedirect(uri) {
  const u = parse(uri);
  return !!u && u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

export function isAllowedRegistrationRedirect(uri) {
  if (uri === CLAUDE_CALLBACK || uri === CHATGPT_LEGACY) return true;
  const u = parse(uri);
  if (
    u && u.protocol === 'https:' && u.hostname === 'chatgpt.com'
    && uri.startsWith(CHATGPT_PREFIX) && u.pathname.length > '/connector/oauth/'.length
  ) return true;
  return isLoopbackRedirect(uri);
}

export function redirectMatches(stored, presented) {
  if (stored === presented) return true;
  // RFC 8252 loopback special case: port-agnostic, localhost ≡ 127.0.0.1.
  if (!isLoopbackRedirect(stored) || !isLoopbackRedirect(presented)) return false;
  const a = parse(stored);
  const b = parse(presented);
  return a.pathname === b.pathname && a.search === b.search;
}
