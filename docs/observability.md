# Observability

Metrics, logging, and operator-facing diagnostic surfaces for universal-memory.

This doc focuses on the v0.7 `um_provider_*` Prometheus metric family — what each metric means, what its labels mean, how it relates to the existing v0.6 `um_mem0_ops_total` metric, and a few useful PromQL queries. It also captures the rationale behind one operator-facing CLI gate that's easy to misread without the design context: the reindex CLI's server-probe.

For the broader v0.6 metrics surface (`um_http_*`, `um_mem0_ops_total`, `um_mcp_tool_calls_total`, `um_lock_contentions_total`), see the registry in [`server/lib/metrics.mjs`](../server/lib/metrics.mjs).

---

## 1. Provider metric family (`um_provider_*`)

Spec reference: §8.3 of the v0.7 provider-neutrality design.

The `um_provider_*` family captures **LLM-call-level** cost, latency, and error signal across every provider-mediated surface (`embed`, `summarizer`, `facts`). Surface dispatch code (`server/lib/embed.mjs`, `server/lib/facts.mjs`, `server/lib/summarize.mjs`) wraps each provider call in a uniform metric-emit block, so a single dashboard can compare costs across OpenAI / Anthropic / Google / Ollama without per-provider conditionals.

### 1.1 Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `um_provider_tokens_total` | Counter | `provider`, `model`, `surface`, `direction` | Tokens consumed (`direction=in`) or produced (`direction=out`) by a provider call. Each call increments two series — one per direction. |
| `um_provider_cost_usd_total` | Counter | `provider`, `model`, `surface` | USD cost of provider calls, computed from `server/lib/pricing.mjs` × token counts. Free-tier providers (Ollama) emit zero-cost samples — the metric still fires so latency/error counters align across providers. |
| `um_provider_request_duration_seconds` | Histogram | `provider`, `model`, `surface` | Wall-clock latency of the provider SDK call (the awaited `complete()` / `embed()` / `extractFacts()` invocation). |
| `um_provider_errors_total` | Counter | `provider`, `model`, `surface`, `error_class` | Provider-call failures, classified by `error_class`. Values include the v0.6 error taxonomy plus three v0.7 provider-specific classes: `PROVIDER_CONFIG`, `PROVIDER_UPSTREAM`, `PROVIDER_RATELIMIT`. |

The metric names are exported as constants from [`server/lib/metrics.mjs`](../server/lib/metrics.mjs) under `PROVIDER_METRICS` — surface modules import these instead of duplicating string literals, so a typo regresses to a lookup error instead of a silent un-scraped metric.

### 1.2 The `surface` label convention (singular, not plural)

`surface` ∈ `{embed, summarizer, facts}` — **singular**, per spec §8.3. Specifically: the metric label is `embed`, **not** `embeddings`.

This deliberately differs from the provider-registry capability key, which uses the plural form (`provider.supports.embeddings === true`). The naming gap is intentional — registry capability keys describe what the provider can do; metric labels describe what surface emitted the call. Two different namespaces, two different conventions, one bridge.

The bridge is the `SURFACES` enum in [`server/lib/metrics.mjs`](../server/lib/metrics.mjs):

```js
export const SURFACES = Object.freeze({
  EMBED: 'embed',           // singular per spec §8.3 metric label (not 'embeddings')
  SUMMARIZER: 'summarizer',
  FACTS: 'facts',
});
```

Surface modules always reference `SURFACES.EMBED` etc. — never the literal strings — so a typo or future drift fails loudly at import time rather than silently emitting an un-scraped metric series with a misspelled label.

### 1.3 Production-emission status (as of v0.7)

| Surface | Orchestrator | Production-wired? | Notes |
|---|---|---|---|
| `summarizer` | `summarize()` in [`server/lib/summarize.mjs`](../server/lib/summarize.mjs) | **Yes — emits today.** | Called from `server/lib/checkpoint.mjs` and `server/lib/update-state.mjs`. Production scrapes will see series with `surface="summarizer"`. |
| `embed` | `embed()` in [`server/lib/embed.mjs`](../server/lib/embed.mjs) | Not yet. | Orchestrator and metric-emit code are complete and unit-tested; the production wiring (replacing the in-flight mem0-mediated embedder path with the surface orchestrator) is future work. Until then, no `surface="embed"` series will appear in production. |
| `facts` | `facts()` in [`server/lib/facts.mjs`](../server/lib/facts.mjs) | Not yet. | Same as embed — orchestrator ready, production call site pending. |

The surface modules are exercised by the registry-loop tests today, so the metric paths are verified; only the production call site is missing. This is by design — the surface orchestrators were landed first so the contracts are stable before the higher-risk wiring change.

---

## 2. Relationship to existing `um_mem0_ops_total` (v0.6)

The two metric families measure **different layers**, both fire for mem0-mediated surfaces (embed, facts), and neither is "authoritative" — they capture different facts.

| Metric | Layer | What it counts |
|---|---|---|
| `um_mem0_ops_total{op, status}` (v0.6) | mem0 client → Qdrant | Storage-level operations (`add`, `search`, `delete`). Status reflects Qdrant interaction success. |
| `um_provider_*` (v0.7) | mem0 client → LLM provider | LLM-call cost / latency / errors *within* an `add` or `search`. Status reflects provider-call success. |

A single `memory_add` call increments `um_mem0_ops_total{op="add"}` (one Qdrant write) **and** `um_provider_tokens_total{surface="facts"}` (one LLM call to extract facts). This is intentional — distinct semantics, distinct dashboards. For direct-dispatch summarizer (no mem0 layer), only `um_provider_*` fires.

When auditing cost-vs-storage anomalies, look at the two families together rather than treating either as canonical.

---

## 3. Sample PromQL queries

These are starting points for dashboards or ad-hoc investigation. Adjust window sizes (`5m`, `1h`, `1d`) to match your scrape cadence and retention.

### 3.1 Total spend per provider (last 24h)

```promql
sum by (provider) (
  increase(um_provider_cost_usd_total[24h])
)
```

Drill down by adding `model` or `surface` to the `by (...)` clause to see whether spend is dominated by a particular surface (e.g., facts extraction during heavy ingestion) or a particular model (e.g., a summarizer model promoted to a more expensive variant).

### 3.2 p95 latency by model (5-minute window)

```promql
histogram_quantile(
  0.95,
  sum by (model, le) (
    rate(um_provider_request_duration_seconds_bucket[5m])
  )
)
```

A spike in the p95 latency of a specific model is a strong early signal of upstream provider degradation — typically observable several minutes before error-rate climbs (the slow-then-fail pattern). Pair this with §3.3.

### 3.3 Error rate per surface (last 5 minutes)

```promql
sum by (surface) (
  rate(um_provider_errors_total[5m])
)
/
sum by (surface) (
  rate(um_provider_tokens_total[5m]) > 0
)
```

The denominator filter (`> 0`) avoids a divide-by-zero when a surface has no traffic in the window. For an alerting threshold, also slice by `error_class` — `PROVIDER_RATELIMIT` errors are usually self-clearing within minutes; `PROVIDER_UPSTREAM` errors are not.

---

## 4. Reindex CLI: server-probe gate semantics

The reindex CLI ([`cli/reindex.mjs`](../cli/reindex.mjs)) gates phase 1 (validate) on a probe of the API/memory server. The behavior is deliberately strict — strict enough that operators occasionally read it as a bug — so the rationale is documented here.

### 4.1 Behavior

In phase 1, after the no-op gate (stamp matches env → refuse), the validator probes `<serverProbeUrl>/api/state`. There are three outcomes:

1. **Server responsive** — refuse with `"server is responsive at <url>; stop it before reindex (the server holds connections to the source collection)"`. The operator must stop the server; otherwise its open Qdrant connections compete with the reindex process.
2. **Probe fails (typically `ECONNREFUSED`)** — refuse with `"could not probe server at <url>; pass --server-url=<url> to point at the right port, or --no-server-probe to skip the probe entirely (only safe if you have stopped the server manually)"`.
3. **Probe explicitly disabled** (`--no-server-probe`) — skip the probe, proceed to phase 1 step 3 (vault walk + estimate).

The relevant logic lives in `runPhase1Validate()` around lines 301–313 of `cli/reindex.mjs`.

### 4.2 Rationale for refusing on `ECONNREFUSED` rather than auto-continuing

`ECONNREFUSED` has multiple causes — server intentionally down, **wrong port**, **wrong host**, network issue, Docker daemon dead. Auto-proceeding on any of those would silently mask a misconfiguration and cause writes to land in an unintended collection. By the time the operator notices, the reindex has populated the wrong target with the wrong embeddings.

The friction of typing `--no-server-probe` is the point. It forces the operator to confront "yes, I know the server is down on purpose, and I am sure this is the reindex CLI talking to the Qdrant instance I think it is" before mutating data.

This is the same shape as v0.6 R1 from the design — the CLI prefers refusing with explicit-choices over silently doing-the-wrong-thing-by-default, even at the cost of a slightly noisier UX. The error message lists the two unambiguous escape hatches (`--server-url=<url>` to retry against a different port, `--no-server-probe` to acknowledge "intentionally stopped"), so the operator's next move is always one flag away.

If the friction proves excessive in practice, the right response is to make the probe error clearer — not to silently auto-continue.
