// server/test/lint/no-direct-pino-import.test.mjs
// C.1 / spec §4.2 round-9 abstraction invariant:
// `lib/logger.mjs` must remain the SOLE source of pino imports across the
// codebase. v0.7 OpenTelemetry integration will swap pino for a
// tracing-aware emitter without touching every call site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk from the server root regardless of cwd (npm test runs from server/,
// but a developer invoking node --test from elsewhere should still get
// correct results).
const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = resolve(dirname(__filename), '..', '..');

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory() && !e.startsWith('.') && e !== 'node_modules') yield* walk(p);
    else if (p.endsWith('.mjs')) yield p;
  }
}

test('no file outside lib/logger.mjs imports pino directly (round-9 abstraction invariant)', () => {
  const offenders = [];
  for (const f of walk(SERVER_ROOT)) {
    const norm = f.replace(/\\/g, '/');
    if (norm.endsWith('/lib/logger.mjs') || norm.endsWith('/test/lint/no-direct-pino-import.test.mjs')) continue;
    const src = readFileSync(f, 'utf8');
    if (/from\s+['"]pino['"]/.test(src) || /require\(['"]pino['"]\)/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `direct pino imports detected in: ${offenders.join(', ')}`);
});
