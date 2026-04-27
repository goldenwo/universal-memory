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

import * as promClient from 'prom-client';

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
