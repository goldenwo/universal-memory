// End-to-end reindex test (UM_LIVE_TESTS-gated).
//
// Exercises the full `node cli/reindex.mjs` pipeline against a real Qdrant
// + real provider APIs. Operator-driven per the FIN1 live-test matrix; not
// runnable in CI (skipped when UM_LIVE_TESTS is unset).
//
// Prereqs (UM_LIVE_TESTS=1):
//   - Qdrant reachable: `docker compose -f server/docker-compose.yml up -d qdrant`
//   - OPENAI_API_KEY and GOOGLE_API_KEY exported.
//   - A scratch UM_VAULT_DIR (operator picks; do NOT point at real notes).
//
// Verification helpers (operator-run after each scenario):
//   curl -s http://localhost:6333/collections | jq .
//   curl -s http://localhost:6333/aliases    | jq .
//
// Teardown:
//   docker compose -f server/docker-compose.yml down -v
//   rm -rf "$UM_VAULT_DIR"
//
// Plan reference: docs/plans/2026-04-27-v0.7-provider-neutrality-plan.md §DE12.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SKIP = !process.env.UM_LIVE_TESTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REINDEX_CLI = path.join(REPO_ROOT, 'cli', 'reindex.mjs');

/**
 * Seed a scratch vault with `count` markdown docs. Each doc has a stable
 * id (matching its filename stem) so post-reindex search assertions can
 * find it back regardless of whether qdrant returned results in insertion
 * order.
 */
async function seedScratchVault(vaultDir, count = 3) {
  const subdir = path.join(vaultDir, 'authored', 'reindex-e2e');
  await mkdir(subdir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `seed-doc-${i}`;
    const body = `Test document ${i}: the quick brown fox jumps over the lazy dog. Index marker: ${id}.`;
    const fm = `---
schema_version: 1
type: note
id: ${id}
title: "Reindex e2e seed doc ${i}"
status: current
---
`;
    await writeFile(path.join(subdir, `${id}.md`), fm + '\n' + body, 'utf8');
  }
  return Array.from({ length: count }, (_, i) => `seed-doc-${i}`);
}

/**
 * Pre-populate qdrant with the seeded vault under a starting provider.
 * Mirrors what a real UM server would do at write time but skips the
 * server-process round-trip — calls `umAdd()` directly with the configured
 * provider env. Returns the live old-collection name.
 */
async function preIndex({ vaultDir, env, ids }) {
  const { umAdd } = await import('../../server/lib/add.mjs');
  const { createMemoryInstance } = await import('../reindex.mjs');
  const userId = env.MEM0_USER_ID || 'reindex-e2e';
  const collection = env.QDRANT_COLLECTION || 'memories';
  const memory = await createMemoryInstance({ env, collection });
  for (const id of ids) {
    const relPath = `authored/reindex-e2e/${id}.md`;
    const text = await readFile(path.join(vaultDir, relPath), 'utf8');
    const body = text.split('---').slice(2).join('---').trim();
    await umAdd({
      memory,
      text: body,
      userId,
      metadata: { id: relPath, schema_version: 1, type: 'note' },
      infer: false,
    });
  }
  return collection;
}

/**
 * Run the reindex CLI synchronously. Captures stdout+stderr.
 */
function runReindexCli(args, env) {
  return spawnSync('node', [REINDEX_CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Spawn the reindex CLI asynchronously so a test can SIGTERM it. Returns
 * the child handle plus a promise that resolves when the process exits.
 */
function spawnReindexCli(args, env) {
  const child = spawn('node', [REINDEX_CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (b) => { stdoutBuf += b.toString(); });
  child.stderr.on('data', (b) => { stderrBuf += b.toString(); });
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout: stdoutBuf, stderr: stderrBuf }));
  });
  return { child, done, getStdout: () => stdoutBuf, getStderr: () => stderrBuf };
}

/**
 * Curl Qdrant's collection list and assert the new collection landed.
 */
async function fetchCollections() {
  const host = process.env.QDRANT_HOST || 'localhost';
  const port = process.env.QDRANT_PORT || '6333';
  const res = await fetch(`http://${host}:${port}/collections`);
  if (!res.ok) throw new Error(`qdrant /collections HTTP ${res.status}`);
  const json = await res.json();
  return json.result?.collections?.map((c) => c.name) || [];
}

async function fetchAliasTarget(alias) {
  const host = process.env.QDRANT_HOST || 'localhost';
  const port = process.env.QDRANT_PORT || '6333';
  const res = await fetch(`http://${host}:${port}/aliases`);
  if (!res.ok) throw new Error(`qdrant /aliases HTTP ${res.status}`);
  const json = await res.json();
  const found = (json.result?.aliases || []).find((a) => a.alias_name === alias);
  return found?.collection_name || null;
}

// ─── Test 1: provider flip e2e (openai → google) ────────────────────────
test('reindex e2e: openai → google flips embedding provider end-to-end', { skip: SKIP }, async () => {
  if (!process.env.OPENAI_API_KEY || !process.env.GOOGLE_API_KEY) {
    assert.fail('OPENAI_API_KEY and GOOGLE_API_KEY are required for this test');
  }
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'reindex-e2e-flip-'));
  const checkpointPath = path.join(vaultDir, 'reindex.checkpoint.json');
  const collection = `reindex_e2e_flip_${Date.now()}`;
  try {
    const ids = await seedScratchVault(vaultDir);

    // Pre-index under openai/text-embedding-3-small.
    const seedEnv = {
      UM_EMBEDDING_PROVIDER: 'openai',
      UM_EMBEDDING_MODEL: 'text-embedding-3-small',
      UM_VAULT_DIR: vaultDir,
      QDRANT_COLLECTION: collection,
      MEM0_USER_ID: 'reindex-e2e-flip',
    };
    await preIndex({ vaultDir, env: seedEnv, ids });

    // Flip env: google/text-embedding-004 + run reindex.
    const flipEnv = {
      ...seedEnv,
      UM_EMBEDDING_PROVIDER: 'google',
      UM_EMBEDDING_MODEL: 'text-embedding-004',
    };
    const result = runReindexCli(
      ['--confirm', '--no-server-probe', '--checkpoint-path', checkpointPath],
      flipEnv,
    );
    assert.equal(result.status, 0, `reindex failed: ${result.stderr}`);
    assert.match(result.stdout, /reindex complete/i);

    // Verify alias resolves to a NEW collection (not the seed one).
    const aliasTarget = await fetchAliasTarget(collection);
    assert.ok(aliasTarget, 'alias should resolve');
    assert.notEqual(aliasTarget, collection, 'alias should now point at a new collection');

    // Verify both old and new collections exist (keep-old default).
    const collections = await fetchCollections();
    assert.ok(collections.includes(collection), 'old collection should still exist');
    assert.ok(collections.includes(aliasTarget), 'new collection should exist');
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
    // Operator runs `docker compose down -v` between scenarios to drop
    // qdrant data. We do NOT auto-clean qdrant collections here — that's
    // the operator's job per the FIN1 matrix's teardown step.
  }
});

// ─── Test 2: --resume continues after kill mid-phase-3 ──────────────────
test('reindex e2e: --resume continues after kill mid-phase-3', { skip: SKIP }, async () => {
  if (!process.env.OPENAI_API_KEY || !process.env.GOOGLE_API_KEY) {
    assert.fail('OPENAI_API_KEY and GOOGLE_API_KEY are required for this test');
  }
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'reindex-e2e-resume3-'));
  const checkpointPath = path.join(vaultDir, 'reindex.checkpoint.json');
  const collection = `reindex_e2e_resume3_${Date.now()}`;
  try {
    // Seed enough docs that phase 3 takes long enough to interrupt.
    const ids = await seedScratchVault(vaultDir, 30);
    const seedEnv = {
      UM_EMBEDDING_PROVIDER: 'openai',
      UM_EMBEDDING_MODEL: 'text-embedding-3-small',
      UM_VAULT_DIR: vaultDir,
      QDRANT_COLLECTION: collection,
      MEM0_USER_ID: 'reindex-e2e-resume3',
    };
    await preIndex({ vaultDir, env: seedEnv, ids });

    const flipEnv = {
      ...seedEnv,
      UM_EMBEDDING_PROVIDER: 'google',
      UM_EMBEDDING_MODEL: 'text-embedding-004',
    };

    // Spawn reindex; let phase-2 complete + a few phase-3 entries process,
    // then SIGTERM. We watch stderr for a phase-3 progress line as the
    // signal. (Phase 3 emits SIGINT-handler "cancellation requested" only
    // after we send the signal — so we just wait ~3s for phase 3 to start.)
    const { child, done } = spawnReindexCli(
      ['--confirm', '--no-server-probe', '--checkpoint-path', checkpointPath],
      flipEnv,
    );
    await new Promise((r) => setTimeout(r, 3000));
    child.kill('SIGINT');
    const first = await done;
    assert.equal(first.code, 0, `first run should exit 0 on graceful cancel: ${first.stderr}`);

    const cp1 = JSON.parse(await readFile(checkpointPath, 'utf8'));
    const processedAfterKill = cp1.processed_ids?.length ?? 0;
    assert.ok(processedAfterKill > 0 && processedAfterKill < ids.length,
      `expected partial progress; got ${processedAfterKill}/${ids.length}`);

    // Resume — should pick up from processedAfterKill and finish.
    const second = runReindexCli(
      ['--confirm', '--resume', '--no-server-probe', '--checkpoint-path', checkpointPath],
      flipEnv,
    );
    assert.equal(second.status, 0, `resume failed: ${second.stderr}`);

    const cp2 = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.equal(cp2.processed_ids.length, ids.length,
      'after resume, processed_ids should cover the full snapshot');
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

// ─── Test 3: --resume after kill between phase-4 and phase-5 ────────────
test('reindex e2e: --resume after kill between phase-4 and phase-5 is safe', { skip: SKIP }, async () => {
  if (!process.env.OPENAI_API_KEY || !process.env.GOOGLE_API_KEY) {
    assert.fail('OPENAI_API_KEY and GOOGLE_API_KEY are required for this test');
  }
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'reindex-e2e-resume45-'));
  const checkpointPath = path.join(vaultDir, 'reindex.checkpoint.json');
  const collection = `reindex_e2e_resume45_${Date.now()}`;
  try {
    const ids = await seedScratchVault(vaultDir, 3);
    const seedEnv = {
      UM_EMBEDDING_PROVIDER: 'openai',
      UM_EMBEDDING_MODEL: 'text-embedding-3-small',
      UM_VAULT_DIR: vaultDir,
      QDRANT_COLLECTION: collection,
      MEM0_USER_ID: 'reindex-e2e-resume45',
    };
    await preIndex({ vaultDir, env: seedEnv, ids });

    const flipEnv = {
      ...seedEnv,
      UM_EMBEDDING_PROVIDER: 'google',
      UM_EMBEDDING_MODEL: 'text-embedding-004',
    };

    // First pass — but stop after phase 4. The cleanest way to simulate
    // "killed between 4 and 5" is to run normally, then manually rewind
    // the checkpoint phase counter and rerun --resume. The resume MUST
    // re-run phase 5 and complete the alias swap.
    const first = runReindexCli(
      ['--confirm', '--no-server-probe', '--checkpoint-path', checkpointPath],
      flipEnv,
    );
    assert.equal(first.status, 0, `initial run failed: ${first.stderr}`);

    // Rewind checkpoint to phase_completed=4 (mid-state).
    const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.ok(cp.target_collection, 'checkpoint must have target_collection');
    cp.phase_completed = 4;
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

    // Resume — phase 5 must replay safely (alias swap is idempotent).
    const second = runReindexCli(
      ['--confirm', '--resume', '--no-server-probe', '--checkpoint-path', checkpointPath],
      flipEnv,
    );
    assert.equal(second.status, 0, `resume failed: ${second.stderr}`);

    // Alias should still resolve to target_collection after replay.
    const aliasTarget = await fetchAliasTarget(collection);
    assert.equal(aliasTarget, cp.target_collection,
      'alias should resolve to the recorded target after replay');
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});
