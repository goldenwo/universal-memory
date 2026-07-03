import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMem0Filters,
  applyMem0Filters,
  toMem0Record,
  toMem0AddResults,
  CompatFilterError,
} from '../lib/mem0-compat.mjs';

// ---------------------------------------------------------------------------
// parseMem0Filters — normalization
// ---------------------------------------------------------------------------

test('parseMem0Filters: undefined → null', () => {
  assert.equal(parseMem0Filters(undefined), null);
});

test('parseMem0Filters: empty object → null', () => {
  assert.equal(parseMem0Filters({}), null);
});

test('parseMem0Filters: empty AND / empty OR → null', () => {
  assert.equal(parseMem0Filters({ AND: [] }), null);
  assert.equal(parseMem0Filters({ OR: [] }), null);
});

test('parseMem0Filters: flat string-equality keys (user_id/agent_id/app_id/run_id)', () => {
  for (const key of ['user_id', 'agent_id', 'app_id', 'run_id']) {
    const d = parseMem0Filters({ [key]: 'v1' });
    assert.deepEqual(d, { branches: [[{ key, op: 'eq', value: 'v1' }]], mode: 'AND' });
  }
});

test('parseMem0Filters: flat multi-key condition object → ONE branch of AND\'d conditions', () => {
  const d = parseMem0Filters({ user_id: 'u1', agent_id: 'a1' });
  assert.equal(d.mode, 'AND');
  assert.equal(d.branches.length, 1);
  assert.deepEqual(d.branches[0], [
    { key: 'user_id', op: 'eq', value: 'u1' },
    { key: 'agent_id', op: 'eq', value: 'a1' },
  ]);
});

test('parseMem0Filters: categories.contains', () => {
  const d = parseMem0Filters({ categories: { contains: 'work' } });
  assert.deepEqual(d, {
    branches: [[{ key: 'categories', op: 'contains', value: 'work' }]],
    mode: 'AND',
  });
});

test('parseMem0Filters: created_at gte + lte → two conditions in one branch', () => {
  const d = parseMem0Filters({ created_at: { gte: '2026-01-01T00:00:00Z', lte: '2026-02-01T00:00:00Z' } });
  assert.equal(d.mode, 'AND');
  assert.deepEqual(d.branches, [[
    { key: 'created_at', op: 'gte', value: '2026-01-01T00:00:00Z' },
    { key: 'created_at', op: 'lte', value: '2026-02-01T00:00:00Z' },
  ]]);
});

test('parseMem0Filters: created_at with only gte', () => {
  const d = parseMem0Filters({ created_at: { gte: '2026-01-01T00:00:00Z' } });
  assert.deepEqual(d.branches, [[{ key: 'created_at', op: 'gte', value: '2026-01-01T00:00:00Z' }]]);
});

test('parseMem0Filters: AND of flat conditions → one branch per flat object', () => {
  const d = parseMem0Filters({ AND: [{ user_id: 'u1' }, { categories: { contains: 'ops' } }] });
  assert.equal(d.mode, 'AND');
  assert.deepEqual(d.branches, [
    [{ key: 'user_id', op: 'eq', value: 'u1' }],
    [{ key: 'categories', op: 'contains', value: 'ops' }],
  ]);
});

test('parseMem0Filters: top-level OR of flat conditions → one branch per flat object', () => {
  const d = parseMem0Filters({ OR: [{ agent_id: 'a1' }, { run_id: 'r1' }] });
  assert.equal(d.mode, 'OR');
  assert.deepEqual(d.branches, [
    [{ key: 'agent_id', op: 'eq', value: 'a1' }],
    [{ key: 'run_id', op: 'eq', value: 'r1' }],
  ]);
});

test('parseMem0Filters: OR preserves multi-condition branches (no flatten)', () => {
  const d = parseMem0Filters({ OR: [{ agent_id: 'a', run_id: 'r1' }, { agent_id: 'b', run_id: 'r2' }] });
  assert.equal(d.mode, 'OR');
  assert.deepEqual(d.branches, [
    [{ key: 'agent_id', op: 'eq', value: 'a' }, { key: 'run_id', op: 'eq', value: 'r1' }],
    [{ key: 'agent_id', op: 'eq', value: 'b' }, { key: 'run_id', op: 'eq', value: 'r2' }],
  ]);
});

test('parseMem0Filters: empty flat objects contribute no branch; all-empty → null', () => {
  // A vacuous OR branch must not become a match-everything arm.
  const d = parseMem0Filters({ OR: [{}, { agent_id: 'a1' }] });
  assert.deepEqual(d.branches, [[{ key: 'agent_id', op: 'eq', value: 'a1' }]]);
  assert.equal(parseMem0Filters({ OR: [{}, {}] }), null);
});

// --- fail-loud cases ---

test('parseMem0Filters: unknown key throws CompatFilterError with .key', () => {
  assert.throws(
    () => parseMem0Filters({ bogus_key: 'x' }),
    (err) => err instanceof CompatFilterError && err.key === 'bogus_key',
  );
});

test('parseMem0Filters: unknown key inside AND branch throws', () => {
  assert.throws(
    () => parseMem0Filters({ AND: [{ user_id: 'u1' }, { nope: 1 }] }),
    (err) => err instanceof CompatFilterError && err.key === 'nope',
  );
});

test('parseMem0Filters: OR nested inside AND throws CompatFilterError', () => {
  assert.throws(
    () => parseMem0Filters({ AND: [{ user_id: 'u1' }, { OR: [{ agent_id: 'a1' }] }] }),
    (err) => err instanceof CompatFilterError && err.key === 'OR',
  );
});

test('parseMem0Filters: AND nested inside OR throws CompatFilterError', () => {
  assert.throws(
    () => parseMem0Filters({ OR: [{ AND: [{ user_id: 'u1' }] }] }),
    (err) => err instanceof CompatFilterError && err.key === 'AND',
  );
});

test('parseMem0Filters: malformed value shapes throw CompatFilterError', () => {
  // string-equality key with non-string value
  assert.throws(
    () => parseMem0Filters({ user_id: 42 }),
    (err) => err instanceof CompatFilterError && err.key === 'user_id',
  );
  // categories without {contains}
  assert.throws(
    () => parseMem0Filters({ categories: 'work' }),
    (err) => err instanceof CompatFilterError && err.key === 'categories',
  );
  // categories.contains non-string
  assert.throws(
    () => parseMem0Filters({ categories: { contains: 7 } }),
    (err) => err instanceof CompatFilterError && err.key === 'categories',
  );
  // created_at as bare string
  assert.throws(
    () => parseMem0Filters({ created_at: '2026-01-01' }),
    (err) => err instanceof CompatFilterError && err.key === 'created_at',
  );
  // created_at object with neither gte nor lte
  assert.throws(
    () => parseMem0Filters({ created_at: {} }),
    (err) => err instanceof CompatFilterError && err.key === 'created_at',
  );
});

test('parseMem0Filters: AND/OR value must be an array', () => {
  assert.throws(
    () => parseMem0Filters({ AND: { user_id: 'u1' } }),
    (err) => err instanceof CompatFilterError && err.key === 'AND',
  );
});

test('CompatFilterError is an Error subclass', () => {
  const e = new CompatFilterError('bad', 'some_key');
  assert.ok(e instanceof Error);
  assert.equal(e.key, 'some_key');
  assert.equal(e.name, 'CompatFilterError');
});

// ---------------------------------------------------------------------------
// applyMem0Filters — pure post-retrieval filtering over PROJECTED records
// ---------------------------------------------------------------------------

const recs = [
  { id: '1', memory: 'alpha', user_id: 'op', created_at: '2026-01-10T00:00:00Z', categories: ['work'], metadata: { agent_id: 'a1' } },
  { id: '2', memory: 'beta', user_id: 'op', created_at: '2026-02-10T00:00:00Z', categories: ['personal', 'health'], metadata: { agent_id: 'a2', run_id: 'r9' } },
  { id: '3', memory: 'gamma', user_id: 'other', created_at: '2026-03-10T00:00:00Z', categories: [], metadata: {} },
];

test('applyMem0Filters: null descriptor → all records unchanged', () => {
  assert.deepEqual(applyMem0Filters(recs, null), recs);
});

test('applyMem0Filters: user_id equality', () => {
  const out = applyMem0Filters(recs, parseMem0Filters({ user_id: 'op' }));
  assert.deepEqual(out.map((r) => r.id), ['1', '2']);
});

test('applyMem0Filters: agent_id matches from metadata (stored-on-write key)', () => {
  const out = applyMem0Filters(recs, parseMem0Filters({ agent_id: 'a2' }));
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

test('applyMem0Filters: categories.contains = array membership', () => {
  const out = applyMem0Filters(recs, parseMem0Filters({ categories: { contains: 'health' } }));
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

test('applyMem0Filters: categories.contains no match → empty', () => {
  assert.deepEqual(applyMem0Filters(recs, parseMem0Filters({ categories: { contains: 'nope' } })), []);
});

test('applyMem0Filters: created_at gte boundary is inclusive', () => {
  const out = applyMem0Filters(recs, parseMem0Filters({ created_at: { gte: '2026-02-10T00:00:00Z' } }));
  assert.deepEqual(out.map((r) => r.id), ['2', '3']);
});

test('applyMem0Filters: created_at lte boundary is inclusive', () => {
  const out = applyMem0Filters(recs, parseMem0Filters({ created_at: { lte: '2026-02-10T00:00:00Z' } }));
  assert.deepEqual(out.map((r) => r.id), ['1', '2']);
});

test('applyMem0Filters: created_at gte+lte window', () => {
  const out = applyMem0Filters(
    recs,
    parseMem0Filters({ created_at: { gte: '2026-01-15T00:00:00Z', lte: '2026-02-15T00:00:00Z' } }),
  );
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

test('applyMem0Filters: record missing created_at fails a created_at condition', () => {
  const out = applyMem0Filters(
    [{ id: 'x', categories: [], metadata: {} }],
    parseMem0Filters({ created_at: { gte: '2020-01-01T00:00:00Z' } }),
  );
  assert.deepEqual(out, []);
});

test('applyMem0Filters: AND semantics — all conditions must hold', () => {
  const out = applyMem0Filters(
    recs,
    parseMem0Filters({ AND: [{ user_id: 'op' }, { categories: { contains: 'work' } }] }),
  );
  assert.deepEqual(out.map((r) => r.id), ['1']);
});

test('applyMem0Filters: OR semantics — any branch suffices', () => {
  const out = applyMem0Filters(
    recs,
    parseMem0Filters({ OR: [{ user_id: 'other' }, { categories: { contains: 'work' } }] }),
  );
  assert.deepEqual(out.map((r) => r.id), ['1', '3']);
});

test('applyMem0Filters: OR branches keep per-branch AND — cross-pairing must NOT match', () => {
  // {OR:[(a,r1),(b,r2)]}: a record carrying (a,r2) satisfies agent_id from
  // branch 1 and run_id from branch 2 but NEITHER branch fully — excluded.
  const descriptor = parseMem0Filters({
    OR: [{ agent_id: 'a', run_id: 'r1' }, { agent_id: 'b', run_id: 'r2' }],
  });
  const rows = [
    { id: 'a-r1', categories: [], metadata: { agent_id: 'a', run_id: 'r1' } },
    { id: 'a-r2', categories: [], metadata: { agent_id: 'a', run_id: 'r2' } }, // cross-pairing
    { id: 'b-r2', categories: [], metadata: { agent_id: 'b', run_id: 'r2' } },
    { id: 'b-r1', categories: [], metadata: { agent_id: 'b', run_id: 'r1' } }, // cross-pairing
  ];
  const out = applyMem0Filters(rows, descriptor);
  assert.deepEqual(out.map((r) => r.id), ['a-r1', 'b-r2']);
});

test('applyMem0Filters: OR branch with created_at {gte,lte} stays a bounded range within its branch', () => {
  // The window must NOT decompose into "gte OR lte" (which matches everything).
  const descriptor = parseMem0Filters({
    OR: [
      { created_at: { gte: '2026-02-01T00:00:00Z', lte: '2026-02-28T00:00:00Z' } },
      { agent_id: 'a9' },
    ],
  });
  const rows = [
    { id: 'before', created_at: '2026-01-10T00:00:00Z', categories: [], metadata: {} },
    { id: 'inside', created_at: '2026-02-10T00:00:00Z', categories: [], metadata: {} },
    { id: 'after', created_at: '2026-03-10T00:00:00Z', categories: [], metadata: {} },
    { id: 'other-arm', created_at: '2026-06-10T00:00:00Z', categories: [], metadata: { agent_id: 'a9' } },
  ];
  const out = applyMem0Filters(rows, descriptor);
  assert.deepEqual(out.map((r) => r.id), ['inside', 'other-arm']);
});

test('applyMem0Filters: created_at compares as instants — +05:00 bound vs Z-stored value', () => {
  // 2026-02-10T05:00:00+05:00 === 2026-02-10T00:00:00Z (same instant).
  // Lexicographic string compare would order '0…Z' < '0…+05:00' wrongly.
  const rows = [{ id: 'z', created_at: '2026-02-10T00:00:00Z', categories: [], metadata: {} }];
  const gte = parseMem0Filters({ created_at: { gte: '2026-02-10T05:00:00+05:00' } });
  assert.deepEqual(applyMem0Filters(rows, gte).map((r) => r.id), ['z'], 'inclusive equal instant (gte)');
  const lte = parseMem0Filters({ created_at: { lte: '2026-02-10T05:00:00+05:00' } });
  assert.deepEqual(applyMem0Filters(rows, lte).map((r) => r.id), ['z'], 'inclusive equal instant (lte)');
  const laterBound = parseMem0Filters({ created_at: { gte: '2026-02-10T05:00:01+05:00' } });
  assert.deepEqual(applyMem0Filters(rows, laterBound), [], 'one second past the instant excludes');
});

test('applyMem0Filters: unparseable created_at on either side fails the condition (NaN)', () => {
  const rows = [
    { id: 'garbage-stored', created_at: 'not-a-date', categories: [], metadata: {} },
    { id: 'ok', created_at: '2026-02-10T00:00:00Z', categories: [], metadata: {} },
  ];
  const d = parseMem0Filters({ created_at: { gte: '2026-01-01T00:00:00Z' } });
  assert.deepEqual(applyMem0Filters(rows, d).map((r) => r.id), ['ok']);
  const garbageBound = parseMem0Filters({ created_at: { lte: 'nonsense' } });
  assert.deepEqual(applyMem0Filters(rows, garbageBound), []);
});

// ---------------------------------------------------------------------------
// toMem0Record — RAW mem0 record → mem0-dialect projection
// ---------------------------------------------------------------------------

test('toMem0Record: full record translates camelCase → snake_case dialect', () => {
  const raw = {
    id: 'p1',
    memory: 'the fact text',
    score: 0.87,
    metadata: {
      userId: 'op',
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-02T12:00:00Z',
      lane: 'work',
      categories: ['stored-a', 'stored-b'],
      customKey: 'kept',
    },
  };
  const out = toMem0Record(raw);
  assert.equal(out.id, 'p1');
  assert.equal(out.memory, 'the fact text');
  assert.equal(out.score, 0.87);
  assert.equal(out.user_id, 'op');
  assert.equal(out.created_at, '2026-06-01T12:00:00Z');
  assert.equal(out.updated_at, '2026-06-02T12:00:00Z');
  assert.deepEqual(out.categories, ['work', 'stored-a', 'stored-b']);
  assert.equal(out.metadata, raw.metadata); // passed through as-is
});

test('toMem0Record: minimal record (no metadata) never throws, categories = []', () => {
  const out = toMem0Record({ id: 'p2', memory: 'bare' });
  assert.equal(out.id, 'p2');
  assert.equal(out.memory, 'bare');
  assert.deepEqual(out.categories, []); // [] beats omission — client filters on r.categories
  assert.ok(!('created_at' in out), 'created_at omitted, not null');
  assert.ok(!('updated_at' in out), 'updated_at omitted, not null');
  assert.ok(!('user_id' in out), 'user_id omitted, not null');
  assert.ok(!('score' in out), 'score omitted when absent');
});

test('toMem0Record: score included only when a number', () => {
  assert.equal(toMem0Record({ id: 'a', memory: 'm', score: 0 }).score, 0);
  assert.ok(!('score' in toMem0Record({ id: 'a', memory: 'm', score: '0.5' })));
  assert.ok(!('score' in toMem0Record({ id: 'a', memory: 'm' })));
});

test('toMem0Record: omission-not-null for created_at/updated_at/user_id individually', () => {
  const out = toMem0Record({ id: 'a', memory: 'm', metadata: { createdAt: '2026-01-01T00:00:00Z' } });
  assert.equal(out.created_at, '2026-01-01T00:00:00Z');
  assert.ok(!('updated_at' in out));
  assert.ok(!('user_id' in out));
});

test('toMem0Record: categories synthesis — lane only', () => {
  const out = toMem0Record({ id: 'a', memory: 'm', metadata: { lane: 'personal' } });
  assert.deepEqual(out.categories, ['personal']);
});

test('toMem0Record: categories synthesis — lane + stored categories, deduped', () => {
  const out = toMem0Record({ id: 'a', memory: 'm', metadata: { lane: 'work', categories: ['work', 'ops'] } });
  assert.deepEqual(out.categories, ['work', 'ops']);
});

test('toMem0Record: categories synthesis — stored categories only (no lane)', () => {
  const out = toMem0Record({ id: 'a', memory: 'm', metadata: { categories: ['ops'] } });
  assert.deepEqual(out.categories, ['ops']);
});

test('toMem0Record: non-array stored categories ignored (never throws)', () => {
  const out = toMem0Record({ id: 'a', memory: 'm', metadata: { categories: 'not-an-array' } });
  assert.deepEqual(out.categories, []);
});

test('toMem0Record: does not mutate the input', () => {
  const metadata = { userId: 'op', createdAt: '2026-01-01T00:00:00Z', lane: 'work', categories: ['x'] };
  const raw = { id: 'a', memory: 'm', metadata };
  const metaSnapshot = JSON.parse(JSON.stringify(metadata));
  toMem0Record(raw);
  assert.deepEqual(raw.metadata, metaSnapshot);
  assert.deepEqual(Object.keys(raw), ['id', 'memory', 'metadata']);
});

// ---------------------------------------------------------------------------
// toMem0AddResults — umAdd result → mem0 dialect
// ---------------------------------------------------------------------------

test('toMem0AddResults: translates internal events to the mem0 dialect (docs R2 row)', () => {
  // Merge family (DEDUP_MERGED / SUPERSEDED_INBAND) reads as "an existing
  // memory changed" to a mem0 client → UPDATE. Internal tokens never leak.
  const out = toMem0AddResults({
    results: [
      { id: 'i1', memory: 'f1', event: 'ADD' },
      { id: 'i2', memory: 'f2', event: 'DEDUP_MERGED', supersededId: 'zzz' },
      { id: 'i3', memory: 'f3', event: 'SUPERSEDED_INBAND', supersededId: 'yyy' },
    ],
  });
  assert.deepEqual(out, {
    results: [
      { id: 'i1', memory: 'f1', event: 'ADD' },
      { id: 'i2', memory: 'f2', event: 'UPDATE' },
      { id: 'i3', memory: 'f3', event: 'UPDATE' },
    ],
  });
});

test('toMem0AddResults: absent / NONE / unknown events degrade to NONE', () => {
  const out = toMem0AddResults({
    results: [
      { id: 'i1', memory: 'f1' },
      { id: 'i2', memory: 'f2', event: 'NONE' },
      { id: 'i3', memory: 'f3', event: 'SOME_FUTURE_INTERNAL_EVENT' },
    ],
  });
  assert.deepEqual(out.results.map((r) => r.event), ['NONE', 'NONE', 'NONE']);
});

test('toMem0AddResults: defensive shapes — undefined / missing results / null', () => {
  assert.deepEqual(toMem0AddResults(undefined), { results: [] });
  assert.deepEqual(toMem0AddResults({}), { results: [] });
  assert.deepEqual(toMem0AddResults(null), { results: [] });
  assert.deepEqual(toMem0AddResults({ results: null }), { results: [] });
});
