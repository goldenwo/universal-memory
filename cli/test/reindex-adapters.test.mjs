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
import { FULL_SCAN_LIMIT } from '../../server/lib/mem0-read.mjs';

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
  const { calls, listAll } = enumeratorOf([
    { id: 'u1', metadata: { id: 'notes/a.md' } },  // vault-backed → excluded
    { id: 'u2', metadata: { id: 'gone/b.md' } },   // .md but NOT in vaultPaths → kept
    { id: 'u3', metadata: {} },                    // fact-only → kept
    { metadata: {} },                              // id-less → skipped
  ]);
  const wrapped = wrapOldMemoryForReindex(target, {
    userId: 'op',
    vaultPaths: ['notes\\a.md'],  // backslash form — the wrapper normalizes
    _listAll: listAll,
  });
  assert.deepEqual(await wrapped.listFactIds(), ['u2', 'u3']);
  assert.deepEqual(calls[0].args, { userId: 'op', limit: FULL_SCAN_LIMIT });
  assert.equal(calls[0].mem, target);
  assert.equal(wrapped.other(), 'delegated');
});

test('wrapOldMemoryForReindex: a saturated enumeration throws', async () => {
  const big = Array.from({ length: FULL_SCAN_LIMIT }, (_, i) => ({ id: `p${i}` }));
  const { listAll } = enumeratorOf(big);
  const wrapped = wrapOldMemoryForReindex({}, { userId: 'op', vaultPaths: [], _listAll: listAll });
  await assert.rejects(() => wrapped.listFactIds(), /saturated at FULL_SCAN_LIMIT/);
});
