/**
 * server/test/patch-contract.test.mjs — locks the mem0ai@3.1.6 patch
 * contract (#231 reconciliation): the pg import hunk + the legacy-qdrant
 * 400-tolerance hunk, at the 3.1.6 canonical counts.
 *
 * Distinct from `provider-matrix.test.mjs` (which exercises the provider
 * registry's clean-error path BEFORE mem0 is touched, so it doesn't verify
 * the patch fired). This file inspects and imports mem0 directly so a patch
 * regression — silent no-op apply, hunk-shape mismatch, future mem0 bump
 * that adds an unpatched static import — fails loud at unit-test time
 * instead of at boot in production.
 *
 * Cite: docs/plans/2026-08-18-mem0ai-3x-spec.md §1.4 (canonical counts),
 * §1.8 (allowlist + red-control mutation), §1.3 (preserved invariant);
 * server/patches/README.md §Reconciliation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEM0_INDEX = resolve(__dirname, '..', 'node_modules', 'mem0ai', 'dist', 'oss', 'index.mjs');

// Canonical counts for mem0ai@3.1.6 (spec §1.4; mirrored in server/Dockerfile
// and server/patches/README.md): upstream ships 6 lazy `await import(` sites;
// the pg hunk adds the 7th. Exactly ONE `[mem0-patch]` warn line (pg) — the
// other 13 W6.2 hunks are retired (upstream moved those providers to optional
// peers and/or lazy loading).
const EXPECTED_AWAIT_IMPORTS = 7;
const EXPECTED_MEMPATCH_LOGS = 1;

// §1.8 pinned ALLOWLIST: the only bare package specifiers permitted as
// top-level STATIC imports in the patched bundle. Node builtins are always
// allowed. `openai`/`axios`/`uuid`/`zod` are mem0ai@3.1.6 regular deps
// (nested under mem0ai, always installed); `better-sqlite3` ships in the
// image (mem0 history default + UM's own counters DB) so its two eager
// imports are legitimately static. ANY other bare static import — e.g. a
// future mem0 bump re-adding an eager provider import — fails this test and
// routes to server/patches/README.md §Reconciliation. This preserves the
// test's original purpose (catch unpatched static imports) as an allowlist
// rather than a denylist that rots as upstream's provider set churns.
const ALLOWED_STATIC_PACKAGES = new Set([
  'openai', 'axios', 'uuid', 'zod', 'better-sqlite3',
  // Self-references: the fail-closed scanner also picks up `from "mem0ai/oss"`
  // inside the bundle's own usage-hint STRINGS. The self-package is
  // definitionally resolvable, so allowlisting it costs nothing.
  'mem0ai',
]);

// The legacy-qdrant guard's two contract regexes. Shared by the positive
// asserts AND the red-control mutation below so they cannot drift apart.
// Spec §1.3 preserved invariant: the guard must keep BOTH conjuncts — the
// 400-status check AND the "already exists" body match. A bare
// `status === 400` guard is out of bounds no matter what error shape a
// future qdrant client emits.
const QDRANT_GUARD_RE = /const legacyQdrantAlreadyExists = error\?\.status === 400 &&[^\n]*already exists/;
const QDRANT_ORED_RE = /=== 403 \|\| legacyQdrantAlreadyExists\)/;

function readSource() {
  if (!existsSync(MEM0_INDEX)) {
    assert.fail(`mem0ai not installed at ${MEM0_INDEX} — run npm ci first`);
  }
  return readFileSync(MEM0_INDEX, 'utf-8');
}

/** Package root of a bare specifier: '@scope/pkg/sub' → '@scope/pkg', 'pkg/sub' → 'pkg'. */
function packageRoot(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

test('patch applied at mem0ai@3.1.6 canonical counts (7 await-imports / 1 mem0-patch warn)', () => {
  const src = readSource();
  const awaitImports = (src.match(/await import\(/g) || []).length;
  const memPatchLogs = (src.match(/\[mem0-patch\]/g) || []).length;
  assert.equal(
    awaitImports, EXPECTED_AWAIT_IMPORTS,
    `expected ${EXPECTED_AWAIT_IMPORTS} \`await import(\` in patched mem0ai (got ${awaitImports}); ` +
    `6 = bare upstream 3.1.6 (patch not applied — run \`cd server && npx patch-package\`); ` +
    `other values = drift, see server/patches/README.md §Reconciliation`,
  );
  assert.equal(
    memPatchLogs, EXPECTED_MEMPATCH_LOGS,
    `expected ${EXPECTED_MEMPATCH_LOGS} [mem0-patch] string in patched mem0ai (got ${memPatchLogs}); ` +
    `0 = patch not applied; if drifted, see server/patches/README.md §Reconciliation`,
  );
});

/**
 * Every module specifier referenced by STATIC import/export syntax.
 * FAIL-CLOSED scanner (round-1 code-review fold): rather than parsing whole
 * statements (which failed open on `export … from`, semicolon-less
 * statements, and multi-statement lines), collect every `from "<spec>"`
 * clause — in JS that clause exists ONLY on static import/export-from
 * syntax (dynamic `import("x")` has no `from`) — plus bare side-effect
 * `import "<spec>"`. A string literal that happens to contain `from "pkg"`
 * would be flagged for a human look, which is the correct failure
 * direction for a gate.
 */
function collectStaticSpecifiers(src) {
  const specs = [];
  // `from` clause: tolerate an interposed block comment (`from/*c*/"x"`).
  for (const m of src.matchAll(/\bfrom\s*(?:\/\*[^]*?\*\/\s*)?["']([^'"\n]+)["']/g)) specs.push(m[1]);
  // Side-effect import: `[;\s})]` covers statement, brace-adjacent
  // (`function f(){}import"x"` — valid ESM the round-2 review proved the
  // old class missed), and paren-adjacent predecessors; `m` flag anchors
  // line starts.
  for (const m of src.matchAll(/(?:^|[;\s})])import\s*(?:\/\*[^]*?\*\/\s*)?["']([^'"\n]+)["']/gm)) specs.push(m[1]);
  return specs;
}

/** Offending (non-allowlisted, non-builtin, non-relative) bare specifiers. */
function allowlistOffenders(src) {
  const offenders = [];
  for (const spec of collectStaticSpecifiers(src)) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue; // relative
    const root = packageRoot(spec.replace(/^node:/, ''));
    if (builtinModules.includes(root)) continue;
    if (!ALLOWED_STATIC_PACKAGES.has(packageRoot(spec))) offenders.push(spec);
  }
  return offenders;
}

test('allowlist: no static import/export-from of any non-allowlisted bare package', () => {
  const offenders = allowlistOffenders(readSource());
  assert.deepEqual(
    offenders, [],
    `non-allowlisted static module reference(s) in mem0ai bundle — a mem0 bump ` +
    `re-added an eager import the image cannot satisfy. Re-derive the patch per ` +
    `server/patches/README.md §Reconciliation: ${offenders.join(', ')}`,
  );
});

test('red control: the allowlist scanner catches smuggled static imports in every syntax shape', () => {
  // Mutation copies (string-level, no file writes): each shape the OLD
  // statement-parsing scanner failed OPEN on must now be flagged.
  const src = readSource();
  const shapes = [
    ['plain import', src + '\nimport { X } from "smuggled-provider";'],
    ['export-from', src + '\nexport { Y } from "smuggled-provider";'],
    ['semicolon-less', src + '\nimport Z from "smuggled-provider"\n'],
    ['side-effect', src + '\nimport "smuggled-provider";'],
    // Round-2 catch: valid ESM the newline-prefixed shapes above cannot see.
    ['brace-adjacent side-effect', src + '\nfunction __rc(){}import"smuggled-provider";'],
    ['comment-interposed from', src + '\nimport { W } from/*c*/"smuggled-provider";'],
  ];
  for (const [label, mutated] of shapes) {
    assert.ok(
      allowlistOffenders(mutated).includes('smuggled-provider'),
      `allowlist scanner FAILED to flag a ${label} of a non-allowlisted package — the gate fails open`,
    );
  }
  // And the unmutated source stays clean (the control controls itself).
  assert.deepEqual(allowlistOffenders(src), []);
});

test('pg hunk: fail-soft dynamic import with `let pkg = {}` init for the two-name destructure', () => {
  const src = readSource();
  // 3.1.6's module-init destructure pulls TWO names — `var { Client,
  // escapeIdentifier } = pkg;` — so the catch default `let pkg = {}` is what
  // keeps module load non-throwing when pg is rm'd from the image (spec §1.3;
  // README §"Known reconciliation hazards").
  assert.match(
    src,
    /let pkg = \{\}; try \{ pkg = \(await import\("pg"\)\)/,
    'pg hunk must initialize `let pkg = {}` so the module-init destructure is non-throwing on absent pg',
  );
  assert.match(
    src,
    /var \{ Client, escapeIdentifier \} = pkg;/,
    'expected 3.1.6\'s two-name pg destructure (`Client, escapeIdentifier`) after the patched import',
  );
});

test('legacy-qdrant hunk: ensureCollection tolerates a 400 "already exists"', () => {
  // qdrant ≤1.7 (the Pi's y0mg v1.7.3) returns HTTP 400 — not 409 — for a
  // duplicate createCollection. mem0ai's ensureCollection catches only
  // 409/401/403, so against a legacy server with an existing collection init
  // throws and the HTTP server never binds (the #157 failure). The hunk adds
  // a guarded 400 case matching the body ("already exists"); genuine 400s
  // still throw.
  const src = readSource();
  assert.match(
    src, QDRANT_GUARD_RE,
    'ensureCollection must treat a 400 whose body says "already exists" like a 409 (legacy qdrant ≤1.7); see server/patches/README.md',
  );
  assert.match(
    src, QDRANT_ORED_RE,
    'the legacy-400 guard must be OR-ed into the existing 409/401/403 exists-branch, not replace it',
  );
});

test('red control: the qdrant contract regexes REJECT a body-match-stripped guard', () => {
  // Mutation control (spec §1.8, red-controls precedent): prove the contract
  // has teeth against exactly the erosion §1.3 forbids — weakening the guard
  // to a bare `status === 400`. String-level mutation copy; no file writes.
  const src = readSource();
  // Anchor must match the real patched source first — a drifted anchor means
  // this control silently stopped controlling (fail LOUD instead).
  const anchorRe = /const legacyQdrantAlreadyExists = error\?\.status === 400 &&[^\n]*\n/;
  assert.match(src, anchorRe, 'mutation anchor drifted — the guard line is not in the patched source');
  const mutated = src.replace(
    anchorRe,
    'const legacyQdrantAlreadyExists = error?.status === 400;\n',
  );
  assert.notEqual(mutated, src, 'mutation was a no-op — the control proved nothing');
  assert.doesNotMatch(
    mutated, QDRANT_GUARD_RE,
    'contract regex FAILED to reject the weakened bare-400 guard — the §1.3 invariant has no teeth',
  );
  // The OR-wiring regex must still pass on the mutated copy — the mutation
  // targets ONLY the body-match conjunct, proving the two regexes carry
  // independent load (one pins the predicate, one pins the wiring).
  assert.match(mutated, QDRANT_ORED_RE);
});

test('mem0ai/oss imports cleanly (module load succeeds)', async () => {
  // The point of the pg hunk: with pg absent from the image, module load must
  // not throw. Locally pg is typically installed (required peer) so the
  // dynamic import succeeds silently — the assertion here is "import resolves
  // + minimum exports". The CI smoke job exercises the absent-pg path via the
  // prod Docker image where the rm step fires.
  const mod = await import('mem0ai/oss');
  assert.equal(typeof mod.Memory, 'function', 'mem0ai/oss must export Memory class');
  assert.equal(typeof mod.LLMFactory, 'function', 'mem0ai/oss must export LLMFactory');
  assert.equal(typeof mod.EmbedderFactory, 'function', 'mem0ai/oss must export EmbedderFactory');
});
