/**
 * server/lib/env-number.mjs — the shared parser for numeric env knobs.
 *
 * A knob is either wholly numeric or not set: a malformed value is no override, and the
 * caller's default applies. The lenient reads this replaces each meant something different
 * by the same typo — parseFloat and parseInt keep a numeric prefix ('0.9x' as 0.9, '5000ms'
 * as 5000, '3.5' as 3), Number reads a blank as 0, and parseInt reads it as NaN, which
 * disabled the rate limiter and stopped withRetry from ever calling its function.
 */

/**
 * The whole trimmed value as a finite number, else undefined (no override, so the caller's
 * default applies). A malformed value never becomes a partial number ('0.1garbage' read as
 * 0.1 by parseFloat), 0 (' ' read by Number) or NaN ('abc').
 */
export function parseNumberEnv(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const n = s === '' ? Number.NaN : Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * parseNumberEnv, kept only when it is a safe integer within [min, max]; else undefined.
 * A fraction is malformed for an integer knob, never truncated ('3.5' is not 3).
 */
export function parseIntEnv(raw, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseNumberEnv(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

/** parseNumberEnv, kept only above 0; for rates and durations, where a fraction is meaningful. */
export function parsePositiveNumberEnv(raw) {
  const n = parseNumberEnv(raw);
  return n > 0 ? n : undefined;
}

/** A TCP port (1-65535) from the environment, else `fallback`. */
export function parsePortEnv(raw, fallback) {
  return parseIntEnv(raw, { min: 1, max: 65535 }) ?? fallback;
}
