/**
 * server/test/dedup.test.mjs — D1 cross-surface fact dedup tests.
 *
 * Covers spec §8.1 unit tests T1–T14 plus T11b (G11 trust boundary).
 * Phase E.1–E.3 of plan 2026-05-09-d1-plan.md.
 *
 * Phase B.2 is the entry point: T8 parametric reserved-field guard.
 * Subsequent phases extend this file with T1–T7+T7b (E.1), T9/T10/T11 mock-narrow (E.2),
 * T11b/T12/T13/T14 (E.3).
 *
 * Mock qdrant fixture lives at server/test/fixtures/qdrant-mock.mjs (added in E.1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_METADATA_FIELDS,
  assertNoReservedFields,
  ReservedMetadataFieldError,
} from '../lib/dedup-constants.mjs';

// ---------------------------------------------------------------------------
// T8 — Reserved-field guard (parametric over all 6 reserved fields).
// Spec §8.1 T8 + spec R5/G11 (caller-trust boundary).
// Plan B.2.
// ---------------------------------------------------------------------------

for (const field of RESERVED_METADATA_FIELDS) {
  test(`T8: assertNoReservedFields rejects metadata.${field}`, () => {
    assert.throws(
      () => assertNoReservedFields({ [field]: 'whatever' }),
      ReservedMetadataFieldError,
      `metadata.${field} should throw ReservedMetadataFieldError`,
    );
  });
}

test('T8: assertNoReservedFields permits non-reserved metadata', () => {
  // Should NOT throw — project/surface/kind/id are all caller-allowed fields.
  assertNoReservedFields({ project: 'p', surface: 's', kind: 'k', id: 'doc-1' });
});

test('T8: assertNoReservedFields treats null/undefined/non-object as no-op', () => {
  // Defensive: callers may pass undefined when no metadata is supplied.
  // Should NOT throw on any of these.
  assertNoReservedFields(undefined);
  assertNoReservedFields(null);
  assertNoReservedFields('not an object');
  assertNoReservedFields(42);
});

test('T8: ReservedMetadataFieldError carries the offending field name', () => {
  try {
    assertNoReservedFields({ dedupCount: 99 });
    assert.fail('expected ReservedMetadataFieldError');
  } catch (e) {
    assert.ok(e instanceof ReservedMetadataFieldError);
    assert.equal(e.name, 'ReservedMetadataFieldError');
    assert.equal(e.field, 'dedupCount');
    assert.match(e.message, /dedupCount.*reserved/);
  }
});

test('T8: assertNoReservedFields uses own-property check (prototype pollution guard)', () => {
  // Per spec R4 A2 — prototype-pollution attempts must NOT trigger the guard
  // unintentionally, AND must NOT bypass it via Object.prototype tricks.
  // hasOwnProperty.call(metadata, field) is the correct check.
  // Smoke: an object with `surfaces` ON ITS PROTOTYPE (not own) is allowed,
  // because it would not be spread into the payload anyway.
  const proto = { surfaces: ['inherited'] };
  const metadata = Object.create(proto);
  metadata.kind = 'page';
  // Should NOT throw — `surfaces` is on the prototype, not own.
  assertNoReservedFields(metadata);
});

test('T8: RESERVED_METADATA_FIELDS is frozen (additions must touch the const, not via runtime push)', () => {
  assert.ok(Object.isFrozen(RESERVED_METADATA_FIELDS));
  assert.throws(
    () => RESERVED_METADATA_FIELDS.push('newField'),
    /Cannot add property|object is not extensible|read only/,
    'frozen array should reject .push()',
  );
});

// ---------------------------------------------------------------------------
// E.1 — umAdd dedup integration tests (T1–T7+T7b).
// Spec §8.1 + plan E.1.
// ---------------------------------------------------------------------------

import { umAdd } from '../lib/add.mjs';
import { v5 as uuidv5 } from 'uuid';
import { NAMESPACE_UM } from '../lib/dedup-constants.mjs';
import { makeMockQdrant, makeMockMemory } from './fixtures/qdrant-mock.mjs';

/**
 * Run `fn` with UM_DEDUP_ENABLED=true; restore prior env on finally.
 * Avoids env-var contamination across parallel tests.
 */
async function withDedupOn(fn) {
  const prev = process.env.UM_DEDUP_ENABLED;
  process.env.UM_DEDUP_ENABLED = 'true';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.UM_DEDUP_ENABLED;
    else process.env.UM_DEDUP_ENABLED = prev;
  }
}

const factsOverride = {
  supports: { facts: true },
  defaults: { factsModel: 'mock' },
  factsInvoke: async (text) => ({
    facts: [`fact about: ${text}`],
    usage: { tokensIn: 10, tokensOut: 5 },
  }),
};
const embedOverride = {
  supports: { embeddings: true },
  defaults: { embeddingModel: 'mock' },
  embed: async () => ({ vector: [0.1, 0.2], usage: { tokensIn: 3, tokensOut: 0 } }),
};

test('T1: hash hit path — write A then write A again returns DEDUP_MERGED, no second upsert', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // Pre-seed the scroll to return a hit on the second call.
    // Existing point id: a deterministic uuidv5 so it reads as "we already wrote this".
    const existingPoint = {
      id: uuidv5('u-1:somehash', NAMESPACE_UM),
      payload: { userId: 'u-1', data: 'raw text', hash: 'somehash', surfaces: ['cli'] },
    };
    qdrant.scrollResult = { points: [existingPoint] };

    const res = await umAdd({
      memory,
      text: 'raw text',
      userId: 'u-1',
      surface: 'claude-code',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].event, 'DEDUP_MERGED');
    assert.equal(res.results[0].id, existingPoint.id);
    assert.equal(qdrant.upserts.length, 0, 'no upsert when hash dedup hits');
    assert.equal(qdrant.setPayloads.length, 1, 'mergeSurface called setPayload');
    const merged = qdrant.setPayloads[0].body.payload;
    assert.deepEqual(merged.surfaces.sort(), ['claude-code', 'cli'].sort(), 'surfaces extended');
    assert.equal(merged.dedupCount, 2);
    assert.ok(typeof merged.dedupLastSeenAt === 'string');
  });
});

test('T2: embedding hit path — Layer 2 fires when hash misses, returns DEDUP_MERGED', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // Layer 1 misses (empty scroll).
    qdrant.scrollResult = { points: [] };
    // Layer 2 hits (search returns an array of ScoredPoint per qdrant 1.13 contract).
    const existingPoint = {
      id: 'existing-uuid-from-prior-write',
      score: 0.97,
      payload: { userId: 'u-1', data: 'similar text', hash: 'differenthash' },
    };
    qdrant.searchResult = [existingPoint];

    const res = await umAdd({
      memory,
      text: 'I prefer Rust over Go',
      userId: 'u-1',
      surface: 'claude-code',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'DEDUP_MERGED');
    assert.equal(qdrant.upserts.length, 0);
    assert.equal(qdrant.searches.length, 1, 'Layer 2 search ran exactly once');
    assert.equal(qdrant.setPayloads.length, 1);
    // LITERAL match to the runtime default in server/lib/add.mjs dedupEmbeddingThreshold()
    // and server/.env.example UM_DEDUP_EMBEDDING_THRESHOLD — update all three together.
    // Default 0.84 from the 2026-05-09 threshold-tuning eval; see docs/architecture/dedup.md.
    assert.equal(qdrant.searches[0].body.score_threshold, 0.84);
  });
});

test('T3: no-hit path — both layers miss, falls through to upsert with surfaces seeded', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // Both miss.
    qdrant.scrollResult = { points: [] };
    qdrant.searchResult = [];

    const res = await umAdd({
      memory,
      text: 'a brand new fact',
      userId: 'u-1',
      surface: 'claude-code',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].event, 'ADD');
    assert.equal(qdrant.upserts.length, 1);
    const payload = qdrant.upserts[0].body.points[0].payload;
    assert.deepEqual(payload.surfaces, ['claude-code']);
    assert.equal(payload.dedupCount, 1);
    assert.equal(payload.dedupVersion, 1);
  });
});

test('T4: multi-fact (infer:true) partial dedup — fact A is dup but B is novel', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // 2 facts; first scroll hits, second misses.
    const factsTwo = {
      ...factsOverride,
      factsInvoke: async () => ({
        facts: ['fact A', 'fact B'],
        usage: { tokensIn: 10, tokensOut: 5 },
      }),
    };
    let scrollCall = 0;
    const origScroll = qdrant.client.scroll;
    qdrant.client.scroll = async (collection, body) => {
      scrollCall++;
      // First call (fact A) hits; second call (fact B) misses.
      if (scrollCall === 1) {
        return { points: [{ id: 'existing-A', payload: { userId: 'u-1', data: 'fact A', hash: 'h-A' } }] };
      }
      return { points: [] };
    };
    qdrant.searchResult = []; // Layer 2 always misses

    const res = await umAdd({
      memory,
      text: 'two-fact input',
      userId: 'u-1',
      surface: 'mcp',
      infer: true,
      _factsProviderOverride: factsTwo,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].event, 'DEDUP_MERGED');
    assert.equal(res.results[1].event, 'ADD');
    assert.equal(qdrant.upserts.length, 1, 'only fact B upserted');
    assert.equal(qdrant.setPayloads.length, 1, 'only fact A merged');
  });
});

test('T4b: F1-cascade — same fact under different project slugs collapses to ONE point with projects=[X,Y]', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // Existing point under project=proj1.
    const existingPoint = {
      id: 'existing-id',
      payload: {
        userId: 'u-1',
        data: 'remember rust',
        hash: 'h-rust',
        surfaces: ['claude-code'],
        projects: ['proj1'],
      },
    };
    qdrant.scrollResult = { points: [existingPoint] };

    const res = await umAdd({
      memory,
      text: 'remember rust',
      userId: 'u-1',
      surface: 'mcp',
      metadata: { project: 'proj2' },
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'DEDUP_MERGED');
    assert.equal(qdrant.upserts.length, 0);
    const merged = qdrant.setPayloads[0].body.payload;
    assert.deepEqual(merged.projects.sort(), ['proj1', 'proj2'].sort(), 'projects Set extends across surfaces');
    assert.deepEqual(merged.surfaces.sort(), ['claude-code', 'mcp'].sort());
  });
});

test('T4c: first-write seeds projects from metadata.project (and scalar project coexists)', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();
    qdrant.scrollResult = { points: [] };
    qdrant.searchResult = [];

    await umAdd({
      memory,
      text: 'fresh fact',
      userId: 'u-1',
      surface: 'cli',
      metadata: { project: 'my-project', kind: 'page' },
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    const payload = qdrant.upserts[0].body.points[0].payload;
    assert.deepEqual(payload.projects, ['my-project'], 'projects Set seeded from metadata.project');
    assert.equal(payload.project, 'my-project', 'scalar project preserved (backward compat)');
    assert.equal(payload.kind, 'page', 'other metadata still flattened');
  });
});

test('T5: no-surface arg → surfaces field omitted from payload (not [])', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();
    qdrant.scrollResult = { points: [] };
    qdrant.searchResult = [];

    await umAdd({
      memory,
      text: 'no surface label',
      userId: 'u-1',
      // surface intentionally omitted
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    const payload = qdrant.upserts[0].body.points[0].payload;
    assert.equal(payload.surfaces, undefined, 'surfaces field omitted when no surface arg');
  });
});

test('T6: fail-soft on scroll error → falls through to upsert', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();
    qdrant.scrollError = new Error('qdrant blip on scroll');

    const res = await umAdd({
      memory,
      text: 'something',
      userId: 'u-1',
      surface: 'cli',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    // Despite scroll error, should fall through to upsert and return ADD.
    assert.equal(res.results[0].event, 'ADD');
    assert.equal(qdrant.upserts.length, 1, 'upsert still happened');
  });
});

test('T6b: fail-soft on setPayload error → falls through to upsert (creates new point)', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // Hash hit forces Layer 3 (mergeSurface), but setPayload throws.
    qdrant.scrollResult = {
      points: [{ id: 'existing', payload: { userId: 'u-1', data: 'X', hash: 'h-X' } }],
    };
    qdrant.setPayloadError = new Error('qdrant blip on setPayload');

    const res = await umAdd({
      memory,
      text: 'X',
      userId: 'u-1',
      surface: 'cli',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    // Failure on setPayload → fall back to plain upsert (creates a duplicate).
    // This is the documented fail-soft behavior — bounded by outage duration.
    assert.equal(res.results[0].event, 'ADD');
    assert.equal(qdrant.upserts.length, 1);
  });
});

test('T7: multi-tenant isolation — same hash for userIdA and userIdB → both upsert (no cross-user merge)', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    // Mock scroll to enforce userId-filter behavior: only return a point if the
    // filter has the matching userId. (Real qdrant does this; mock simulates.)
    qdrant.client.scroll = async (collection, body) => {
      qdrant.scrolls.push({ collection, body });
      const userIdFilter = body.filter.must.find((c) => c.key === 'userId').match.value;
      // Pretend userId=alice has a prior point; bob doesn't.
      if (userIdFilter === 'alice') {
        return { points: [{ id: 'alice-existing', payload: { userId: 'alice', data: 'X', hash: 'h-X' } }] };
      }
      return { points: [] };
    };
    qdrant.searchResult = [];

    // Bob writes "X" — should NOT merge with alice's record.
    const resBob = await umAdd({
      memory,
      text: 'X',
      userId: 'bob',
      surface: 'cli',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(resBob.results[0].event, 'ADD', 'bob writes a NEW point');
    assert.equal(qdrant.upserts.length, 1);
    assert.equal(qdrant.upserts[0].body.points[0].payload.userId, 'bob');
    // Verify the scroll filter actually included userId=bob:
    const scrollFilter = qdrant.scrolls[0].body.filter.must;
    const userIdConstraint = scrollFilter.find((c) => c.key === 'userId');
    assert.equal(userIdConstraint.match.value, 'bob');
  });
});

// ---------------------------------------------------------------------------
// E.2 — Mock-narrowing T9+T10+T11.
// Spec §8.1 + plan E.2. The mock provides ONLY .upsert (no scroll/search/
// setPayload) so the test fails with TypeError if the §4.5.1 short-circuit
// doesn't fire BEFORE any dedup-side method access. Strongest possible
// regression guard for the flag-gate.
// ---------------------------------------------------------------------------

import { makeMockQdrantUpsertOnly } from './fixtures/qdrant-mock.mjs';

test('T9: flag off — UM_DEDUP_ENABLED=false → no scroll/search/setPayload calls (regression guard)', async () => {
  // Explicit opt-out: since the v1.1 flag-flip, default is ON, so we must
  // set 'false' (not just delete) to exercise the disabled path.
  const prev = process.env.UM_DEDUP_ENABLED;
  process.env.UM_DEDUP_ENABLED = 'false';
  try {
    const qdrant = makeMockQdrantUpsertOnly();
    const memory = makeMockMemory();

    const res = await umAdd({
      memory,
      text: 'fact',
      userId: 'u-1',
      surface: 'cli',
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    // If §4.5.1 short-circuit regressed, the missing scroll/search/setPayload
    // would TypeError before we got here. Reaching this assertion proves the
    // flag-gate fires correctly.
    assert.equal(res.results[0].event, 'ADD');
    assert.equal(qdrant.upserts.length, 1);
    // Point ID must be randomUUID (NOT uuidv5) when not dedup-eligible.
    const id = qdrant.upserts[0].body.points[0].id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(id, uuidRegex);
  } finally {
    if (prev !== undefined) process.env.UM_DEDUP_ENABLED = prev;
  }
});

test('T10: system-doc bypass — metadata.id in SYSTEM_METADATA_IDS → no dedup-side method calls', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrantUpsertOnly();
    const memory = makeMockMemory();

    // Embedding-stamp doc (per server/lib/system-docs.mjs SYSTEM_METADATA_IDS).
    await umAdd({
      memory,
      text: 'embedding-stamp',
      userId: '_um_system',
      metadata: { id: '_um_embedding_stamp', stamp: { provider: 'openai', model: 'x', dim: 1536 } },
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(qdrant.upserts.length, 1, 'system docs upsert directly without dedup');
  });
});

test('T11: migration bypass — _systemMigration:true → no dedup-side method calls', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrantUpsertOnly();
    const memory = makeMockMemory();

    await umAdd({
      memory,
      text: 'migrated fact from Pi',
      userId: 'golden',
      surface: 'discord-openclaw',
      _systemMigration: true,
      infer: false,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(qdrant.upserts.length, 1, 'migration writes upsert directly without dedup');
    // Point ID under bypass uses randomUUID (NOT uuidv5) so migration writes
    // never collide on uuidv5 with concurrent CC writes.
    const id = qdrant.upserts[0].body.points[0].id;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ---------------------------------------------------------------------------
// E.3 — T11b + T12 + T13 + T14.
// Spec §8.1 + plan E.3.
// ---------------------------------------------------------------------------

test('T11b: caller-supplied metadata.systemMigration is rejected (G11 trust boundary)', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();

    await assert.rejects(
      umAdd({
        memory,
        text: 'attacker payload',
        userId: 'untrusted',
        metadata: { systemMigration: true },  // SMUGGLING ATTEMPT
        infer: false,
        _factsProviderOverride: factsOverride,
        _embedProviderOverride: embedOverride,
        _qdrantClient: qdrant.client,
      }),
      ReservedMetadataFieldError,
      'metadata.systemMigration must be rejected so untrusted callers cannot bypass dedup',
    );

    // No qdrant write happened (assertNoReservedFields runs at entry).
    assert.equal(qdrant.upserts.length, 0);
    assert.equal(qdrant.scrolls.length, 0);
    assert.equal(qdrant.searches.length, 0);
    assert.equal(qdrant.setPayloads.length, 0);
  });
});

test('T12: uuidv5(hash+":"+userId, NAMESPACE_UM) is stable across runs (regression guard against namespace drift)', () => {
  // If NAMESPACE_UM is ever regenerated, this test breaks loudly — and it
  // SHOULD break, because regenerating the namespace orphans every existing
  // dedup-eligible point.
  //
  // Input format: hash FIRST then ':' then userId. md5 is always 32 hex chars
  // [0-9a-f], so the partition is unambiguous regardless of userId chars.
  // See add.mjs line ~206 + security-review H1 for the rationale.
  const HASH = 'abcdef0123456789abcdef0123456789';  // 32 hex chars (md5 shape)
  const pinned = uuidv5(`${HASH}:user1`, NAMESPACE_UM);
  assert.equal(NAMESPACE_UM, 'e2de504c-45bb-4531-952f-f33a6f60c945');
  // Recompute and compare to itself across two calls (canonical stability).
  const twice = uuidv5(`${HASH}:user1`, NAMESPACE_UM);
  assert.equal(pinned, twice);
  // Different userId → different ID.
  const other = uuidv5(`${HASH}:user2`, NAMESPACE_UM);
  assert.notEqual(pinned, other);
  // UUID v5 format check.
  assert.match(pinned, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be valid UUID v5');

  // Security-review H1 colon-safety: a userId containing ':' must NOT collide
  // with a userId that aliases the colon-split. Concretely: with hash-first
  // ordering, `${HASH}:alice:bob` (userId='alice:bob') is unambiguous because
  // the hash prefix is always exactly 32 hex chars (0-9a-f only, never ':').
  // Verify by constructing two distinct (hash, userId) pairs and asserting
  // their uuidv5s differ. (Under a hypothetical attacker-controlled hash —
  // not reachable today since md5 is hex — both `(HASH, 'alice:bob')` and
  // `(HASH, 'alice')` produce different ID inputs, hence different UUIDs.)
  const colonUser = uuidv5(`${HASH}:alice:bob`, NAMESPACE_UM);
  const plainUser = uuidv5(`${HASH}:alice`, NAMESPACE_UM);
  assert.notEqual(colonUser, plainUser, 'H1 colon-safety: userIds with and without ":" suffix must produce distinct uuidv5');
});

test('T13: reindex bypass — _systemMigration:true with infer:false (reindex-shaped call) skips dedup', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrantUpsertOnly();
    const memory = makeMockMemory();

    // Reindex Phase 3 shape per cli/reindex.mjs:531: infer:false, full
    // frontmatter spread in metadata, _systemMigration:true at top level.
    await umAdd({
      memory,
      text: 'rebuilt vault doc body',
      userId: 'u-reindex',
      surface: 'reindex',
      metadata: { id: 'doc-7', kind: 'page', project: 'p1' },
      infer: false,
      _systemMigration: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(qdrant.upserts.length, 1, 'reindex writes upsert directly');
    // Reindex point ID uses randomUUID (not uuidv5) — preserves the existing
    // reindex contract where each rebuild emits a fresh ID.
  });
});

test('T14: UM_DEDUP_EMBEDDING_THRESHOLD env var flows through to qdrant.search score_threshold', async () => {
  const prevThreshold = process.env.UM_DEDUP_EMBEDDING_THRESHOLD;
  process.env.UM_DEDUP_EMBEDDING_THRESHOLD = '0.85';
  try {
    await withDedupOn(async () => {
      const qdrant = makeMockQdrant();
      const memory = makeMockMemory();
      qdrant.scrollResult = { points: [] };
      qdrant.searchResult = [];

      await umAdd({
        memory,
        text: 'something',
        userId: 'u-1',
        surface: 'cli',
        infer: false,
        _factsProviderOverride: factsOverride,
        _embedProviderOverride: embedOverride,
        _qdrantClient: qdrant.client,
      });

      assert.equal(qdrant.searches.length, 1, 'Layer 2 ran');
      assert.equal(qdrant.searches[0].body.score_threshold, 0.85, 'env-var threshold flows to search');
    });
  } finally {
    if (prevThreshold === undefined) delete process.env.UM_DEDUP_EMBEDDING_THRESHOLD;
    else process.env.UM_DEDUP_EMBEDDING_THRESHOLD = prevThreshold;
  }
});

test('T7b: multi-tenant isolation under uuidv5 — different userIds with same hash produce different point IDs', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    const memory = makeMockMemory();
    qdrant.scrollResult = { points: [] };
    qdrant.searchResult = [];

    // Alice writes "X"
    await umAdd({
      memory, text: 'X', userId: 'alice', surface: 'cli', infer: false,
      _factsProviderOverride: factsOverride, _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });
    // Bob writes "X" — same hash, different userId
    await umAdd({
      memory, text: 'X', userId: 'bob', surface: 'cli', infer: false,
      _factsProviderOverride: factsOverride, _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(qdrant.upserts.length, 2, 'both writes upsert');
    const idAlice = qdrant.upserts[0].body.points[0].id;
    const idBob = qdrant.upserts[1].body.points[0].id;
    assert.notEqual(idAlice, idBob, 'different userIds → different uuidv5 IDs');
    // Both should be valid UUID format (qdrant ExtendedPointId requires UUID strings).
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(idAlice, uuidRegex);
    assert.match(idBob, uuidRegex);
  });
});

// ---------------------------------------------------------------------------
// D2 lane / persona dedup cascade (T13–T18 + T15b).
// Spec §8 + spec §4.7. Each test uses `mock.honorFilters = true` to exercise
// the real partition-arm filter behavior (legacy tests rely on the mock
// returning pre-seeded results regardless of filter for shape-only assertions;
// D2 tests need filters to actually run).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
function md5Hex(s) { return createHash('md5').update(s).digest('hex'); }

test('T13: same text + same lane + same persona → DEDUP_MERGED', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    qdrant.honorFilters = true;
    const text = 'I work in Go';
    const hash = md5Hex(text);
    // Pre-seed an existing point with matching (userId, hash, lane, persona).
    qdrant.scrollResult = { points: [{
      id: 'existing-work-eng',
      payload: { userId: 'u-1', hash, lane: 'work', persona: 'engineer', data: text, surfaces: ['cli'] },
    }] };

    const res = await umAdd({
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      surface: 'claude-code',
      infer: false,
      metadata: { lane: 'work', persona: 'engineer' },
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'DEDUP_MERGED');
    assert.equal(qdrant.upserts.length, 0, 'no upsert on dedup-merge');
  });
});

test('T14: same text, one write has lane set + the other does not → 2 records, NO merge', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    qdrant.honorFilters = true;
    const text = 'cross-lane test';
    const hash = md5Hex(text);
    // Pre-seed an existing point with NO lane key.
    qdrant.scrollResult = { points: [{
      id: 'existing-no-lane',
      payload: { userId: 'u-1', hash, data: text },
    }] };

    const res = await umAdd({
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      infer: false,
      metadata: { lane: 'work' },     // new write HAS lane
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'ADD', 'lane-set write must not merge into no-lane point');
    assert.equal(qdrant.upserts.length, 1, 'upserted as new record');
  });
});

test('T15: same text + both writes have lane set but different values → 2 records, NO merge', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    qdrant.honorFilters = true;
    const text = 'I prefer Rust';
    const hash = md5Hex(text);
    qdrant.scrollResult = { points: [{
      id: 'existing-work',
      payload: { userId: 'u-1', hash, lane: 'work', data: text },
    }] };

    const res = await umAdd({
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      infer: false,
      metadata: { lane: 'personal' },
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'ADD', 'different lane values must not merge');
    assert.equal(qdrant.upserts.length, 1);
  });
});

test('T15b: legacy point (no lane key) + new write WITH lane → 2 records (asymmetric back-compat)', async () => {
  // Symmetric counterpart to T18 (legacy + new without lane → MERGE).
  // The cascade must treat a lane-set new write as a different partition
  // from a legacy no-lane existing point, even when text + userId match.
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    qdrant.honorFilters = true;
    const text = 'asymmetric case';
    const hash = md5Hex(text);
    qdrant.scrollResult = { points: [{
      id: 'legacy-point-no-lane',
      payload: { userId: 'u-1', hash, data: text, surfaces: ['pre-d2'] },
    }] };

    const res = await umAdd({
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      surface: 'claude-code',
      infer: false,
      metadata: { lane: 'work' },
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'ADD');
    assert.equal(qdrant.upserts.length, 1);
    const newPayload = qdrant.upserts[0].body.points[0].payload;
    assert.equal(newPayload.lane, 'work', 'new point has lane=work');
    assert.equal(newPayload.hash, hash);
  });
});

test('T16: same text + same lane + different persona → 2 records, NO merge', async () => {
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    qdrant.honorFilters = true;
    const text = 'persona partition';
    const hash = md5Hex(text);
    qdrant.scrollResult = { points: [{
      id: 'existing-work-eng',
      payload: { userId: 'u-1', hash, lane: 'work', persona: 'engineer', data: text },
    }] };

    const res = await umAdd({
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      infer: false,
      metadata: { lane: 'work', persona: 'parent' },
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'ADD', 'different persona values must not merge');
    assert.equal(qdrant.upserts.length, 1);
  });
});

test('T17: TOCTOU — two writes with same (lane, persona) → same uuidv5 point-id', async () => {
  // The cascade's deterministic point-id is the TOCTOU guard: even without
  // dedup check (e.g. fail-soft fallthrough), concurrent identical writes
  // with the same partition tuple collide on the SAME id, so qdrant upsert
  // semantics keep them at one row.
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    // Both writes miss dedup (no pre-seeded points), so both reach the
    // plain-upsert path. The two upserts MUST share the same point-id.
    qdrant.honorFilters = true;
    const text = 'concurrent identical';
    const args = {
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      infer: false,
      metadata: { lane: 'work', persona: 'engineer' },
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    };
    await umAdd(args);
    await umAdd(args);

    assert.equal(qdrant.upserts.length, 2, 'both writes ran upsert');
    const id1 = qdrant.upserts[0].body.points[0].id;
    const id2 = qdrant.upserts[1].body.points[0].id;
    assert.equal(id1, id2, 'same (userId, hash, lane, persona) → same uuidv5 point-id (TOCTOU collide-on-write)');

    // And a different partition tuple produces a DIFFERENT id.
    qdrant.upserts.length = 0;
    await umAdd({ ...args, metadata: { lane: 'personal', persona: 'engineer' } });
    const id3 = qdrant.upserts[0].body.points[0].id;
    assert.notEqual(id3, id1, 'different lane → distinct point-id');
  });
});

test('T18: legacy point (no lane key) + new write with NO lane → DEDUP_MERGED (back-compat)', async () => {
  // Symmetric counterpart to T15b. Legacy points (pre-D2) had no lane/persona
  // keys; a new write that ALSO omits both should merge with them — the
  // absence arm (`is_empty`) matches both.
  await withDedupOn(async () => {
    const qdrant = makeMockQdrant();
    qdrant.honorFilters = true;
    const text = 'legacy-compat case';
    const hash = md5Hex(text);
    qdrant.scrollResult = { points: [{
      id: 'legacy-point',
      payload: { userId: 'u-1', hash, data: text, surfaces: ['pre-d2'] },
    }] };

    const res = await umAdd({
      memory: makeMockMemory(),
      text,
      userId: 'u-1',
      surface: 'claude-code',
      infer: false,
      // no lane / persona in metadata
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    });

    assert.equal(res.results[0].event, 'DEDUP_MERGED', 'no-lane new write must merge with legacy no-lane point');
    assert.equal(qdrant.upserts.length, 0);
    assert.equal(qdrant.setPayloads.length, 1, 'mergeSurface fired');
  });
});

// ---------------------------------------------------------------------------
// D3.1 — Task 1.4: dedup layers exclude status:'superseded' tombstones.
// R1-Lens-A-G4. Both checkContentHashDedup and checkEmbeddingDedup must return
// null when the only matching candidate has status:'superseded'. A point with
// NO status key (pre-D3/legacy) must still return as a dedup hit (absence-
// tolerance invariant: exclusion = must_not superseded, NOT must current).
// ---------------------------------------------------------------------------

import { checkContentHashDedup, checkEmbeddingDedup } from '../lib/dedup.mjs';

// T19: hash-dedup skips a superseded tombstone — re-assert produces a fresh point (null hit).
test('T19: D3.1 hash-dedup skips superseded tombstone (re-assert => fresh point)', async () => {
  const mock = makeMockQdrant({
    points: [{ id: 'tombstone-h', payload: { userId: 'u', hash: 'H', status: 'superseded' } }],
  });
  const hit = await checkContentHashDedup({
    client: mock.client,
    collection: 'c',
    userId: 'u',
    hash: 'H',
    lane: undefined,
    persona: undefined,
  });
  assert.equal(hit, null, 'superseded point must NOT be returned as a hash dedup hit');
});

// T20: embedding-dedup skips a superseded tombstone — same exclusion via search filter.
test('T20: D3.1 embedding-dedup skips superseded tombstone (re-assert => fresh point)', async () => {
  const mock = makeMockQdrant({
    points: [{
      id: 'tombstone-e',
      payload: { userId: 'u', status: 'superseded' },
      // score would make it a hit if not excluded
      score: 0.99,
    }],
  });
  const hit = await checkEmbeddingDedup({
    client: mock.client,
    collection: 'c',
    userId: 'u',
    vector: [0.1, 0.2],
    threshold: 0.84,
    lane: undefined,
    persona: undefined,
  });
  assert.equal(hit, null, 'superseded point must NOT be returned as an embedding dedup hit');
});

// T21a: absence-tolerance — hash-dedup: a point with NO status key is still a valid dedup hit.
// Proves the exclusion is "must_not status==superseded", NOT "must status==current".
// Pre-D3 facts have no status key; they must still dedup-merge normally.
test('T21a: D3.1 absence-tolerance — hash-dedup: no-status point IS still a dedup hit', async () => {
  const mock = makeMockQdrant({
    points: [{ id: 'pre-d3-point', payload: { userId: 'u', hash: 'H' } }],
    // No 'status' key at all — mimics every pre-D3 fact in production
  });
  const hit = await checkContentHashDedup({
    client: mock.client,
    collection: 'c',
    userId: 'u',
    hash: 'H',
    lane: undefined,
    persona: undefined,
  });
  assert.ok(hit !== null, 'no-status (pre-D3) point must still be returned as a hash dedup hit');
  assert.equal(hit.id, 'pre-d3-point');
});

// T21b: absence-tolerance — embedding-dedup: a point with NO status key is still a valid dedup hit.
test('T21b: D3.1 absence-tolerance — embedding-dedup: no-status point IS still a dedup hit', async () => {
  const mock = makeMockQdrant({
    points: [{ id: 'pre-d3-emb', payload: { userId: 'u' }, score: 0.99 }],
  });
  const hit = await checkEmbeddingDedup({
    client: mock.client,
    collection: 'c',
    userId: 'u',
    vector: [0.1, 0.2],
    threshold: 0.84,
    lane: undefined,
    persona: undefined,
  });
  assert.ok(hit !== null, 'no-status (pre-D3) point must still be returned as an embedding dedup hit');
  assert.equal(hit.id, 'pre-d3-emb');
});

// T22a: sanity — hash-dedup: a point with status:'current' is still a valid dedup hit.
test('T22a: D3.1 sanity — hash-dedup: status:current point IS still a dedup hit', async () => {
  const mock = makeMockQdrant({
    points: [{ id: 'current-h', payload: { userId: 'u', hash: 'H', status: 'current' } }],
  });
  const hit = await checkContentHashDedup({
    client: mock.client,
    collection: 'c',
    userId: 'u',
    hash: 'H',
    lane: undefined,
    persona: undefined,
  });
  assert.ok(hit !== null, 'status:current point must still be returned as a hash dedup hit');
  assert.equal(hit.id, 'current-h');
});

// T22b: sanity — embedding-dedup: a point with status:'current' is still a valid dedup hit.
test('T22b: D3.1 sanity — embedding-dedup: status:current point IS still a dedup hit', async () => {
  const mock = makeMockQdrant({
    points: [{ id: 'current-e', payload: { userId: 'u', status: 'current' }, score: 0.99 }],
  });
  const hit = await checkEmbeddingDedup({
    client: mock.client,
    collection: 'c',
    userId: 'u',
    vector: [0.1, 0.2],
    threshold: 0.84,
    lane: undefined,
    persona: undefined,
  });
  assert.ok(hit !== null, 'status:current point must still be returned as an embedding dedup hit');
  assert.equal(hit.id, 'current-e');
});

// ---------------------------------------------------------------------------
// D3.2 — Task 2.1: findEmbeddingSimilarCandidates (T23).
// Returns top-K current points in the given partition; excludes superseded
// tombstones and points outside the lane/persona partition. Pure read — no
// mutations.
// ---------------------------------------------------------------------------

import { findEmbeddingSimilarCandidates } from '../lib/dedup.mjs';

// T23: findEmbeddingSimilarCandidates — returns only current lane:work points;
// excludes superseded tombstone and lane:other point.
test('T23: D3.2 findEmbeddingSimilarCandidates — current lane:work only (superseded + other-lane excluded)', async () => {
  const mock = makeMockQdrant({
    points: [
      // 2 current points in lane:work
      { id: 'work-a', payload: { userId: 'u', lane: 'work', status: 'current', data: 'fact A' }, score: 0.91 },
      { id: 'work-b', payload: { userId: 'u', lane: 'work', status: 'current', data: 'fact B' }, score: 0.88 },
      // 1 superseded tombstone in lane:work — must be excluded
      { id: 'work-dead', payload: { userId: 'u', lane: 'work', status: 'superseded', data: 'old fact' }, score: 0.95 },
      // 1 current point in a different lane — must be excluded
      { id: 'other-c', payload: { userId: 'u', lane: 'other', status: 'current', data: 'other lane' }, score: 0.90 },
    ],
  });

  const candidates = await findEmbeddingSimilarCandidates({
    client: mock.client,
    collection: 'col',
    userId: 'u',
    vector: [0.1, 0.2],
    threshold: 0.5,
    lane: 'work',
    persona: undefined,
    limit: 10,
  });

  // Must return exactly the 2 current lane:work points.
  assert.equal(candidates.length, 2, 'only the 2 current lane:work points returned');
  const returnedIds = candidates.map((c) => c.id).sort();
  assert.deepEqual(returnedIds, ['work-a', 'work-b'].sort(), 'correct point ids returned');

  // Each item must have the shape {id, payload, score}.
  for (const c of candidates) {
    assert.ok('id' in c, 'result has id field');
    assert.ok('payload' in c, 'result has payload field');
    assert.ok('score' in c, 'result has score field');
  }

  // Verify the search was called with limit and score_threshold.
  assert.equal(mock.searches.length, 1, 'client.search called once');
  assert.equal(mock.searches[0].body.limit, 10, 'limit forwarded to client.search');
  assert.equal(mock.searches[0].body.score_threshold, 0.5, 'threshold forwarded as score_threshold');
});
