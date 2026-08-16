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
// (chunk ends `boundary: "turn"`, positionally exact) UNLESS either (a) the
// chunk is still empty, or (b) the chunk has SOME content but it is still
// below `minChunkBytes` (the resolved #185 bytes floor) — in either case the
// oversized segment is hard-split to fill the remaining budget (chunk ends
// `boundary: "split"`). Case (a) is what guarantees every call makes forward
// progress regardless of how large a single turn or legacy blob is (spec
// §4.4 "guaranteed progress"); case (b) is the "fill-to-floor" rule (spec
// §4.4) that keeps a sub-floor head + oversized-next-turn from abstaining
// forever with the cursor frozen (Task-6 review IMPORTANT 2) — a chunk is
// only ever allowed to end thin when it is genuinely the last content in the
// corpus (nothing left pending to fill it with).
//
// Locking: per spec, the caller injects `acquireLock`/`releaseLock` (bound
// lockdir.mjs functions, same `<rawFilePath>.lockdir` convention as
// checkpoint.mjs:357). This module acquires a file's lock immediately before
// reading it and releases it right after (finally) — it never reads a file
// it could not lock, and never reads PAST a file whose lock it could not
// acquire (spec §4.4 "no-skip-ahead", I3).

import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTurnHeaderRe, DEFAULT_MIN_TRANSCRIPT_BYTES } from './checkpoint-config.mjs';
import { getLogger } from './logger.mjs';
import { safeLog } from './obs-fallback.mjs';
import { currentRequestId } from './request-context.mjs';

// Raw day-file naming (mirrors checkpoint-cursor.mjs's CURSOR_FILE_RE):
// `YYYY-MM-DD.md`, so lexical order == chronological order.
const RAW_DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** List raw day-files at or after `cursorFile` (lexical, == chronological), sorted ascending. */
async function listPendingRawFiles(rawDir, cursorFile) {
  const entries = await fs.readdir(rawDir).catch(() => []);
  return entries.filter((n) => RAW_DAY_FILE_RE.test(n) && n >= cursorFile).sort();
}

/** A never-headered legacy file/blob's fallback attribution: its own filename date at UTC midnight. */
function fileDateMidnightIso(fname) {
  return `${fname.slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Split one file's unread remainder into ordered segments.
 *
 * Header scanning happens entirely in the BYTE domain via a `latin1`
 * decode, never `utf8` (round-1 review IMPORTANT 1). `latin1` maps every
 * byte 0x00-0xFF to exactly one UTF-16 code unit, so a JS string char index
 * is ALWAYS identical to its byte offset — for ANY input, valid UTF-8 or
 * not. `utf8` decoding is lossy for invalid byte sequences (each maps to
 * one U+FFFD replacement character, which is 3 bytes when re-measured via
 * `Buffer.byteLength`), so converting a utf8-decoded string's char index
 * back to a byte offset silently inflates past the true position — a raw
 * capture file containing even one stray non-UTF-8 byte (a truncated
 * multi-byte write, corrupted transport, …) could produce a chunk that
 * exceeds `chunkMaxBytes` (I2 violation) and a `nextCursor.offset` beyond
 * the file's actual size. The header pattern itself is pure ASCII, so
 * matching against the latin1-decoded string finds real headers identically
 * to matching the utf8-decoded one — only the invalid-byte robustness
 * differs. `chunk.text` is still emitted via a `utf8` decode of the exact
 * byte slices at the very end (buildNextChunk's `buildResult`) — this
 * function only ever decodes for POSITION-FINDING, never for content.
 *
 * @param {Buffer} remainder - bytes from the resume offset to EOF.
 * @returns {Array<{startByte: number, endByte: number, headerIso: string|null}>}
 *   Byte ranges are relative to `remainder` (0-based). `headerIso` is the
 *   turn's own ISO (extracted from its header) for a real turn segment, or
 *   `null` for a leading continuation / legacy blob segment.
 */
function segmentsForRemainder(remainder) {
  if (remainder.length === 0) return [];
  const remainderLatin1 = remainder.toString('latin1');
  const headerRe = makeTurnHeaderRe('gm');
  // makeTurnHeaderRe()'s only capture group is the role, not the ISO, so the
  // ISO is sliced out of each full match (`## <ISO> <role>`) directly —
  // matches checkpoint-cursor.mjs's recoveryReinit approach for the same
  // shared regex. `m.index` under latin1 decoding IS the byte offset — no
  // conversion needed (see function doc above).
  const matches = [...remainderLatin1.matchAll(headerRe)].map((m) => ({
    byte: m.index,
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
 * The byte length of `buf` AFTER a `utf8` decode-then-re-encode round trip
 * — i.e. what `chunkMaxBytes` must actually bound (round-1 review
 * IMPORTANT 1's residual). For VALID UTF-8 content this always equals
 * `buf.length` exactly (utf8 is a lossless bijection for well-formed
 * input). It can EXCEED `buf.length` for genuinely invalid byte sequences:
 * each maximal invalid subsequence decodes to one U+FFFD replacement
 * character, which is 3 bytes in UTF-8 — so a single stray invalid byte can
 * inflate by 2 bytes on re-encode. Raw byte-slice bookkeeping alone (how
 * many source bytes were included) is NOT sufficient to bound this; every
 * budget decision in this module compares against THIS value, not
 * `buf.length`.
 */
function decodedByteLength(buf) {
  return Buffer.byteLength(buf.toString('utf8'), 'utf8');
}

/** Back off from `pos` to the nearest position NOT sitting on a UTF-8 continuation byte (10xxxxxx). */
function backToUtf8Boundary(buf, pos) {
  let p = pos;
  while (p > 0 && (buf[p] & 0xc0) === 0x80) p -= 1;
  return p;
}

/**
 * Guaranteed-progress hard split (spec §4.4): find the split point, in
 * bytes from the start of `buf`, such that the INCLUDED PREFIX's decoded
 * (re-encoded) length — not merely its raw byte count — is `<= maxBytes`.
 * Starts from the last newline strictly under the limit, else the nearest
 * UTF-8 character boundary at or before the limit (never mid-codepoint);
 * then, since even a boundary-respecting raw-byte cut can still decode
 * larger than `maxBytes` when the source contains genuinely invalid UTF-8
 * (round-1 review IMPORTANT 1), iteratively backs off further — always
 * re-landing on a safe codepoint boundary — until the decoded length
 * actually fits. Always returns > 0 for any realistic `maxBytes` (>= a few
 * bytes) on content that isn't overwhelmingly invalid bytes, which is what
 * guarantees assembly position always advances.
 *
 * @param {Buffer} buf
 * @param {number} maxBytes
 * @returns {number}
 */
function computeSplitPoint(buf, maxBytes) {
  const limit = Math.min(maxBytes, buf.length);
  const newlineIdx = buf.lastIndexOf(0x0a, limit - 1); // 0x0a = '\n'
  let candidate = newlineIdx !== -1 ? newlineIdx + 1 : backToUtf8Boundary(buf, limit);
  while (candidate > 0 && decodedByteLength(buf.subarray(0, candidate)) > maxBytes) {
    candidate = backToUtf8Boundary(buf, candidate - 1);
  }
  return candidate;
}

/**
 * A turn header can match the regex SHAPE (`\d{4}-\d{2}-\d{2}T\S*`) while
 * still being semantically unparseable content (e.g. `Tzzz`, or a
 * shape-valid-but-impossible calendar date like month 13) — client-supplied
 * text is untrusted. Returns `iso` unchanged when it parses, else `null`.
 */
function validIso(iso) {
  return iso !== null && !Number.isNaN(Date.parse(iso)) ? iso : null;
}

/**
 * Track running min/max ISO (by parsed epoch ms) across a chunk's segments.
 * Round-1 review MINOR 3: silently no-ops on an unparseable `iso` (defense
 * in depth — the caller already routes an unparseable header ISO through
 * the headerless carry/file-date fallback via `validIso` before it ever
 * reaches here, so this guard should never actually fire in practice, but a
 * poisoned covers_from/covers_until is a bad enough outcome to guard twice).
 */
function trackIso(range, iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return;
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
 * @param {number} [args.minChunkBytes] - the resolved #185 bytes floor
 *   (spec §4.4's fill-to-floor rule, Task-6 review IMPORTANT 2). The caller
 *   resolves this via checkpoint-config.mjs's resolveFloor exactly as
 *   checkpoint-chunk-txn.mjs's own #185 gate does, and passes it in here so
 *   the builder never STOPS a chunk below this floor while content still
 *   pends — it hard-splits to fill the remaining budget instead. Defaults
 *   to DEFAULT_MIN_TRANSCRIPT_BYTES for callers that don't thread a
 *   resolved value through (e.g. direct unit tests of this module).
 * @param {(lockdirPath: string) => Promise<boolean>} args.acquireLock
 * @param {(lockdirPath: string) => Promise<void>} args.releaseLock
 * @returns {Promise<
 *   {chunk: object, nextCursor: object} |
 *   {exhausted: true} |
 *   {stopped: {reason: 'raw_lock', file: string}, chunk?: object, nextCursor?: object}
 * >}
 */
export async function buildNextChunk({
  vaultDir, project, cursor, chunkMaxBytes,
  minChunkBytes = DEFAULT_MIN_TRANSCRIPT_BYTES,
  acquireLock, releaseLock,
}) {
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
  let decodedBytesSoFar = 0;
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

    // Round-1 review MINOR 4: a lock-free stat BEFORE ever touching the
    // lock. If this file already has nothing left to read from the resume
    // position (the cursor sits at or past its current size), there's no
    // reason to acquire its lock at all — skip straight to the next
    // pending file. Without this, a cursor sitting exactly at the LAST
    // file's EOF, with that file locked by a live session for an unrelated
    // append, would report a spurious `stopped: raw_lock` instead of
    // `exhausted` — there was never anything to read from it. A stat that
    // fails (ENOENT/etc) is treated as "unknown, don't skip" — the
    // subsequent lock+read attempt handles a genuinely vanished file (see
    // MINOR 5 below) without this pre-check masking the real error class.
    const resumeByteGuess = fname === cursor.file ? cursor.offset : 0;
    const preStat = await fs.stat(filePath).catch(() => null);
    if (preStat && resumeByteGuess >= preStat.size) {
      continue;
    }

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

    // Round-1 review MINOR 5. (a) A file that vanishes between the readdir
    // snapshot above and this read (ENOENT) is not a hazard — §4.2 check 3
    // treats deletion of already-digested files as legal — so it's treated
    // as "nothing to contribute here" and the walk moves on, rather than
    // aborting the whole run. Any OTHER read error is unexpected and still
    // surfaces. (b) `releaseLock` is best-effort: a rejection there must
    // never escape the `finally` and mask whichever error (if any) came out
    // of the `try` — caught, logged, swallowed.
    let fileBuf = null;
    try {
      fileBuf = await fs.readFile(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      safeLog(() => getLogger().warn({
        request_id: currentRequestId(),
        component: 'chunk-builder',
        project,
        file: fname,
      }, 'chunk-builder: raw file vanished mid-walk (ENOENT) — skipping'), 'log:chunk-builder:enoent-skip');
    } finally {
      try {
        await releaseLock(lockPath);
      } catch (releaseErr) {
        safeLog(() => getLogger().warn({
          request_id: currentRequestId(),
          component: 'chunk-builder',
          project,
          file: fname,
          err_message: releaseErr?.message ?? String(releaseErr),
        }, 'chunk-builder: releaseLock failed (best-effort)'), 'log:chunk-builder:release-failed');
      }
    }
    if (fileBuf === null) continue;

    const resumeByte = fname === cursor.file ? Math.min(cursor.offset, fileBuf.length) : 0;
    const remainder = fileBuf.subarray(resumeByte);
    const segments = segmentsForRemainder(remainder);

    for (const seg of segments) {
      const segLen = seg.endByte - seg.startByte;
      if (segLen <= 0) {
        continue;
      }
      // A structurally-matched header whose ISO doesn't actually parse
      // (round-1 review MINOR 3, e.g. `## 2026-08-10Tzzz user`) is treated
      // as headerless for ATTRIBUTION purposes — it contributes nothing to
      // covers_from/covers_until directly and never advances the carry;
      // the carry/file-date fallback chain applies exactly as if this
      // segment had no header at all. It still counts toward `turnCount`
      // below (the header genuinely delimits a turn boundary structurally —
      // only its timestamp is garbage).
      const parsedHeaderIso = validIso(seg.headerIso);
      const segIso = parsedHeaderIso ?? carryIso ?? fileDateMidnightIso(fname);
      const segBuf = remainder.subarray(seg.startByte, seg.endByte);
      // Budget decisions compare DECODED length, not raw byte-slice length
      // (round-1 review IMPORTANT 1's residual): a segment's raw bytes can
      // fit the remaining budget while its utf8-decoded (re-encoded) form
      // does not, if it contains genuinely invalid UTF-8.
      const segDecodedLen = decodedByteLength(segBuf);

      if (decodedBytesSoFar + segDecodedLen > chunkMaxBytes) {
        // Fill-to-floor (spec §4.4, Task-6 review IMPORTANT 2): a chunk is
        // hard-split to fill the REMAINING budget — not merely ended early
        // — whenever ending it here would leave it below `minChunkBytes`
        // (the resolved #185 bytes floor) while content still pends. Two
        // cases trigger this:
        //   (a) pieces.length === 0 — the chunk's first segment alone
        //       exceeds the budget (guaranteed progress, unconditional —
        //       there is no accumulated content to fall below any floor).
        //   (b) pieces.length > 0 but decodedBytesSoFar < minChunkBytes —
        //       the chunk already has SOME content, but ending it here
        //       would produce a sub-floor chunk. Without this, a sub-floor
        //       head followed by an oversized turn would abstain FOREVER
        //       (the #185 thin gate on the first chunk of a run never
        //       advances the cursor — reproduced: 3 runs, cursor frozen,
        //       backlog undigested) — the exact silent-abstain-with-
        //       pending-backlog class this design exists to dissolve.
        // `remainingBudget > 0` guards a pathological misconfiguration
        // (minChunkBytes > chunkMaxBytes) from ever computing a zero/
        // negative split budget — falls through to the plain stop instead.
        const remainingBudget = chunkMaxBytes - decodedBytesSoFar;
        const fillToFloor = (pieces.length === 0 || decodedBytesSoFar < minChunkBytes) && remainingBudget > 0;
        if (fillToFloor) {
          if (pieces.length === 0) {
            // This is also the chunk's first (and only) content so far: fix
            // startFile/startOffset to exactly where the split piece begins.
            startFile = fname;
            startOffset = resumeByte + seg.startByte;
          }
          const splitAt = computeSplitPoint(segBuf, remainingBudget);
          pieces.push(segBuf.subarray(0, splitAt));
          if (seg.headerIso) turnCount += 1;
          trackIso(isoRange, segIso);
          endFile = fname;
          endOffset = resumeByte + seg.startByte + splitAt;
          boundary = 'split';
        }
        // Either just hard-split (above, guaranteeing first-segment
        // progress or filling a sub-floor chunk to the floor) or the chunk
        // already had enough content (>= minChunkBytes) and this segment
        // doesn't fit the remaining budget (deferred to the next call) —
        // either way, stop assembling: `endFile`/`endOffset`/`boundary`
        // already hold the correct cut point.
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
      pieces.push(segBuf);
      // Safe to accumulate decoded lengths independently and sum them
      // (rather than re-decoding the whole growing buffer each time):
      // every segment boundary here is ASCII-anchored (a header match or
      // EOF), never an arbitrary mid-codepoint cut, so decoding each piece
      // separately and decoding their concatenation agree exactly.
      decodedBytesSoFar += segDecodedLen;
      if (seg.headerIso) turnCount += 1;
      if (parsedHeaderIso) carryIso = parsedHeaderIso;
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
