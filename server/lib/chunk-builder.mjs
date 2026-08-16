// server/lib/chunk-builder.mjs — cursor -> bounded chunk assembly (spec
// §4.4, docs/plans/2026-08-15-checkpoint-chunked-summarization-spec.md;
// interface decisions from .superpowers/sdd/2026-08-15-checkpoint-chunked-
// summarization-plan/task-4-brief.md).
//
// THIS MODULE'S BOUNDARY MATH FEEDS THE CURSOR — the arc's catastrophic-class
// surface (checkpoint-cursor.mjs: a bug here means silent, permanent loss of
// turns, I1 — no loss, at-least-once by construction). Every byte walked is
// accounted for exactly once: no byte is ever read twice, none is ever
// skipped. The `nextCursor` this module returns must always be constructed
// from the EXACT byte position immediately following the last byte included
// in `chunk.text` — that invariant is what the byte-exact concatenation
// sweep test (server/test/chunk-builder.test.mjs) falsifies.
//
// Core model: walk raw day-files ascending from the cursor position. Each
// file's unread remainder is split into ordered "segments" — either a whole
// turn (bounded by two consecutive header matches, or a header match and
// EOF), a leading headerless continuation (content before the first header
// in the remainder — only non-empty when resuming mid-turn from a `boundary:
// "split"` cursor), or, when a file has NO header match anywhere in its
// remainder, the ENTIRE remainder as one legacy blob segment. Segments are
// accumulated into the chunk being built, in order, until the next segment
// would push the chunk over `chunkMaxBytes` — at which point assembly stops
// (chunk ends `boundary: "turn"`, positionally exact) UNLESS the chunk is
// still empty, in which case the oversized segment itself is hard-split at
// `chunkMaxBytes` (chunk ends `boundary: "split"`) — this is what guarantees
// every call makes forward progress regardless of how large a single turn or
// legacy blob is (spec §4.4 "guaranteed progress").
//
// Locking: per spec, the caller injects `acquireLock`/`releaseLock` (bound
// lockdir.mjs functions, same `<rawFilePath>.lockdir` convention as
// checkpoint.mjs:357). This module acquires a file's lock immediately before
// reading it and releases it right after (finally) — it never reads a file
// it could not lock, and never reads PAST a file whose lock it could not
// acquire (spec §4.4 "no-skip-ahead", I3).

import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTurnHeaderRe } from './checkpoint-config.mjs';

// Raw day-file naming (mirrors checkpoint-cursor.mjs's CURSOR_FILE_RE):
// `YYYY-MM-DD.md`, so lexical order == chronological order.
const RAW_DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** List raw day-files at or after `cursorFile` (lexical, == chronological), sorted ascending. */
async function listPendingRawFiles(rawDir, cursorFile) {
  const entries = await fs.readdir(rawDir).catch(() => []);
  return entries.filter((n) => RAW_DAY_FILE_RE.test(n) && n >= cursorFile).sort();
}

/** Convert a JS string char-index into its UTF-8 byte offset (positions in this module are byte-exact). */
function charIndexToByteOffset(str, charIndex) {
  return Buffer.byteLength(str.slice(0, charIndex), 'utf8');
}

/** A never-headered legacy file/blob's fallback attribution: its own filename date at UTC midnight. */
function fileDateMidnightIso(fname) {
  return `${fname.slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Split one file's unread remainder into ordered segments.
 *
 * @param {Buffer} remainder - bytes from the resume offset to EOF.
 * @returns {Array<{startByte: number, endByte: number, headerIso: string|null}>}
 *   Byte ranges are relative to `remainder` (0-based). `headerIso` is the
 *   turn's own ISO (extracted from its header) for a real turn segment, or
 *   `null` for a leading continuation / legacy blob segment.
 */
function segmentsForRemainder(remainder) {
  if (remainder.length === 0) return [];
  const remainderStr = remainder.toString('utf8');
  const headerRe = makeTurnHeaderRe('gm');
  // makeTurnHeaderRe()'s only capture group is the role, not the ISO, so the
  // ISO is sliced out of each full match (`## <ISO> <role>`) directly —
  // matches checkpoint-cursor.mjs's recoveryReinit approach for the same
  // shared regex.
  const matches = [...remainderStr.matchAll(headerRe)].map((m) => ({
    byte: charIndexToByteOffset(remainderStr, m.index),
    iso: m[0].slice(3, m[0].indexOf(' ', 3)),
  }));

  if (matches.length === 0) {
    // No header anywhere in this remainder: the whole thing is one legacy
    // blob segment (spec §4.4).
    return [{ startByte: 0, endByte: remainder.length, headerIso: null }];
  }

  const segments = [];
  if (matches[0].byte > 0) {
    // Content before the first header in this remainder: only reachable
    // when resuming mid-turn from a `boundary: "split"` cursor (the
    // originating header sits below the resume offset, already consumed in
    // an earlier chunk) — a headerless continuation segment.
    segments.push({ startByte: 0, endByte: matches[0].byte, headerIso: null });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].byte;
    const end = i + 1 < matches.length ? matches[i + 1].byte : remainder.length;
    segments.push({ startByte: start, endByte: end, headerIso: matches[i].iso });
  }
  return segments;
}

/**
 * Guaranteed-progress hard split (spec §4.4): find the split point, in
 * bytes from the start of `buf`, at or under `maxBytes` — the last newline
 * strictly under the limit, else the nearest UTF-8 character boundary at or
 * before the limit (never mid-codepoint). Always returns > 0 for any
 * realistic `maxBytes` (>= a few bytes), which is what guarantees assembly
 * position always advances.
 *
 * @param {Buffer} buf
 * @param {number} maxBytes
 * @returns {number}
 */
function computeSplitPoint(buf, maxBytes) {
  const limit = Math.min(maxBytes, buf.length);
  const newlineIdx = buf.lastIndexOf(0x0a, limit - 1); // 0x0a = '\n'
  if (newlineIdx !== -1) return newlineIdx + 1;
  // No newline in range: back off from `limit` to the nearest position that
  // does not sit on a UTF-8 continuation byte (10xxxxxx) — i.e. a position
  // that either starts a new codepoint or is plain ASCII.
  let p = limit;
  while (p > 0 && (buf[p] & 0xc0) === 0x80) p -= 1;
  return p;
}

/** Track running min/max ISO (by parsed epoch ms) across a chunk's segments. */
function trackIso(range, iso) {
  const ms = Date.parse(iso);
  if (range.min === null || ms < range.min.ms) range.min = { iso, ms };
  if (range.max === null || ms > range.max.ms) range.max = { iso, ms };
}

/**
 * Assemble the next bounded chunk of whole turns from a project's raw
 * capture stream, starting at `cursor` (spec §4.4).
 *
 * @param {object} args
 * @param {string} args.vaultDir
 * @param {string} args.project
 * @param {object} args.cursor - `{file, offset, boundary, last_turn_iso}`
 *   (schema per checkpoint-cursor.mjs) — trusted as-is; validity is the
 *   caller's responsibility (checkpoint-cursor.mjs's loadCursor).
 * @param {number} args.chunkMaxBytes - hard ceiling on `chunk.text`'s byte
 *   length (I2, absolute — never exceeded for any input).
 * @param {(lockdirPath: string) => Promise<boolean>} args.acquireLock
 * @param {(lockdirPath: string) => Promise<void>} args.releaseLock
 * @returns {Promise<
 *   {chunk: object, nextCursor: object} |
 *   {exhausted: true} |
 *   {stopped: {reason: 'raw_lock', file: string}, chunk?: object, nextCursor?: object}
 * >}
 */
export async function buildNextChunk({ vaultDir, project, cursor, chunkMaxBytes, acquireLock, releaseLock }) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  const pendingFiles = await listPendingRawFiles(rawDir, cursor.file);
  if (pendingFiles.length === 0) {
    return { exhausted: true };
  }

  // startFile/startOffset are the position of the FIRST byte actually
  // included in `chunk.text` — set lazily on the first segment added below,
  // NOT wherever the scan happened to begin. These two can differ: a cursor
  // sitting exactly at a file's EOF (nothing left to read there) still
  // starts the SCAN at that file, but the chunk's real content window
  // begins at offset 0 of the next file. Using the scan-start position here
  // instead would make the §4.5 deterministic summary id
  // (hash8(project|startFile|startOffset|endFile|endOffset)) depend on an
  // empty, content-free prefix — two positions describing the identical
  // content window could hash to different ids, breaking crash-redo
  // idempotency.
  let startFile = null;
  let startOffset = null;

  // Carry: the ISO attributed to headerless content. Seeded from the
  // cursor's own last_turn_iso only when resuming mid a hard split (spec
  // §4.5.4 / §4.1) — the originating turn's header sits below the resume
  // offset and is never re-read, so seeding from the NEXT header would
  // overestimate (the unsafe direction for the recovery watermark). Updated
  // to a turn's own ISO every time a real header is consumed.
  let carryIso = cursor.boundary === 'split' ? cursor.last_turn_iso : null;

  const pieces = [];
  let accumulatedBytes = 0;
  let turnCount = 0;
  const isoRange = { min: null, max: null };
  let endFile = null;
  let endOffset = null;
  let boundary = null;

  const buildResult = (stoppedInfo) => {
    const result = {
      chunk: {
        text: Buffer.concat(pieces).toString('utf8'),
        turnCount,
        startFile,
        startOffset,
        endFile,
        endOffset,
        boundary,
        coversFrom: isoRange.min.iso,
        coversUntil: isoRange.max.iso,
      },
      nextCursor: {
        file: endFile,
        offset: endOffset,
        boundary,
        // "max ISO seen so far" (spec §4.1's digested_through watermark) —
        // deliberately the chunk's own covers_until, not merely the
        // positionally-last header, so non-monotonic client timestamps
        // never regress the watermark within a single chunk.
        last_turn_iso: isoRange.max.iso,
        last_summary_id: null,
      },
    };
    return stoppedInfo ? { stopped: stoppedInfo, ...result } : result;
  };

  let stopped = false;
  for (const fname of pendingFiles) {
    if (stopped) break;

    const filePath = path.join(rawDir, fname);
    const lockPath = `${filePath}.lockdir`;
    const gotLock = await acquireLock(lockPath);
    if (!gotLock) {
      if (pieces.length === 0) {
        return { stopped: { reason: 'raw_lock', file: fname } };
      }
      // No-skip-ahead (I3): what's accumulated so far already ends cleanly
      // at the previous file's EOF (this loop only advances to a NEW file
      // once the previous one's segments are fully drained within budget),
      // so `endFile`/`endOffset`/`boundary` are already correct — never
      // read a byte of `fname` or anything past it.
      return buildResult({ reason: 'raw_lock', file: fname });
    }

    let fileBuf;
    try {
      fileBuf = await fs.readFile(filePath);
    } finally {
      await releaseLock(lockPath);
    }

    const resumeByte = fname === cursor.file ? Math.min(cursor.offset, fileBuf.length) : 0;
    const remainder = fileBuf.subarray(resumeByte);
    const segments = segmentsForRemainder(remainder);

    for (const seg of segments) {
      const segLen = seg.endByte - seg.startByte;
      if (segLen <= 0) {
        continue;
      }
      const segIso = seg.headerIso ?? carryIso ?? fileDateMidnightIso(fname);

      if (accumulatedBytes + segLen > chunkMaxBytes) {
        if (pieces.length === 0) {
          // Guaranteed progress (spec §4.4): this single segment alone
          // exceeds the budget — hard-split it, ending the chunk here. This
          // is also the chunk's first (and only) content: fix startFile/
          // startOffset to exactly where the split piece begins.
          startFile = fname;
          startOffset = resumeByte + seg.startByte;
          const segBuf = remainder.subarray(seg.startByte, seg.endByte);
          const splitAt = computeSplitPoint(segBuf, chunkMaxBytes);
          pieces.push(segBuf.subarray(0, splitAt));
          if (seg.headerIso) turnCount += 1;
          trackIso(isoRange, segIso);
          endFile = fname;
          endOffset = resumeByte + seg.startByte + splitAt;
          boundary = 'split';
        }
        // Either just hard-split (above) or the chunk already had content
        // and this segment doesn't fit in the remaining budget (deferred to
        // the next call) — either way, stop assembling: `endFile`/
        // `endOffset`/`boundary` already hold the correct cut point.
        stopped = true;
        break;
      }

      if (pieces.length === 0) {
        // First segment actually landing in this chunk — fix the content
        // window's start here (see the module-level comment on
        // startFile/startOffset above for why this can't be the scan's
        // starting position).
        startFile = fname;
        startOffset = resumeByte + seg.startByte;
      }
      pieces.push(remainder.subarray(seg.startByte, seg.endByte));
      accumulatedBytes += segLen;
      if (seg.headerIso) {
        turnCount += 1;
        carryIso = seg.headerIso;
      }
      trackIso(isoRange, segIso);
      endFile = fname;
      endOffset = resumeByte + seg.endByte;
      boundary = 'turn'; // clean so far — overwritten only by an explicit split above
    }
    // This file's segments are fully drained within budget (or assembly
    // just stopped): the outer loop's `if (stopped) break;` guard above
    // handles the latter on the next iteration check.
  }

  if (pieces.length === 0) {
    return { exhausted: true };
  }
  return buildResult(null);
}
