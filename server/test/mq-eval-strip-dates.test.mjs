// server/test/mq-eval-strip-dates.test.mjs — the scoped valid_from strip that creates
// the undated cohort, and the two cohort assertions that must run before any number.
//
// This unit exists because BOTH failure directions produce a VACUOUS PASS — a green
// result that looks exactly like success while measuring nothing:
//
//   strip too NARROW (no-op)  → every point stays dated → the undated cohort is empty,
//                               so the quantity under test has no subjects.
//   strip too BROAD (all)     → every point undated → the undated factor becomes a
//                               UNIFORM multiplier, ordering is unchanged by construction,
//                               and the delta is exactly 0.
//
// Two specific ways the no-op happens, both asserted below:
//   - setPayload cannot delete keys (lib/supersede.mjs clears to null for that reason);
//     only deletePayload removes one.
//   - the key is top-level `valid_from`, not `metadata.valid_from` (lib/add.mjs flattens
//     metadata to the payload root; the dotted form is only the read projection).
//
// A MOCK qdrant client is used throughout — no network, no live service.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripValidFrom, assertDateCohorts } from '../eval/memory-quality-eval.mjs';
import { isUsableDate } from '../lib/ranking.mjs';

const SCRATCH = 'eval_mq_undated_test';

/** Minimal qdrant double: records every call, serves retrieve() from a payload map. */
function mockClient(payloads = {}) {
  const calls = { deletePayload: [], setPayload: [], retrieve: [] };
  return {
    calls,
    async deletePayload(collection, args) {
      calls.deletePayload.push({ collection, args });
      for (const id of args.points ?? []) {
        for (const key of args.keys ?? []) delete (payloads[String(id)] ?? {})[key];
      }
    },
    async setPayload(collection, args) { calls.setPayload.push({ collection, args }); },
    async retrieve(collection, args) {
      calls.retrieve.push({ collection, args });
      return (args.ids ?? [])
        .filter((id) => payloads[String(id)] !== undefined)
        .map((id) => ({ id, payload: payloads[String(id)] }));
    },
  };
}

const dated = (d = '2026-07-30T00:00:00.000Z') => ({ valid_from: d, data: 'x' });
const undated = () => ({ data: 'x' });

// --- stripValidFrom: the right API, the right key, the right scope ---------

test('stripValidFrom: uses deletePayload — NOT setPayload (setPayload cannot delete keys)', async () => {
  const c = mockClient({ p1: dated() });
  await stripValidFrom(c, SCRATCH, ['p1']);
  assert.equal(c.calls.deletePayload.length, 1);
  assert.equal(c.calls.setPayload.length, 0, 'setPayload cannot delete a key — using it is a silent no-op');
});

test('stripValidFrom: targets the TOP-LEVEL key, never the dotted read-path projection', async () => {
  const c = mockClient({ p1: dated() });
  await stripValidFrom(c, SCRATCH, ['p1']);
  const { args } = c.calls.deletePayload[0];
  assert.deepEqual(args.keys, ['valid_from']);
  assert.ok(
    !JSON.stringify(args).includes('metadata.valid_from'),
    'metadata.valid_from is only the read projection — naming it removes nothing',
  );
});

test('stripValidFrom: passes exactly the id subset it was given (scoping)', async () => {
  const c = mockClient({ a: dated(), b: dated(), keep: dated() });
  await stripValidFrom(c, SCRATCH, ['a', 'b']);
  assert.deepEqual(c.calls.deletePayload[0].args.points, ['a', 'b']);
  assert.equal(c.calls.deletePayload[0].collection, SCRATCH);
});

test('stripValidFrom: waits, so the next read sees a consistent state', async () => {
  const c = mockClient({ p1: dated() });
  await stripValidFrom(c, SCRATCH, ['p1']);
  assert.equal(c.calls.deletePayload[0].args.wait, true);
});

test('stripValidFrom: refuses a non-scratch collection BEFORE any client call', async () => {
  for (const bad of ['memories', 'production', '']) {
    const c = mockClient({ p1: dated() });
    await assert.rejects(() => stripValidFrom(c, bad, ['p1']), /refusing non-scratch collection|scratch/i);
    assert.equal(c.calls.deletePayload.length, 0, `a client call escaped the guard for '${bad}'`);
  }
});

test('stripValidFrom: refuses an EMPTY subset rather than silently doing nothing', async () => {
  const c = mockClient({ p1: dated() });
  await assert.rejects(() => stripValidFrom(c, SCRATCH, []), /non-empty/);
  await assert.rejects(() => stripValidFrom(c, SCRATCH, undefined), /non-empty/);
  assert.equal(c.calls.deletePayload.length, 0);
});

// --- assertDateCohorts: both directions are mandatory ----------------------

test('assertDateCohorts: passes on the correct arrangement and reports both sizes', async () => {
  const c = mockClient({ u1: undated(), u2: undated(), d1: dated(), d2: dated() });
  const got = await assertDateCohorts(c, SCRATCH, { undatedIds: ['u1', 'u2'], datedIds: ['d1', 'd2'] });
  assert.deepEqual(got, { undated: 2, dated: 2 });
});

test('assertDateCohorts: THROWS when an undated point still carries valid_from (strip no-opped)', async () => {
  const c = mockClient({ u1: undated(), u2: dated(), d1: dated() });
  await assert.rejects(
    () => assertDateCohorts(c, SCRATCH, { undatedIds: ['u1', 'u2'], datedIds: ['d1'] }),
    /STILL carry valid_from/,
  );
});

test('assertDateCohorts: THROWS when a dated distractor LOST valid_from (strip too broad)', async () => {
  const c = mockClient({ u1: undated(), d1: dated(), d2: undated() });
  await assert.rejects(
    () => assertDateCohorts(c, SCRATCH, { undatedIds: ['u1'], datedIds: ['d1', 'd2'] }),
    /LOST a usable valid_from/,
  );
});

test('assertDateCohorts: THROWS when EITHER cohort is empty (a one-sided corpus is vacuous)', async () => {
  const c = mockClient({ u1: undated(), d1: dated() });
  await assert.rejects(() => assertDateCohorts(c, SCRATCH, { undatedIds: [], datedIds: ['d1'] }), /BOTH cohorts non-empty/);
  await assert.rejects(() => assertDateCohorts(c, SCRATCH, { undatedIds: ['u1'], datedIds: [] }), /BOTH cohorts non-empty/);
  await assert.rejects(() => assertDateCohorts(c, SCRATCH, {}), /BOTH cohorts non-empty/);
});

test('assertDateCohorts: THROWS when a cohort point is missing from the collection', async () => {
  const c = mockClient({ u1: undated(), d1: dated() });
  await assert.rejects(
    () => assertDateCohorts(c, SCRATCH, { undatedIds: ['u1', 'ghost'], datedIds: ['d1'] }),
    /not found/,
  );
});

test('assertDateCohorts: refuses a non-scratch collection', async () => {
  const c = mockClient({ u1: undated(), d1: dated() });
  await assert.rejects(
    () => assertDateCohorts(c, 'memories', { undatedIds: ['u1'], datedIds: ['d1'] }),
    /refusing non-scratch collection|scratch/i,
  );
  assert.equal(c.calls.retrieve.length, 0);
});

test('assertDateCohorts: reads payloads (with_payload) or it could not see the key at all', async () => {
  const c = mockClient({ u1: undated(), d1: dated() });
  await assertDateCohorts(c, SCRATCH, { undatedIds: ['u1'], datedIds: ['d1'] });
  assert.equal(c.calls.retrieve[0].args.with_payload, true);
});

test('assertDateCohorts: a NULL valid_from in the undated cohort THROWS — it is not "undated enough"', async () => {
  // Pins the strict half of the asymmetry: `!== undefined`, never a truthiness test.
  //
  // Be precise about what this buys, because the comment here used to overclaim. Measured
  // against qdrant v1.13.0 (2026-08-06): a null-valued payload key comes back ABSENT —
  // qdrant drops nulls — so this does NOT catch a setPayload-based strip, and an earlier
  // version of this comment said it did. What it does guarantee is that a present-but-null
  // value from ANY source (a direct upsert, another client, a future qdrant that preserves
  // nulls) is refused rather than quietly counted as undated. The read path treats null as
  // undated, so agreeing with it here would hide a strip that only half-worked.
  const c = mockClient({ u1: { valid_from: null, data: 'x' }, d1: dated() });
  await assert.rejects(
    () => assertDateCohorts(c, SCRATCH, { undatedIds: ['u1'], datedIds: ['d1'] }),
    /STILL carry valid_from/,
  );
});

test('assertDateCohorts: an UNUSABLE valid_from on a dated point THROWS — pins the other half', async () => {
  // The lenient-looking half: a dated point must carry a value the READ PATH can use.
  // A present-but-unusable value is scored as undated by the ranker, so the corpus is
  // uniformly undated in effect — the vacuous pass arriving through the back door.
  for (const bad of [null, '', 'not-a-date', 12345]) {
    const c = mockClient({ u1: undated(), d1: { valid_from: bad, data: 'x' } });
    await assert.rejects(
      () => assertDateCohorts(c, SCRATCH, { undatedIds: ['u1'], datedIds: ['d1'] }),
      /LOST a usable valid_from/,
      `a dated point with valid_from=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('assertDateCohorts: the dated check uses the READ PATH predicate, not a local one', async () => {
  // Guards against the guard drifting from lib/ranking.mjs. An ISO string the ranker
  // accepts must pass here; anything it rejects must fail here.
  const c = mockClient({ u1: undated(), d1: dated('2026-07-30T00:00:00.000Z') });
  assert.ok(isUsableDate('2026-07-30T00:00:00.000Z'));
  await assertDateCohorts(c, SCRATCH, { undatedIds: ['u1'], datedIds: ['d1'] });
});

// --- the two together: the real sequence -----------------------------------

test('strip then assert: the intended end-to-end shape leaves exactly one cohort undated', async () => {
  const payloads = { g1: dated(), g2: dated(), dist1: dated(), dist2: dated() };
  const c = mockClient(payloads);

  await stripValidFrom(c, SCRATCH, ['g1', 'g2']);
  const got = await assertDateCohorts(c, SCRATCH, { undatedIds: ['g1', 'g2'], datedIds: ['dist1', 'dist2'] });

  assert.deepEqual(got, { undated: 2, dated: 2 });
  assert.equal(payloads.g1.valid_from, undefined);
  assert.equal(payloads.dist1.valid_from, '2026-07-30T00:00:00.000Z', 'distractors must keep their date');
});

test('strip then assert: stripping EVERYTHING is caught, not silently accepted', async () => {
  // The vacuous-pass trap: a uniformly-undated corpus yields a delta of exactly 0.
  const c = mockClient({ g1: dated(), g2: dated(), dist1: dated(), dist2: dated() });
  await stripValidFrom(c, SCRATCH, ['g1', 'g2', 'dist1', 'dist2']);
  await assert.rejects(
    () => assertDateCohorts(c, SCRATCH, { undatedIds: ['g1', 'g2'], datedIds: ['dist1', 'dist2'] }),
    /LOST a usable valid_from/,
  );
});

test('stripValidFrom: the key it sends is the one a REAL qdrant would act on', async () => {
  // Trap (b) is guarded at the call boundary, which is the only place a mock can testify
  // about honestly: a mock cannot prove what qdrant does with a dotted path. What it CAN
  // prove is that we never send one. add.mjs flattens metadata to the payload root, so
  // 'valid_from' is the real key and 'metadata.valid_from' would match nothing.
  const c = mockClient({ g1: dated() });
  await stripValidFrom(c, SCRATCH, ['g1']);
  const sentKeys = c.calls.deletePayload[0].args.keys;
  assert.deepEqual(sentKeys, ['valid_from']);
  assert.ok(sentKeys.every((k) => !k.includes('.')), 'no dotted path may be sent');
});

test('strip then assert: a no-op strip is caught by the cohort guard', async () => {
  // The end of the chain: whatever the cause (wrong API, wrong key, wrong ids), a strip
  // that did not actually remove the key must fail before any number is computed.
  const c = mockClient({ g1: dated(), dist1: dated() });
  // deliberately strip nothing
  await assert.rejects(
    () => assertDateCohorts(c, SCRATCH, { undatedIds: ['g1'], datedIds: ['dist1'] }),
    /STILL carry valid_from/,
  );
});
