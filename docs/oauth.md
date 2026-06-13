# OAuth for vendor MCP connectors (Claude.ai + ChatGPT)

> **Status:** ships in v1.4 behind `UM_OAUTH_ENABLED` (default **off**). Turn it
> on only after the live smoke probe passes against your public URL (see
> [§7](#7-verifying-troubleshooting)). Design rationale + the full normative
> contract live in [`docs/plans/2026-06-12-gap3-oauth-spec.md`](plans/2026-06-12-gap3-oauth-spec.md).

Both vendors' MCP connector flows are OAuth-only — they will not accept a static
bearer token. This guide is for an operator who already runs UM locally and wants
to connect Claude.ai (web/desktop/mobile) and/or ChatGPT as MCP connectors over a
public HTTPS tunnel. The server embeds a minimal **single-operator** OAuth 2.1
authorization server (MCP auth spec 2025-11-25: RFC 9728 + 8414 + PKCE, DCR, and
CIMD). No external identity provider, no extra container, no new dependencies.

Audience: you have UM running (`install.sh` + `docker compose up -d`) and a public
tunnel (see [`docs/um-tunnel.md`](um-tunnel.md)). For the legacy local Claude Code
path, nothing here applies — see [§6](#6-the-legacy-bearer-token-is-unaffected).

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
| `UM_OAUTH_CIMD_HOSTS` | `claude.ai,chatgpt.com,openai.com` | Allowlisted hosts whose CIMD client-id documents the server will fetch (see [§4](#4-connecting-chatgpt-cimd)). Comma-separated; subdomains included. Extend only for a vendor you trust. |

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

## 3. Connecting Claude.ai (one-click DCR)

Claude registers itself automatically via Dynamic Client Registration — no manual
client id needed.

1. In Claude.ai → **Settings → Connectors → Add custom connector**, paste your
   `UM_PUBLIC_BASE_URL` + `/mcp` (e.g. `https://your-host.tailXXXX.ts.net/mcp`).
2. Claude probes discovery, registers a client, and opens UM's **consent page** in a
   browser tab.
3. The consent page shows the requesting client name and the redirect host. Paste
   your **operator bearer token** (the same secret in `~/.um/auth-token` that your
   hooks/CLI use) into the field and click **Allow**.
   - A signed, `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/oauth` keeps
     the browser trusted for **15 minutes**, so a retry or connecting a second
     vendor in the same sitting skips the paste. The cookie proves *operator
     presence only* — you still click **Allow** on every authorization; it never
     auto-approves.
4. The tab closes and Claude is connected. The same `https://claude.ai/api/mcp/auth_callback`
   redirect covers Claude web, Desktop, mobile, and Cowork.

Claude Code (the CLI) uses a loopback redirect on an ephemeral port and is also
supported, but for local use it doesn't need OAuth at all (see [§6](#6-the-legacy-bearer-token-is-unaffected)).

---

## 4. Connecting ChatGPT (CIMD)

ChatGPT prefers CIMD: it presents its client-id as an HTTPS URL pointing at a
metadata document, which the server fetches and validates (allowlist-first, then
HTTPS-only with SSRF guards). DCR is also accepted as a fallback.

1. In ChatGPT's connector/developer-mode dialog, add your `…/mcp` URL.
2. The dialog shows CIMD as available (it reads `client_id_metadata_document_supported`
   from discovery). Proceed; ChatGPT opens UM's consent page.
3. Same consent step as Claude: paste the operator token, click **Allow**. The page
   shows ChatGPT's actual redirect host (`chatgpt.com`) so you can confirm what
   you're authorizing.

If a future vendor uses a CIMD host other than the three defaults, add it to
`UM_OAUTH_CIMD_HOSTS` — the server will not fetch a client document from an
off-allowlist host.

---

## 5. Revoking access

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

## 6. The legacy bearer token is unaffected

OAuth runs in parallel with the existing bearer-token auth. Your Claude Code hooks,
the `um-cli`, the Raspberry-Pi clients, and CI all keep sending
`Authorization: Bearer <UM_AUTH_TOKEN>` and are never touched by any of this —
vendors simply never use that path. Rotating the operator bearer token affects only
*future* consent (the next paste must use the new token); already-issued OAuth
grants and any live consent cookie keep working. The `/mcp` endpoint accepts
**either** a valid legacy bearer token **or** a valid OAuth access token.

---

## 7. Verifying & troubleshooting

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
| `um_oauth_consent_total` | `outcome` (`allow`, `deny`, `bad_token`, `throttled`, `csrf_reject`) | Consent-page outcomes — `bad_token` means a wrong operator token was pasted. |
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

## 8. Security model, briefly

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
