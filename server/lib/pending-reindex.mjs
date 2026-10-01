// server/lib/pending-reindex.mjs — #314 D7: the write-ahead reindex repair record.
//
// One small file per session summary whose reindex is not yet confirmed:
// `state/<project>/pending-reindex/<summaryId>.json`, holding `{ summary_path, since }`.
// The chunk transaction creates it after the summary's durable rename and before its
// cursor advance, and deletes it once its own step 7 reindex succeeds; doCheckpoint
// repairs a layer's older entries under the same checkpoint lock. layers.mjs reads the
// entries for the repair arm of `stale` (`repair_since`). Nothing outside a checkpoint
// deletes an entry.

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export const PENDING_REINDEX_DIRNAME = 'pending-reindex';

// `<summaryId>.json` only — a tmp file mid-rename (`<summaryId>.json.tmp`) never matches.
const ENTRY_FILE_RE = /^(.+)\.json$/;

// Refuse to follow a symlink at the open() syscall (a no-op on Windows; the lstat guards
// below still apply there) — the same guard advanceCursor's inline write uses.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** The layer's entry directory. */
export function pendingReindexDir(vaultDir, project) {
  return path.join(vaultDir, 'state', project, PENDING_REINDEX_DIRNAME);
}

function entryPath(vaultDir, project, summaryId) {
  return path.join(pendingReindexDir(vaultDir, project), `${summaryId}.json`);
}

/**
 * Write (or overwrite: a retried chunk reuses its summary id) the entry for one summary —
 * `.tmp` write + atomic rename, mirroring advanceCursor, refusing a planted symlink at either
 * path. Throws on any failure; the chunk transaction maps that to `pending_write`.
 */
export async function writePendingReindex({ vaultDir, project, summaryId, summaryPath, since }) {
  const finalPath = entryPath(vaultDir, project, summaryId);
  const tmpPath = `${finalPath}.tmp`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  for (const p of [tmpPath, finalPath]) {
    const st = await fs.lstat(p).catch(() => null);
    if (st && st.isSymbolicLink()) {
      throw Object.assign(new Error('pending-reindex: target is a symlink; refusing to write'), { code: 'SYMLINK_REFUSED' });
    }
  }
  const fh = await fs.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
  try {
    await fh.writeFile(JSON.stringify({ summary_path: summaryPath, since }), 'utf8');
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, finalPath);
}

/** Delete one entry by id; an entry already gone is fine. Throws on any other error. */
export async function deletePendingReindex({ vaultDir, project, id }) {
  await fs.rm(entryPath(vaultDir, project, id), { force: true });
}

/**
 * The layer's entries, oldest `since` first; an entry whose `since` is missing or
 * unparseable sorts first (the alerting direction), ties by id. An entry that cannot be
 * read or parsed is still listed, with `summary_path` and `since` null; one deleted
 * between the readdir and its read is skipped. A missing directory means no entries;
 * any other readdir error throws.
 *
 * @returns {Promise<Array<{ id: string, summary_path: string|null, since: string|null, sinceMs: number }>>}
 */
export async function listPendingReindex({ vaultDir, project }) {
  const dir = pendingReindexDir(vaultDir, project);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const name of names) {
    const m = ENTRY_FILE_RE.exec(name);
    if (!m) continue;
    let summaryPath = null;
    let since = null;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed.summary_path === 'string') summaryPath = parsed.summary_path;
        if (typeof parsed.since === 'string') since = parsed.since;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue;
    }
    entries.push({ id: m[1], summary_path: summaryPath, since, sinceMs: since === null ? NaN : Date.parse(since) });
  }
  const sortKey = (e) => (Number.isNaN(e.sinceMs) ? -Infinity : e.sinceMs);
  entries.sort((a, b) => (sortKey(a) - sortKey(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}
