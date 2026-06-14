// server/lib/oauth/idp/github.mjs
// GitHub login adapter (spec §4.1/§4.3/§6.6). Plain OAuth2 + /user — no id_token.
// The fetch guard mirrors cimd.mjs (redirect:'manual', 5s timeout, 64KB cap,
// text()-then-parse) but THROWS on any failure; the callback handler maps a throw
// to a spec-shaped retriable error page that leaks no secret.
const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;

async function guardedJson(url, opts, fetchImpl) {
  const res = await fetchImpl(url, {
    ...opts,
    redirect: 'manual',                       // never follow redirects (SSRF)
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { ...(opts.headers || {}), Accept: 'application/json', 'User-Agent': 'universal-memory' },
  });
  if (res.status !== 200) throw new Error(`github ${url} -> ${res.status}`);
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) throw new Error('github response too large');
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('github response too large');
  return JSON.parse(text);
}

export function createGithubAdapter(env) {
  const clientId = env.UM_OAUTH_IDP_GITHUB_CLIENT_ID;
  const clientSecret = env.UM_OAUTH_IDP_GITHUB_CLIENT_SECRET;
  return {
    id: 'github',
    label: 'GitHub',
    buildAuthorizeUrl({ state, redirectUri /* nonce unused by GitHub */ }) {
      const u = new URL(AUTH_URL);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      // NO scope param — default grant returns id+login (spec §4.5)
      u.searchParams.set('allow_signup', 'false');
      return u.toString();
    },
    async exchangeCode({ code, redirectUri, fetchImpl = fetch }) {
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
      const json = await guardedJson(TOKEN_URL, { method: 'POST', body }, fetchImpl);
      if (!json.access_token) throw new Error('github: no access_token');
      return { credentials: { accessToken: json.access_token } };
    },
    async fetchIdentity({ credentials, fetchImpl = fetch }) {
      const json = await guardedJson(USER_URL, { headers: { Authorization: `Bearer ${credentials.accessToken}` } }, fetchImpl);
      if (!Number.isInteger(json.id) || json.id <= 0) throw new Error('github: missing/invalid id'); // deny: never an undefined or non-positive subject
      return { subject: String(json.id), displayName: String(json.login ?? json.id) };
    },
  };
}
