import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { umAdd } from '../lib/add.mjs';
import { RESERVED_METADATA_FIELDS, NAMESPACE_UM } from '../lib/dedup-constants.mjs';
import { registry } from '../lib/metrics.mjs';

// P4 ISOLATION: the lane classifier is ACTIVE by default (opt-out) as of v1.3.0. The umAdd
// tests in this file exercise OTHER behaviors (facts pipeline, dedup, point-IDs, in-band
// supersession) and inject the classifier seam (_classifyLane / _laneClassifierEnabled) only
// where they test it. Pin the env OFF here so the always-on classifier does not perturb the
// seam-less tests. The new opt-out DEFAULT (env unset → active) is verified directly by the
// 'Gap-5 P4 opt-out' tests below and by classifierEnabled's unit test in lane-classifier.test.mjs.
process.env.UM_LANE_CLASSIFIER_ENABLED = 'false';

function md5(s) { return createHash('md5').update(s).digest('hex'); }

// Test fixtures — mock qdrant client + memory shim
function makeMockQdrant() {
  const upserts = [];
  return {
    upserts,
    client: {
      upsert: async (collection, body) => { upserts.push({ collection, body }); return { status: 'ok' }; },
    },
  };
}

function makeMockMemory({ collection = 'memories' } = {}) {
  return { config: { vectorStore: { config: { collectionName: collection, host: 'localhost', port: 6333 } } } };
}

test('umAdd infer:true calls facts() then embed() per fact, then qdrant.upsert per fact', async () => {
  const calls = [];
  const factsOverride = {
    supports: { facts: true },
    defaults: { factsModel: 'mock' },
    factsInvoke: async (text) => {
      calls.push({ kind: 'facts', text });
      return { facts: ['fact 1', 'fact 2'], usage: { tokensIn: 10, tokensOut: 5 } };
    },
  };
  const embedOverride = {
    supports: { embeddings: true },
    defaults: { embeddingModel: 'mock' },
    embed: async (text) => {
      calls.push({ kind: 'embed', text });
      return { vector: [0.1, 0.2], usage: { tokensIn: 3, tokensOut: 0 } };
    },
  };
  const qdrant = makeMockQdrant();
  const memory = makeMockMemory();

  const result = await umAdd({
    memory, text: 'I like blue.', userId: 'u-1', infer: true,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
  });

  assert.equal(calls.length, 3, 'facts() once + embed() twice');
  assert.equal(calls[0].kind, 'facts');
  assert.equal(calls[1].kind, 'embed');
  assert.equal(calls[1].text, 'fact 1');
  assert.equal(calls[2].text, 'fact 2');
  assert.equal(qdrant.upserts.length, 2);
  assert.equal(qdrant.upserts[0].collection, 'memories');

  // Return shape mirrors mem0's add()
  assert.ok(Array.isArray(result.results));
  assert.equal(result.results.length, 2);
  for (const r of result.results) {
    assert.ok(typeof r.id === 'string');
    assert.equal(r.event, 'ADD');
  }
});

test('umAdd infer:false skips facts(), embeds raw text once, single qdrant upsert', async () => {
  const calls = [];
  const factsOverride = {
    factsInvoke: async () => { calls.push('facts'); return { facts: [], usage: { tokensIn: 0, tokensOut: 0 } }; },
  };
  const embedOverride = {
    supports: { embeddings: true }, defaults: { embeddingModel: 'mock' },
    embed: async (text) => { calls.push('embed:' + text); return { vector: [0.5], usage: { tokensIn: 8, tokensOut: 0 } }; },
  };
  const qdrant = makeMockQdrant();
  const memory = makeMockMemory();

  await umAdd({
    memory, text: 'raw doc text', userId: 'u-2', metadata: { id: 'doc-7', kind: 'page' }, infer: false,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
  });

  assert.deepEqual(calls, ['embed:raw doc text']);  // facts() NOT called when infer:false
  assert.equal(qdrant.upserts.length, 1);
  // Payload schema (load-bearing — spec §4.3): camelCase userId/createdAt, metadata flattened.
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(payload.userId, 'u-2');
  assert.equal(payload.id, 'doc-7');         // metadata flattened
  assert.equal(payload.kind, 'page');         // metadata flattened
  assert.equal(payload.data, 'raw doc text');
  assert.ok(typeof payload.hash === 'string' && payload.hash.length === 32, 'md5(text)');
  assert.ok(typeof payload.createdAt === 'string', 'ISO 8601 createdAt');
  assert.equal(payload.user_id, undefined, 'snake_case user_id MUST NOT appear');
  assert.equal(payload.created_at, undefined, 'snake_case created_at MUST NOT appear');
  assert.equal(payload.metadata, undefined, 'metadata MUST be flattened, not nested');
  // D1 v1.1 schema additions (always seeded regardless of UM_DEDUP_ENABLED).
  // Visibility lock: if a future change drops these fields, this assertion
  // fails loudly rather than silently regressing the dedup contract.
  assert.equal(payload.dedupCount, 1, 'D1: dedupCount MUST be seeded to 1 on first write');
  assert.equal(payload.dedupVersion, 1, 'D1: dedupVersion MUST be seeded to 1 (schema-version pin)');
});

test('umAdd error from facts() propagates without writing to qdrant', async () => {
  const factsOverride = { factsInvoke: async () => { throw new Error('facts failed'); } };
  const embedOverride = { embed: async () => assert.fail('embed should not be called') };
  const qdrant = makeMockQdrant();
  await assert.rejects(
    () => umAdd({
      memory: makeMockMemory(), text: 't', userId: 'u', infer: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    }),
    /facts failed/,
  );
  assert.equal(qdrant.upserts.length, 0);
});

test('umAdd empty facts (infer:true, 0 extracted) returns { results: [] }, no qdrant write', async () => {
  const factsOverride = { factsInvoke: async () => ({ facts: [], usage: { tokensIn: 5, tokensOut: 1 } }) };
  const embedOverride = { embed: async () => assert.fail('embed should not be called when facts empty') };
  const qdrant = makeMockQdrant();
  const result = await umAdd({
    memory: makeMockMemory(), text: 't', userId: 'u', infer: true,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
  });
  assert.deepEqual(result, { results: [] });
  assert.equal(qdrant.upserts.length, 0);
});

test('umAdd binds {userId, collection, infer} to pino ALS via withRequestContext', async () => {
  const { withRequestContext } = await import('../lib/request-context.mjs');
  let observed;
  const factsOverride = {
    factsInvoke: async () => {
      // Inside the orchestrator call, the ALS store should hold our binding.
      const { _alsForTest } = await import('../lib/request-context.mjs');
      observed = _alsForTest().getStore();
      return { facts: [], usage: { tokensIn: 0, tokensOut: 0 } };
    },
  };
  await withRequestContext({ id: 'req-1' }, async () => {
    await umAdd({
      memory: { config: { vectorStore: { config: { collectionName: 'cc', host: 'localhost', port: 6333 } } } },
      text: 't', userId: 'alice', infer: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: { embed: async () => ({ vector: [], usage: { tokensIn: 0, tokensOut: 0 } }) },
      _qdrantClient: { upsert: async () => ({}) },
    });
  });
  assert.equal(observed?.userId, 'alice');
  assert.equal(observed?.collection, 'cc');
  assert.equal(observed?.infer, true);
  assert.equal(observed?.id, 'req-1');  // outer request_id preserved
});

test('umAdd increments um_facts_extracted_total by facts.length per call', async () => {
  const incCalls = [];
  const fakeFactsCounter = { inc: (labels, value) => incCalls.push({ labels, value }) };
  // Provide `defaults.factsModel` so the facts orchestrator's fallback chain
  // (ctx.model ?? env ?? provider.defaults?.factsModel) resolves to a real
  // string. Without this, model falls through to undefined and the counter
  // emits {provider, model: undefined} — production has no such gap because
  // real providers always export defaults.
  const factsOverride = {
    defaults: { factsModel: 'mock-facts-model' },
    factsInvoke: async () => ({ facts: ['a', 'b', 'c'], usage: { tokensIn: 5, tokensOut: 2 } }),
  };
  await umAdd({
    memory: { config: { vectorStore: { config: { collectionName: 'c', host: 'localhost', port: 6333 } } } }, text: 't', userId: 'u', infer: true,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: { embed: async () => ({ vector: [0.1], usage: { tokensIn: 0, tokensOut: 0 } }) },
    _qdrantClient: { upsert: async () => ({}) },
    _factsCounter: fakeFactsCounter,
  });
  assert.equal(incCalls.length, 1);
  assert.equal(incCalls[0].value, 3);
  // Labels come from the orchestrator return shape (T11 extension). Assert
  // they're present AND non-undefined strings — a regression that fell through
  // env resolution and emitted {provider: undefined, model: undefined} would
  // have passed the weaker `'in' in labels` check.
  assert.equal(typeof incCalls[0].labels.provider, 'string');
  assert.equal(typeof incCalls[0].labels.model, 'string');
});

test('umAdd emits facts.empty INFO log when infer:true extracts zero facts', async () => {
  const logged = [];
  const fakeLogger = { info: (obj, msg) => logged.push({ obj, msg }) };
  await umAdd({
    memory: { config: { vectorStore: { config: { collectionName: 'c', host: 'localhost', port: 6333 } } } }, text: 't', userId: 'u', infer: true,
    _factsProviderOverride: { factsInvoke: async () => ({ facts: [], usage: { tokensIn: 5, tokensOut: 1 } }) },
    _embedProviderOverride: { embed: async () => assert.fail('should not call embed') },
    _qdrantClient: { upsert: async () => ({}) },
    _logger: fakeLogger,
  });
  const empty = logged.find((l) => l.obj?.event === 'facts.empty');
  assert.ok(empty, 'facts.empty INFO line emitted');
  assert.equal(empty.obj.userId, 'u');
  assert.equal(empty.obj.collection, 'c');
  assert.equal(typeof empty.obj.textLength, 'number');
});

// ── D2 lane / persona schema (T7–T12 + T12b) ───────────────────────────
//
// Covers the additive metadata fields landing in the qdrant payload, the
// staging-out pattern that defeats the ...metadata spread, the validation
// that throws BEFORE any side effect, the reserved-fields-exclusion
// contract, and the uuidv5 seed continuity for legacy back-compat.

// Mock with empty dedup responses so dedupEligible=true writes still reach
// the plain-upsert (uuidv5) path without spurious fail-soft logs.
function makeMockQdrantD2() {
  const upserts = [];
  return {
    upserts,
    client: {
      upsert: async (collection, body) => { upserts.push({ collection, body }); return { status: 'ok' }; },
      scroll: async () => ({ points: [] }),
      search: async () => [],
    },
  };
}

const factsPassthrough = {
  factsInvoke: async (text) => ({ facts: [text], usage: { tokensIn: 0, tokensOut: 0 } }),
};
const embedDummy = {
  embed: async () => ({ vector: [0.1, 0.2], usage: { tokensIn: 0, tokensOut: 0 } }),
};

test('umAdd T7: metadata.lane="work" → payload has lane:"work"', async () => {
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'hello', userId: 'u', infer: false,
    metadata: { lane: 'work', project: 'p' },
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: qdrant.client,
  });
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(payload.lane, 'work');
});

test('umAdd T8: no lane → payload has NO lane key (Object.hasOwn === false)', async () => {
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'hello', userId: 'u', infer: false,
    metadata: { project: 'p' },
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: qdrant.client,
  });
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(Object.hasOwn(payload, 'lane'), false, 'payload should have no lane key');
  assert.equal(Object.hasOwn(payload, 'persona'), false, 'payload should have no persona key');
});

test('umAdd T9: metadata.lane=null is equivalent to omitted — locks anti-spread anti-goal', async () => {
  // The buildPayload spread of ...metadata would otherwise leak `lane: null`
  // into the payload. D2 §4.1 stages lane/persona out of the spread; this
  // test pins the contract.
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'hello', userId: 'u', infer: false,
    metadata: { lane: null, persona: null, project: 'p' },
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: qdrant.client,
  });
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(Object.hasOwn(payload, 'lane'), false, 'caller lane:null → no lane key in payload');
  assert.equal(Object.hasOwn(payload, 'persona'), false, 'caller persona:null → no persona key in payload');
});

test('umAdd T10: both lane + persona set → payload has both keys with validated values', async () => {
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'hello', userId: 'u', infer: false,
    metadata: { lane: 'work', persona: 'me-engineer', project: 'p' },
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: qdrant.client,
  });
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(payload.lane, 'work');
  assert.equal(payload.persona, 'me-engineer');
});

test('umAdd T11: invalid lane rejects BEFORE any facts/embed/qdrant side effect (R5)', async () => {
  let factsCalled = 0;
  let embedCalled = 0;
  const qdrant = makeMockQdrantD2();
  await assert.rejects(
    () => umAdd({
      memory: makeMockMemory(), text: 'hello', userId: 'u', infer: true,
      metadata: { lane: 'work/personal', project: 'p' },
      _factsProviderOverride: {
        factsInvoke: async () => { factsCalled++; return { facts: ['x'], usage: { tokensIn: 0, tokensOut: 0 } }; },
      },
      _embedProviderOverride: {
        embed: async () => { embedCalled++; return { vector: [0.1], usage: { tokensIn: 0, tokensOut: 0 } }; },
      },
      _qdrantClient: qdrant.client,
    }),
    (err) => err.code === 'INPUT_INVALID' && /lane must match/.test(err.message),
  );
  assert.equal(factsCalled, 0, 'facts() must NOT be called when validation fails');
  assert.equal(embedCalled, 0, 'embed() must NOT be called when validation fails');
  assert.equal(qdrant.upserts.length, 0, 'no upserts when validation fails');
});

test('umAdd T12: RESERVED_METADATA_FIELDS does NOT include lane or persona (caller-settable contract)', () => {
  // Lane/persona are caller-settable, NOT reserved. assertNoReservedFields
  // protects D1's accumulator fields (surfaces, projects, dedupCount,
  // dedupVersion, dedupLastSeenAt, systemMigration). D2's lane/persona are
  // separate, single-valued, caller-settable — they must NEVER appear on
  // the reserved list, otherwise valid lane/persona writes would hard-fail
  // at the assertNoReservedFields check.
  assert.ok(!RESERVED_METADATA_FIELDS.includes('lane'),
    'lane must not be reserved (caller-settable per D2)');
  assert.ok(!RESERVED_METADATA_FIELDS.includes('persona'),
    'persona must not be reserved (caller-settable per D2)');
  // Defensive: still includes the D1 six (regression guard against future
  // accidental removal during D2-related code churn).
  for (const f of ['surfaces', 'projects', 'dedupCount', 'dedupVersion', 'dedupLastSeenAt', 'systemMigration']) {
    assert.ok(RESERVED_METADATA_FIELDS.includes(f),
      `${f} must remain reserved (D1 invariant)`);
  }
});

test('umAdd T12b: uuidv5 seed extension preserves legacy back-compat + partitions per (lane, persona)', async () => {
  // When both lane and persona are unset, the extended seed reduces to the
  // legacy `${hash}:${userId}` shape — so pre-D2 dedup-eligible IDs stay
  // valid. When either is set, the suffix `:${lane||''}:${persona||''}` is
  // appended, producing a distinct deterministic ID per partition tuple.
  const userId = 'u-1';
  const text = 'hello world';
  const itemHash = md5(text);

  // No lane / persona — reduces to legacy shape.
  const noLaneQdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text, userId, infer: false,
    metadata: {},
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: noLaneQdrant.client,
  });
  const noLaneId = noLaneQdrant.upserts[0].body.points[0].id;
  const expectedLegacy = uuidv5(`${itemHash}:${userId}`, NAMESPACE_UM);
  assert.equal(noLaneId, expectedLegacy,
    'no lane/persona seed must equal legacy ${hash}:${userId} shape');

  // Lane set — distinct deterministic ID.
  const laneQdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text, userId, infer: false,
    metadata: { lane: 'work' },
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: laneQdrant.client,
  });
  const laneId = laneQdrant.upserts[0].body.points[0].id;
  const expectedWithLane = uuidv5(`${itemHash}:${userId}:work:`, NAMESPACE_UM);
  assert.equal(laneId, expectedWithLane,
    'lane=work seed must equal ${hash}:${userId}:work: shape');
  assert.notEqual(laneId, noLaneId,
    'lane-set point-id must differ from no-lane point-id (partition guarantee)');

  // Lane + persona set — different again.
  const bothQdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text, userId, infer: false,
    metadata: { lane: 'work', persona: 'engineer' },
    _factsProviderOverride: factsPassthrough,
    _embedProviderOverride: embedDummy,
    _qdrantClient: bothQdrant.client,
  });
  const bothId = bothQdrant.upserts[0].body.points[0].id;
  const expectedBoth = uuidv5(`${itemHash}:${userId}:work:engineer`, NAMESPACE_UM);
  assert.equal(bothId, expectedBoth,
    'lane=work + persona=engineer seed must equal ${hash}:${userId}:work:engineer shape');
  assert.notEqual(bothId, laneId, 'persona variation must produce a distinct ID');
  assert.notEqual(bothId, noLaneId, 'lane+persona vs neither must produce a distinct ID');
});

// ---------------------------------------------------------------------------
// Gap-5 P1: lane-classifier seam tests
// ---------------------------------------------------------------------------

// Gap-5 shadow (flag OFF): classified lane is NOT written.
test('Gap-5 shadow: flag off → lane omitted on write even when classifier would route', async () => {
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'sprint planning notes', userId: 'u1', metadata: {}, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: qdrant.client,
    _classifyLane: async () => ({ lane: 'work', score: 0.9 }), // would route
    _laneClassifierEnabled: false,                              // shadow
  });
  assert.equal(qdrant.upserts[0].body.points[0].payload.lane, undefined);
});

// Gap-5 active (flag ON): classified lane IS written.
test('Gap-5 active: flag on + caller omits lane → classified lane written to payload', async () => {
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'sprint planning notes', userId: 'u1', metadata: {}, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: qdrant.client,
    _classifyLane: async () => ({ lane: 'work', score: 0.9 }),
    _laneClassifierEnabled: true,
  });
  assert.equal(qdrant.upserts[0].body.points[0].payload.lane, 'work');
});

// Gap-5: explicit caller lane wins over classifier (active).
test('Gap-5: explicit caller lane wins over classifier (active)', async () => {
  let classifierCalled = false;
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'x', userId: 'u1', metadata: { lane: 'personal' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: qdrant.client,
    _classifyLane: async () => { classifierCalled = true; return { lane: 'work', score: 0.9 }; },
    _laneClassifierEnabled: true,
  });
  assert.equal(qdrant.upserts[0].body.points[0].payload.lane, 'personal');
  assert.equal(classifierCalled, false);
});

// Gap-5: _systemMigration write skips classification entirely.
test('Gap-5: _systemMigration write skips the classifier', async () => {
  let classifierCalled = false;
  const qdrant = makeMockQdrantD2();
  await umAdd({
    memory: makeMockMemory(), text: 'x', userId: 'u1', metadata: {}, infer: false, _systemMigration: true,
    _embedProviderOverride: embedDummy, _qdrantClient: qdrant.client,
    _classifyLane: async () => { classifierCalled = true; return { lane: 'work', score: 0.9 }; },
    _laneClassifierEnabled: true,
  });
  assert.equal(classifierCalled, false);
  assert.equal(qdrant.upserts[0].body.points[0].payload.lane, undefined);
});

// Gap-5: classifier returns null (unroutable) → lane omitted + legacy point-ID.
test('Gap-5 active: classifier null (unroutable) → lane omitted + legacy point-ID (no lane:null)', async () => {
  const q = makeMockQdrantD2();
  const text = 'unroutable text';
  await umAdd({
    memory: makeMockMemory(), text, userId: 'u1', metadata: {}, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _classifyLane: async () => ({ lane: null, score: 0.1 }), // below-threshold / omit
    _laneClassifierEnabled: true,
  });
  const point = q.upserts[0].body.points[0];
  assert.equal(Object.hasOwn(point.payload, 'lane'), false, 'no lane:null key in payload');
  assert.equal(point.id, uuidv5(`${md5(text)}:u1`, NAMESPACE_UM), 'ID must equal the caller-omitted legacy shape');
});

// Gap-5: infer:true classifies each fact independently.
test('Gap-5 active: infer:true classifies each fact independently', async () => {
  const q = makeMockQdrantD2();
  const factsOverride = {
    supports: { facts: true },
    defaults: { factsModel: 'mock' },
    factsInvoke: async () => ({ facts: ['f1', 'f2'], usage: { tokensIn: 0, tokensOut: 0 } }),
  };
  let n = 0;
  await umAdd({
    memory: makeMockMemory(), text: 'mixed', userId: 'u1', metadata: {}, infer: true,
    _factsProviderOverride: factsOverride, _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _classifyLane: async () => (n++ === 0 ? { lane: 'work', score: 0.9 } : { lane: 'home', score: 0.9 }),
    _laneClassifierEnabled: true,
  });
  assert.equal(q.upserts[0].body.points[0].payload.lane, 'work');
  assert.equal(q.upserts[1].body.points[0].payload.lane, 'home');
});

// Gap-5 P4: env-driven default is OPT-OUT (the flip). With NO _laneClassifierEnabled
// seam, active-vs-not resolves from the env via defaultClassifierEnabled(). These two
// tests lock the env contract that the explicit-seam tests above do not exercise.
test('Gap-5 P4 opt-out: env UNSET → classified lane written (active by default)', async () => {
  const prev = process.env.UM_LANE_CLASSIFIER_ENABLED;
  delete process.env.UM_LANE_CLASSIFIER_ENABLED;
  try {
    const q = makeMockQdrantD2();
    await umAdd({
      memory: makeMockMemory(), text: 'sprint planning notes', userId: 'u1', metadata: {}, infer: false,
      _embedProviderOverride: embedDummy, _qdrantClient: q.client,
      _classifyLane: async () => ({ lane: 'work', score: 0.9 }),
      // _laneClassifierEnabled intentionally OMITTED → resolves from env (opt-out default)
    });
    assert.equal(q.upserts[0].body.points[0].payload.lane, 'work', 'env-unset default is ACTIVE post-P4');
  } finally {
    if (prev === undefined) delete process.env.UM_LANE_CLASSIFIER_ENABLED; else process.env.UM_LANE_CLASSIFIER_ENABLED = prev;
  }
});

test('Gap-5 P4 opt-out: env " false " → lane NOT written (explicit opt-out, whitespace-trimmed)', async () => {
  const prev = process.env.UM_LANE_CLASSIFIER_ENABLED;
  process.env.UM_LANE_CLASSIFIER_ENABLED = ' false ';   // padded → still opts out
  try {
    const q = makeMockQdrantD2();
    await umAdd({
      memory: makeMockMemory(), text: 'sprint planning notes', userId: 'u1', metadata: {}, infer: false,
      _embedProviderOverride: embedDummy, _qdrantClient: q.client,
      _classifyLane: async () => ({ lane: 'work', score: 0.9 }),
    });
    assert.equal(q.upserts[0].body.points[0].payload.lane, undefined, 'env=false opts out → no lane written');
  } finally {
    if (prev === undefined) delete process.env.UM_LANE_CLASSIFIER_ENABLED; else process.env.UM_LANE_CLASSIFIER_ENABLED = prev;
  }
});

// ---------------------------------------------------------------------------
// Gap-5 P3: ADR-0007 Option C — dedup defers to supersession in-band.
// ---------------------------------------------------------------------------

// Mock qdrant that can serve a Layer-1 (scroll/hash) or Layer-2 (search/
// embedding) dedup hit, capture upsert + setPayload, and record call ORDER (for
// the crash-safe upsert-before-demote assertion). setPayload is used by BOTH
// mergeSurface (keep-older: payload carries dedupCount, NOT status) and
// supersedePoint (demote: payload carries status:'superseded') — assertions key
// on payload CONTENT, not on "setPayload was called".
function makeMockQdrantInband({ searchHit = null, scrollHit = null, setPayloadThrows = false } = {}) {
  const calls = [];
  const upserts = [];
  const setPayloads = [];
  return {
    calls, upserts, setPayloads,
    client: {
      scroll: async () => { calls.push({ op: 'scroll' }); return { points: scrollHit ? [scrollHit] : [] }; },
      search: async () => { calls.push({ op: 'search' }); return searchHit ? [searchHit] : []; },
      upsert: async (collection, body) => {
        calls.push({ op: 'upsert', id: body.points[0].id });
        upserts.push({ collection, body });
        return { status: 'ok' };
      },
      setPayload: async (collection, body) => {
        calls.push({ op: 'setPayload', payload: body.payload, points: body.points });
        setPayloads.push({ collection, body });
        if (setPayloadThrows) throw new Error('qdrant setPayload failed');
        return { status: 'ok' };
      },
    },
  };
}

const judgeContradicts = async () => ({ contradicts: true, confidence: 0.9, reasoning: 'newer invalidates older' });
const judgeDeclines = async () => ({ contradicts: false, confidence: 0.1, reasoning: 'unrelated' });

// (a) THE LOAD-BEARING INVARIANT (spec §4 / ADR-0007 line 79): an in-band
// eligible contradiction → the NEWER fact persists as its OWN status:current
// point AND the older point is demoted. Skipping the merge alone is insufficient
// (supersession only demotes the older; the newer must be upserted).
test('Gap-5 P3: in-band eligible contradiction → newer persists status:current + older demoted', async () => {
  const older = { id: 'older-pt-1', score: 0.85, payload: { data: 'I live in Boston', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  const text = 'I live in Denver now';
  const result = await umAdd({
    memory: makeMockMemory(), text, userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeContradicts,
  });
  // Newer upserted as its OWN current point (NOT dropped via keep-older).
  assert.equal(q.upserts.length, 1, 'newer fact must be upserted (not merged away)');
  const newer = q.upserts[0].body.points[0];
  assert.equal(newer.payload.status, 'current', 'newer fact is status:current');
  assert.equal(newer.payload.lane, 'work');
  assert.equal(newer.payload.data, text);
  // Older point demoted with supersededBy = newer id.
  const demote = q.setPayloads.find((s) => s.body.payload.status === 'superseded');
  assert.ok(demote, 'older point must be demoted to superseded');
  assert.deepEqual(demote.body.points, ['older-pt-1']);
  assert.equal(demote.body.payload.supersededBy, newer.id, 'supersededBy points at the newer fact id');
  // Result reflects the supersession (not a plain DEDUP_MERGED).
  assert.equal(result.results[0].event, 'SUPERSEDED_INBAND');
  assert.equal(result.results[0].supersededId, 'older-pt-1');
});

// Crash-safe ordering: upsert-newer MUST precede demote-older, so a crash
// between leaves two current points (the accepted D1 trade-off), never the
// "no current fact" recall-loss D3's precision-first design exists to prevent.
test('Gap-5 P3: crash-safe order — newer upsert precedes older demotion', async () => {
  const older = { id: 'older-pt-2', score: 0.85, payload: { data: 'old', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  await umAdd({
    memory: makeMockMemory(), text: 'new contradicting fact', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeContradicts,
  });
  const upsertIdx = q.calls.findIndex((c) => c.op === 'upsert');
  const demoteIdx = q.calls.findIndex((c) => c.op === 'setPayload' && c.payload.status === 'superseded');
  assert.ok(upsertIdx >= 0 && demoteIdx >= 0, 'both ops happened');
  assert.ok(upsertIdx < demoteIdx, 'upsert-newer must come BEFORE demote-older (crash-safety)');
});

// Fail-soft demotion: if the demote setPayload throws, the write STILL succeeds
// (newer is current) and umAdd does not throw — no silent data-loss path.
test('Gap-5 P3: demotion failure is fail-soft — newer stays current, write succeeds', async () => {
  const older = { id: 'older-pt-3', score: 0.85, payload: { data: 'old', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older, setPayloadThrows: true });
  const result = await umAdd({
    memory: makeMockMemory(), text: 'new contradicting fact', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeContradicts,
  });
  assert.equal(q.upserts.length, 1, 'newer fact persisted as current even though demotion failed');
  assert.equal(q.upserts[0].body.points[0].payload.status, 'current');
  assert.equal(result.results.length, 1, 'umAdd returned a result (did not throw)');
});

// (b) out-of-band (cosine above the 0.95 confident-dup floor) → unchanged keep-older; judge NOT consulted.
test('Gap-5 P3: out-of-band hit (pure duplicate) → keep-older merge, no supersede, no judge', async () => {
  let judged = false;
  const older = { id: 'older-pt-4', score: 0.97, payload: { data: 'dup', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  const result = await umAdd({
    memory: makeMockMemory(), text: 'dup', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true,
    _judgeContradiction: async () => { judged = true; return { contradicts: true, confidence: 0.9 }; },
  });
  assert.equal(judged, false, 'above-ceiling hit must NOT reach the judge');
  assert.equal(q.upserts.length, 0, 'keep-older: newer not upserted');
  assert.equal(result.results[0].event, 'DEDUP_MERGED');
  assert.ok(!q.setPayloads.some((s) => s.body.payload.status === 'superseded'), 'no demotion');
});

// (b) flag off → unchanged keep-older; judge NOT consulted.
test('Gap-5 P3: autosupersede flag off → keep-older merge, no judge', async () => {
  let judged = false;
  const older = { id: 'older-pt-5', score: 0.85, payload: { data: 'x', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  const result = await umAdd({
    memory: makeMockMemory(), text: 'y', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: false,
    _judgeContradiction: async () => { judged = true; return { contradicts: true, confidence: 0.9 }; },
  });
  assert.equal(judged, false, 'flag-off must short-circuit before the judge');
  assert.equal(q.upserts.length, 0);
  assert.equal(result.results[0].event, 'DEDUP_MERGED');
});

// (b) unpartitioned (no lane/persona) → unchanged keep-older; judge NOT consulted (R1-B1).
test('Gap-5 P3: unpartitioned hit → keep-older merge, no judge (R1-B1)', async () => {
  let judged = false;
  const older = { id: 'older-pt-6', score: 0.85, payload: { data: 'x', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  const result = await umAdd({
    memory: makeMockMemory(), text: 'y', userId: 'u1', metadata: {}, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true,
    _judgeContradiction: async () => { judged = true; return { contradicts: true, confidence: 0.9 }; },
  });
  assert.equal(judged, false, 'unpartitioned write must not reach the judge');
  assert.equal(q.upserts.length, 0);
  assert.equal(result.results[0].event, 'DEDUP_MERGED');
});

// Layer-1 hash hit (exact text) is never a contradiction → always keep-older, never judged.
test('Gap-5 P3: exact hash hit → keep-older, judge never consulted (even if eligible+enabled)', async () => {
  let judged = false;
  const hashOlder = { id: 'older-h', payload: { data: 'exact same text', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ scrollHit: hashOlder });
  const result = await umAdd({
    memory: makeMockMemory(), text: 'exact same text', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true,
    _judgeContradiction: async () => { judged = true; return { contradicts: true, confidence: 0.9 }; },
  });
  assert.equal(judged, false, 'hash hits are exact duplicates, never contradictions — no judge');
  assert.equal(q.upserts.length, 0);
  assert.equal(result.results[0].event, 'DEDUP_MERGED');
});

// in-band eligible BUT judge declines → keep-older (newer NOT upserted, older NOT demoted).
test('Gap-5 P3: in-band but judge declines → keep-older merge', async () => {
  const older = { id: 'older-pt-7', score: 0.85, payload: { data: 'related but not contradicting', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  const result = await umAdd({
    memory: makeMockMemory(), text: 'also about work', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeDeclines,
  });
  assert.equal(q.upserts.length, 0, 'judge declined → keep-older, newer not upserted');
  assert.equal(result.results[0].event, 'DEDUP_MERGED');
  assert.ok(!q.setPayloads.some((s) => s.body.payload.status === 'superseded'), 'no demotion when judge declines');
});

// Wiring proof: the in-band judge duration histogram is observed when the inline judge ran.
// Uses the same judgeContradicts harness as the load-bearing invariant test above.
test('Gap-5 P3: in-band judge duration histogram observed when judge ran (v1.5.0 p99 telemetry)', async () => {
  const older = { id: 'older-duration-1', score: 0.85, payload: { data: 'I use vim', lane: 'work', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  // Snapshot the count before this test so we assert increment (registry is shared across the file).
  const textBefore = await registry.metrics();
  const countBefore = Number((textBefore.match(/um_inband_supersede_duration_seconds_count (\d+)/) ?? [, '0'])[1]);
  await umAdd({
    memory: makeMockMemory(), text: 'I use emacs now', userId: 'u1', metadata: { lane: 'work' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeContradicts,
  });
  const textAfter = await registry.metrics();
  const countAfter = Number((textAfter.match(/um_inband_supersede_duration_seconds_count (\d+)/) ?? [, '0'])[1]);
  assert.ok(countAfter > countBefore, 'um_inband_supersede_duration_seconds must be observed when the inline judge ran');
});

// Per-item loop-locality: in infer:true, fact 1 contradicts in-band while fact 2 is
// a clean add. `supersedeOlderId` is declared INSIDE the per-item loop, so the
// supersede target must NOT leak into fact 2's iteration (a leak would demote
// fact 1's older point twice / mislabel fact 2 as SUPERSEDED_INBAND).
test('Gap-5 P3: infer:true — per-fact supersede target does not leak across items', async () => {
  const olderF1 = { id: 'older-f1', score: 0.85, payload: { data: 'f1 older', lane: 'work', status: 'current' } };
  let searchCalls = 0;
  const upserts = [];
  const setPayloads = [];
  const client = {
    scroll: async () => ({ points: [] }),
    search: async () => { searchCalls += 1; return searchCalls === 1 ? [olderF1] : []; }, // hit on fact 1 only
    upsert: async (_c, body) => { upserts.push(body.points[0]); return { status: 'ok' }; },
    setPayload: async (_c, body) => { setPayloads.push(body); return { status: 'ok' }; },
  };
  const factsOverride = {
    supports: { facts: true }, defaults: { factsModel: 'mock' },
    factsInvoke: async () => ({ facts: ['f1 newer', 'f2 unrelated'], usage: { tokensIn: 0, tokensOut: 0 } }),
  };
  const result = await umAdd({
    memory: makeMockMemory(), text: 'mixed', userId: 'u1', metadata: { lane: 'work' }, infer: true,
    _factsProviderOverride: factsOverride, _embedProviderOverride: embedDummy, _qdrantClient: client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeContradicts,
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].event, 'SUPERSEDED_INBAND', 'fact 1 (in-band contradiction) supersedes');
  assert.equal(result.results[0].supersededId, 'older-f1');
  assert.equal(result.results[1].event, 'ADD', 'fact 2 is a plain ADD — the supersede target did not leak across items');
  const demotions = setPayloads.filter((s) => s.payload.status === 'superseded');
  assert.equal(demotions.length, 1, 'exactly one demotion — only the contradicting fact demotes an older point');
  assert.equal(demotions[0].points[0], 'older-f1');
});

// Coverage parity: a persona-only partition (no lane) triggers Option C identically.
test('Gap-5 P3: in-band contradiction on a persona-only partition → newer current + older demoted', async () => {
  const older = { id: 'older-persona-1', score: 0.85, payload: { data: 'I prefer tabs', persona: 'engineer', status: 'current' } };
  const q = makeMockQdrantInband({ searchHit: older });
  const text = 'I prefer spaces now';
  const result = await umAdd({
    memory: makeMockMemory(), text, userId: 'u1', metadata: { persona: 'engineer' }, infer: false,
    _embedProviderOverride: embedDummy, _qdrantClient: q.client,
    _autoSupersedeEnabled: true, _judgeContradiction: judgeContradicts,
  });
  assert.equal(q.upserts.length, 1, 'newer fact upserted as its own point');
  const newer = q.upserts[0].body.points[0];
  assert.equal(newer.payload.status, 'current');
  assert.equal(newer.payload.persona, 'engineer');
  const demote = q.setPayloads.find((s) => s.body.payload.status === 'superseded');
  assert.ok(demote, 'older point demoted');
  assert.deepEqual(demote.body.points, ['older-persona-1']);
  assert.equal(result.results[0].event, 'SUPERSEDED_INBAND');
});

// ---------------------------------------------------------------------------

test('umAdd surfaces qdrant errors raw — outer call sites wrap retry policy', async () => {
  // Spec §6 + add.mjs header: umAdd does NOT internally wrap qdrant.upsert
  // in withRetry. The mem0-mcp-http call sites (lines 688/778/2179/2338)
  // each wrap umAdd() in withRetry({op:'add'}) — that's the single source
  // of retry/UPSTREAM_FAILURE behavior. Wrapping again inside umAdd would
  // multiply attempts (4×4 = 16) and double-emit um_mem0_ops_total.
  let calls = 0;
  const flakyClient = {
    upsert: async () => { calls++; throw Object.assign(new Error('connection refused'), { retryable: true }); },
  };
  const factsOverride = { factsInvoke: async () => ({ facts: ['x'], usage: { tokensIn: 0, tokensOut: 0 } }) };
  const embedOverride = { embed: async () => ({ vector: [0.1], usage: { tokensIn: 0, tokensOut: 0 } }) };
  await assert.rejects(
    () => umAdd({
      memory: makeMockMemory(), text: 't', userId: 'u', infer: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: flakyClient,
    }),
    /connection refused/,
  );
  assert.equal(calls, 1, 'no inner retry — single attempt before throw');
});
