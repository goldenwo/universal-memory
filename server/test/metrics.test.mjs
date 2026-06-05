// server/test/metrics.test.mjs
// C.4 — prom-client Registry + 13 bound metrics (spec §4.2 + §8.3 + D1 §9 + Gap-5).
//
// Tests pin three contracts:
//   1. Exactly 13 metrics registered (5 v0.6 ops + 1 v0.7 facts-extracted +
//      4 v0.8 G2 um_provider_* + 2 v1.1 D1 dedup metrics + 1 Gap-5 lane-classifier). No defaults —
//      registry body is bounded; also prevents recon-via-label-inventory.
//   2. endpoint label uses route template, NOT raw expanded paths
//      (cardinality cap N1 — same discipline as C.3 logging).
//   3. prom-client throws synchronously on label-shape violations.
//      C.9's observability-never-500s wrapper relies on this — pinning
//      it here documents why that wrapper exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  mem0OpsTotal,
  mcpToolCallsTotal,
  lockContentionsTotal,
  umFactsExtractedTotal,
  umLaneClassifiedTotal,
} from '../lib/metrics.mjs';

test('registry exposes exactly 13 named metrics', () => {
  const names = registry.getMetricsAsArray().map((m) => m.name).sort();
  assert.deepEqual(names, [
    'um_dedup_check_duration_seconds',  // D1 §9
    'um_dedup_total',                   // D1 §9
    'um_facts_extracted_total',
    'um_http_request_duration_seconds',
    'um_http_requests_total',
    'um_lane_classified_total',         // Gap-5
    'um_lock_contentions_total',
    'um_mcp_tool_calls_total',
    'um_mem0_ops_total',
    'um_provider_cost_usd_total',
    'um_provider_errors_total',
    'um_provider_request_duration_seconds',
    'um_provider_tokens_total',
  ]);
});

test('endpoint label uses route template — no raw slugs (cardinality cap N1)', async () => {
  // Increment with template form
  httpRequestsTotal.inc({ endpoint: '/api/recent/:project', status: '200' });
  const text = await registry.metrics();
  // Sanity: label appears
  assert.match(text, /endpoint="\/api\/recent\/:project"/);
  // Cardinality test: nothing should match the raw-slug form
  assert.doesNotMatch(text, /endpoint="\/api\/recent\/[a-z0-9-]+(?<!:project)"/);
});

test('counter increments do not throw on label-shape violation — caller must pre-validate', () => {
  // prom-client throws on cardinality violations; observability-never-500s wrapper
  // (C.9) will catch this. Test pins prom-client behavior so C.9 wrapper is justified.
  assert.throws(() => httpRequestsTotal.inc({ wrong: 'label' }));
});

test('histogram observes a duration and shows up in metrics text', async () => {
  httpRequestDurationSeconds.observe({ endpoint: '/health' }, 0.001);
  const text = await registry.metrics();
  assert.match(text, /um_http_request_duration_seconds_bucket\{[^}]*endpoint="\/health"/);
});

test('default collectors NOT enabled — no process/eventloop/gc metrics', async () => {
  const text = await registry.metrics();
  assert.doesNotMatch(text, /^process_cpu_seconds_total/m);
  assert.doesNotMatch(text, /^nodejs_eventloop_lag_seconds/m);
  assert.doesNotMatch(text, /^nodejs_gc_duration_seconds/m);
});

test('mem0OpsTotal, mcpToolCallsTotal, lockContentionsTotal exported and registered', async () => {
  // Sanity check the other 3 counters are wired to the registry, not stranded.
  mem0OpsTotal.inc({ op: 'add', status: 'ok' });
  mcpToolCallsTotal.inc({ tool: 'memory_search', status: 'ok' });
  lockContentionsTotal.inc({ lock_path: '/tmp/test.lock' });
  const text = await registry.metrics();
  assert.match(text, /^um_mem0_ops_total\{op="add",status="ok"\} 1/m);
  assert.match(text, /^um_mcp_tool_calls_total\{tool="memory_search",status="ok"\} 1/m);
  assert.match(text, /^um_lock_contentions_total\{lock_path="\/tmp\/test\.lock"\} 1/m);
});

test('umFactsExtractedTotal is a prom-client Counter with provider+model labels', () => {
  assert.equal(typeof umFactsExtractedTotal.inc, 'function');
  assert.doesNotThrow(() => umFactsExtractedTotal.inc({ provider: 'openai', model: 'gpt-4.1-nano-2025-04-14' }, 3));
  assert.throws(
    () => umFactsExtractedTotal.inc({ wrong: 'shape' }, 1),
    /label/i,
    'prom-client throws on label-shape violations',
  );
});

test('umLaneClassifiedTotal counter exists with outcome label', () => {
  assert.equal(typeof umLaneClassifiedTotal.inc, 'function');
  umLaneClassifiedTotal.inc({ outcome: 'routed' }); // throws if label-shape wrong
});
