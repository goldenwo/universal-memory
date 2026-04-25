// server/lib/bridge-contract.mjs
// Shared §4.3.0 bridge primitives used by all bridge implementations (D.2–D.10).
//
// Exports:
//   readCursor(path)               — read JSON cursor file; returns default shape on ENOENT
//   writeCursor(path, cursor)      — atomic write-rename so readers never see partial files
//   wrapExternal(source, body)     — wrap bridge content in fenced marker with source discriminator
//   twoPhaseWrite(path, content, reindexFn) — write markdown then reindex; reindex failure
//                                    propagates without advancing the caller's cursor (idempotent retry)
//   withBridgeLock(vaultDir, bridgeName, fn) — coordinate concurrent bridge runs via lockdir

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireLockdir, releaseLockdir } from './lockdir.mjs';

export async function readCursor(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return { schema: 1, last_ingested_id: null, last_ingested_at: null };
    throw e;
  }
}

export async function writeCursor(path, cursor) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(cursor, null, 2));
  await rename(tmp, path);
}

export function wrapExternal(source, body) {
  // Security: body may be attacker-controlled (e.g., malicious summary in claude-mem
  // SQLite). HTML-entity escape is INEFFECTIVE against LLM downstream consumers —
  // the summarizer readily decodes `&lt;/external-summary&gt;` back to raw close
  // tags during reasoning, letting attacker forge native provenance (round-2
  // adversarial catch). We reject outright instead:
  //   - any occurrence of `</external-summary` (case-insensitive, any whitespace)
  //   - any occurrence of `<external-summary` in body (no nesting allowed)
  //   - null bytes
  // Entity-encoded variants (`&lt;external-summary`) are not caught here — they
  // cannot break the outer XML at parser level and represent a weaker, accepted
  // residual risk for v0.6.
  // Legitimate claude-mem summaries will not contain these literal marker strings;
  // the 1-in-a-million false positive is skipped with a logged warning and the
  // bridge advances the cursor past the row (so we don't stall forever). See D.6
  // for the skip-with-log path.
  if (body.includes('\u0000')) throw Object.assign(new Error('null byte in external body'), { code: 'INPUT_INVALID' });
  if (/<\/?external-summary/i.test(body)) {
    throw Object.assign(new Error('body contains literal <external-summary> marker — refusing to wrap to prevent marker-break-out injection'), { code: 'INPUT_INVALID' });
  }
  // Truncate at the first character outside [a-z0-9-] so injected quotes/spaces
  // don't smuggle extra tokens into the attribute value after stripping.
  const safeSource = String(source).replace(/[^a-z0-9-].*/, '');
  if (!safeSource) throw Object.assign(new Error('empty source discriminator'), { code: 'INPUT_INVALID' });
  return `<external-summary source="${safeSource}">\n${body}\n</external-summary>`;
}

// twoPhaseWrite: write markdown to disk, then call reindexFn.
// If reindexFn throws, the markdown file remains on disk but the error propagates
// to the caller — the caller's cursor MUST NOT be advanced on rejection (do not
// catch-and-advance on reindex failure; the next bridge run is an idempotent retry).
export async function twoPhaseWrite(vaultPath, content, reindexFn) {
  await mkdir(dirname(vaultPath), { recursive: true });
  await writeFile(vaultPath, content);
  // Phase 2: reindex — propagates on failure so caller cursor stays unchanged
  await reindexFn(vaultPath);
}

export async function withBridgeLock(vaultDir, bridgeName, fn) {
  const lock = join(vaultDir, '.local', 'locks', `bridge-${bridgeName}.lockdir`);
  await mkdir(dirname(lock), { recursive: true });
  const ok = await acquireLockdir(lock, { timeoutMs: 1000 });
  if (!ok) throw Object.assign(new Error('bridge lock contention'), { code: 'STATE_LOCK_CONTENTION' });
  try { return await fn(); } finally { await releaseLockdir(lock); }
}
