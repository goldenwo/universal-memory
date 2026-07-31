#!/usr/bin/env node
// plugins/openclaw/reaction-producer/reaction-producer.mjs — #201 PR 2:
// standalone read-only Discord gateway listener that POSTs late-arriving
// reactions to UM's /api/reaction.
//
// WHY STANDALONE (Task-0 spike, 2026-07-31): the OpenClaw plugin bus exposes
// no reaction event at v2026.6.1 — the only in-gateway consumer of reactions
// is the monitor → enqueueSystemEvent → agent-notification path (LLM-mediated,
// not producer-grade). This process opens its OWN gateway session with the
// SAME bot token (Discord permits multiple sessions per token, each with its
// own intents) — no second app, no guild invite, read-only intents.
//
// DESIGN (matches the /api/reaction contract in openapi.yaml):
// • Absolute counts, not deltas: each burst triggers ONE message fetch (the
//   only REST call) and the total is recomputed from message.reactions.
// • message_ts derives from the message-id snowflake; message_hash =
//   md5(message.content) rides along as the contract's best-effort refiner.
// • Retry on 5xx, 429, 401/403 (token rotation heals) AND outcome=unaddressed,
//   capped ~10 min (lib.backoffDelaysMs). 400 = drop (caller-malformed).
// • Reconnect on close is a fresh IDENTIFY (no RESUME — deliberate
//   simplification; reactions during a gap are lost and observable as absent
//   rows, sparse by nature). Fatal close codes (bad token / bad intents)
//   exit non-zero instead of looping.
// • Heartbeat ACKs are tracked — a half-open socket (no ACK by the next
//   beat) forces a close + reconnect instead of a silent zombie.
// • The bot's own reactions are ignored (parity with the gateway's handler).
// • SCOPE: guild-channel reactions only. DM reactions are deliberately out —
//   DM captures carry a different sessionKey shape than the channel template,
//   so delivering them would only mint unaddressed noise (this deployment's
//   ledger rows are channel-keyed).
//
// Env (systemd unit wires these):
//   DISCORD_BOT_TOKEN   — required (shared EnvironmentFile with the gateway)
//   UM_SERVER_URL       — default http://127.0.0.1:6337
//   UM_TOKEN_FILE       — default ~/.um/auth-token
//   UM_RUN_ID_TEMPLATE  — default agent:main:discord:channel:{channelId}
//   UM_REACTION_DEBOUNCE_MS — default 2000 (trailing debounce per message)

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  snowflakeToIso,
  absoluteCount,
  reactionTypes,
  buildRunId,
  backoffDelaysMs,
} from './lib.mjs';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('reaction-producer: DISCORD_BOT_TOKEN is required');
  process.exit(1);
}
const UM_URL = (process.env.UM_SERVER_URL ?? 'http://127.0.0.1:6337').replace(/\/$/, '');
const UM_TOKEN_FILE = process.env.UM_TOKEN_FILE ?? path.join(homedir(), '.um', 'auth-token');
const RUN_ID_TEMPLATE = process.env.UM_RUN_ID_TEMPLATE ?? 'agent:main:discord:channel:{channelId}';
const DEBOUNCE_MS = Number.parseInt(process.env.UM_REACTION_DEBOUNCE_MS ?? '', 10) || 2000;

const API = 'https://discord.com/api/v10';
const INTENTS = (1 << 0) | (1 << 10); // Guilds | GuildMessageReactions
// 4004 auth failed; 4010-4014 invalid shard/sharding-required/version/intents/
// disallowed-intents — reconnecting cannot fix any of these.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const md5 = (s) => createHash('md5').update(s).digest('hex');

function umToken() {
  return readFileSync(UM_TOKEN_FILE, 'utf-8').trim();
}

function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

async function discordGet(pathname) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  });
  if (!res.ok) {
    const err = new Error(`discord GET ${pathname} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// UM delivery with capped retry (5xx/429/401/403 + unaddressed per contract)
// ---------------------------------------------------------------------------

async function postReaction(body, attempt = 0) {
  let res;
  try {
    res = await fetch(`${UM_URL}/api/reaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${umToken()}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return retryOrGiveUp(body, attempt, `network: ${err?.message}`);
  }
  if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) {
    // 429: the /api/* limiter; 401/403: rotated token or writes toggled —
    // all transient from the producer's seat. Distinct log, same backoff.
    return retryOrGiveUp(body, attempt, `http ${res.status}`);
  }
  let parsed = {};
  try { parsed = await res.json(); } catch { /* non-JSON error body */ }
  if (res.status === 400) {
    log(`drop message=${body.message_id} 400: ${parsed?.error?.message ?? 'invalid'}`);
    return;
  }
  if (res.status !== 200) {
    log(`drop message=${body.message_id} unexpected http ${res.status}`);
    return;
  }
  if (parsed.outcome === 'unaddressed') {
    return retryOrGiveUp(body, attempt, `unaddressed:${parsed.reason ?? ''}`);
  }
  log(`delivered message=${body.message_id} outcome=${parsed.outcome} points=${(parsed.point_ids ?? []).length} annotated=${parsed.annotated}`);
}

function retryOrGiveUp(body, attempt, why) {
  const delays = backoffDelaysMs();
  if (attempt >= delays.length) {
    log(`give-up message=${body.message_id} after ${attempt} retries (${why})`);
    return;
  }
  log(`retry#${attempt + 1} message=${body.message_id} in ${delays[attempt]}ms (${why})`);
  // NOT unref'd: pending retries must keep the process alive through a
  // gateway close (review #206) — systemd owns the daemon's lifetime.
  setTimeout(() => { postReaction(body, attempt + 1).catch(() => {}); }, delays[attempt]);
}

// ---------------------------------------------------------------------------
// Per-message trailing debounce → one fetch + one POST per burst
// ---------------------------------------------------------------------------

const pending = new Map(); // messageId -> {channelId, timer}

function scheduleDelivery(channelId, messageId) {
  const existing = pending.get(messageId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending.delete(messageId);
    deliver(channelId, messageId).catch((err) => {
      log(`deliver failed message=${messageId}: ${err?.message}`);
    });
  }, DEBOUNCE_MS);
  pending.set(messageId, { channelId, timer });
}

async function deliver(channelId, messageId, attempt = 0) {
  let message = null;
  try {
    message = await discordGet(`/channels/${channelId}/messages/${messageId}`);
  } catch (err) {
    if (err?.status === 403 || err?.status === 404) {
      // Deleted message / lost access / missing Read Message History: nothing
      // to count — skip quietly.
      log(`skip message=${messageId}: ${err.message}`);
      return;
    }
    // 429 / Discord 5xx / network: retry on the same capped schedule.
    const delays = backoffDelaysMs();
    if (attempt >= delays.length) {
      log(`give-up fetch message=${messageId} after ${attempt} retries (${err?.message})`);
      return;
    }
    log(`refetch#${attempt + 1} message=${messageId} in ${delays[attempt]}ms (${err?.message})`);
    setTimeout(() => { deliver(channelId, messageId, attempt + 1).catch(() => {}); }, delays[attempt]);
    return;
  }
  const content = typeof message.content === 'string' ? message.content : '';
  await postReaction({
    run_id: buildRunId(RUN_ID_TEMPLATE, channelId),
    message_id: messageId,
    message_ts: snowflakeToIso(messageId),
    ...(content.length > 0 ? { message_hash: md5(content) } : {}),
    reaction_count: absoluteCount(message),
    reaction_types: reactionTypes(message),
  });
}

// ---------------------------------------------------------------------------
// Gateway client (native WebSocket, fresh-IDENTIFY reconnect, ACK-tracked)
// ---------------------------------------------------------------------------

let botUserId = null;
let ws = null;
let heartbeatTimer = null;
let lastSeq = null;
let awaitingAck = false;
let reconnectDelay = 5_000;

function scheduleReconnect(why) {
  log(`${why}; reconnecting in ${reconnectDelay}ms`);
  setTimeout(() => {
    connect().catch((err) => scheduleReconnect(`reconnect failed: ${err?.message}`));
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 300_000);
}

async function connect() {
  const { url } = await discordGet('/gateway/bot');
  lastSeq = null;
  awaitingAck = false;
  ws = new WebSocket(`${url}?v=10&encoding=json`);

  ws.addEventListener('message', (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    if (frame.s != null) lastSeq = frame.s;
    switch (frame.op) {
      case 10: { // HELLO
        const interval = frame.d.heartbeat_interval;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (awaitingAck) {
            // Half-open socket: our last beat was never ACKed. Force the
            // close path — heartbeating into the void is a silent zombie
            // (review #206).
            try { ws.close(4000, 'heartbeat ack timeout'); } catch { /* closing */ }
            return;
          }
          awaitingAck = true;
          try { ws.send(JSON.stringify({ op: 1, d: lastSeq })); } catch { /* closing */ }
        }, interval);
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: TOKEN,
            intents: INTENTS,
            properties: { os: 'linux', browser: 'um-reaction-producer', device: 'um-reaction-producer' },
          },
        }));
        break;
      }
      case 11: // HEARTBEAT_ACK
        awaitingAck = false;
        break;
      case 1: // server-requested immediate heartbeat
        try { ws.send(JSON.stringify({ op: 1, d: lastSeq })); } catch { /* closing */ }
        break;
      case 0: { // DISPATCH
        const { t, d } = frame;
        if (t === 'READY') {
          botUserId = d.user?.id ?? null;
          reconnectDelay = 5_000;
          log(`ready as bot=${botUserId} session=${d.session_id}`);
          break;
        }
        if (t === 'MESSAGE_REACTION_ADD' || t === 'MESSAGE_REACTION_REMOVE') {
          if (d.user_id && d.user_id === botUserId) break; // ignore the bot's own
          scheduleDelivery(d.channel_id, d.message_id);
          break;
        }
        if (t === 'MESSAGE_REACTION_REMOVE_ALL' || t === 'MESSAGE_REACTION_REMOVE_EMOJI') {
          scheduleDelivery(d.channel_id, d.message_id);
          break;
        }
        break;
      }
      case 7: // RECONNECT requested
      case 9: // INVALID SESSION
        try { ws.close(); } catch { /* already closing */ }
        break;
      default:
        break;
    }
  });

  ws.addEventListener('close', (ev) => {
    clearInterval(heartbeatTimer);
    if (FATAL_CLOSE_CODES.has(ev.code)) {
      console.error(`reaction-producer: fatal gateway close code=${ev.code} (${ev.reason || 'no reason'}); exiting`);
      process.exit(1);
    }
    scheduleReconnect(`gateway closed code=${ev.code}`);
  });

  ws.addEventListener('error', () => { /* close follows; handled there */ });
}

log(`starting: um=${UM_URL} template=${RUN_ID_TEMPLATE} debounce=${DEBOUNCE_MS}ms`);
connect().catch((err) => scheduleReconnect(`initial connect failed: ${err?.message}`));
