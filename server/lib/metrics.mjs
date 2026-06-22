// server/lib/metrics.mjs
//
// prom-client Registry with explicit 5 named metrics (spec §4.2).
//
// DO NOT call collectDefaultMetrics() — process/GC/eventloop metrics
// would balloon /metrics body from ~2KB to ~15KB and add a
// recon-via-label-inventory signal. Cron scrapes don't care; 15s-cadence
// Prometheus accumulates the waste.
//
// Cardinality discipline (cap N1):
//   - The `endpoint` label is ALWAYS the route template
//     (e.g., '/api/recent/:project'), NEVER raw expanded paths.
//     Per-project slugs explode label cardinality.
//   - Same discipline as C.3 logging: caller computes routeTemplate,
//     passes it here. The endpoint-class router (B.2) is the source.
//
// prom-client throws synchronously on label-shape violations (label
// not in initial labelset). The observability-never-500s wrapper
// (C.9) will catch this so a metrics-emit failure never poisons the
// request path. Test pins this prom-client behavior so the wrapper's
// existence is justified.
//
// v0.7+ note: this module is the single point through which metrics
// flow. An OpenTelemetry-aware emitter can swap the backend without
// touching call sites — same abstraction invariant the logger holds.
//
// NOTE: registry's `supports.embeddings` (plural) ≠ metric label `embed` (singular).
// Spec §8.3 mandates singular metric labels. Use SURFACES.* never the literal strings.

import * as promClient from 'prom-client';

/**
 * Provider-metric name constants (spec §8.3).
 * Surface modules (embed/facts/summarize) import these instead of duplicating
 * literal strings; a typo regresses to a compile/lookup error rather than a
 * silent un-scraped metric.
 */
export const PROVIDER_METRICS = Object.freeze({
  TOKENS_TOTAL: 'um_provider_tokens_total',
  COST_USD_TOTAL: 'um_provider_cost_usd_total',
  REQUEST_DURATION_SECONDS: 'um_provider_request_duration_seconds',
  ERRORS_TOTAL: 'um_provider_errors_total',
});

/**
 * Default no-op metrics sink used when callers don't inject `ctx.metrics`.
 * Production paths without a wired prom-client adapter still complete normally;
 * the orchestrators only depend on the duck-typed `{ counter, histogram }` shape.
 */
export const NOOP_METRICS = Object.freeze({
  counter: () => {},
  histogram: () => {},
});

/**
 * Surface-label enum for um_provider_* metrics (spec §8.3).
 *
 * Bridges the naming gap between the provider registry's capability key
 * `supports.embeddings` (PLURAL) and the metric label `embed` (SINGULAR).
 * Always reference SURFACES.* — never the literal strings — so a typo or
 * future drift fails loudly at import time.
 */
export const SURFACES = Object.freeze({
  EMBED: 'embed',           // singular per spec §8.3 metric label (not 'embeddings')
  SUMMARIZER: 'summarizer',
  FACTS: 'facts',
});

export const registry = new promClient.Registry();

export const httpRequestsTotal = new promClient.Counter({
  name: 'um_http_requests_total',
  help: 'HTTP request count by endpoint and status',
  labelNames: ['endpoint', 'status'],
  registers: [registry],
});

export const httpRequestDurationSeconds = new promClient.Histogram({
  name: 'um_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['endpoint'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const mem0OpsTotal = new promClient.Counter({
  name: 'um_mem0_ops_total',
  help: 'mem0 op count by op-name and status',
  labelNames: ['op', 'status'],
  registers: [registry],
});

export const mcpToolCallsTotal = new promClient.Counter({
  name: 'um_mcp_tool_calls_total',
  help: 'MCP tool invocation count by tool-name and status',
  labelNames: ['tool', 'status'],
  registers: [registry],
});

// Gap-3 OAuth: which auth branch admitted a request (spec §4.2 — /mcp auth is an
// OR of legacy-bearer and OAuth-token verification). `branch` ∈ {'legacy','oauth'}
// — fixed enum, never user input (bounded cardinality). Lets ops confirm the
// OAuth path is actually being exercised post-flip without log-grepping.
export const umMcpAuthBranchTotal = new promClient.Counter({
  name: 'um_mcp_auth_branch_total',
  help: 'Auth-branch that admitted a request (Gap-3): legacy bearer vs OAuth token',
  labelNames: ['branch'], // 'legacy' | 'oauth'
  registers: [registry],
});

// Gap-3 OAuth: RFC 7591 Dynamic Client Registration outcomes (spec §4.1 register
// row, §6 item 1). `outcome` ∈ {'accepted','rejected_redirect','rejected_metadata',
// 'rejected_limit'} — fixed enum, never user input (bounded cardinality). Lets ops
// confirm DCR is being exercised and watch the rejection mix (a spike in
// rejected_redirect = a vendor probing off-allowlist callbacks; rejected_limit =
// the registration cap is being hit and prune isn't keeping up).
export const umOauthRegistrationsTotal = new promClient.Counter({
  name: 'um_oauth_registrations_total',
  help: 'RFC 7591 DCR outcomes (Gap-3): accepted|rejected_redirect|rejected_metadata|rejected_limit',
  labelNames: ['outcome'],
  registers: [registry],
});

// Gap-3 OAuth PR-5 / Gap-4 bridge: consent-page outcomes (spec §6 item 12, plan Task 2.7).
// Two bounded label dimensions:
//   outcome ∈ {'allow','deny','bad_token','throttled','csrf_reject'} — fixed enum,
//     never user input (bounded cardinality: 5).
//   method ∈ {'token','idp'} — which consent path minted the allow:
//     'token' = operator-token paste / presence-cookie (handleConsent's terminal paths);
//     'idp'   = social-login IdP callback completed successfully (handleIdpCallback success).
// Emitted by handleConsent's terminal paths (method='token') and handleIdpCallback
// success (method='idp') via the injected onConsent callback so endpoints.mjs stays
// metrics-free (same callback-seam discipline as um_oauth_registrations_total). Lets
// ops watch the consent mix post-flip: a spike in csrf_reject = cross-origin/forged-
// CSRF probing the trust boundary; bad_token = wrong operator-token pastes; throttled =
// the global consent throttle (spec §6 item 9) is shedding load.
// CRITICAL: prom-client throws synchronously on a missing label — every emit MUST
// provide both {outcome, method}. The dispatcher defaults method='token' as insurance.
export const umOauthConsentTotal = new promClient.Counter({
  name: 'um_oauth_consent_total',
  help: 'OAuth consent-page outcomes (Gap-3 PR-5 / Gap-4): allow|deny|bad_token|throttled|csrf_reject, by method=token|idp',
  labelNames: ['outcome', 'method'],
  registers: [registry],
});

// Gap-4 bridge: social-login IdP callback outcomes (spec §6). Bounded:
//   provider ∈ configured IdP ids (today: 'github'); outcome ∈ {'success','mismatch','error','denied'}.
// 'mismatch' = authenticated at the provider but not THE operator; 'error' = provider
// exchange/identity failure; 'denied' = user cancelled/denied at the IdP (provider returned
// ?error with no code). Emitted by handleIdpCallback via the onIdpOutcome callback.
export const umOauthIdpTotal = new promClient.Counter({
  name: 'um_oauth_idp_total',
  help: 'Social-login IdP callback outcomes (Gap-4): success|mismatch|error|denied, by provider',
  labelNames: ['provider', 'outcome'],
  registers: [registry],
});

// Gap-3 OAuth PR-5: token-endpoint grant outcomes (spec §6 item 12, plan Task 2.7).
// Two bounded label dimensions:
//   grant_type ∈ {'authorization_code','refresh_token','unknown'} — 'unknown' is
//     used when grant_type is absent/un-parseable (malformed body before parse) or
//     not a supported value (unsupported_grant_type), so a hostile caller spraying
//     arbitrary grant_type strings can NEVER explode label cardinality.
//   outcome ∈ {'issued','invalid_grant','reuse_blocked','invalid_client',
//     'invalid_request','unsupported'} — fixed enum.
// Bounded cardinality: 3 × 6 = 18 combinations (most never co-occur).
// This counter SUBSUMES two spec §6 item-12 observability asks without extra
// counters: refresh-rotation success = {grant_type=refresh_token,outcome=issued};
// reuse-tripwire trips = {grant_type=refresh_token,outcome=reuse_blocked}.
// Emitted by handleToken's terminal paths via the injected onTokenGrant callback
// (endpoints.mjs stays metrics-free — same callback seam as the counters above).
export const umOauthTokenGrantsTotal = new promClient.Counter({
  name: 'um_oauth_token_grants_total',
  help: 'OAuth token-grant outcomes (Gap-3 PR-5), by grant_type (authorization_code|refresh_token|unknown) and outcome (issued|invalid_grant|reuse_blocked|invalid_client|invalid_request|unsupported)',
  labelNames: ['grant_type', 'outcome'],
  registers: [registry],
});

export const lockContentionsTotal = new promClient.Counter({
  name: 'um_lock_contentions_total',
  help: 'Lock contention events by lock-path',
  labelNames: ['lock_path'],
  registers: [registry],
});

// Cross-surface dedup metrics (D1 spec §9, plan C.4).
// `kind` ∈ {'hash','embedding'} — which dedup layer fired.
// `result` ∈ {'hit','miss','error'} — outcome.
// `stage` ∈ {'scroll','search','setPayload',''} — which qdrant call attempted
//   when result='error'. Empty string for hit/miss (label is required-present
//   per prom-client; '' is the conventional don't-care value).
// Cardinality: 2 × 3 × 4 = 24 combinations (bounded). All caller-derived
// label values come from a fixed enum, never user input — A5 closed.
export const umDedupTotal = new promClient.Counter({
  name: 'um_dedup_total',
  help: 'Cross-surface dedup attempts, by layer (hash|embedding), outcome (hit|miss|error), and stage (scroll|search|setPayload|"")',
  labelNames: ['kind', 'result', 'stage'],
  registers: [registry],
});

// Answer-correctness eval grader (offline thermometer — spec 2026-06-22). NOT a
// hot-path counter; incremented only by the offline eval. `outcome` ∈
// {'answers','declines','parse_fail'} — fixed enum (bounded cardinality 3).
// answers/declines = a parsed verdict (memory does / does not answer); parse_fail =
// unparseable or invoke error (the grader's ok:false).
export const umAnswerGradedTotal = new promClient.Counter({
  name: 'um_answer_graded_total',
  help: 'Answer-correctness grader verdicts (offline eval): answers|declines|parse_fail',
  labelNames: ['outcome'],
  registers: [registry],
});

// Lane auto-classification outcomes at write time (Gap-5).
// `outcome` ∈ {'routed','omitted','error'} — fixed enum, never user input (bounded cardinality).
export const umLaneClassifiedTotal = new promClient.Counter({
  name: 'um_lane_classified_total',
  help: 'Lane auto-classification outcomes at write time (Gap-5).',
  labelNames: ['outcome'], // 'routed' | 'omitted' | 'error'
  registers: [registry],
});

// In-band supersession outcomes at write time (Gap-5 P3, ADR-0007 Option C).
// Counts ONLY the supersede-eligible in-band slice that reached the inline judge
// (flag-on + partitioned + cosine in the contradiction-overlap band). Normal
// keep-older dedup merges are NOT counted here — they remain under um_dedup_total.
// `outcome` ∈ {'superseded','declined','demote_error'} — fixed enum, never user
// input (bounded cardinality):
//   superseded   — judge confirmed; older point demoted, newer persisted current.
//   declined     — judge consulted but not a confident contradiction → kept-older.
//   demote_error — judge confirmed + newer persisted, but the demotion setPayload
//                  failed (fail-soft: newer is still current; older stays current
//                  for the session-end detector — never "no current fact").
export const umInbandSupersedeTotal = new promClient.Counter({
  name: 'um_inband_supersede_total',
  help: 'Write-time in-band supersession outcomes (Gap-5 P3): superseded|declined|demote_error',
  labelNames: ['outcome'],
  registers: [registry],
});

// Per-stage dedup overhead. Buckets target 1ms..2.5s — qdrant calls in the
// dedup hot path are typically <100ms; histogram resolves the long tail.
export const umDedupCheckDurationSeconds = new promClient.Histogram({
  name: 'um_dedup_check_duration_seconds',
  help: 'Per-stage dedup query duration in seconds, by kind and stage',
  labelNames: ['kind', 'stage'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

// Empty-extraction visibility (spec §6, §8 acceptance criteria).
// Sum of facts extracted PER call (not call count). Distinguishes "0 facts
// from 5 calls" (provider misconfig?) from "5 facts from 5 calls". Operator
// alert pattern: rate(um_facts_extracted_total[5m]) == 0 while
// um_provider_request_duration_seconds_count{surface="facts"} > 0.
export const umFactsExtractedTotal = new promClient.Counter({
  name: 'um_facts_extracted_total',
  help: 'Facts extracted by the facts() orchestrator, by provider and model',
  labelNames: ['provider', 'model'],
  registers: [registry],
});

// Provider-surface metrics (spec §8.3). The orchestrators (embed/facts/
// summarize) call `metrics.counter(...)` / `metrics.histogram(...)` via an
// injected adapter; production calls fall through to PROVIDER_METRICS_ADAPTER
// below which actually inc/observes these prom-client instances.
export const umProviderTokensTotal = new promClient.Counter({
  name: 'um_provider_tokens_total',
  help: 'Tokens consumed by provider invocations, by provider/model/surface/direction',
  labelNames: ['provider', 'model', 'surface', 'direction'],
  registers: [registry],
});

export const umProviderCostUsdTotal = new promClient.Counter({
  name: 'um_provider_cost_usd_total',
  help: 'USD cost of provider invocations, by provider/model/surface',
  labelNames: ['provider', 'model', 'surface'],
  registers: [registry],
});

export const umProviderRequestDurationSeconds = new promClient.Histogram({
  name: 'um_provider_request_duration_seconds',
  help: 'Provider invocation latency in seconds, by provider/model/surface',
  labelNames: ['provider', 'model', 'surface'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const umProviderErrorsTotal = new promClient.Counter({
  name: 'um_provider_errors_total',
  help: 'Provider invocation errors, by provider/model/surface/error_class',
  labelNames: ['provider', 'model', 'surface', 'error_class'],
  registers: [registry],
});

/**
 * Production metrics adapter for the orchestrators. Duck-types as
 * `{ counter, histogram }` (matching the NOOP_METRICS shape) and dispatches
 * by metric NAME to the appropriate prom-client instance.
 *
 * Why this shape: embed.mjs / facts.mjs / summarize.mjs were originally
 * written to receive a metrics adapter from each call site. v0.8 G2 found
 * that no production call site actually injects one, so the orchestrators
 * default to NOOP_METRICS — silent no-op. This adapter closes that gap by
 * being the real default. Tests can still inject a fake adapter (capturing
 * calls) or NOOP_METRICS (silence).
 *
 * Wrapped in try/catch because prom-client throws synchronously on
 * label-shape violations; observability MUST NOT poison the request path
 * (C.9 obs-fallback discipline).
 */
export const PROVIDER_METRICS_ADAPTER = Object.freeze({
  counter: (name, labels, value) => {
    try {
      switch (name) {
        case 'um_provider_tokens_total':
          umProviderTokensTotal.inc(labels, value);
          break;
        case 'um_provider_cost_usd_total':
          umProviderCostUsdTotal.inc(labels, value);
          break;
        case 'um_provider_errors_total':
          umProviderErrorsTotal.inc(labels, value);
          break;
        // Unknown counter name → silent.
      }
    } catch { /* fail-safe — observability MUST NOT poison the request path */ }
  },
  histogram: (name, labels, value) => {
    try {
      if (name === 'um_provider_request_duration_seconds') {
        umProviderRequestDurationSeconds.observe(labels, value);
      }
    } catch { /* fail-safe */ }
  },
});
