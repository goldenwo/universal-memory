/**
 * server/lib/checked-knobs.mjs — the env knobs whose silent fallback would do harm.
 *
 * A malformed numeric knob is normally no override (env-number.mjs). For these, falling back
 * to the default would loosen a protection (the rate limiter, the request-body cap), move a
 * port, or delete data (the capture-ledger retention horizon), so a set-but-malformed value
 * refuses boot (startup-validation.mjs validateNumericKnobs) — #321's rule. Every reader
 * goes through checkedKnob() and boot walks this same table, so whatever boot accepts is
 * what the reader honours; test/lint/checked-knobs-one-reader.test.mjs keeps it that way.
 */

import { parseIntEnv, parsePositiveNumberEnv, parsePortEnv } from './env-number.mjs';

export const CHECKED_KNOBS = Object.freeze({
  UM_RATE_LIMIT_RPM: { parse: parsePositiveNumberEnv, fallback: 60, expected: 'a positive number of requests per minute' },
  UM_RATE_LIMIT_BURST: { parse: parseIntEnv, fallback: 10, expected: 'a whole number >= 1' },
  UM_RATE_LIMIT_MAX_IPS: { parse: parseIntEnv, fallback: 10000, expected: 'a whole number >= 1' },
  UM_HTTP_MAX_REQUEST_BYTES: { parse: parseIntEnv, fallback: 2 * 1024 * 1024, expected: 'a whole number of bytes >= 1' },
  MEM0_MCP_PORT: { parse: parsePortEnv, fallback: 6335, expected: 'a TCP port 1-65535' },
  QDRANT_PORT: { parse: parsePortEnv, fallback: 6333, expected: 'a TCP port 1-65535' },
  UM_CAPTURE_LEDGER_RETENTION_DAYS: { parse: parseIntEnv, fallback: 30, expected: 'a whole number of days >= 1' },
});

/** The knob's value: the env value its parse accepts, else the fallback (unset or blank). */
export function checkedKnob(name, env = process.env) {
  const { parse, fallback } = CHECKED_KNOBS[name];
  return parse(env[name]) ?? fallback;
}

/** As checkedKnob, but a set, non-blank value the parse rejects throws, naming it. */
export function requireCheckedKnob(name, env = process.env) {
  const { parse, fallback, expected } = CHECKED_KNOBS[name];
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = parse(raw);
  if (value === undefined) {
    throw new Error(`${name} must be ${expected} (default ${fallback}), got ${JSON.stringify(raw)}`);
  }
  return value;
}
