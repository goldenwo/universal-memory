// plugins/openclaw/reaction-producer/lib.mjs — pure helpers for the Discord
// reaction producer (#201 PR 2).
//
// The producer is a standalone read-only Discord gateway listener that POSTs
// late-arriving reactions to UM's /api/reaction. These helpers are the
// testable core; the gateway/IO shell lives in reaction-producer.mjs.

const DISCORD_EPOCH_MS = 1420070400000n;

/** Discord snowflake → ISO-8601 timestamp (the message's creation time). */
export function snowflakeToIso(id) {
  const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
  return new Date(Number(ms)).toISOString();
}

/**
 * ABSOLUTE current reaction count on a fetched message — the wire contract's
 * unit (not a delta). The bot's own reactions are excluded via the `me` flag
 * (one per emoji), matching the gateway-side convention of ignoring bot
 * reactions.
 */
export function absoluteCount(message) {
  let total = 0;
  for (const r of message?.reactions ?? []) {
    total += (r.count ?? 0) - (r.me ? 1 : 0);
  }
  return total;
}

/** Emoji labels (unicode name or custom-emoji name), deduped, encounter order. */
export function reactionTypes(message) {
  const seen = new Set();
  const out = [];
  for (const r of message?.reactions ?? []) {
    const name = r.emoji?.name;
    if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * run_id template → the exact OpenClaw sessionKey shape the capture ledger
 * stores (opaque equality on the UM side — the template keeps the producer
 * configurable without UM ever parsing the format).
 */
export function buildRunId(template, channelId) {
  return template.replace('{channelId}', channelId);
}

/**
 * Retry backoff for 5xx / `unaddressed` responses (spec D-b: capped ~10 min
 * total — a reaction can land seconds before its capture is recorded).
 */
export function backoffDelaysMs() {
  return [5_000, 15_000, 45_000, 120_000, 180_000, 240_000];
}
