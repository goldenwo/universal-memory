# OAuth for vendor MCP connectors (Claude.ai + ChatGPT)

> **Status:** ships in v1.4 behind `UM_OAUTH_ENABLED` (default **off**). Turn it
> on only after the live smoke probe passes against your public URL (see
> [§8](#8-verifying--troubleshooting)). Design rationale + the full normative
> contract live in [`docs/plans/2026-06-12-gap3-oauth-spec.md`](plans/2026-06-12-gap3-oauth-spec.md).

Both vendors' MCP connector flows are OAuth-only — they will not accept a static
bearer token. This guide is for an operator who already runs UM locally and wants
to connect Claude.ai (web/desktop/mobile) and/or ChatGPT as MCP connectors over a
public HTTPS tunnel. The server embeds a minimal **single-operator** OAuth 2.1
authorization server (MCP auth spec 2025-11-25: RFC 9728 + 8414 + PKCE, DCR, and
CIMD). No external identity provider, no extra container, no new dependencies.

Audience: you have UM running (`install.sh` + `docker compose up -d`) and a public
tunnel (see [`docs/um-tunnel.md`](um-tunnel.md)). For the legacy local Claude Code
path, nothing here applies — see [§7](#7-the-legacy-bearer-token-is-unaffected).

---

## 1. What this adds, in one breath

When you add UM as a connector, the vendor opens a browser tab at **your** server's
consent page, you prove you're the operator (paste your existing token once), click
**Allow**, and the vendor receives an OAuth token behind the scenes. Every later
`/mcp` call from that vendor carries the OAuth token; your hooks/CLI keep using the
legacy bearer token unchanged. You do this once per connector, basically never again.

---

## 2. Enabling it

Three environment variables on the server (already documented in
[`server/.env.example`](../server/.env.example)):

| Env | Default | Meaning |
|---|---|---|
| `UM_OAUTH_ENABLED` | `false` | Master gate. When `false`, **every** OAuth route — the discovery well-knowns and all `/oauth/*` — returns 404; there is no half-enabled state. |
| `UM_PUBLIC_BASE_URL` | *(required when enabled)* | Your canonical public origin, e.g. your Tailscale Funnel URL `https://host.tailXXXX.ts.net`. **The server refuses to boot if OAuth is on and this is unset.** It is config-canonical: the issuer, protected-resource document, token audience, and the `/openapi.yaml` `servers:` URL all derive from it — never from a request `Host` header. |
| `UM_OAUTH_CIMD_HOSTS` | `claude.ai,chatgpt.com,openai.com` | Allowlisted hosts whose CIMD client-id documents the server will fetch (see [§5](#5-connecting-chatgpt-cimd)). Comma-separated; subdomains included. Extend only for a vendor you trust. |

### What `UM_PUBLIC_BASE_URL` is, and how to get it

This is the one value you have to set, so it's worth being clear about.

**Why it's needed at all.** When Claude.ai or ChatGPT connect, they first fetch your
server's discovery documents and read absolute URLs out of them ("authorize here,
get tokens there"). Those URLs must be the address the vendor — running in the
cloud — can actually reach, so the server has to be told its own public address.
Every OAuth server works this way; it can't be skipped.

**Why you set it instead of the server guessing it.** The server *could* read the
address off each incoming request's `Host` header (zero config), but that's a known
attack — a forged header could make the server hand out tokens scoped to the wrong
address — so the OAuth spec requires the value to come from your config, never from
the request.

**How to find the value (Tailscale Funnel — the recommended path).** Your Funnel URL
is always `https://<your-device>.<your-tailnet>.ts.net`. Two easy ways to get it:
- run `tailscale status` and read this device's name, **or**
- just run `um-tunnel` once — it prints the exact public URL at the top; copy that.

  (Using cloudflared or ngrok instead? Their quick-tunnel URLs are random per run, so
  start the tunnel first, copy the URL it prints, then set it here. A custom domain is
  whatever you've pointed at the server.)

**Format — origin only, no path, no trailing slash:**
- ✅ `https://my-laptop.tail1a2b.ts.net`
- ❌ `https://my-laptop.tail1a2b.ts.net/mcp`  ❌ `https://my-laptop.tail1a2b.ts.net/`

It must **exactly match** the URL the vendor reaches you on (your tunnel URL). On a
mismatch the server logs an `oauth_host_mismatch` warning and vendors may fail to
connect — that warning is the first thing to check if a connect fails.

**Don't confuse it with the connector URL you paste into the vendor.** That one is
`UM_PUBLIC_BASE_URL` **plus `/mcp`** (e.g. `https://my-laptop.tail1a2b.ts.net/mcp`).
The base URL is the origin; the connector URL adds the `/mcp` path.

Enable it:

```bash
# in server/.env
UM_OAUTH_ENABLED=true
UM_PUBLIC_BASE_URL=https://your-host.tailXXXX.ts.net
docker compose up -d   # restart to pick up the env
```

Confirm discovery is live (these 404 when the flag is off):

```bash
curl -sf https://your-host.tailXXXX.ts.net/.well-known/oauth-authorization-server | head -c 300
```

You should see JSON with `issuer`, `authorization_endpoint`, `token_endpoint`,
`registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, and
`client_id_metadata_document_supported: true`.

---

## 3. Sign in with GitHub (social login)

An optional alternative to pasting the operator token on the consent page. When
configured, the consent page gains a **"Continue with GitHub"** button — you click
it, approve the GitHub OAuth screen, and the server verifies you are the operator
by numeric id (or login) and issues the MCP token. The operator-token paste remains
visible under a **"use operator token instead"** disclosure as a break-glass
fallback. The button is inert (never shown) unless `UM_OAUTH_ENABLED=true` AND all
three GitHub vars below are set.

### 3.1 Create a GitHub OAuth App

Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.**
Use **OAuth Apps**, not GitHub Apps.

| Field | Value |
|---|---|
| Homepage URL | `UM_PUBLIC_BASE_URL` (your public origin, e.g. `https://your-host.tailXXXX.ts.net`) |
| Authorization callback URL | `${UM_PUBLIC_BASE_URL}/oauth/idp/github/callback` (exact path) |

After creating the app, copy the **Client ID** and generate a **Client secret**.

### 3.2 Environment variables

Add all three to `server/.env` (they are documented in
[`server/.env.example`](../server/.env.example)):

```bash
UM_OAUTH_IDP_GITHUB_CLIENT_ID=<your app's client id>
UM_OAUTH_IDP_GITHUB_CLIENT_SECRET=<your app's client secret>
UM_OAUTH_OPERATOR_GITHUB=<your numeric id or login>
```

Restart the server after setting them:

```bash
docker compose up -d
```

### 3.3 `UM_OAUTH_OPERATOR_GITHUB` — numeric id vs login

Set this to your GitHub account by **numeric id (preferred)** or login.

**Why numeric id is preferred.** A numeric id gives a stable canonical identity
(`sub=github:<id>`) that survives a GitHub username rename and is coherent at the
future per-user (Gap-4) tier. A login-only value is **incoherent across sign-in
paths**: the GitHub button still stamps the real `sub=github:<id>` (from the
verified GitHub id), but the token-paste and presence-cookie fallback paths stamp
`sub=owner` (no live id is known there) — so the same operator ends up with two
different subjects depending on how they signed in. The server logs a boot
advisory at startup. (A login also changes if you rename your GitHub account,
which would then break the allowlist match.) Configure the numeric id so every
path stamps the same canonical `sub=github:<id>`.

Find your numeric id:

```bash
curl -s https://api.github.com/users/<your-login> | grep '"id"'
```

Read the `"id"` field (an integer). Use that integer as the value of
`UM_OAUTH_OPERATOR_GITHUB`.

### 3.4 Boot behavior

The three vars are **all-or-nothing.** Setting 1 or 2 of the 3 causes the server
to refuse startup with an error listing all three required vars — a half-configured
provider is rejected rather than silently disabled. Setting none of them leaves
the consent page unchanged (token-paste only, no GitHub button).

### 3.5 Verification

The automated test suite covers the social-login flow end-to-end with a fake
GitHub provider (no real OAuth App needed). Verifying the button against the
**real** GitHub requires a live OAuth App and a human login — that is a manual
step. Once the vars are set and the server restarts, open the consent page in a
browser and confirm the **"Continue with GitHub"** button is visible.

---

## 4. Connecting Claude.ai (one-click DCR)

Claude registers itself automatically via Dynamic Client Registration — no manual
client id needed.

1. In Claude.ai → **Settings → Connectors → Add custom connector**, paste your
   `UM_PUBLIC_BASE_URL` + `/mcp` (e.g. `https://your-host.tailXXXX.ts.net/mcp`).
2. Claude probes discovery, registers a client, and opens UM's **consent page** in a
   browser tab.
3. The consent page shows the requesting client name and the redirect host. Paste
   your **operator bearer token** (the same secret in `~/.um/auth-token` that your
   hooks/CLI use) into the field and click **Allow**. If social login is configured,
   you can click **"Continue with GitHub"** instead — see [§3](#3-sign-in-with-github-social-login).
   - A signed, `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/oauth` keeps
     the browser trusted for **15 minutes**, so a retry or connecting a second
     vendor in the same sitting skips the paste. The cookie proves *operator
     presence only* — you still click **Allow** on every authorization; it never
     auto-approves.
4. The tab closes and Claude is connected. The same `https://claude.ai/api/mcp/auth_callback`
   redirect covers Claude web, Desktop, mobile, and Cowork.

Claude Code (the CLI) uses a loopback redirect on an ephemeral port and is also
supported, but for local use it doesn't need OAuth at all (see [§7](#7-the-legacy-bearer-token-is-unaffected)).

---

## 5. Connecting ChatGPT (CIMD)

ChatGPT prefers CIMD: it presents its client-id as an HTTPS URL pointing at a
metadata document, which the server fetches and validates (allowlist-first, then
HTTPS-only with SSRF guards). DCR is also accepted as a fallback.

1. In ChatGPT's connector/developer-mode dialog, add your `…/mcp` URL.
2. The dialog shows CIMD as available (it reads `client_id_metadata_document_supported`
   from discovery). Proceed; ChatGPT opens UM's consent page.
3. Same consent step as Claude: paste the operator token, click **Allow**. The page
   shows ChatGPT's actual redirect host (`chatgpt.com`) so you can confirm what
   you're authorizing. If social login is configured, you can click
   **"Continue with GitHub"** instead — see [§3](#3-sign-in-with-github-social-login).

If a future vendor uses a CIMD host other than the three defaults, add it to
`UM_OAUTH_CIMD_HOSTS` — the server will not fetch a client document from an
off-allowlist host.

---

## 6. Revoking access

Tokens are opaque and stored only as hashes; revocation is instant and does not
require restarting the server. Use the CLI **on the same host as the server** (the
revoke endpoint is loopback-only):

```bash
# disconnect one vendor (its registration + all its tokens):
node server/bin/oauth-revoke.mjs --client <client_id>

# panic-revoke every grant (all tokens + codes; registrations kept):
node server/bin/oauth-revoke.mjs --all

# non-default port:
node server/bin/oauth-revoke.mjs --all --port 6399
```

The CLI prints what it revoked (token/code counts). It POSTs to the running
server's loopback `/oauth/revoke` route, because only the running process owns the
in-process state the verifier reads — a tool editing the state file directly would
race the server's own writes.

**Nuclear option (server stopped):** delete `<UM_VAULT_DIR>/oauth-state.json` while
the server is down. This kills **all** grants *and* the consent-cookie signing key
(every live 15-minute cookie is orphaned) and the client registrations. The server
regenerates a fresh key on next boot. Use this only when you can't reach a running
server.

---

## 7. The legacy bearer token is unaffected

OAuth runs in parallel with the existing bearer-token auth. Your Claude Code hooks,
the `um-cli`, the Raspberry-Pi clients, and CI all keep sending
`Authorization: Bearer <UM_AUTH_TOKEN>` and are never touched by any of this —
vendors simply never use that path. Rotating the operator bearer token affects only
*future* consent (the next paste must use the new token); already-issued OAuth
grants and any live consent cookie keep working. The `/mcp` endpoint accepts
**either** a valid legacy bearer token **or** a valid OAuth access token.

---

## 8. Verifying & troubleshooting

**Smoke probe.** Before connecting a real vendor, run the end-to-end flow probe
against your public URL (discovery → register → authorize → consent → token →
authenticated `/mcp` call → refresh rotation → reuse-tripwire):

```bash
UM_PROBE_BASE_URL=https://your-host.tailXXXX.ts.net \
UM_AUTH_TOKEN=<operator token> \
node server/test/oauth-flow-probe.mjs
```

Eight `[oauth-probe] step N … OK` lines and exit 0 means the surface is healthy.
It is also wired into `server/test/smoke.sh` behind `UM_SMOKE_OAUTH=1` (skips with a
notice if the server has OAuth disabled).

**Metrics.** The `/metrics` endpoint exposes counters for every step, so you can see
where a failed connect died:

| Counter | Labels | Tells you |
|---|---|---|
| `um_oauth_registrations_total` | `outcome` (`accepted`, `rejected_redirect`, `rejected_metadata`, `rejected_limit`) | DCR registration attempts and why any were rejected. |
| `um_oauth_consent_total` | `outcome` (`allow`, `deny`, `bad_token`, `throttled`, `csrf_reject`), `method` (`token` \| `idp`) | Consent-page outcomes — `bad_token` means a wrong operator token was pasted; `method` distinguishes token-paste from social-login approvals. |
| `um_oauth_idp_total` | `provider` (`github`), `outcome` (`success` \| `mismatch` \| `error` \| `denied`) | Social-login IdP callback outcomes. `mismatch` = authenticated at GitHub but not the configured operator; `denied` = user declined the GitHub OAuth screen; `error` = provider exchange or identity-fetch failure. |
| `um_oauth_token_grants_total` | `grant_type` (`authorization_code`, `refresh_token`, `unknown`), `outcome` (`issued`, `invalid_grant`, `reuse_blocked`, …) | Token exchanges. `refresh_token`+`reuse_blocked` = a rotated refresh token was replayed (possible theft). |
| `um_mcp_auth_branch_total` | `branch` (`legacy`, `oauth`) | Which auth path authenticated each `/mcp` request. |

**Logs.** Structured warnings carry a stable `error_class`:

- `oauth_host_mismatch` — a request's effective host (incl. `x-forwarded-host`)
  disagreed with `UM_PUBLIC_BASE_URL`. The server still serves config-derived URLs;
  this warns that your tunnel/proxy host doesn't match what you configured. If
  vendors can't complete discovery, this is the first thing to check.
- `oauth_seed_invalid_format` / `oauth_seed_invalid_uri` — the optional
  `UM_OAUTH_SEED_CLIENT` manual-client seed (a pre-DCR fallback of the form
  `<client_id>|<redirect_uri>`) was malformed and ignored.

**Vendor can't reach the AS at all?** Confirm the tunnel is up and the well-knowns
return 200 over the *public* URL (not just loopback), and that
`UM_PUBLIC_BASE_URL` exactly matches that public origin. A 404 on the well-knowns
means `UM_OAUTH_ENABLED` isn't `true` on the running container.

---

## 9. Security model, briefly

- **The consent page is the trust boundary.** Discovery and registration grant
  nothing — a stranger who finds your URL can complete discovery and even register a
  client, but cannot pass consent without your operator token. There is no open
  signup.
- **Tokens:** opaque 32-byte random strings, stored only as SHA-256 hashes; access
  tokens live 30 minutes; refresh tokens rotate on every use and a replayed old
  refresh token revokes the whole family. Every token is audience-bound to your
  `UM_PUBLIC_BASE_URL` + `/mcp`.
- **Least privilege:** an OAuth token authenticates **only `/mcp`** — vendors speak
  MCP and never need the REST API, so a connector token cannot reach `/api/*` even
  if exfiltrated. Your machine clients (CLI, hooks, Pi) keep using the legacy bearer
  token, which retains full-surface access.
- **CIMD fetches** are allowlist-gated before any network call, HTTPS-only, with
  redirect-following disabled, a 5s timeout, and a 64 KB body cap.
- **Rate limiting:** all `/oauth/*` routes share a dedicated limiter independent of
  the `/mcp` budget, so a connect storm can't starve your real traffic; failed
  consent attempts feed a global exponential backoff.

For the complete normative contract (PKCE enforcement, redirect-URI matching,
atomic code consumption, the Gap-4 multi-user seams), see the spec linked at the top.
