// server/lib/checkpoint-cursor.mjs — durable per-project digest cursor
// (spec §4.1-4.3, docs/plans/2026-08-15-checkpoint-chunked-summarization-
// spec.md; interface decisions from .superpowers/sdd/2026-08-15-checkpoint-
// chunked-summarization-plan/task-2-brief.md).
//
// THIS IS THE ARC'S CATASTROPHIC-CLASS SURFACE: a cursor bug means silent,
// permanent loss of turns (I1 — no loss, at-least-once by construction).
// Every ambiguous case in this file is resolved toward RE-READING
// (duplication), never toward skipping. Concretely:
//   - An invalid/corrupt cursor never "guesses" an offset — it always
//     recovery-reinits from the covers_until watermark (§4.2), which is
//     provably conservative (48h slack) rather than trusting stale state.
//   - A cursor whose `file` no longer exists is NOT invalid (files may be
//     legally deleted in future); we resume at the next newer file, offset
//     0 — never skip past unread bytes.
//   - Forged/quoted turn headers inside content can only pull a recovery
//     cursor EARLIER (first-match-wins scan), never later than real
//     undigested content.
//
// Cursor semantics (positional, authoritative — §4.1): every raw file
// lexicographically < `file` is fully digested; `file` is digested through
// byte `offset`. Raw filenames are `YYYY-MM-DD.md`, so lexical order ==
// chronological order.
//
// This module does NO locking (the caller holds the state lockdir for the
// whole checkpoint run — §4.1) and NEVER deletes anything.
//
// Exports: loadCursor, bootstrapInit, recoveryReinit, advanceCursor.

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';
import { RECOVERY_SLACK_MS, makeTurnHeaderRe } from './checkpoint-config.mjs';

// B.12-style hardening (checkpoint.mjs, append-turn.mjs): refuse to follow
// symlinks at the open() syscall level. undefined on Windows (NTFS has a
// different threat model) → coerced to a no-op via `?? 0` so vault writes
// still succeed there; the lstat-based guard below still applies cross-platform.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// §4.2 check 0: `file` must match this BEFORE it is ever joined into a path
// anywhere in this module — the sole path-traversal gate (e.g. rejects
// `../../evil.md`, `2026-8-1.md` — not zero-padded).
const CURSOR_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

// Turn-header matching uses the shared `makeTurnHeaderRe()` factory
// (checkpoint-config.mjs) — never a locally-built pattern. A quoted header
// pasted at column 0 inside content also matches — acceptable (and
// load-bearing safe) per the recovery-scan doc comment above.

// Small trailing window read at a cursor's `offset` — large enough for the
// longest possible header prefix (`## ` + ISO-with-millis + ` ` + role),
// never the whole (potentially huge) day file.
const HEADER_WINDOW_BYTES = 128;

// Small leading window read from a session summary file to extract
// `covers_until:` — frontmatter always lives in the first few hundred
// bytes; reading the whole (potentially large) summary body would be
// wasteful for a recovery scan that may touch many files.
const HEAD_READ_BYTES = 4096;

/**
 * Build a fresh, valid cursor object. Always constructs a brand-new
 * RegExp/Date — never shares mutable module-level state across calls.
 */
function makeCursor({ file, offset = 0, boundary = 'turn', lastTurnIso = null, lastSummaryId = null }) {
  return {
    schema_version: 1,
    file,
    offset,
    boundary,
    last_turn_iso: lastTurnIso,
    last_summary_id: lastSummaryId,
    updated_at: new Date().toISOString(),
  };
}

/**
 * §4.2 check 0 (type/shape guard, first and strict). Returns null when
 * `cursor` is well-formed, else a short machine-readable detail string
 * naming the first field that failed — checked in the order the spec lists
 * them so the NaN-offset case (which defeats naive `>` comparisons by
 * construction) is always caught before any positional check runs.
 *
 * @param {unknown} cursor - parsed JSON value (may be anything).
 * @returns {string|null}
 */
function shapeInvalidDetail(cursor) {
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return 'not_an_object';
  if (cursor.schema_version !== 1) return 'schema_version';
  if (typeof cursor.file !== 'string' || !CURSOR_FILE_RE.test(cursor.file)) return 'file';
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return 'offset';
  if (cursor.boundary !== 'turn' && cursor.boundary !== 'split') return 'boundary';
  return null;
}

/** List raw day-files (`YYYY-MM-DD.md`) in a project's raw dir, sorted ascending (== chronological). */
async function listRawFiles(rawDir) {
  const entries = await fs.readdir(rawDir).catch(() => []);
  return entries.filter((n) => CURSOR_FILE_RE.test(n)).sort();
}

/** Read up to `length` bytes at `position` from a file. Never reads the whole file. */
async function readWindow(filePath, position, length) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * §4.2 check 2: is the byte at `offset` the start of a turn header? Uses a
 * fresh RegExp instance every call (`makeTurnHeaderRe()`, non-global) — never
 * a shared module-level pattern a scan loop might reuse, whose `lastIndex`
 * would otherwise mutate across calls and silently shift boundaries.
 */
async function isTurnHeaderAt(filePath, offset) {
  const window = await readWindow(filePath, offset, HEADER_WINDOW_BYTES);
  return makeTurnHeaderRe().test(window);
}

/**
 * §4.2 check 4: any raw file lexically < `cursor.file` whose mtime is at or
 * newer than `cursor.updated_at` means content appeared below the cursor
 * after (or in the same instant as) it was last written — the §4.3b
 * write-ordering invariant was violated.
 *
 * Direction matters here: firing this tripwire means "recovery re-init",
 * which is the SAFE (re-read/duplicate) outcome; not firing means "trust
 * this cursor", which is the UNSAFE (possible-skip) outcome. So every
 * precision ambiguity must be resolved toward firing, never away from it.
 * Concretely: `updated_at` is an ISO string (millisecond precision only),
 * while filesystem mtimes (`stat.mtimeMs`) carry sub-millisecond precision
 * on NTFS/most Linux filesystems. Comparing with strict `>` after flooring
 * the mtime down to match the ISO string's precision would make a
 * same-millisecond write LESS likely to be flagged as growth — exactly the
 * unsafe direction. Using the raw (unfloored) mtime with `>=` instead means
 * a below-cursor file touched in the cursor's own millisecond (or any
 * later one) is always caught.
 *
 * `cursor.updated_at` is always written by advanceCursor in normal
 * operation; if it is ever missing/unparseable on a hand-edited or legacy
 * file, we treat the threshold as "everything is newer" (duplication-safe
 * direction — never silently accept a cursor we cannot actually vouch for).
 */
async function belowCursorGrowthDetected(rawDir, cursor) {
  const updatedAtMs = Date.parse(cursor.updated_at);
  const threshold = Number.isNaN(updatedAtMs) ? -Infinity : updatedAtMs;
  const entries = await fs.readdir(rawDir).catch(() => []);
  for (const name of entries) {
    if (!CURSOR_FILE_RE.test(name)) continue;
    if (name >= cursor.file) continue; // only files lexically < cursor.file
    const st = await fs.stat(path.join(rawDir, name)).catch(() => null);
    if (!st) continue;
    if (st.mtimeMs >= threshold) return true;
  }
  return false;
}

/**
 * §4.2 checks 1/2/3/4, run in spec order against an already shape-valid
 * cursor. Returns either `{ invalid: true, reason }` (caller must recovery
 * re-init) or `{ invalid: false, cursor: <possibly-adjusted cursor> }`.
 */
async function validateAndAdjust({ vaultDir, project, cursor }) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  const filePath = path.join(rawDir, cursor.file); // safe: cursor.file already passed CURSOR_FILE_RE

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Check 3: `file` doesn't exist → NOT invalid. Still run check 4 (it is
    // independent of whether `file` itself exists) before finalizing —
    // biasing toward catching a real hazard over skipping a check.
    if (await belowCursorGrowthDetected(rawDir, cursor)) {
      return { invalid: true, reason: 'below_cursor_growth' };
    }
    const candidates = await listRawFiles(rawDir);
    const next = candidates.find((n) => n > cursor.file);
    if (next === undefined) {
      // No newer file exists. If `cursor.file` is dated in the future
      // relative to today, this can never self-correct: raw files are
      // never created ahead of their write date, so "adjust and resume at
      // the same name" would return this exact answer on every future
      // load forever. Worse, the cursor's positional semantics ("every
      // file lexically < `file` is digested") would then treat ALL real
      // content written from now on — every date up to the poisoned
      // future one — as already-digested, silently skipping it. That is
      // the unsafe/skip direction, so this is NOT the check-3 "legally
      // deleted file" case — it is corruption, and gets recovery re-init.
      const todayFile = `${new Date().toISOString().slice(0, 10)}.md`;
      if (cursor.file > todayFile) {
        return { invalid: true, reason: 'future_dated_file' };
      }
    }
    return {
      invalid: false,
      cursor: {
        ...cursor,
        // No newer file exists yet: keep pointing at the same (currently
        // absent) name at offset 0 rather than guessing — self-corrects on
        // a future load once content lands there or later. Never rewritten
        // to disk here (brief: "do not rewrite the file here").
        file: next ?? cursor.file,
        offset: 0,
        boundary: 'turn',
      },
      missingFileAdjustment: true,
    };
  }

  // Check 1.
  if (cursor.offset > stat.size) {
    return { invalid: true, reason: 'offset_exceeds_size' };
  }

  // Check 2 — only when boundary === 'turn', and only when not already at EOF.
  if (cursor.boundary === 'turn' && cursor.offset !== stat.size) {
    const atHeader = await isTurnHeaderAt(filePath, cursor.offset);
    if (!atHeader) {
      return { invalid: true, reason: 'boundary_misaligned' };
    }
  }

  // Check 4.
  if (await belowCursorGrowthDetected(rawDir, cursor)) {
    return { invalid: true, reason: 'below_cursor_growth' };
  }

  return { invalid: false, cursor };
}

/**
 * §4.3 bootstrap init — used only when no cursor file has ever existed, and
 * as recoveryReinit's fallback when no session summary carries covers_until.
 *
 * @param {object} args
 * @param {string} args.vaultDir
 * @param {string} args.project
 * @returns {Promise<object>} a complete, valid cursor object (not persisted).
 */
export async function bootstrapInit({ vaultDir, project }) {
  const sessionsDir = path.join(vaultDir, 'sessions', project);
  const sessionFiles = await fs.readdir(sessionsDir).catch(() => []);
  // Anchored to `.md$` (matches recoveryReinit's sessionMdRe) — WITHOUT this,
  // an orphan `session-2026-08-14-....md.tmp` (phase-2 failures leave these
  // behind forever; nothing reaps them) or a stray `session-2026-08-14-
  // notes.txt` would set the bootstrap boundary too high, silently skipping
  // the entire backlog below it.
  const sessionDateRe = /^session-(\d{4}-\d{2}-\d{2})-.*\.md$/;
  let newestDate = null;
  for (const name of sessionFiles) {
    const m = sessionDateRe.exec(name);
    if (!m) continue;
    if (newestDate === null || m[1] > newestDate) newestDate = m[1];
  }
  if (newestDate !== null) {
    // The named file need not exist — cursor semantics are purely
    // positional; chunk assembly simply starts at the first existing file
    // >= this name.
    return makeCursor({ file: `${newestDate}.md` });
  }

  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  const rawFiles = await listRawFiles(rawDir);
  if (rawFiles.length > 0) {
    return makeCursor({ file: rawFiles[0] }); // oldest raw file — digest full history
  }

  // No session summaries and no raw captures at all: sentinel that sorts
  // before every legal date, so "everything is newer than it" holds.
  return makeCursor({ file: '0000-00-00.md' });
}

// Matches a leading YAML frontmatter block (mirrors frontmatter.mjs's
// FM_REGEX, applied to a bounded head window instead of the whole file):
// captures only the text BETWEEN the opening and closing `---` fences.
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;

/**
 * Read `covers_until:` from a summary file's LEADING FRONTMATTER BLOCK
 * only, without reading the full body.
 *
 * Extraction is strictly bounded to the text between the opening and
 * closing `---` fences — never the body. A body line that happens to read
 * "covers_until: <date>" (LLM-generated summary content can echo field
 * names verbatim, and this repo's own captures literally discuss this
 * field) must never be mistaken for real frontmatter: doing so would
 * fabricate the recovery watermark W and could push a recovery scan PAST
 * genuinely undigested content — the skip/loss direction. If the head
 * window doesn't start with a `---` fence, or the closing fence isn't
 * found within HEAD_READ_BYTES, we bail (return null) rather than widen
 * the search into the body.
 */
async function readCoversUntilHead(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_READ_BYTES, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    const fmMatch = FRONTMATTER_BLOCK_RE.exec(head);
    if (!fmMatch) return null; // no frontmatter block in the head window — never scan the body
    const frontmatterBlock = fmMatch[1];
    const m = /^covers_until:\s*(.+)$/m.exec(frontmatterBlock);
    if (!m) return null;
    return m[1].trim().replace(/^['"]|['"]$/g, '');
  } finally {
    await fh.close();
  }
}

/** Convert a JS string char-index into its UTF-8 byte offset (cursor positions are byte-exact). */
function charIndexToByteOffset(content, charIndex) {
  return Buffer.byteLength(content.slice(0, charIndex), 'utf8');
}

/**
 * §4.2 recovery re-init — NOT the §4.3 bootstrap heuristic. Computes
 * W = max(covers_until) over all session summary frontmatter, then scans
 * raw files oldest-first for the FIRST turn header whose ISO > W - 48h
 * slack. Falls back to bootstrapInit when no summary carries covers_until
 * (pure legacy corpus).
 *
 * @param {object} args
 * @param {string} args.vaultDir
 * @param {string} args.project
 * @returns {Promise<object>} a complete, valid cursor object (not persisted).
 */
export async function recoveryReinit({ vaultDir, project }) {
  const sessionsDir = path.join(vaultDir, 'sessions', project);
  const sessionFiles = await fs.readdir(sessionsDir).catch(() => []);
  const sessionMdRe = /^session-.*\.md$/;

  let maxCoversUntilMs = -Infinity;
  for (const name of sessionFiles) {
    if (!sessionMdRe.test(name)) continue;
    const coversUntil = await readCoversUntilHead(path.join(sessionsDir, name));
    if (coversUntil == null) continue;
    const ms = Date.parse(coversUntil);
    if (Number.isNaN(ms)) continue;
    if (ms > maxCoversUntilMs) maxCoversUntilMs = ms;
  }

  if (maxCoversUntilMs === -Infinity) {
    // No summary anywhere carries covers_until (pure legacy corpus) — in
    // that world summaries still mean "coverage through run date".
    return bootstrapInit({ vaultDir, project });
  }

  const threshold = maxCoversUntilMs - RECOVERY_SLACK_MS;
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  const rawFiles = await listRawFiles(rawDir);
  // Oldest raw file (if any) that yields ZERO header matches at all — a
  // legacy headerless blob. Distinct from "has headers, none above the
  // watermark": we cannot vouch for content we can't even parse for turn
  // boundaries, so it must never be silently folded into "all digested".
  let firstHeaderlessFile = null;

  for (const name of rawFiles) {
    const filePath = path.join(rawDir, name);
    const content = await fs.readFile(filePath, 'utf8');
    // Fresh RegExp instance per file (makeTurnHeaderRe('gm')) — never a
    // shared/module-level object whose lastIndex could carry state across
    // files. The pattern's only capture group is the role, not the ISO, so
    // the ISO is sliced out of the full match (`## <ISO> <role>`) instead.
    const headerRe = makeTurnHeaderRe('gm');
    let sawHeader = false;
    for (const m of content.matchAll(headerRe)) {
      sawHeader = true;
      const iso = m[0].slice(3, m[0].indexOf(' ', 3));
      const ms = Date.parse(iso);
      if (Number.isNaN(ms) || !(ms > threshold)) continue;
      // First match wins (file order, then in-file order) — forged/quoted
      // headers can only pull the cursor earlier than real content, never
      // later (duplication-safe, never loss).
      return makeCursor({ file: name, offset: charIndexToByteOffset(content, m.index) });
    }
    if (!sawHeader && firstHeaderlessFile === null) firstHeaderlessFile = name;
  }

  // No turn header found above the watermark in any raw file.
  if (firstHeaderlessFile !== null) {
    // At least one pending raw file has NO header matches whatsoever (a
    // legacy blob) — resolve toward re-reading it (never-skip), not EOF.
    return makeCursor({ file: firstHeaderlessFile, offset: 0 });
  }
  if (rawFiles.length === 0) {
    // Summaries exist (we have a W) but every raw file is gone — a
    // degenerate state this system should never produce on its own (raw
    // files are never deleted here). Fall back to the sentinel: duplication-
    // safe (sorts before everything) rather than fabricating a filename.
    return makeCursor({ file: '0000-00-00.md' });
  }
  const newest = rawFiles[rawFiles.length - 1];
  const newestStat = await fs.stat(path.join(rawDir, newest));
  return makeCursor({ file: newest, offset: newestStat.size });
}

/**
 * Load and validate the durable per-project cursor (§4.1/§4.2).
 *
 * @param {object} args
 * @param {string} args.vaultDir
 * @param {string} args.project
 * @returns {Promise<{cursor: object, reinitialized: boolean, reason?: string}>}
 */
export async function loadCursor({ vaultDir, project }) {
  const cursorPath = path.join(vaultDir, 'state', project, 'checkpoint-cursor.json');

  let raw;
  try {
    raw = await fs.readFile(cursorPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // No cursor file has ever existed — §4.3 bootstrap, not a recovery.
    const cursor = await bootstrapInit({ vaultDir, project });
    return { cursor, reinitialized: true, reason: 'bootstrap' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      component: 'checkpoint-cursor',
      project,
      path: cursorPath,
      reason: 'parse_error',
    }, 'checkpoint cursor: JSON parse failed — recovery re-init'), 'log:checkpoint-cursor:parse-error');
    const cursor = await recoveryReinit({ vaultDir, project });
    return { cursor, reinitialized: true, reason: 'parse_error' };
  }

  const shapeDetail = shapeInvalidDetail(parsed);
  if (shapeDetail !== null) {
    const reason = `shape_invalid:${shapeDetail}`;
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      component: 'checkpoint-cursor',
      project,
      path: cursorPath,
      reason,
    }, 'checkpoint cursor: shape invalid — recovery re-init'), 'log:checkpoint-cursor:shape-invalid');
    const cursor = await recoveryReinit({ vaultDir, project });
    return { cursor, reinitialized: true, reason };
  }

  const result = await validateAndAdjust({ vaultDir, project, cursor: parsed });
  if (result.invalid) {
    safeLog(() => getLogger().warn({
      request_id: currentRequestId(),
      component: 'checkpoint-cursor',
      project,
      path: cursorPath,
      reason: result.reason,
    }, 'checkpoint cursor: invalid — recovery re-init'), 'log:checkpoint-cursor:invalid');
    const cursor = await recoveryReinit({ vaultDir, project });
    return { cursor, reinitialized: true, reason: result.reason };
  }

  if (result.missingFileAdjustment) {
    return { cursor: result.cursor, reinitialized: false, reason: 'missing_file_adjusted' };
  }
  return { cursor: result.cursor, reinitialized: false };
}

/**
 * Persist the cursor: `.tmp` write + atomic `fs.rename` (same pattern
 * state.md already uses), performed while the caller holds the state
 * lockdir — this module does no locking of its own. `schema_version` is
 * pinned to 1; `updated_at` is always set to now.
 *
 * @param {object} args
 * @param {string} args.vaultDir
 * @param {string} args.project
 * @param {object} args.cursor - complete new cursor: file/offset/boundary/
 *   last_turn_iso/last_summary_id.
 * @returns {Promise<object>} the persisted cursor object.
 */
export async function advanceCursor({ vaultDir, project, cursor }) {
  const cursorPath = path.join(vaultDir, 'state', project, 'checkpoint-cursor.json');
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });

  const toWrite = {
    schema_version: 1,
    file: cursor.file,
    offset: cursor.offset,
    boundary: cursor.boundary,
    last_turn_iso: cursor.last_turn_iso ?? null,
    last_summary_id: cursor.last_summary_id ?? null,
    updated_at: new Date().toISOString(),
  };

  const tmpPath = cursorPath + '.tmp';

  // Symlink guards (same pattern as checkpoint.mjs's summary/state.md
  // writes): refuse to write through a planted symlink at either path.
  const tmpSymCheck = await fs.lstat(tmpPath).catch(() => null);
  if (tmpSymCheck && tmpSymCheck.isSymbolicLink()) {
    throw Object.assign(new Error('checkpoint cursor: target is a symlink; refusing to write'), { code: 'SYMLINK_REFUSED' });
  }
  const finalSymCheck = await fs.lstat(cursorPath).catch(() => null);
  if (finalSymCheck && finalSymCheck.isSymbolicLink()) {
    throw Object.assign(new Error('checkpoint cursor: target is a symlink; refusing to write'), { code: 'SYMLINK_REFUSED' });
  }

  const fh = await fs.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o644);
  try {
    await fh.writeFile(JSON.stringify(toWrite, null, 2), 'utf8');
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, cursorPath);

  return toWrite;
}
