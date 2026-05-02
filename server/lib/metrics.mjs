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

export const lockContentionsTotal = new promClient.Counter({
  name: 'um_lock_contentions_total',
  help: 'Lock contention events by lock-path',
  labelNames: ['lock_path'],
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
