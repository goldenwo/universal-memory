/**
 * server/lib/checked-knobs.mjs — the env knobs whose silent fallback would do harm.
 *
 * A malformed numeric knob is normally no override (env-number.mjs). For these, falling back
 * to the default would loosen a protection (the rate limiter, the request-body cap), move a
 * port, or delete data (the capture-ledger retention horizon), so a set-but-malformed value
 * refuses boot (startup-validation.mjs validateNumericKnobs) — #321's rule. Boot walks this
 * table with requireCheckedKnob; the server's own readers then use checkedKnob, and code
 * that runs without that boot check (the CLIs) uses requireCheckedKnob directly.
 * test/lint/checked-knobs-one-reader.test.mjs keeps every other reader out.
 *
 * Each entry's `parse` takes the raw env string and returns the value, or undefined to
 * reject it; it must never substitute a default, or boot validation could not refuse.
 */

import { parseIntEnv, parsePositiveNumberEnv, parsePortEnv } from './env-number.mjs';

const knob = (parse, fallback, expected) => Object.freeze({ parse, fallback, expected });

export const CHECKED_KNOBS = Object.freeze({
  UM_RATE_LIMIT_RPM: knob(parsePositiveNumberEnv, 60, 'a positive number of requests per minute'),
  UM_RATE_LIMIT_BURST: knob(parseIntEnv, 10, 'a whole number >= 1'),
  UM_RATE_LIMIT_MAX_IPS: knob(parseIntEnv, 10000, 'a whole number >= 1'),
  UM_HTTP_MAX_REQUEST_BYTES: knob(parseIntEnv, 2 * 1024 * 1024, 'a whole number of bytes >= 1'),
  MEM0_MCP_PORT: knob(parsePortEnv, 6335, 'a TCP port 1-65535'),
  QDRANT_PORT: knob(parsePortEnv, 6333, 'a TCP port 1-65535'),
  UM_CAPTURE_LEDGER_RETENTION_DAYS: knob(parseIntEnv, 30, 'a whole number of days >= 1'),
});

function entry(name) {
  if (!Object.hasOwn(CHECKED_KNOBS, name)) throw new Error(`unknown checked knob: ${name}`);
  return CHECKED_KNOBS[name];
}

/**
 * The knob's value as the running server reads it: the env value its parse accepts, else
 * the default — for unset and blank, and also for a malformed value, which boot validation
 * has already refused by the time a server reader runs. Code without that boot check
 * (a CLI) must use requireCheckedKnob instead.
 */
export function checkedKnob(name, env = process.env) {
  const { parse, fallback } = entry(name);
  return parse(env[name]) ?? fallback;
}

/** As checkedKnob, but a set, non-blank value the parse rejects throws, naming it. */
export function requireCheckedKnob(name, env = process.env) {
  const { parse, fallback, expected } = entry(name);
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = parse(raw);
  if (value === undefined) {
    throw new Error(`${name} must be ${expected} (default ${fallback}), got ${JSON.stringify(raw)}`);
  }
  return value;
}
