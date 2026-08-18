// server/test/lint/no-nested-provider-sdk.test.mjs — #231 overrides dedupe
// invariant (spec §1.2).
//
// mem0ai@3.1.6 declares stale optional-peer ranges for @anthropic-ai/sdk
// (^0.40.1) and @google/genai (^1.40.0). package.json `overrides` force both
// to our top-level majors. npm's silent fallback for an unsatisfied (or
// un-overridden) peer is to NEST a second copy under
// node_modules/mem0ai/node_modules — mem0's lazy `import()` would then load
// the nested copy while UM's provider registry loads the top-level one:
// invisible version skew that no other gate observes (deps-guard runs
// `npm ci` + this suite; nothing else inspects the tree shape). Measured in
// the #231 recon probe: without overrides npm ERESOLVEs outright; a future
// lockfile regen or grouped dependabot PR could reintroduce nesting without
// any install error.
//
// @qdrant/js-client-rest rides along: mem0 peers ^1.18.0 and ours satisfies
// it today, so nesting is impossible NOW — but a future pin drift would nest
// a second qdrant client that mem0's vector store actually USES at runtime
// (worse than the SDK case). Same detector, near-zero cost.
//
// better-sqlite3 added in #255: mem0 peers ^12.6.2 (NON-optional) and our
// direct ^12.9.0 satisfies it — no override exists or is needed today. But a
// future major divergence (the gated 13.x arc) would nest a second NATIVE
// addon, and mem0's SQLiteManager would then open the history db through a
// different binding than UM's counters db uses — strictly worse than the SDK
// skew case. Dedup here rests on direct-dep satisfaction, not an override.
//
// Runs in the same suite the deps-guard CI job executes → standing gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = resolve(dirname(__filename), '..', '..');
const MEM0_DIR = join(SERVER_ROOT, 'node_modules', 'mem0ai');

const FORBIDDEN_NESTED = [
  '@anthropic-ai/sdk',
  '@google/genai',
  '@qdrant/js-client-rest',
  'better-sqlite3',
];

test('no provider SDK is nested under node_modules/mem0ai (overrides dedupe holds)', () => {
  // Guard against a vacuous pass: if mem0ai itself is absent the nested
  // checks would trivially succeed while certifying nothing.
  assert.ok(
    existsSync(join(MEM0_DIR, 'package.json')),
    `mem0ai not installed at ${MEM0_DIR} — run npm ci first`,
  );
  const nested = FORBIDDEN_NESTED.filter((pkg) =>
    existsSync(join(MEM0_DIR, 'node_modules', pkg)),
  );
  assert.deepEqual(
    nested, [],
    `package(s) nested under node_modules/mem0ai/node_modules: ${nested.join(', ')} — ` +
    `dedupe is broken (package.json overrides for the SDKs, direct-dep peer ` +
    `satisfaction for better-sqlite3); mem0 would run a different copy than ` +
    `UM loads at top level (for better-sqlite3: a second native binding on ` +
    `the same history db). ` +
    `See docs/plans/2026-08-18-mem0ai-3x-spec.md §1.2 and #255.`,
  );
});
