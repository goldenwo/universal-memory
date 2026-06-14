/**
 * Endpoint-class routing policy (spec §4.2 step 3).
 *
 * Decides, for each inbound request, whether auth + rate-limit apply,
 * whether the endpoint is public, loopback-gated, or should return a
 * hard 404.
 *
 * Implemented as a scan-first-match ROWS table so future surfaces
 * (/providers/* in v0.7, /admin/* in v1.0) land as new rows with
 * their own tests — not new branches on a growing switch. Round-9
 * extensibility fix.
 *
 * PURE module: no I/O, no state, no globals read except the env
 * object the caller passes in. All three inputs (req, env, sourceIp)
 * are injected so tests can exhaustively pin the policy matrix.
 *
 * Return shape:
 *   { bypassAuth: boolean, bypassRateLimit: boolean }   // normal path
 *   { returnStatus: number }                            // hard short-circuit
 */

import { configuredProviders } from './oauth/idp/config.mjs';

// Loopback in all three shapes Node's remoteAddress reports: IPv4,
// IPv6, and the IPv4-mapped-in-IPv6 form seen on dual-stack sockets.
function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// First-match-wins table. Order is load-bearing — see the `?gpt=1`
// row which MUST precede the catch-all `/openapi.yaml` row.
const ROWS = [
  // /health: always public (liveness probe for load balancers, k8s,
  // uptime monitors). No auth, no rate-limit, no env flags.
  { match: (p, s) => p === '/health',                                pol: () => ({ bypassAuth: true,  bypassRateLimit: true  }) },

  // /openapi.yaml?gpt=1: Custom GPT import path. GPT builder fetches
  // the spec unauthenticated during schema discovery; this rule
  // MUST come before the catch-all /openapi.yaml row below.
  { match: (p, s) => p === '/openapi.yaml' && s.get('gpt') === '1',  pol: () => ({ bypassAuth: true,  bypassRateLimit: true  }) },

  // /openapi.yaml: general OpenAPI spec. Defaults to auth-required
  // (leak protection); ops can opt out via UM_OPENAPI_AUTH_REQUIRED=false.
  { match: (p, s) => p === '/openapi.yaml',                          pol: (e) => openapiPolicy(e) },

  // /metrics: Prometheus scrape endpoint. Decision tree in metricsPolicy().
  { match: (p, s) => p === '/metrics',                               pol: (e, ip) => metricsPolicy(e, ip) },

  // OAuth surface (Gap-3 spec 4.1): one ROW per route; ALL gated on
  // UM_OAUTH_ENABLED — when off they hard-404 so no half-enabled state
  // exists. bypassAuth=true because these are public by design (the
  // consent gate inside the handler is the trust boundary, spec 6 item 7).
  // bypassRateLimit=true means "skip the SHARED limiter" — the dedicated
  // OAuth limiter (spec 6 item 1, independent of /mcp) is applied in the
  // dispatch layer, not here.
  // OAUTH_PUBLIC_PATHS defined below — safe: the lambda closes over it, not called at init.
  { match: (p, s) => OAUTH_PUBLIC_PATHS.has(p),                      pol: (e) => oauthPolicy(e) },
  // /oauth/revoke is deliberately separate from (and after) the public block:
  // it is loopback-only operator revocation (spec 4.3) — same posture as the
  // /metrics loopback branch, not a public OAuth path.
  { match: (p, s) => p === '/oauth/revoke',                          pol: (e, ip) => oauthRevokePolicy(e, ip) },

  // Social login (Gap-4 bridge): /oauth/idp/<provider>/{login,callback}. A PREFIX
  // row (not an exact path) — public only when OAuth is on AND a provider is fully
  // configured; otherwise hard-404 (default-closed, like the other OAuth rows).
  { match: (p, s) => p.startsWith('/oauth/idp/'),                    pol: (e) => oauthIdpPolicy(e) },

  // /api/*: all REST endpoints — auth + rate-limit always on.
  { match: (p, s) => p.startsWith('/api/'),                          pol: () => ({ bypassAuth: false, bypassRateLimit: false }) },

  // /mcp: MCP HTTP transport — auth + rate-limit always on.
  { match: (p, s) => p === '/mcp',                                   pol: () => ({ bypassAuth: false, bypassRateLimit: false }) },

  // /providers/*: RESERVED for v0.7 (external memory provider
  // passthrough). In v0.6 falls through to auth + rate-limit so a
  // rogue deploy of v0.6 against a v0.7 client doesn't silently
  // bypass. v0.7 may refine this row's policy.
  { match: (p, s) => p.startsWith('/providers/'),                    pol: () => ({ bypassAuth: false, bypassRateLimit: false }) },

  // /admin/*: RESERVED for v1.0 (multi-user admin surface). Same
  // default-close posture as /providers/*.
  { match: (p, s) => p.startsWith('/admin/'),                        pol: () => ({ bypassAuth: false, bypassRateLimit: false }) },
];

/**
 * /openapi.yaml policy (no ?gpt=1).
 *
 * Default-closed: UM_OPENAPI_AUTH_REQUIRED unset → treated as 'true'.
 * Ops must explicitly set the flag to 'false' to expose the spec.
 */
function openapiPolicy(env) {
  const authRequired = (env.UM_OPENAPI_AUTH_REQUIRED ?? 'true') === 'true';
  return authRequired
    ? { bypassAuth: false, bypassRateLimit: false }
    : { bypassAuth: true,  bypassRateLimit: true  };
}

/**
 * /metrics policy decision tree:
 *
 *   loopback-only (default true) + loopback IP → bypass
 *     → fast Prometheus scrape path from node_exporter sidecar.
 *   loopback-only + external IP → returnStatus 404
 *     → don't advertise the endpoint exists at all.
 *   public (loopback-only=false) + auth-required (default true) → fall through to auth
 *   public + auth-not-required → bypass
 *     → ops opted out explicitly; bypass rate-limit too so scrapes
 *       don't hit the limiter under steady 15s intervals.
 */
function metricsPolicy(env, sourceIp) {
  const loopbackOnly = (env.UM_METRICS_LOOPBACK_ONLY ?? 'true') === 'true';
  const isLoopback = isLoopbackIp(sourceIp);
  if (loopbackOnly && !isLoopback) return { returnStatus: 404 };
  if (loopbackOnly && isLoopback) return { bypassAuth: true, bypassRateLimit: true };
  const authRequired = (env.UM_METRICS_AUTH_REQUIRED ?? 'true') === 'true';
  return authRequired
    ? { bypassAuth: false, bypassRateLimit: false }
    : { bypassAuth: true,  bypassRateLimit: true  };
}

const OAUTH_PUBLIC_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register', '/oauth/authorize', '/oauth/consent', '/oauth/token',
]);

function oauthEnabled(env) { return (env.UM_OAUTH_ENABLED ?? 'false') === 'true'; }

function oauthPolicy(env) {
  if (!oauthEnabled(env)) return { returnStatus: 404 };
  return { bypassAuth: true, bypassRateLimit: true };
}

function oauthRevokePolicy(env, sourceIp) {
  if (!oauthEnabled(env)) return { returnStatus: 404 };
  if (!isLoopbackIp(sourceIp)) return { returnStatus: 404 };
  return { bypassAuth: true, bypassRateLimit: true };
}

function oauthIdpPolicy(env) {
  if (!oauthEnabled(env)) return { returnStatus: 404 };
  // Default-closed until a provider is fully configured (the social-login trio).
  if (configuredProviders(env).length === 0) return { returnStatus: 404 };
  // Public like the other OAuth routes; the DEDICATED OAuth limiter (applied in
  // the /oauth/* dispatch layer, which also matches /oauth/idp/*) handles rate
  // limiting, so skip the SHARED limiter here to avoid double-limiting.
  return { bypassAuth: true, bypassRateLimit: true };
}

/**
 * Classify an inbound request against the ROWS table.
 *
 * @param {{ url: string, headers?: object }} req
 *   Node http.IncomingMessage-shaped value. Only `url` is read.
 * @param {object} [env=process.env]
 *   Env-variable source. Defaulted to process.env for prod; tests
 *   inject a plain object so they can pin flag combinations.
 * @param {string|null} [sourceIp=null]
 *   Client IP string (typically `req.socket.remoteAddress`). Used by
 *   the /metrics and /oauth/revoke rows; other rows ignore it.
 * @returns {{ bypassAuth: boolean, bypassRateLimit: boolean } | { returnStatus: number }}
 */
export function endpointClassRoute(req, env = process.env, sourceIp = null) {
  // URL parser needs a base; the host segment is discarded — we only
  // care about pathname + searchParams.
  const url = new URL(req.url, 'http://x');
  for (const row of ROWS) {
    if (row.match(url.pathname, url.searchParams)) {
      return row.pol(env, sourceIp);
    }
  }
  // Default-close: unknown paths require auth + rate-limit. This
  // prevents a missing row from silently opening a public endpoint.
  return { bypassAuth: false, bypassRateLimit: false };
}
