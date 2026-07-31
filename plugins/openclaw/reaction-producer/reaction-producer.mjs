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
// • message_ts derives from the message-id snowflake — no extra fetch.
// • Retry on 5xx AND outcome=unaddressed, capped ~10 min (lib.backoffDelaysMs)
//   — a reaction can land seconds before its capture is recorded.
// • Reconnect on close is a fresh IDENTIFY (no RESUME — deliberate
//   simplification; reactions during a gap are lost and observable as absent
//   rows, sparse by nature).
// • The bot's own reactions are ignored (parity with the gateway's handler).
//
// Env (systemd unit wires these):
//   DISCORD_BOT_TOKEN   — required (shared EnvironmentFile with the gateway)
//   UM_SERVER_URL       — default http://127.0.0.1:6337
//   UM_TOKEN_FILE       — default ~/.um/auth-token
//   UM_RUN_ID_TEMPLATE  — default agent:main:discord:channel:{channelId}
//   UM_REACTION_DEBOUNCE_MS — default 2000 (trailing debounce per message)

import { readFileSync } from 'node:fs';
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
  if (!res.ok) throw new Error(`discord GET ${pathname} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// UM delivery with capped retry (5xx + unaddressed per the contract)
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
  if (res.status >= 500) {
    return retryOrGiveUp(body, attempt, `http ${res.status}`);
  }
  let parsed = {};
  try { parsed = await res.json(); } catch { /* non-JSON error body */ }
  if (res.status === 400) {
    log(`drop message=${body.message_id} 400: ${parsed?.error?.message ?? 'invalid'}`);
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
  setTimeout(() => { postReaction(body, attempt + 1).catch(() => {}); }, delays[attempt]).unref?.();
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
  timer.unref?.();
  pending.set(messageId, { channelId, timer });
}

async function deliver(channelId, messageId) {
  let message = null;
  try {
    message = await discordGet(`/channels/${channelId}/messages/${messageId}`);
  } catch (err) {
    // Deleted message / lost access: nothing to count — skip quietly.
    log(`skip message=${messageId}: ${err?.message}`);
    return;
  }
  await postReaction({
    run_id: buildRunId(RUN_ID_TEMPLATE, channelId),
    message_id: messageId,
    message_ts: snowflakeToIso(messageId),
    reaction_count: absoluteCount(message),
    reaction_types: reactionTypes(message),
  });
}

// ---------------------------------------------------------------------------
// Gateway client (native WebSocket, fresh-IDENTIFY reconnect)
// ---------------------------------------------------------------------------

let botUserId = null;
let ws = null;
let heartbeatTimer = null;
let lastSeq = null;
let reconnectDelay = 5_000;

async function connect() {
  const { url } = await discordGet('/gateway/bot');
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
          try { ws.send(JSON.stringify({ op: 1, d: lastSeq })); } catch { /* closing */ }
        }, interval);
        heartbeatTimer.unref?.();
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
    log(`gateway closed code=${ev.code}; reconnecting in ${reconnectDelay}ms`);
    setTimeout(() => {
      connect().catch((err) => log(`reconnect failed: ${err?.message}`));
    }, reconnectDelay).unref?.();
    reconnectDelay = Math.min(reconnectDelay * 2, 300_000);
  });

  ws.addEventListener('error', () => { /* close follows; handled there */ });
}

log(`starting: um=${UM_URL} template=${RUN_ID_TEMPLATE} debounce=${DEBOUNCE_MS}ms`);
connect().catch((err) => {
  console.error(`reaction-producer: initial connect failed: ${err?.message}`);
  process.exit(1);
});
