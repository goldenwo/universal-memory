/**
 * server/test/eval-memory-quality.smoke.test.mjs — Phase 2 live-wiring smoke for the
 * end-to-end memory-quality eval (plan T2.5). De-risks the wiring BEFORE the big
 * fixtures by exercising runOnce against LIVE qdrant on a tiny inline fixture.
 *
 * Gating: UM_QDRANT_INTEGRATION=1 (real qdrant) + a real OPENAI_API_KEY (real embed +
 * the real contradiction judge). Run:
 *   UM_QDRANT_INTEGRATION=1 node --env-file=.env --test test/eval-memory-quality.smoke.test.mjs
 *
 * Verifies (the assumptions the round-1 review flagged):
 *   - the scratch collection is created + name-guarded (^eval_mq_), the real
 *     `memories` collection point-count is unchanged after the run (isolation);
 *   - id round-trips write→search AND the userId reconciliation holds, so a query
 *     whose answer was seeded ranks its target #1 (recall@1 == 1) — proving the
 *     seed-then-capture join works end-to-end;
 *   - one entity-swap staleness pair FIRES the session-end detector, is demoted via
 *     supersedePoint, and `doSearch` (status:current) then HIDES the original
 *     (stale-return == 0 over the fired row);
 *   - scratch collections are dropped on exit (teardown).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { runOnce } from '../eval/memory-quality-eval.mjs';

const SKIP = !process.env.UM_QDRANT_INTEGRATION;
const QDRANT_HOST = process.env.QDRANT_HOST ?? 'localhost';
const QDRANT_PORT = parseInt(process.env.QDRANT_PORT ?? '6333', 10);

// Tiny inline fixtures. For the SMOKE we only need the join + wiring to work, so the
// recall query may be lexically close to its target (de-leak rigor is a Phase-3 fixture
// concern, not a wiring concern).
const RECALL_ROWS = [
  {
    id: 'smoke-r1',
    seed_facts: [
      { text: 'The team standup moved to 10am starting next sprint.', lane: 'work' },
      { text: 'My dentist appointment is on the 14th.', lane: 'health' },
      { text: 'The garage door opener battery is a CR2032.', lane: 'home' },
    ],
    query: 'what time is the team standup now',
    target_ref: 'smoke-r1:0',
    category: 'work',
    paraphrase_level: 'lexical',
  },
];

const STALENESS_ROWS = [
  {
    id: 'smoke-s1',
    original_fact: 'I work at Acme Corp',
    updated_fact: 'I work at Beta Industries',
    lane: 'work',
    query: 'where do I work',
    expected: 'updated',
  },
];

test('mq-eval smoke: recall join + staleness detector path + isolation', { skip: SKIP }, async () => {
  const client = new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT });

  // Isolation invariant: capture the real `memories` point-count before the run.
  let before = null;
  try {
    before = (await client.count('memories', { exact: true })).count;
  } catch (e) {
    if (e?.status !== 404) throw e; // 404 = no memories collection here; fine.
  }

  const result = await runOnce({
    recallRows: RECALL_ROWS,
    stalenessRows: STALENESS_ROWS,
    runid: `smoke${process.pid}`,
  });

  // --- recall join works end-to-end (id round-trip + userId reconciliation) ---
  assert.equal(result.recall.queryCount, 1, 'one recall query');
  assert.equal(result.recall.aggregate[1], 1, 'target ranks #1 → seed→search join works');
  assert.equal(result.recall.mrr, 1, 'MRR 1 for the single #1 hit');

  // --- staleness fires the detector, supersedes, and doSearch hides the original ---
  assert.equal(result.staleness.fired, 1, 'the work-contradiction fires the session-end detector');
  assert.equal(result.staleness.staleReturnRate, 0, 'after supersede, the demoted original is NOT returned');

  // --- isolation: scratch collections gone; `memories` untouched ---
  const cols = (await client.getCollections()).collections.map((c) => c.name);
  assert.ok(!cols.some((n) => n.includes(`smoke${process.pid}`)), 'scratch collections dropped on teardown');
  if (before != null) {
    const after = (await client.count('memories', { exact: true })).count;
    assert.equal(after, before, 'real `memories` collection point-count unchanged');
  }
});
