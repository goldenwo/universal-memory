# Migration guide

## v0.8 → v1.0

v1.0 is **stabilization + public release**, not a feature release. There are no env-var renames, no API contract changes, and no operator-facing breakage relative to v0.8. The notable items below are **distribution shape**, **W6.4 security hardening** (3 internal-API hardening fixes), and the formal **post-v1.0 support window**.

### Distribution: pull-by-default

Up to v0.8, `server/docker-compose.yml` shipped with `build: .` + `image: universal-memory-server:0.7.0-alpha`, which built the image locally on every fresh install (~2-5 min cold-build).

v1.0 flips this to pull-by-default:

```yaml
image: ${UM_IMAGE:-ghcr.io/goldenwo/universal-memory-server:${UM_VERSION:-latest}}
```

**Action for operators upgrading from v0.8 → v1.0:**

- **First-time installs:** zero-config — `docker compose up -d` pulls `:latest` from GHCR (~20s).
- **Existing v0.8 installs:** `docker compose pull && docker compose up -d` reuses your existing `.env` and vault. The locally-tagged `universal-memory-server:0.7.0-alpha` image is still on disk; `docker image prune` cleans it up.
- **Pin a version in production:** add `UM_VERSION=1.0.0` to `server/.env`. Recommended for production — `:latest` is a moving target across patch releases.
- **Local source builds (development):** set `UM_BUILD_LOCAL=1` in your environment and re-run `bash server/install.sh`. Or invoke compose manually with both files: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d`.

The `release.yml` workflow (multi-arch amd64 + arm64) emits semver tags on every `v*.*.*` tag push: `1.0.0` + `1.0` + `latest` for stable releases; prereleases skip `latest`. v0.7-alpha and v0.8-alpha images exist on GHCR but never claimed `latest`, so the default-to-`:latest` path resolves only to v1.0+.

### W6.4 security hardening (internal — no operator action)

Three internal-API hardening fixes from the v1.0 W6.4 security review pass. None require operator action; documenting here so the auth posture is unambiguous:

1. **CORS preflight allows `Authorization`** — browser-origin clients (Custom GPT Actions, Claude.ai web connector, third-party browser tooling) sending `Authorization: Bearer <token>` were silently rejected before reaching the auth layer. Fixed.
2. **`compareTokens` hashes inputs to fixed-size SHA-256 digests** before timing-safe compare. Removes any length-dependent timing channel from the prior dummy-compare scheme. Real-world exploitability of the prior scheme was low; the fix is simpler and tighter.
3. **Logger redacts active `UM_AUTH_TOKEN` value** as a defense-in-depth pattern, in addition to the existing four-pattern static redaction (sk-*, sk-ant-*, AIza*, Bearer *). No current code path logs the raw token; this catches future debug-log or error-context leaks.

### Bearer-auth posture summary (cumulative through v1.0)

For operators consolidating from any pre-v0.6 version:

| Surface | Auth required? | Default |
|---|---|---|
| `/api/*` | Yes — `Authorization: Bearer <UM_AUTH_TOKEN>` | Loopback bypass (`127.0.0.1` only, no forwarded headers) is on by default; disable with `UM_ALLOW_LOOPBACK_NOAUTH=false` |
| `/mcp` | Yes — same as `/api/*` | Same loopback bypass |
| `/metrics` | Loopback-only | Set `UM_ALLOW_METRICS_PUBLIC=true` to expose externally (put it behind your own auth proxy if you do) |
| `/health` | No | Liveness probe; intentionally unauthenticated |
| `/openapi.yaml` | No | Schema endpoint; safe to expose |

Tunnel-fronted installs (Cloudflare Tunnel, ngrok, Tailscale Funnel) trigger the forwarded-headers check and require the bearer token regardless of source IP. install.sh generates `UM_AUTH_TOKEN` automatically and writes it to `~/.um/auth-token` (chmod 600); operators rotate by re-running install.sh or by replacing `UM_AUTH_TOKEN` in `server/.env` and bouncing the container.

### Supported versions (formalized at v1.0)

Per [SECURITY.md](SECURITY.md):

- `v1.0` and later — supported (security fixes target the latest minor + one previous minor for ~6 months)
- `v0.x-alpha` — unsupported; please upgrade

Pre-1.0 alphas remain installable from GHCR for archaeology / pinning to a known shape, but receive no further security or correctness fixes.

---

## v0.7 → v0.8

v0.8 is a behavior-and-test consolidation release. **No env-var renames, no API contract changes, no breaking flow changes.** The headline shift is internal: v0.7 promised provider metric emission for `embed`/`facts` surfaces but `mem0.add()` bypassed the orchestrators, so those metrics emitted zero. v0.8 G2 introduces `umAdd()` and routes through the orchestrators for real.

### What changed

- **`umAdd()` orchestrator** replaces all 6 `mem0.add()` call sites. Production embed/facts metrics now emit correctly.
- **Qdrant server image bumped `v1.11.3 → v1.13.0`** to match the `@qdrant/js-client-rest@1.13.0` client pulled transitively by `mem0ai@2.4.6`. Two-minor-version mismatch was emitting a runtime warning on every client construction.
- **`infer:true` semantics:** umAdd does NOT replicate mem0's semantic dedup. Every extracted fact becomes a new ADD. Re-running the same `/api/add` request twice now creates 2 facts instead of 1. Callers that depended on idempotent re-adds must use deterministic `metadata.id` + a pre-call existence check. (Documented as a v0.8 non-goal in spec §3.)
- **`um reindex` CLI dispatcher** — operator-driven embedding-provider migrations now run via `um reindex` rather than direct `node cli/reindex.mjs`.
- **DE12 e2e test fill** — three `assert.fail()` stubs from v0.7 became real e2e implementations (operator-driven, `UM_LIVE_TESTS=1` gated): provider flip openai → google, `--resume` mid-phase-3, `--resume` between phase-4 and phase-5.

### Action for operators

For most operators: **no action needed**. Pull the new image (or rebuild) and `docker compose up -d --force-recreate`. The Qdrant data on disk is forward-compatible across the 1.11 → 1.13 minor bump.

If you call `/api/add` repeatedly with the same input expecting idempotency: pin a deterministic `metadata.id` and check via `/api/list` before calling. The mem0 OSS dedup that v0.7 implicitly inherited is not part of v0.8's contract.

If you've been running `node cli/reindex.mjs` directly: switch to `um reindex` (see `docs/um-cli.md` for flags).

---

## v0.6 → v0.7

v0.7 generalises summarizer/facts/embeddings to a four-provider matrix
(openai / anthropic / google / ollama). Two breaking changes worth your
attention: env-var renames (no fallback code in the v0.7 server), and a
stricter `--yes` installer contract. The embedding-collection stamp + reindex
guard means upgrading without changing your embedding provider/model is a
no-op; switching providers requires an explicit reindex step.

### Breaking: env-var renames (hard breaks; pre-v1.0 policy, spec §12)

The v0.7 server reads only the new names. There is **no fallback** to the v0.6
names — a `.env` carrying the old names will fail startup validation with an
"unknown env var" / "required env var missing" error pointing at the new name.

| v0.6 | v0.7 | Reason |
|---|---|---|
| `UM_SUMMARIZER` | `UM_SUMMARIZER_PROVIDER` | provider-vs-mode clarity, parity across surfaces |
| `UM_SUMMARIZE_MODEL` | `UM_SUMMARIZER_MODEL` | noun-form consistency |
| `MEM0_LLM_MODEL` | `UM_FACTS_MODEL` | hide mem0 dependency, semantic clarity |
| `MEM0_EMBEDDER_MODEL` | `UM_EMBEDDING_MODEL` | same |
| _(new in v0.7)_ | `UM_EMBEDDING_PROVIDER` | required for v0.7 multi-provider |
| _(new in v0.7)_ | `UM_FACTS_PROVIDER` | required for v0.7 multi-provider |
| _(new in v0.7)_ | `UM_FACTS_FALLBACK` | optional opt-in for cross-provider facts fallback |

**Action.** Rename the four old vars in `server/.env` (and any deployment
secret store / CI config) before upgrading. Add `UM_EMBEDDING_PROVIDER` and
`UM_FACTS_PROVIDER` if you want to be explicit; otherwise both default to
`openai` (matching v0.6's effective behavior) and pick up `OPENAI_API_KEY`
via the v0.6 §5.2 key resolution rule.

A typical v0.6 → v0.7 rename in `server/.env`:

```bash
# Before (v0.6)
UM_SUMMARIZER=openai
UM_SUMMARIZE_MODEL=gpt-4o-mini
MEM0_LLM_MODEL=gpt-4.1-nano-2025-04-14
MEM0_EMBEDDER_MODEL=text-embedding-3-small

# After (v0.7)
UM_SUMMARIZER_PROVIDER=openai
UM_SUMMARIZER_MODEL=gpt-4o-mini
UM_FACTS_PROVIDER=openai
UM_FACTS_MODEL=gpt-4.1-nano-2025-04-14
UM_EMBEDDING_PROVIDER=openai
UM_EMBEDDING_MODEL=text-embedding-3-small
```

Per the **pre-v1.0 hard-break policy** (spec §12), v0.7 carries no
compatibility shim for the old names. Re-running `installer/install.sh` after
the upgrade will rewrite the managed block in `server/.env.example` with the
v0.7 names; existing `.env` files are not auto-migrated by design (operator
owns secrets).

### Breaking: `install.sh --yes` refuses on missing API key

Before (v0.6): `install.sh --yes` was permissive about missing API keys —
defaults caught the openai-only world, so a `.env` could be written
successfully even if no key was set, and the server's first start would
surface the missing-key error.

After (v0.7): `--yes` honors any pre-set `UM_*_PROVIDER` and matching
`*_API_KEY` env vars, defaults missing provider vars to `openai`, and **fails
fast with a clear error if a required API key is missing**. It does **not**
write `.env` in that case.

| Env state at `--yes` invocation | v0.7 result |
|---|---|
| All `UM_*_PROVIDER` and matching API keys present | Writes `.env`, no prompts, exit 0 |
| `UM_*_PROVIDER` unset → defaults to `openai` + `OPENAI_API_KEY` present | Same as above |
| `UM_*_PROVIDER` set, but matching API key missing | Refuses with `"--yes mode requires <KEY> to be set in env or .env. Re-run interactively or set the key first."` Exits non-zero. |
| `UM_*_PROVIDER=ollama` + `OLLAMA_HOST` not reachable | Refuses with the spec §10 R5 error message |

**Action for CI scripts.** If your CI / scripted install calls
`install.sh --yes` without a key in the environment, set `OPENAI_API_KEY`
(or the matching provider key for whatever `UM_*_PROVIDER` you've chosen)
before the invocation. The wizard's path 4 ("Skip — I'll edit .env myself")
remains the deliberate "I know what I'm doing" escape hatch and is distinct
from `--yes`.

Rationale: `--yes` is for CI / scripted installs where the operator has
already arranged credentials. Writing a `.env` that fails to start is a worse
outcome than refusing and pointing at the missing key. Aligns with v0.6's
discipline of explicit-fail-over-implicit-broken.

### Reindex required only if changing embedding provider / model

v0.7 introduces an **embedding stamp** (sentinel doc inside the Qdrant
collection at fixed metadata id `_um_embedding_stamp`) recording the active
provider, model, and dim. On every server start the stamp is compared against
the configured embedding env vars; mismatch refuses startup.

**Same provider + model (the common case): no reindex needed.** If you upgrade
v0.6 → v0.7 with the v0.6 default of `openai` + `text-embedding-3-small`,
the v0.7 server's first start finds **no stamp** in the existing collection,
writes one from current env, and continues. No operator action required. (See
spec §6.2 R2 — the "first-startup mitigation" branch.)

**Different provider or model: explicit reindex required.** If you change
`UM_EMBEDDING_PROVIDER` or `UM_EMBEDDING_MODEL` at upgrade, the server refuses
to start with a structured error pointing at the migration command:

```
[fatal] Embedding configuration changed since last start.
  Stamped:    provider=openai     model=text-embedding-3-small  dim=1536
  Configured: provider=google     model=text-embedding-004      dim=768

  The Qdrant collection was built with the stamped configuration.
  Switching embedding providers/models requires re-embedding every vector
  (vault docs + memory_add facts).

  To migrate, run:    um-cli reindex --confirm
  To revert, set env: UM_EMBEDDING_PROVIDER=openai
                      UM_EMBEDDING_MODEL=text-embedding-3-small
```

The reindex CLI is a separate process from the running server. Operator
workflow:

```bash
# 1. Stop the server
docker compose stop universal-memory

# 2. Update server/.env with the new embedding provider/model (already done
#    if you've already attempted to start v0.7 and seen the refuse-message)

# 3. Run the reindex CLI from the host (must reach the same Qdrant the
#    server uses); --confirm acknowledges the cost estimate
um-cli reindex --confirm

# 4. Restart the server; startup guard reads the new stamp → match → continue
docker compose start universal-memory
```

The reindex CLI rebuilds into a new Qdrant collection, atomically swaps the
canonical alias, and writes the new stamp before the swap. If interrupted,
re-run with `--resume` — checkpoint state lives at
`$UM_VAULT_DIR/.um/reindex-state.json`. Cross-provider embedding fallback is
**deliberately not supported** — different latent space + different dim = silent
index corruption — so the "switch embedding provider, then reindex" path is the
only supported way to change embeddings post-install.

There is no `--ignore-stamp` escape hatch in the server. To bypass, you must
manually delete the stamp doc — explicitly destructive, hard to do by accident.

---

## v0.5 → v0.6

### Breaking: `/api/list` response envelope

Before (v0.5): `GET /api/list` returned a bare JSON array.

```bash
$ curl http://localhost:6335/api/list
[{"id":"...","text":"...","metadata":{...}}, ...]
```

After (v0.6): returns `{results: [...]}` matching `/api/search` and `/api/recent`.

```bash
$ curl http://localhost:6335/api/list
{"results":[{"id":"...","text":"...","metadata":{...}}, ...]}
```

Why: consistency across list-shape endpoints; future-proofs for additive top-level siblings (`provider`, `latency_ms` in v0.7+) without another shape change.

### Breaking: unified §5.1 error envelope on every endpoint (Task B.13)

Before (v0.5): error responses were ad-hoc — most paths emitted `{error:
'<message>'}`, a few emitted `{schema_version: 1, ok: false, error:
'<message>'}`, and `/mcp` tool errors returned plain `"Error: <msg>"` text.

```bash
$ curl http://localhost:6335/api/search -d '{}'   # missing query
{"error":"query is required"}
```

After (v0.6): every 4xx/5xx response from `/api/*` and the inner text content
block of `/mcp` tool errors uses the §5.1 unified envelope with a stable §5.2
error code:

```bash
$ curl http://localhost:6335/api/search -d '{}'
{"ok":false,"error":{"code":"INPUT_INVALID","message":"query is required","retryable":false}}
```

Stable `code` values use one of six prefix-groups: `AUTH_*` (auth), `INPUT_*`
(caller-shape errors), `STATE_*` (vault/memory ID state), `LIMIT_*` (rate/cap),
`UPSTREAM_*` (downstream dependencies), `SERVER_*` (server-internal). Full
table in `docs/plans/2026-04-24-v0.6-design.md` §5.2.

`/mcp` JSON-RPC also gains a dual-shape: outer JSON-RPC `error.code` is a
numeric `-32xxx` value mapped from the string code (parse-error / method-
not-found at the transport layer), AND the inner `result.content[0].text`
carries the unified envelope as a JSON string (tool-level errors).

**Action for clients:** update error parsing to read `body.error.code` (string)
or `body.error.message` (human-readable) instead of the old `body.error`
(formerly the message itself). The `retryable` boolean is a new affordance —
clients can use it to decide whether to retry without baking in code-by-code
knowledge.

### Breaking: auth required + loopback-only surfaces

Four additional breaking changes ship in v0.6. All are related to hardening the
server's network surface.

- **`/openapi.yaml` (full spec) is now auth-required + loopback-only.** The
  `?gpt=1` variant (trimmed spec for GPT plugin discovery) remains exempt.
  Off-loopback requests without a valid `Authorization: Bearer <token>` header
  receive `401 AUTH_REQUIRED`. The query-string-param variant
  (`/openapi.yaml?gpt=1`) continues to require no auth so that GPT and Claude
  plugin manifests can pull the spec anonymously.

- **`UM_AUTH_TOKEN` is now a required env var for non-loopback operation.**
  `install.sh` generates a random 64-hex token at first install and writes it
  to `server/.env` and `~/.um/auth-token`. On loopback (localhost / 127.0.0.1 /
  ::1) with no forwarded-for proxy headers, auth is skipped by default
  (`UM_ALLOW_LOOPBACK_NOAUTH=true`). Any request from a routable address
  without a valid bearer token gets `401 AUTH_REQUIRED`.

- **Mixed-version caveat (v0.5 plugin + v0.6 server on non-loopback).** If you
  upgraded the server to v0.6 but have not yet re-installed the CLI plugin,
  requests from non-loopback hosts (tunnel-fronted Docker, published port) will
  silently `401` on every call. See the retrofitted CLIs section below for the
  remediation path.

- **Request-body cap (`UM_HTTP_MAX_REQUEST_BYTES`, default 2 MB).** Requests
  whose body exceeds the cap are rejected early with `413 INPUT_TOO_LARGE`
  before reaching any route handler. The cap applies to all `POST` and `PUT`
  endpoints. Increase via env var if you legitimately need larger bodies (e.g.
  bulk-import scripts).

- **`/metrics` is default-secure.** When `UM_METRICS_LOOPBACK_ONLY=true`
  (the default), `/metrics` returns `404` for any off-loopback request.
  When the flag is false and the source is non-loopback, bearer auth is
  required (`UM_METRICS_AUTH_REQUIRED` auto-true). Prometheus scrapers on the
  same host are unaffected.

### Per-endpoint error-shape changes

All 12 REST/MCP endpoints now emit the unified §5.1 error envelope described
in the existing "unified §5.1 error envelope" section above. The examples below
show the concrete before/after `curl` pairs for each endpoint.

**Convention:** examples use `$UM_AUTH_TOKEN` to reference the bearer token.
Set it in your shell before running: `export UM_AUTH_TOKEN=$(cat ~/.um/auth-token)`.
On loopback, the `Authorization` header is optional (skipped by
`UM_ALLOW_LOOPBACK_NOAUTH`); include it for correctness and to match
non-loopback behavior.

#### `POST /api/search`

**Before (v0.5):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"query":""}' http://localhost:6335/api/search
{"error":"query is required"}
```

**After (v0.6):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       -d '{"query":""}' http://localhost:6335/api/search
{"ok":false,"error":{"code":"INPUT_INVALID","message":"query is required","retryable":false}}
```

#### `GET /api/search`

**Before (v0.5):**
```bash
$ curl -s 'http://localhost:6335/api/search?query='
{"error":"query is required"}
```

**After (v0.6):**
```bash
$ curl -s -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       'http://localhost:6335/api/search?query='
{"ok":false,"error":{"code":"INPUT_INVALID","message":"query is required","retryable":false}}
```

#### `POST /api/add`

**Before (v0.5):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -d '{}' http://localhost:6335/api/add
{"error":"text is required"}
```

**After (v0.6):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       -d '{}' http://localhost:6335/api/add
{"ok":false,"error":{"code":"INPUT_INVALID","message":"text is required","retryable":false}}
```

#### `GET /api/list`

**Before (v0.5):** bare array + ad-hoc error string.
```bash
$ curl -s http://localhost:6335/api/list
[{"id":"...","text":"...","metadata":{}}]

# error path
{"error":"upstream failure"}
```

**After (v0.6):** `{results:[...]}` envelope (see also the list-envelope section
above) + unified error on failure.
```bash
$ curl -s -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       http://localhost:6335/api/list
{"results":[{"id":"...","text":"...","metadata":{}}]}

# error path
{"ok":false,"error":{"code":"UPSTREAM_FAILURE","message":"mem0 unavailable","retryable":true}}
```

#### `GET /api/recent/{project}`

**Before (v0.5):**
```bash
$ curl -s http://localhost:6335/api/recent/nonexistent-project
{"error":"project not found"}
```

**After (v0.6):**
```bash
$ curl -s -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       http://localhost:6335/api/recent/nonexistent-project
{"ok":false,"error":{"code":"STATE_NOT_FOUND","message":"project not found","retryable":false}}
```

#### `POST /api/reindex`

**Before (v0.5):**
```bash
$ curl -s -X POST http://localhost:6335/api/reindex
{"error":"reindex already in progress"}
```

**After (v0.6):**
```bash
$ curl -s -X POST \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       http://localhost:6335/api/reindex
{"ok":false,"error":{"code":"STATE_LOCK_CONTENTION","message":"reindex already in progress","retryable":true}}
```

#### `GET /api/state/{project}`

**Before (v0.5):**
```bash
$ curl -s http://localhost:6335/api/state/unknown-project
{"error":"state file not found"}
```

**After (v0.6):**
```bash
$ curl -s -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       http://localhost:6335/api/state/unknown-project
{"ok":false,"error":{"code":"STATE_NOT_FOUND","message":"state file not found","retryable":false}}
```

#### `POST /api/append-turn`

**Before (v0.5):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"project":"x","content":"hi"}' \
       http://localhost:6335/api/append-turn
{"error":"role is required"}
```

**After (v0.6):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       -d '{"project":"x","content":"hi"}' \
       http://localhost:6335/api/append-turn
{"ok":false,"error":{"code":"INPUT_INVALID","message":"role is required","retryable":false}}
```

#### `POST /api/checkpoint`

**Before (v0.5):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -d '{}' http://localhost:6335/api/checkpoint
{"error":"project is required"}
```

**After (v0.6):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       -d '{}' http://localhost:6335/api/checkpoint
{"ok":false,"error":{"code":"INPUT_INVALID","message":"project is required","retryable":false}}
```

#### `POST /api/delete`

**Before (v0.5):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -d '{}' http://localhost:6335/api/delete
{"error":"id is required"}
```

**After (v0.6):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       -d '{}' http://localhost:6335/api/delete
{"ok":false,"error":{"code":"INPUT_INVALID","message":"id is required","retryable":false}}
```

#### `DELETE /api/{id}`

**Before (v0.5):**
```bash
$ curl -s -X DELETE http://localhost:6335/api/no-such-id
{"error":"memory not found"}
```

**After (v0.6):**
```bash
$ curl -s -X DELETE \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       http://localhost:6335/api/no-such-id
{"ok":false,"error":{"code":"STATE_NOT_FOUND","message":"memory not found","retryable":false}}
```

#### `POST /mcp` (JSON-RPC + inner content block)

`/mcp` has a dual-shape error surface: the outer JSON-RPC layer and the inner
tool-result content block.

**Outer JSON-RPC error (transport / method layer) — before (v0.5):**
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}' \
       http://localhost:6335/mcp
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: no_such_tool"}}
```

**Outer JSON-RPC error (transport / method layer) — after (v0.6):**
Same numeric codes (`-32601` method-not-found, `-32602` invalid-params,
`-32603` internal, `-32000` series for server errors). No change to the
outer envelope — JSON-RPC 2.0 compliance is preserved.
```bash
$ curl -s -X POST -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $UM_AUTH_TOKEN" \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}' \
       http://localhost:6335/mcp
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: no_such_tool"}}
```

**Inner content block (tool-level error) — before (v0.5):** plain error string.
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "Error: query is required" }
    ]
  }
}
```

**Inner content block (tool-level error) — after (v0.6):** `content[0].text`
carries the §5.1 envelope as a JSON string.
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"ok\":false,\"error\":{\"code\":\"INPUT_INVALID\",\"message\":\"query is required\",\"retryable\":false}}"
      }
    ]
  }
}
```

**Action for MCP clients:** parse `content[0].text` as JSON; check `ok` before
consuming the result. The `retryable` boolean lets clients back off automatically
without a code-by-code allowlist.

### Environment variable manifest

All v0.6 env vars with their defaults and purpose. These live in `server/.env`
(Docker) or the shell environment (direct-run). `install.sh` writes the
mandatory vars on first install; optional vars are commented stubs.

| Env | Default | Purpose |
|---|---|---|
| `UM_AUTH_TOKEN` | (generated at install) | Bearer token for `/api/*` + `/mcp` |
| `UM_ALLOW_LOOPBACK_NOAUTH` | `true` | Skip auth when source is loopback AND no proxy headers |
| `UM_RATE_LIMIT_RPM` | `60` | Sustained requests per minute per IP |
| `UM_RATE_LIMIT_BURST` | `10` | Burst capacity per IP |
| `UM_RATE_LIMIT_MAX_IPS` | `10000` | Bounded-map cap with LRU eviction |
| `UM_METRICS_LOOPBACK_ONLY` | `true` | `/metrics` returns 404 off loopback when true |
| `UM_METRICS_AUTH_REQUIRED` | (auto-true when loopback-off) | Require bearer on `/metrics` when public |
| `UM_OPENAPI_AUTH_REQUIRED` | `true` | Full openapi spec auth-required; `?gpt=1` variant stays exempt |
| `UM_LOG_LEVEL` | `info` | pino log level (`bridge`/CI set `debug`) |
| `UM_HTTP_MAX_REQUEST_BYTES` | `2097152` | Request-body cap in bytes (fires `INPUT_TOO_LARGE` on excess) |
| `UM_LOCK_LOW_DISK_THRESHOLD` | `104857600` | Under this bytes, stale-lockdir recovery drops 10 min → 2 min |
| `UM_UPSTREAM_RETRY_MAX` | `3` | mem0/qdrant retry count before `UPSTREAM_FAILURE` |
| `UM_BRIDGE_MAX_PER_RUN` | `50` | Per-tick session cap; first-run backfill spans multiple ticks |
| `UM_BRIDGE_JITTER_SEC` | `600` | CLI startup jitter (launchd/cron consumer; systemd uses native `RandomizedDelaySec`) |

### Token rotation recipe

To rotate `UM_AUTH_TOKEN` without reinstalling:

```bash
# Linux / macOS / Git Bash on Windows
NEW_TOKEN=$(openssl rand -hex 32)
sed -i "s/^UM_AUTH_TOKEN=.*/UM_AUTH_TOKEN=${NEW_TOKEN}/" .env
echo "$NEW_TOKEN" > ~/.um/auth-token && chmod 600 ~/.um/auth-token
docker compose restart   # or: systemctl --user restart um-server
```

> **macOS note:** BSD `sed` requires an explicit backup suffix: `sed -i ''
> "s/..."`. **Git Bash on Windows:** `sed -i` works if Git for Windows is
> installed; PowerShell users can use
> `(Get-Content .env) -replace '^UM_AUTH_TOKEN=.*',"UM_AUTH_TOKEN=$NEW_TOKEN" | Set-Content .env`.

The `~/.um/auth-token` file is the install contract (B.4): `install.sh` writes
the token there and appends a marker-block trailer to your shell rc
(`~/.bashrc` / `~/.zshrc`) that `export`s `UM_AUTH_TOKEN` from that file on
every new shell. After rotating, **re-source your rc** or open a new terminal
so the updated token is exported:

```bash
source ~/.bashrc   # or ~/.zshrc
```

CLIs auto-pick up the new token on the next shell session without any further
action.

### Retrofitted CLI wrappers

> **Note:** the v0.6 plan originally listed 9 retrofitted CLIs; the actual
> retrofit in B.7 covered **6 CLIs** (the ones that call non-loopback-safe
> endpoints). The list below reflects the current state.

Six shell CLIs gained automatic `UM_AUTH_TOKEN` injection (sourced from
`~/.um/auth-token` via the marker-block trailer) in v0.6:

| CLI | Endpoint(s) | Upgrade note |
|---|---|---|
| `um-list.sh` | `GET /api/list` | Requires `UM_AUTH_TOKEN` on non-loopback; auto-sourced after re-install |
| `um-recent.sh` | `GET /api/recent/{project}` | Same; also gains `{results:[...]}` envelope in output parsing |
| `um-search.sh` | `POST /api/search` | Requires `UM_AUTH_TOKEN`; error shape updated to §5.1 |
| `um-state.sh` | `GET /api/state/{project}` | Requires `UM_AUTH_TOKEN` on non-loopback |
| `um-forget` | `DELETE /api/{id}` + `POST /api/reindex` | Two-step; both calls now send bearer token |
| `um-supersede` | `DELETE /api/{id}` + `POST /api/add` + `POST /api/reindex` | Three-step; all calls now send bearer token |

**Silent-401 warning:** If you upgraded the server to v0.6 but kept the v0.5
plugin CLIs (i.e. did not re-run `installer/install.sh --cli`), non-loopback
installs (tunnel-fronted server, Docker with a published port) will **silently
401 on every request** — the CLI exits non-zero but may not surface the auth
error clearly. The marker-block trailer in your shell rc handles this
automatically AFTER you re-source the rc or open a new terminal; before that,
manually export the token:

```bash
export UM_AUTH_TOKEN=$(cat ~/.um/auth-token)
```

Then re-run the install to pick up the updated wrappers:

```bash
bash installer/install.sh --cli
source ~/.bashrc   # or ~/.zshrc
```

---

## v0.4.0-alpha → v0.5.0-alpha

Four changes worth knowing about. None are breaking for existing Claude Code
users — all are additive or fix silent regressions.

### 1. New write tool `memory_append_turn`

Non-CC surfaces (Claude.ai, ChatGPT Desktop, Codex) can now append
conversation turns to the raw-capture pipeline via the `memory_append_turn`
MCP tool or `POST /api/append-turn` REST endpoint. The three required args are
`project`, `content`, and `role` (`user`/`assistant`/`system`).

This is distinct from:
- `memory_add` — runs mem0's fact-extractor; no project structure, no raw
  capture, no session-end pipeline.
- `memory_capture` — writes a stable authored document with full frontmatter;
  appropriate for ADRs, canonical docs, anything that needs a stable ID and
  versioning.

Use `memory_append_turn` when you want turn-level capture that feeds into
`memory_checkpoint`'s synthesis pipeline. If your rubric (system prompt paste-in
for Claude.ai / ChatGPT Desktop / Custom GPT setups) is re-pasted from the
current `docs/memory-routing-rubric.md`, it will already include the new
`memory_append_turn` routing clause.

### 2. `memory_checkpoint` server-side body

`memory_checkpoint` is no longer a stub. In v0.4 it returned an actionable
error pointing at `/um-checkpoint` or `hooks/session-end.sh`. In v0.5 it
executes the full session-end pipeline: reads raw captures → LLM-summarizes →
writes to `sessions/<project>/` → merges into `state/<project>/state.md` →
re-indexes into mem0.

Claude Code users are unaffected — the hook-driven pipeline is unchanged.
Claude.ai / ChatGPT Desktop / Codex users gain the ability to trigger session
summaries and `state.md` refreshes directly via MCP.

**Important caveat:** if `UM_SUMMARIZER=claude-agent-sdk` is set in
`server/.env`, the server-side checkpoint will fall back to `openai`/`ollama`
with a warning log — Docker cannot spawn a host-side Claude Code process.
Recommendation: set `UM_SUMMARIZER=openai` or `UM_SUMMARIZER=ollama` in
`server/.env` to use the server-side path cleanly. The `claude-agent-sdk` mode
remains valid for hook-driven summarization in the CC plugin (which spawns CC
directly).

### 3. Modular install

`install-cli.sh` continues to work exactly as before (backward-compat). No
changes needed for existing CLI-only installs.

The new entry point `install.sh` now supports composable component flags:

```bash
bash installer/install.sh --server          # server only
bash installer/install.sh --plugin-cc       # CC plugin only
bash installer/install.sh --plugin-codex    # Codex plugin only
bash installer/install.sh --cli             # CLI only
bash installer/install.sh --all             # everything
bash installer/install.sh                   # interactive wizard if TTY, else equivalent to --all
bash installer/install.sh --yes             # skip all prompts
bash installer/install.sh --dry-run         # print actions without executing
```

Existing v0.4 invocations of `installer/install.sh` with no flags continue to
work (the wizard fires only when stdin is a TTY and no flags are present).

**After upgrade:** restart Claude Code (quit + relaunch) so the updated plugin loads. CC reads plugin manifests at startup; a running session continues to use the old plugin until restart.

### 4. `UM_PROMPT_DIR` env var (non-breaking)

The installer now writes a `UM_PROMPT_DIR` export to the managed block in
`~/.bashrc`/`~/.zshrc` for plugin-cc installs. `hooks/lib/summarize.sh` and
`update-state.sh` read the summarize and state-update prompts from that
directory; if `UM_PROMPT_DIR` is unset, they fall back to the plugin-local
`hooks/lib/prompts/` directory as before.

This means re-running the installer (to pick up the new managed block) will
eliminate prompt drift between the CC plugin and any server-side prompt path.
Re-install is optional — existing installs continue to work with the fallback.

**Known limitations (deferred to v0.6):**
- Cross-process concurrent-write coordination between Claude Code's stop.sh
  (perl Fcntl::flock) and the node server's memory_append_turn (proper-lockfile)
  uses different lock mechanisms. Corruption risk is practically low (stop.sh
  writes <10ms) but cross-language coordination is a v0.6 hardening item.

---

### Rollback from v0.5 to v0.4

All v0.5 changes are additive — new tool (`memory_append_turn`), new env var (`UM_PROMPT_DIR`), new installer flags, real `memory_checkpoint` body replacing the v0.4 stub. There are NO vault schema changes: `captures/`, `sessions/`, `state/` directories are unchanged.

To rollback: `git checkout v0.4.0-alpha` on the server repo and redeploy the Docker stack. The client plugin at `~/.claude/plugins/universal-memory/` can be reinstalled via `installer/install-cli.sh` from v0.4. Existing vault data stays compatible.

The only consideration: any raw captures written via `memory_append_turn` (v0.5-only tool) will still be present in `captures/<project>/raw/<date>.md` as v0.5-format headers (`## <ISO> <role> [(conversation_id: ...)]`). The v0.4 session-end summarizer treats any `## ` line as a turn header and accepts them. No cleanup needed.

---

### Closing note for v0.4 → v0.5

No database migrations, no config-file rewrites, no plugin reinstall required.
Re-installing (`bash installer/install.sh --plugin-cc`) will pick up the new
`UM_PROMPT_DIR` managed-block entry; hooks gracefully default to the
plugin-local `prompts/` directory if `UM_PROMPT_DIR` is unset. The vault
filesystem layout is unchanged.

---

## v0.3.0-alpha → v0.4.0-alpha

Four user-visible changes need attention. Two are breaking for programmatic
consumers of UM's REST / MCP surface; one is a behavior change on
`memory_recent`; one is a cosmetic install-docs pivot.

### 1. REST response shapes changed (breaking)

**What changed.** `/api/search`, `/api/list`, and `/api/recent/{project}`
now return compact `{id, title, score, snippet}` by default. The full
`body` + `metadata` fields are no longer sent unless you ask for them.

**Who's affected.** Any script, agent, or integration that parses `body`
or `metadata` from these endpoints.

**Fix.** Append `?full=1` to the query string.

```bash
# v0.3 — full body every time
curl -s "http://localhost:6335/api/search?query=foo&limit=5"

# v0.4 default — compact snippet
curl -s "http://localhost:6335/api/search?query=foo&limit=5"

# v0.4 — opt into v0.3 behavior
curl -s "http://localhost:6335/api/search?query=foo&limit=5&full=1"
```

**Why.** Tool-call context in LLM surfaces is expensive. Compact shape
cuts 41.9% of single-hop read context against the v0.3 baseline. Clients
that genuinely need full bodies get them with one extra query param.

### 2. MCP response shapes + tool visibility (breaking)

**What changed.**

1. `memory_search`, `memory_list`, `memory_recent` return compact shape by
   default. Pass `full: true` in tool arguments to opt back in.
2. `tools/list` returns 4 tools by default — the 4 reads. The 7 write
   tools (`memory_add`, `memory_append_turn`, `memory_capture`,
   `memory_checkpoint`, `memory_delete`, `memory_forget`, `memory_supersede`)
   are filtered out of discovery unless `UM_MCP_WRITE_ENABLED=true` on
   the server.

**Who's affected.**

- MCP clients whose system prompt references "11 tools" or expects to see
  write tools in the discovery response.
- Clients that consume `memory_search` body content directly.

**Fix.**

1. For full bodies, pass `full: true` in `tools/call` arguments:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"foo","full":true}}}
   ```

2. To see writes in `tools/list`, set `UM_MCP_WRITE_ENABLED=true` in the
   server's `.env`, then `docker compose restart memory-server`. This has
   always been the gate for write *success*; now it's also the gate for
   write *visibility*.

**Why.** Reading `memory_search` responses one screenful at a time without
compact snippets eats 40%+ of useful LLM context. Hiding writes by default
also reduces accidental footgun surface for non-operator clients that
discover tools dynamically.

### 3. `memory_recent` semantics changed (behavior change)

**What changed.** `memory_recent` used to wrap
`memory_search('session_summary', ...)` — mem0 vector-scored results
tagged as session summaries. It now reads the filesystem directly
(mtime-sorted, newest first) via the same code path as
`GET /api/recent/{project}`.

**Who's affected.** Anyone who relied on the vector-scored ordering or the
implicit "only session_summary type" filter.

**Fix.** The `project` argument is now required (previously implicit).
Pass a project name or slug. Pass `full: true` to get bodies instead of
snippets.

**Why.** Filesystem mtime is monotonic, cheap, and deterministic.
Vector-scored "recent" was semantically confusing — why would a
three-month-old doc score higher than yesterday's? REST parity via
`/api/recent/{project}` is new in v0.4.

### 4. Install docs pivot (cosmetic)

**What changed.** `installer/install-cli.md` describes the install method
as `git clone + bash installer/install-cli.sh` rather than a single-file
`curl | bash` URL.

**Who's affected.** Anyone following older docs that pointed at a
release-asset `install-cli.sh` URL.

**Fix.** Clone the repo at the `v0.4.0-alpha` tag, then run the installer:

```bash
git clone --branch v0.4.0-alpha https://github.com/goldenwo/universal-memory
cd universal-memory
bash installer/install-cli.sh
```

**Why.** The CLI installer needs access to the full repo layout to copy
libs and subcommand scripts. Self-bootstrapping `curl | bash` for the CLI
is deferred to a future release. The server installer
(`installer/install.sh`) still supports `curl | bash` — it clones
internally.

### Closing note

No database migrations, no config-file rewrites, no plugin reinstalls —
just the above. The vault filesystem layout is unchanged.
