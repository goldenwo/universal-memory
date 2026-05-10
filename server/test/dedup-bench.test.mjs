/**
 * server/test/dedup-bench.test.mjs — D1 perf benchmark B1.
 *
 * Spec §8.4 + plan E.6.
 *
 * Measures per-call overhead of the dedup pipeline under MOCKED qdrant.
 * With mocks the absolute numbers are tiny (sub-ms per call); the real-world
 * latency is dominated by qdrant network RTT. B1's purpose is
 * regression-detection: the dedup overhead must NOT accidentally grow 10×
 * over time (e.g., if someone wraps the dedup hook in a heavy decorator).
 *
 * Test strategy:
 *   - 100 sequential umAdd calls under flag-off → record p95 baseline
 *   - 100 sequential umAdd calls under flag-on (no dedup hits) → record p95
 *   - Assert (flag-on p95 - flag-off p95) ≤ 80 ms
 *
 * The "no dedup hits" path exercises BOTH layers (scroll + search miss) plus
 * the buildPayload extension and the uuidv5 ID generation — i.e., the
 * worst-case overhead. A real qdrant would add ~30-80ms RTT per call to
 * each side; this test isolates the JS-side cost.
 *
 * Skip-on-CI guard: set UM_BENCH_SKIP=1 to skip if CI is too noisy.
 * The test is intentionally lenient (300ms slack) so noisy CI shouldn't
 * trigger false alarms; the regression guard is the 10× class, not microsecond
 * precision.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { umAdd } from '../lib/add.mjs';
import { makeMockQdrant, makeMockMemory } from './fixtures/qdrant-mock.mjs';

const SKIP = process.env.UM_BENCH_SKIP === '1';

const factsOverride = {
  supports: { facts: true },
  defaults: { factsModel: 'mock' },
  factsInvoke: async () => ({ facts: [], usage: { tokensIn: 0, tokensOut: 0 } }),
};
const embedOverride = {
  supports: { embeddings: true },
  defaults: { embeddingModel: 'mock' },
  embed: async () => ({ vector: [0.1, 0.2], usage: { tokensIn: 1, tokensOut: 0 } }),
};

async function runBatch({ enabled, n, qdrant, memory }) {
  const prev = process.env.UM_DEDUP_ENABLED;
  // Set explicit literals on both arms — default is now ON (v1.1 flag-flip),
  // so `delete` would no longer mean "off". 'true' for clarity even though
  // unset would also be ON; 'false' is the only opt-out value.
  if (enabled) process.env.UM_DEDUP_ENABLED = 'true';
  else process.env.UM_DEDUP_ENABLED = 'false';
  // Reset miss-state every run.
  qdrant.scrollResult = { points: [] };
  qdrant.searchResult = [];
  const durations = [];
  try {
    for (let i = 0; i < n; i++) {
      const startNs = process.hrtime.bigint();
      // Use unique text per iter so hash dedup never hits (worst-case overhead).
      await umAdd({
        memory,
        text: `bench-${i}-${enabled ? 'on' : 'off'}-${Math.random()}`,
        userId: 'u-bench',
        surface: 'cli',
        infer: false,
        _factsProviderOverride: factsOverride,
        _embedProviderOverride: embedOverride,
        _qdrantClient: qdrant.client,
      });
      const durMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      durations.push(durMs);
    }
    return durations;
  } finally {
    if (prev === undefined) delete process.env.UM_DEDUP_ENABLED;
    else process.env.UM_DEDUP_ENABLED = prev;
  }
}

function p95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)];
}

test('B1: dedup-on p95 overhead vs dedup-off ≤ 80ms (regression guard, mocked qdrant)', { skip: SKIP }, async () => {
  const N = 100;
  const memory = makeMockMemory();
  const qdrant = makeMockQdrant();

  // Warm-up — node-test cold start, JIT, etc. can skew the first batch.
  await runBatch({ enabled: false, n: 20, qdrant, memory });
  await runBatch({ enabled: true, n: 20, qdrant, memory });

  const offDurs = await runBatch({ enabled: false, n: N, qdrant, memory });
  const onDurs = await runBatch({ enabled: true, n: N, qdrant, memory });

  const offP95 = p95(offDurs);
  const onP95 = p95(onDurs);
  const overhead = onP95 - offP95;

  console.log(`  [B1] flag-off p95 = ${offP95.toFixed(2)}ms; flag-on p95 = ${onP95.toFixed(2)}ms; overhead = ${overhead.toFixed(2)}ms`);
  assert.ok(
    overhead <= 80,
    `dedup-on p95 overhead = ${overhead.toFixed(2)}ms exceeds 80ms regression budget; investigate dedup hot path`,
  );
});
