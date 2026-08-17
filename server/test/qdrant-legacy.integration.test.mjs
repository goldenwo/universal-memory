/**
 * server/test/qdrant-legacy.integration.test.mjs — the Pi-shaped legacy
 * gate for the #231 mem0ai 3.x reconciliation (spec §1.10 / A3).
 *
 * Boots the REAL server (mem0-mcp-http.mjs) against a dockerized qdrant
 * 1.7.x holding a PRE-EXISTING dense-only collection — the exact deployment
 * the legacy-qdrant 400-tolerance hunk exists for (the Pi runs y0mg
 * qdrant v1.7.3; official images SIGABRT on that host).
 *
 * WHY THE SERVER, NOT A BARE Memory: mem0ai@3.1.6's Memory constructor
 * swallows `_autoInitialize` errors into `_initError` and only surfaces
 * them on the first public call (spec F14) — "constructor survives" passes
 * with AND without the hunk. The server's warmup `getAll`
 * (mem0-mcp-http.mjs:459) IS that public call, so SERVER BINDS vs NEVER
 * BINDS is the discriminator — the exact #157 failure mode.
 *
 * DUAL-MODE BY TREE STATE: the expectation flips on whether the hunk is
 * present in node_modules (auto-detected). On a BARE 3.1.6 tree this test
 * PROVES the failure mode (RED leg: server dies the #157 death); on the
 * patched tree it proves the fix (GREEN leg). Same env both legs — the
 * hunk is the only variable (spec §1.10 positive control).
 *
 * KEYLESS: a format-valid PLACEHOLDER key satisfies the provider-key
 * preflight (mem0-mcp-http.mjs:296-299 exits BEFORE initMemory without
 * one — a truly keyless boot would fake the RED signal). No embedder call
 * fires on this path: our openai embedderConfig pre-sets `embeddingDims`,
 * which mem0's ConfigManager maps into vectorStore.config.dimension
 * (3.1.6 L14529) so `_autoInitialize`'s live dimension probe is skipped,
 * and UM_TEST_MOCK_SDK=1 makes the DE5 stamp guard skip writeStamp/
 * verifyDim (both would route through mem0's REAL embedder). Entity-store
 * + add/search functional asserts are NOT here — they need real
 * embeddings and live in the A9 legacy arm (spec §1.10 assert split).
 *
 * Gating: UM_QDRANT_LEGACY_INTEGRATION=1, plus a qdrant 1.7.x reachable at
 * UM_LEGACY_QDRANT_HOST:UM_LEGACY_QDRANT_PORT (default localhost:6338):
 *   docker run -d --name um-legacy-qdrant -p 6338:6333 qdrant/qdrant:v1.7.4
 * (amd64 official image — the SIGABRT is Pi/arm-specific.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tempDir } from './helpers/tmpdir.mjs';

const SKIP = !process.env.UM_QDRANT_LEGACY_INTEGRATION;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..');
const MEM0_INDEX = join(SERVER_ROOT, 'node_modules', 'mem0ai', 'dist', 'oss', 'index.mjs');

const QDRANT_HOST = process.env.UM_LEGACY_QDRANT_HOST ?? 'localhost';
const QDRANT_PORT = parseInt(process.env.UM_LEGACY_QDRANT_PORT ?? '6338', 10);
const QDRANT_URL = `http://${QDRANT_HOST}:${QDRANT_PORT}`;
// Scratch server port, distinct from the default 6335 stack.
const SERVER_PORT = parseInt(process.env.UM_LEGACY_SERVER_PORT ?? '6398', 10);
const COLLECTION = `legacy_compat_${process.pid}`;
// Dim must match the openai provider default (text-embedding-3-small =
// 1536) so the pre-existing collection looks exactly like the Pi's.
const DIM = 1536;

// GREEN leg: bind well inside the 30×2s warmup window. RED leg: the warmup
// burns the FULL retry budget (~60s) before the FATAL, so give it headroom.
const GREEN_BIND_BUDGET_MS = 90_000;
const RED_FATAL_BUDGET_MS = 110_000;

const hunkPresent = () =>
  existsSync(MEM0_INDEX) && readFileSync(MEM0_INDEX, 'utf-8').includes('legacyQdrantAlreadyExists');

async function qdrantFetch(path, init) {
  const res = await fetch(`${QDRANT_URL}${path}`, init);
  let body;
  try { body = await res.json(); } catch { body = undefined; }
  return { status: res.status, body };
}

async function createDenseCollection(name) {
  return qdrantFetch(`/collections/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }),
  });
}

function spawnServer(logSink, historyDir) {
  const child = spawn(process.execPath, ['mem0-mcp-http.mjs'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      MEM0_MCP_PORT: String(SERVER_PORT),
      QDRANT_HOST,
      QDRANT_PORT: String(QDRANT_PORT),
      QDRANT_COLLECTION: COLLECTION,
      MEM0_HISTORY_DB_PATH: join(historyDir, 'mem0-history.db'),
      // Format-valid placeholder — passes the sk- preflight, never used
      // (see header). NOT a secret.
      OPENAI_API_KEY: 'sk-um-legacy-boot-placeholder-000000000000',
      // Second boot preflight that would otherwise fake the RED signal by
      // dying before initMemory (same class as the key preflight): the
      // server requires a user id at startup.
      MEM0_USER_ID: 'um-legacy-gate',
      UM_TEST_MOCK_SDK: '1',
      UM_EMBEDDING_PROVIDER: 'openai',
      UM_FACTS_PROVIDER: 'openai',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logSink.lines.push(d.toString()));
  child.stderr.on('data', (d) => logSink.lines.push(d.toString()));
  child.on('exit', (code) => { logSink.exitCode = code; });
  return child;
}

async function waitFor(predicate, budgetMs, intervalMs = 1000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function healthUp() {
  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

test('legacy qdrant 1.7.x: pre-existing collection → the hunk decides server life', { skip: SKIP, timeout: 240_000 }, async (t) => {
  // --- Preflight: the target really is a legacy 1.7.x qdrant. ---
  const root = await qdrantFetch('/');
  assert.ok(
    root.body?.version?.startsWith('1.7.'),
    `expected a qdrant 1.7.x at ${QDRANT_URL} (got ${root.body?.version ?? 'no response'}); ` +
    `start one with: docker run -d -p ${QDRANT_PORT}:6333 qdrant/qdrant:v1.7.4`,
  );

  // --- Setup: the Pi shape — collection ALREADY EXISTS, dense-only. ---
  const created = await createDenseCollection(COLLECTION);
  assert.equal(created.status, 200, `setup create failed: ${JSON.stringify(created.body)}`);
  t.after(async () => {
    for (const c of [COLLECTION, `${COLLECTION}_entities`, 'memory_migrations']) {
      await qdrantFetch(`/collections/${c}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  // Pin the SERVER behavior the hunk bridges: duplicate create on 1.7.x is
  // HTTP 400 (not 409) with an "already exists" body — the #157 shape and
  // the spec §1.3 invariant's first conjunct's reason to exist.
  const dup = await createDenseCollection(COLLECTION);
  assert.equal(dup.status, 400, `legacy qdrant duplicate-create must be 400, got ${dup.status}`);
  assert.match(
    JSON.stringify(dup.body).toLowerCase(), /already exists/,
    `legacy 400 body must say "already exists": ${JSON.stringify(dup.body)}`,
  );

  // --- Drive: boot the real server; expectation flips on tree state. ---
  const logSink = { lines: [], exitCode: undefined };
  const historyDir = tempDir('um-legacy-');
  const child = spawnServer(logSink, historyDir);
  t.after(() => { try { child.kill(); } catch { /* already dead */ } });

  const log = () => logSink.lines.join('');

  if (hunkPresent()) {
    // GREEN leg (positive control: same env as RED; hunk = only variable).
    // Early-exit on child death so a wrong-death (e.g. an unrelated boot
    // preflight) surfaces its log immediately instead of burning the budget.
    await waitFor(
      async () => (await healthUp()) || logSink.exitCode !== undefined,
      GREEN_BIND_BUDGET_MS,
    );
    assert.ok(
      await healthUp(),
      `WITH the hunk the server must bind within ${GREEN_BIND_BUDGET_MS / 1000}s — it did not ` +
      `(exitCode=${logSink.exitCode}).\n--- server log ---\n${log()}`,
    );
    // BM25 degrades on the pre-hybrid collection (spec F8): the exists-branch
    // verifies the sparse slot is absent and warns.
    assert.match(
      log(), /predates hybrid search/,
      `expected the "predates hybrid search" BM25-degrade warn on a legacy collection.\n--- server log ---\n${log()}`,
    );
    // mem0 3.1.6 init also ensures its migrations collection (spec F4) —
    // fresh CREATE on 1.7.x must have succeeded.
    const migrations = await qdrantFetch('/collections/memory_migrations');
    assert.equal(migrations.status, 200, 'memory_migrations was not created on the legacy server');
    // Exists-path createFilterIndexes (spec F10) is per-field try/catch'd —
    // a healthy bind IS the non-fatal assert; record chatter for R2 evidence.
    const chatter = logSink.lines.filter((l) => /version|compat/i.test(l));
    t.diagnostic(`client-compat chatter (${chatter.length} line(s)): ${chatter.join(' | ').slice(0, 500)}`);
  } else {
    // RED leg — bare 3.1.6: init's duplicate create throws the raw 400, the
    // warmup burns its 30×2s retries re-hitting it, then boot dies (#157).
    // Early-exit on child death so a DIFFERENT death (wrong preflight, port
    // clash) fails fast with its log instead of burning the budget.
    await waitFor(
      async () =>
        /FATAL: Qdrant unreachable after 30 attempts/.test(log()) ||
        logSink.exitCode !== undefined,
      RED_FATAL_BUDGET_MS,
    );
    assert.match(
      log(), /FATAL: Qdrant unreachable after 30 attempts/,
      `WITHOUT the hunk the boot must die the #157 death (warmup FATAL after 30 attempts; ` +
      `exitCode=${logSink.exitCode}).\n--- server log ---\n${log()}`,
    );
    assert.equal(await healthUp(), false, 'server must NOT be serving /health on the RED leg');
    // The underlying error is the legacy 400 — pin that it is the duplicate-
    // create shape, not a connectivity failure masquerading as RED.
    assert.match(
      log(), /400|Bad Request|already exists/i,
      `RED-leg failure must be the legacy 400 mode, not qdrant-unreachable.\n--- server log ---\n${log()}`,
    );
  }
});
