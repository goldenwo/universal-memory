/**
 * cli/test/reindex-adapters.test.mjs — pins the #231 native-enumeration
 * conversion of the two reindex snapshot adapters (round-2 review fold:
 * the round-1 CRITICAL fix had zero coverage — createVaultAdapter was
 * untested repo-wide and reindex-phase2-3 stubs listFactIds wholesale,
 * bypassing the wrapper's own enumeration).
 *
 * Pins, per adapter:
 *   - the enumerator receives {userId, limit: FULL_SCAN_LIMIT} (the old
 *     bare mem0 getAll silently capped at 100 — a latent truncation on
 *     the SNAPSHOT path — and mem0 3.x rejects the old shape outright);
 *   - a saturated scan throws instead of proceeding on a truncated view
 *     (a truncated snapshot is data loss on this delete-then-rewrite arc);
 *   - the projection/filter logic the phases depend on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVaultAdapter, wrapOldMemoryForReindex } from '../reindex.mjs';
import { FULL_SCAN_LIMIT, umGetAll } from '../../server/lib/mem0-read.mjs';

function enumeratorOf(items) {
  const calls = [];
  const listAll = async (mem, args) => { calls.push({ mem, args }); return { results: items }; };
  return { calls, listAll };
}

test('createVaultAdapter: fact-only read enumerates via umGetAll at FULL_SCAN_LIMIT and caches', async () => {
  const oldMemory = { tag: 'old' };
  const { calls, listAll } = enumeratorOf([
    { id: 'f1', memory: 'fact one', metadata: { lane: 'work' } },
    { id: 'f2', memory: 'fact two', metadata: {} },
  ]);
  const vault = await createVaultAdapter({ vaultDir: '/nowhere', oldMemory, userId: 'op', _listAll: listAll });

  const doc = await vault.read('f2');
  assert.deepEqual(doc, { frontmatter: { id: 'f2' }, body: 'fact two' });
  // Scope + cap pin: the exact args the #231 conversion must send.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mem, oldMemory);
  assert.deepEqual(calls[0].args, { userId: 'op', limit: FULL_SCAN_LIMIT });

  // Cache pin: a second fact-only read must NOT re-enumerate.
  await vault.read('f1');
  assert.equal(calls.length, 1);

  await assert.rejects(() => vault.read('missing-id'), /not found in oldMemory/);
});

test('createVaultAdapter: a saturated enumeration throws — never a silently truncated snapshot', async () => {
  const big = Array.from({ length: FULL_SCAN_LIMIT }, (_, i) => ({ id: `p${i}`, memory: 'x' }));
  const { listAll } = enumeratorOf(big);
  const vault = await createVaultAdapter({ vaultDir: '/nowhere', oldMemory: {}, userId: 'op', _listAll: listAll });
  await assert.rejects(() => vault.read('p1'), /saturated at FULL_SCAN_LIMIT/);
});

test('wrapOldMemoryForReindex.listFactIds: same enumeration contract; vault-backed entries excluded; other methods delegate', async () => {
  const target = { other: () => 'delegated' };
  // #362: metadata.id is what reindexDoc writes — the doc's frontmatter id (its filename stem),
  // never a vault path. The old fixture used path ids, a shape no writer produces, so every
  // real vault-backed point passed as a fact and a migration would have written each doc twice.
  const { calls, listAll } = enumeratorOf([
    { id: 'u1', metadata: { id: 's1', type: 'session_summary' } },  // vault-backed → excluded
    { id: 'u2', metadata: { id: 'gone-doc', type: 'note' } },       // its vault file is gone → kept
    { id: 'u3', metadata: {} },                                     // fact-only → kept
    { metadata: {} },                                               // id-less → skipped
  ]);
  const wrapped = wrapOldMemoryForReindex(target, { userId: 'op', _listAll: listAll });
  assert.deepEqual(await wrapped.listFactIds({ vaultIds: ['s1'] }), ['u2', 'u3']);
  assert.deepEqual(calls[0].args, { userId: 'op', limit: FULL_SCAN_LIMIT });
  assert.equal(calls[0].mem, target);
  assert.equal(wrapped.other(), 'delegated');
});

test('wrapOldMemoryForReindex #362: a stored point, through umGetAll\'s real projection, is recognised as vault-backed by its payload id', async () => {
  // Payloads as they sit in the live collection: a vault doc reindexDoc wrote (payload.id = the
  // frontmatter id) and a memory_add fact (no id). Only the Qdrant client is faked.
  const points = [
    { id: 'p-doc', payload: { id: 's1', type: 'session_summary', title: 'Session one', schema_version: 1, data: 'Session one\n\nWhat happened.', userId: 'op' } },
    { id: 'p-fact', payload: { data: 'a fact', userId: 'op' } },
  ];
  const client = { scroll: async () => ({ points }) };
  const memory = { config: { vectorStore: { config: { collectionName: 'memories' } } } };
  const wrapped = wrapOldMemoryForReindex(memory, {
    userId: 'op',
    _listAll: (mem, args) => umGetAll(mem, args, { getClient: async () => client }),
  });
  assert.deepEqual(await wrapped.listFactIds({ vaultIds: ['s1'] }), ['p-fact']);
});

test('wrapOldMemoryForReindex: a saturated enumeration throws', async () => {
  const big = Array.from({ length: FULL_SCAN_LIMIT }, (_, i) => ({ id: `p${i}` }));
  const { listAll } = enumeratorOf(big);
  const wrapped = wrapOldMemoryForReindex({}, { userId: 'op', vaultPaths: [], _listAll: listAll });
  await assert.rejects(() => wrapped.listFactIds(), /saturated at FULL_SCAN_LIMIT/);
});
