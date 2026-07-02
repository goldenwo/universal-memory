/**
 * server/test/patch-contract.test.mjs — locks the W6.2 patch's
 * boot-tier contract: importing `mem0ai/oss` must not throw, AND the
 * patched-import shape must produce the documented `[mem0-patch]` warns
 * when peerDeps are absent.
 *
 * Distinct from `provider-matrix.test.mjs` (which exercises the
 * provider registry's clean-error path BEFORE mem0 is touched, so it
 * doesn't actually verify the patch fired). This file imports mem0
 * directly so a patch regression — silent no-op apply, hunk-shape
 * mismatch, future mem0 bump that adds an unpatched static import —
 * fails loud at unit-test time instead of at boot in production.
 *
 * Cite: docs/plans/2026-05-07-w6.2-image-size-spec.md §Test strategy
 * "Boot tier"; server/patches/README.md §Reconciliation step 6.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEM0_INDEX = resolve(__dirname, '..', 'node_modules', 'mem0ai', 'dist', 'oss', 'index.mjs');

// W6.2 canonical counts for mem0ai@2.4.6 (also documented in
// server/Dockerfile and server/patches/README.md).
// awaitImports: count of `await import(` in the patched module
// memPatchLogs: count of `[mem0-patch]` warn-line strings
const EXPECTED_AWAIT_IMPORTS = 14;
const EXPECTED_MEMPATCH_LOGS = 14;

test('W6.2 patch is applied to mem0ai/dist/oss/index.mjs', () => {
  if (!existsSync(MEM0_INDEX)) {
    assert.fail(`mem0ai not installed at ${MEM0_INDEX} — run npm ci first`);
  }
  const src = readFileSync(MEM0_INDEX, 'utf-8');
  const awaitImports = (src.match(/await import\(/g) || []).length;
  const memPatchLogs = (src.match(/\[mem0-patch\]/g) || []).length;

  // The patch is applied via `npx patch-package` (in Docker build OR
  // explicit CI step OR local npm test run). If counts are 0 here,
  // the patch wasn't applied; if they're nonzero but != expected,
  // something has drifted from the canonical count.
  assert.equal(
    awaitImports, EXPECTED_AWAIT_IMPORTS,
    `expected ${EXPECTED_AWAIT_IMPORTS} \`await import(\` in patched mem0ai (got ${awaitImports}); ` +
    `if 0, run \`cd server && npx patch-package\`; if drifted, see server/patches/README.md §Reconciliation`,
  );
  assert.equal(
    memPatchLogs, EXPECTED_MEMPATCH_LOGS,
    `expected ${EXPECTED_MEMPATCH_LOGS} [mem0-patch] strings in patched mem0ai (got ${memPatchLogs})`,
  );
});

test('W6.2 patch: no eager imports of unused-provider packages remain', () => {
  if (!existsSync(MEM0_INDEX)) return; // covered by previous test's failure
  const src = readFileSync(MEM0_INDEX, 'utf-8');
  // Match top-level `import ... from "<unused-pkg>"` (single-line OR
  // first line of a multi-line import block). Multi-line imports start
  // with `import {\n` and end with `} from "<pkg>";` — we check the
  // `from "..."` line via regex on the full source.
  const unusedPkgRe = /(groq-sdk|@mistralai\/mistralai|better-sqlite3|cloudflare|@supabase\/supabase-js|@langchain\/core|@azure\/identity|@azure\/search-documents|neo4j-driver|^pg|redis)/;
  const lines = src.split('\n');
  const eagerLines = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // single-line eager: `import ... from "<unused>";` at start of line
    if (/^import\s/.test(ln) && unusedPkgRe.test(ln) && /from\s+"[^"]+";/.test(ln)) {
      eagerLines.push(`L${i + 1}: ${ln.trim()}`);
    }
  }
  assert.deepEqual(
    eagerLines, [],
    `expected 0 eager top-level imports of unused-provider packages, found:\n${eagerLines.join('\n')}\n` +
    `See server/patches/README.md §Reconciliation`,
  );
});

test('W6.2 patch: mem0ai/oss imports cleanly (module load succeeds)', async () => {
  // The whole point of the patch: with peer-skipped providers absent,
  // module load must not throw. Locally we typically have all peers
  // installed so the dynamic imports succeed silently — the assertion
  // here is just "import resolves without error" + minimum exports.
  // The CI smoke job exercises the absent-peer path via the prod
  // Docker image where the rm step fires.
  const mod = await import('mem0ai/oss');
  // Sanity exports the patched module surfaces. These names are stable
  // across mem0 minor versions; if a major bump removes them, the
  // patch reconciliation procedure is needed.
  // Memory class is the primary entrypoint; LLMFactory/EmbedderFactory
  // are the registries we depend on indirectly via Memory's constructor.
  assert.equal(typeof mod.Memory, 'function', 'mem0ai/oss must export Memory class');
  assert.equal(typeof mod.LLMFactory, 'function', 'mem0ai/oss must export LLMFactory');
  assert.equal(typeof mod.EmbedderFactory, 'function', 'mem0ai/oss must export EmbedderFactory');
});

test('legacy-qdrant patch: ensureCollection tolerates a 400 "already exists"', () => {
  // qdrant ≤1.7 (e.g. the Pi's y0mg/qdrant-raspberry-pi v1.7.3) returns
  // HTTP 400 — not 409 — for a duplicate createCollection. mem0ai's
  // ensureCollection catches only 409/401/403, so against a legacy
  // server with an existing collection, init throws and the HTTP server
  // never binds. The patch adds a guarded 400 case that matches the
  // qdrant error body ("already exists") and keeps genuine 400s throwing.
  if (!existsSync(MEM0_INDEX)) return;
  const src = readFileSync(MEM0_INDEX, 'utf-8');
  assert.match(
    src,
    /const legacyQdrantAlreadyExists = error\?\.status === 400 &&[^\n]*already exists/,
    'ensureCollection must treat a 400 whose body says "already exists" like a 409 (legacy qdrant ≤1.7); see server/patches/README.md',
  );
  assert.match(
    src,
    /=== 403 \|\| legacyQdrantAlreadyExists\)/,
    'the legacy-400 guard must be OR-ed into the existing 409/401/403 exists-branch, not replace it',
  );
});

test('W6.2 patch: pg destructure has defensive `let pkg = {}` init', () => {
  // The pg patch is special-cased: `var { Client } = pkg;` immediately
  // follows the patched import at module load, so the catch block must
  // initialize pkg to {} (not leave it undefined) to keep the
  // destructure non-throwing. This pattern is documented in
  // server/patches/README.md §"Known reconciliation hazards".
  if (!existsSync(MEM0_INDEX)) return;
  const src = readFileSync(MEM0_INDEX, 'utf-8');
  assert.match(
    src,
    /let pkg = \{\}; try \{ pkg = \(await import\("pg"\)\)/,
    'pg patch must initialize `let pkg = {}` so the `var { Client } = pkg;` destructure that follows is non-throwing on absent pg',
  );
});
