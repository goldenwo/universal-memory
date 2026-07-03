# mem0 Platform-compat facade

Universal-memory can speak the **mem0 Platform HTTP dialect**: a flag-gated set of
`/v1/*` + `/v2/*` routes that lets any existing mem0 Platform client — including the
OpenClaw Discord bot's `openclaw-mem0` memory plugin in `mode: "platform"` — use a
self-hosted UM server as its backend with **zero client changes**.

This document is the **canonical contract** for the facade (the design spec is a
gitignored working doc; this file is the versioned, public record). It pins the
contract oracle, documents the supported route/shape subset, the deliberate no-ops
and degradations, and the reconciliation procedure for when the oracle moves.

## What / why

Already running a mem0 Platform client? Adopting UM is three steps:

1. Enable the facade on your UM server (`UM_MEM0_COMPAT_ENABLED=true`).
2. Point the client's `baseUrl` (or host/endpoint setting) at your UM server.
3. Swap the mem0 API key for your `UM_AUTH_TOKEN`.

The facade is a **dialect adapter, not a second write path**: every compat route
translates to the same internals the REST and MCP surfaces call (`umAdd`, search,
list/delete helpers), so compat-written facts get UM's full quality pipeline
(extraction, dedup, supersession, lanes) and are recallable from every other
surface — and vice versa.

Implementation: [`server/lib/mem0-compat.mjs`](../server/lib/mem0-compat.mjs)
(pure filter parser + record projector + route handlers), wired via a flag-gated
endpoint-class row ([`server/lib/endpoint-class.mjs`](../server/lib/endpoint-class.mjs))
and the `Token|Bearer` auth extractor ([`server/lib/auth.mjs`](../server/lib/auth.mjs)).

## Enabling

```bash
# in the server's .env (default: false — the facade ships inert)
UM_MEM0_COMPAT_ENABLED=true
```

- **Flag off (default):** every `/v1/*` and `/v2/*` path hard-404s at the
  endpoint-class layer, **before auth** — byte-identical to a server without the
  feature. Flag off + a bad token → **404**, not 401 (a tested ordering invariant:
  the flag-off server does not reveal that the routes exist).
- **Auth:** every compat route requires `Authorization: Token <key>` **or**
  `Authorization: Bearer <key>` — mem0 SaaS clients send the `Token` scheme; both
  are accepted and validated against the **same `UM_AUTH_TOKEN`** as the rest of
  the server. Wrong/absent key → **401** (the client's `AuthError`).
- **No loopback bypass:** unlike `/health`, compat routes require auth even from
  127.0.0.1 — a mem0 client always sends its key, and docker-bridge peer addresses
  make loopback semantics misleading on containerized deployments anyway.
- **Rate limiting:** standard API treatment (the shared per-IP token bucket).
- **Error dialect:** `{"detail": "..."}` JSON with 400/401/404 status codes,
  matching the mem0 client's typed-error mapping.

## Adoption steps

### Any mem0 Platform client

1. `UM_MEM0_COMPAT_ENABLED=true` on the server, restart/recreate it.
2. Set the client's base URL to your UM server (e.g. `http://127.0.0.1:6337` or
   wherever the server listens).
3. Use your `UM_AUTH_TOKEN` as the API key.

### OpenClaw worked example

The `openclaw-mem0` plugin ships a platform mode — a plain HTTP client with a
configurable `baseUrl`. In `openclaw.json`:

```jsonc
{
  "plugins": {
    "mem0": {
      "mode": "platform",
      "baseUrl": "http://127.0.0.1:6337",   // the UM server (Pi deploy port)
      "apiKey": "<your UM_AUTH_TOKEN>"
    }
  }
}
```

Restart OpenClaw. The plugin's full runtime loop (autoRecall search, autoCapture
add, list/get/delete tools) then runs against UM. Its entity/event affordances
degrade gracefully (see [No-ops and degradations](#no-ops-and-degradations)).

## Route contract

The supported subset is pinned by the oracle client's own request-building and
response-parsing code (see [Contract oracle pin](#contract-oracle-pin)) — not by
mem0's public docs. Trailing slashes are part of the contract (the client sends
them). All handlers translate to the same internals the REST/MCP surfaces use.

| # | Route | Client sends | Client reads back | UM mechanism |
|---|---|---|---|---|
| R1 | `GET /v1/ping/` | — | any 200 JSON | liveness: `{status:"ok", name:"universal-memory", version}` |
| R2 | `POST /v1/memories/` | `{messages:[{role,content}], user_id?, agent_id?, app_id?, run_id?, metadata?, infer?, categories?, ...}` | `{results:[{id, memory, event}]}` | messages joined into ONE role-prefixed transcript (`user: ...\nassistant: ...`) → a single `umAdd` call (UM's extractor pulls multiple facts from a blob, preserving mem0's whole-conversation semantics); `results[]` carries real events (ADD/UPDATE/NONE from dedup). `infer:false` → the verbatim store path, one result per message. `agent_id`/`app_id`/`run_id`/`categories` stored into metadata; provenance from `X-Mem0-Source` (lowercased) else `mem0-compat`, into the standard `surfaces` attribution |
| R3 | `POST /v2/memories/search/` | `{query, top_k, threshold, filters?, rerank?, keyword_search?, fields?}` | `{results:[record...]}` | semantic search scoped to the operator; over-fetch `max(top_k*3, 30)` → facade-side filter → post-filter `score >= threshold` (default 0.3) → truncate to `top_k`. Superseded/system records never surface (read-path parity) |
| R4 | `POST /v2/memories/?page=&page_size=` | `{filters?}` | `{results:[record...]}` | full list scoped to the operator → facade-side filter → page/page_size window; `page_size` capped at **500** |
| R5 | `GET /v1/memories/{id}/` | — | one record | direct qdrant point fetch + operator scope check (foreign/absent/invalid id → uniform 404) |
| R6 | `PUT /v1/memories/{id}/` | `{text?, metadata?}` | updated record + `event:"UPDATE"` | direct qdrant ops (NOT `mem0.Memory.update`, which neither scope-checks nor preserves UM's payload schema): fetch → scope check → re-embed new text with the collection's stamped model → upsert the SAME point id preserving the full umAdd payload schema (`data`/`hash` refreshed; `surfaces`/`status`/`userId`/`createdAt` carried; `updatedAt` set). Deliberately bypasses dedup/supersession — an explicit user edit is authoritative (mem0 semantics). Protected payload keys (`userId`, `data`, `hash`, timestamps, supersession state) cannot be overwritten via `metadata` |
| R7 | `DELETE /v1/memories/{id}/` | — | `{message}` | scope-checked delete by id |
| R8 | `DELETE /v1/memories/?user_id=&agent_id=&app_id=&run_id=` | query params | `{message}` | facade-side scoped scan-then-delete-by-ids (O(N) by design at single-operator instance scale — NOT a new indexed delete path). Refuses when no recognized scope param is present. System docs (e.g. the embedding stamp) are never deleted |
| R9 | `DELETE /v2/entities/{type}/{id}/` | path | `{message}` | `user/<operator>` → same scan-delete as R8's user scope (foreign user id → 404, no leak); `agent`/`app`/`run` → scan filtered on the stored metadata key; unknown type → 400 |
| R10 | `GET /v1/entities/` | — | `{results:[{type,...}]}` | single-operator projection: exactly one `{type:"user", id:<operator>, total_memories}` entry |
| R11 | `GET /v1/events/`, `GET /v1/event/{id}/` | — | list / one object | empty list / 404 — UM has no SaaS ingestion-event concept; the client's event tools degrade to "no events" |

Unknown `/v1/*`/`/v2/*` paths (flag on): 404 in the compat dialect
(`{detail:"unknown compat route"}`).

## Filter subset

`filters` (R3/R4) is either a flat condition object or `{AND:[...]}` / `{OR:[...]}`
of flat conditions (`OR` at top level only — the oracle client emits it only via
passthrough extra-filters). Supported condition keys:

- `user_id` / `agent_id` / `app_id` / `run_id` — string equality
- `categories: {contains: <string>}`
- `created_at: {gte?: <ISO-8601>, lte?: <ISO-8601>}`

**Unknown filter keys → 400** (fail-loud beats a silently wrong result set; this is
also the runtime drift tripwire — see [Reconciliation](#reconciliation)).

**Application point (honest):** UM's internals expose no filtered retrieval, so
filters are applied **facade-side, post-retrieval**. R4/R8 filter over the full
list; R3 over-fetches (`max(top_k*3, 30)`), post-filters, then truncates to
`top_k`. **Under-fill caveat:** a highly-selective filter combined with a small
`top_k` can return fewer than `top_k` matching results even when more exist deeper
in the ranking. Accepted because the oracle client's steady-state search carries
only `user_id` — which matches everything on a single-operator instance. If a real
consumer later needs indexed filtering, that's a qdrant-payload-filter feature arc,
not a facade change.

## Record projection

Search/list/get results are projected to the mem0 dialect in one pure function
(`toMem0Record`):

```
{id, memory, score?, created_at?, updated_at?, categories, metadata, user_id?}
```

- **Name translation is explicit:** UM's internal payload is camelCase (`userId`,
  `createdAt`, `updatedAt`); the projector translates to the dialect's snake_case.
- `memory` = the fact text.
- `categories` is **synthesized** from UM's `metadata.lane` plus any categories
  stored at add time (deduped) — the client's category affordances degrade
  gracefully. Always present (`[]` when none; the client filters on it).
- Fields UM can't populate are **omitted, not null-stuffed** (the client uses `??`
  fallbacks throughout).
- `score` appears on search results only.

## No-ops and degradations

Accepted-but-ignored request parameters (documented no-ops — the client may send
them; they change nothing):

- `rerank` — UM returns its own ranking.
- `keyword_search` — semantic-only retrieval.
- `fields` — full records are always returned (the client reads what it needs).

Graceful degradations:

- **Entities (R10):** single-operator projection only — one `user` entry with a
  total count. No agent/app/run entity registry.
- **Events (R11):** always empty / 404 — UM has no SaaS ingestion-event pipeline;
  the client's event tools report "no events".
- Also out of scope (non-goals): orgs/projects, graph memory, webhooks, exports,
  feedback, batch endpoints, and any client SDK or plugin fork.

## Identity semantics

UM is **single-user-per-instance**. Compat requests may carry `user_id`; when
present anywhere (body, filters, R8 query params) it MUST equal the instance's
resolved operator id, else **400** with a clear `detail` — no impersonation, no
silent remap. `agent_id`/`app_id`/`run_id` are stored into metadata on write and
honored as metadata filters on read — best-effort partition parity without
inventing multi-tenancy.

**By-id no-leak rule (R5/R6/R7, R9 user scope):** every by-id operation fetches
the point and verifies its stored `userId` matches the operator; a foreign,
absent, or malformed id uniformly returns **404** — the existence of foreign
points is never disclosed (never 400, never acted on).

## Contract oracle pin

The facade's contract oracle is the **consuming client's source**, not mem0's API
docs — we implement exactly what a real client sends and reads.

- Oracle: plugin `openclaw-mem0`, version `1.0.6`
- Pinned file: `backend/platform.ts`, SHA-256 `e753e8769e309e491f898612634da7b1cffc0f2b6c6cc92940aba0255805b606`

The pin records the snapshot this facade (route table above, shape tests, and
fixtures) was derived from.

## Reconciliation

The oracle is a moving upstream. **On every plugin bump**, before trusting the
facade against the new version:

1. Re-diff the plugin's request builders and response parsing against the
   [route contract table](#route-contract). Grep targets in the plugin source:
   - `_request\(` — every outgoing call site (method, path, body shape)
   - `"/v1/` and `"/v2/` — route paths (new routes, changed trailing slashes)
   - field reads on returned records (e.g. `.memory`, `.id`, `.score`,
     `.created_at`, `.categories`, `.event`) — the read-back subset
2. Update the facade + shape tests (`server/test/mem0-compat-*.test.mjs`) for any
   drift; add table rows for new routes/fields.
3. Re-pin: update the version + SHA-256 above to the new snapshot.

Runtime drift detection is fail-loud by design: an unknown filter key 400s rather
than returning a silently wrong result set, and the S9 smoke
(`UM_SMOKE_MEM0_COMPAT=1` in [`server/test/smoke.sh`](../server/test/smoke.sh))
plus soak-period write counts surface behavioral drift.

## Extending the compat subset

When a new mem0-dialect client (or a new plugin version) needs a route or field
the facade doesn't speak yet:

1. **Pin from its parser**: read the client's request builder + response parsing
   for the new surface — that code, not documentation, defines the required shape.
2. **Add a shape test**: a fixture derived from the client source, asserting
   request-shape acceptance and response-shape fidelity
   (`server/test/mem0-compat-*.test.mjs`).
3. **Add a table row**: extend the [route contract table](#route-contract) with
   the route, what the client sends/reads, and the UM mechanism (including honest
   notes on any facade-side application or degradation).

## Flag lifecycle

`UM_MEM0_COMPAT_ENABLED` stays **opt-in through the soak period** of the first
live consumer (the OpenClaw bot flip). A default-on decision is the operator's
post-soak call (the OAuth-flip precedent). There is **no retirement path** — the
flag lives as long as mem0-dialect clients exist.

## Non-goal lift protocol

A non-goal listed in this document expires only via an explicit
"Superseded by <PR/issue> on <date>" note added here — never silently.
