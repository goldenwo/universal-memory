// server/test/helpers/direction-policy-cases.mjs — the #276 supersession-direction case table.
//
// Same contract as clamp-policy-cases.mjs: the SAME table is run by
// supersession-direction.test.mjs in the real suite AND by a red-control runner
// against deliberately-broken copies of lib/supersede.mjs, so a control can never
// drift from the suite it certifies. `runCase(id, resolve, mod)` — `resolve` is
// resolveSupersessionDirection, `mod` the module it came from.
//
// The rule under pin (spec 2026-09-10-276 §4.1; on any disagreement §4.1 wins):
//   truthTime(stored)   := usable(stored.valid_from)   ? epoch(stored.valid_from)   : null
//   truthTime(incoming) := usable(incoming.valid_from) ? epoch(incoming.valid_from) : epoch(assertedAt)
//   now                 := caller-passed; defaults to assertedAt when omitted or unusable
//   assertedAt unusable                              -> 'ambiguous'
//   truthTime(stored) === null                       -> 'ambiguous'
//   truthTime(stored) > epoch(now) + CLOCK_SKEW_TOLERANCE_MS -> 'stored-future'
//   truthTime(incoming) > epoch(now) + CLOCK_SKEW_TOLERANCE_MS -> 'incoming-future'   (#318)
//   incoming > stored -> 'incoming-newer' ; incoming < stored -> 'stored-newer' ; equal -> 'ambiguous'
// The registration timestamp is never consulted; the ADR decision-date field is never
// consulted. A missing stored truth time ABSTAINS — it never falls through to arrival order.
import assert from 'node:assert/strict';
import { CLOCK_SKEW_TOLERANCE_MS } from '../../lib/ranking.mjs';

const KEYS = ['direction', 'incomingAt', 'storedAt'];
const iso = (ms) => new Date(ms).toISOString();

// Every row asserts the return shape: exactly {direction, incomingAt, storedAt}.
function expect(resolve, args, direction, extra = {}) {
  const r = resolve(args);
  assert.ok(r && typeof r === 'object', 'returns an object');
  assert.deepEqual(Object.keys(r).sort(), KEYS.slice().sort(), 'exactly the keys direction/incomingAt/storedAt');
  assert.equal(r.direction, direction);
  for (const [k, v] of Object.entries(extra)) assert.equal(r[k], v, `${k}`);
  return r;
}

// The live pair (issue #276).
const KUZU_STORED_DECIDED = '2026-08-18';                 // ADR-0008 decided
const KUZU_INCOMING_DECIDED = '2026-04-16';               // ADR-0004 decided
const KUZU_STORED_REGISTERED = '2026-08-18T02:09:45.533Z';
const KUZU_INCOMING_REGISTERED = '2026-08-18T02:09:47.029Z';

const T0 = '2026-06-01T00:00:00.000Z';
const T0_MS = Date.parse(T0);
const PAST = '2026-01-01T00:00:00.000Z';
const LATER = '2026-09-01T00:00:00.000Z';

export const CASES = {
  K1: [
    ['live pair, truth-time form: the retired fact (stored) is newer than the arriving older one -> stored-newer', (resolve) => {
      expect(resolve, {
        stored: { valid_from: KUZU_STORED_DECIDED },
        incoming: { valid_from: KUZU_INCOMING_DECIDED, assertedAt: KUZU_INCOMING_REGISTERED },
      }, 'stored-newer', { incomingAt: '2026-04-16T00:00:00.000Z', storedAt: '2026-08-18T00:00:00.000Z' });
    }],
  ],

  K2: [
    // The registration instants are the issue's 2026-08-19 reading (ADR-0004 1.496 s later);
    // the 2026-09-15 census found both points re-registered on 08-24 in the other order. The
    // row pins the MECHANISM — the decision-date field is not read — not today's live values.
    ['live pair, registration form (the 2026-08-19 reading): the decision-date field is NOT read -> incoming-newer', (resolve) => {
      expect(resolve, {
        stored: { valid_from: KUZU_STORED_REGISTERED, decided_at: KUZU_STORED_DECIDED },
        incoming: { valid_from: KUZU_INCOMING_REGISTERED, decided_at: KUZU_INCOMING_DECIDED, assertedAt: KUZU_INCOMING_REGISTERED },
      }, 'incoming-newer', { incomingAt: KUZU_INCOMING_REGISTERED, storedAt: KUZU_STORED_REGISTERED });
    }],
  ],

  D1: [
    ['incoming later -> incoming-newer', (resolve) => {
      expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: LATER, assertedAt: LATER } }, 'incoming-newer',
        { incomingAt: LATER, storedAt: PAST });
    }],
    ['incoming earlier -> stored-newer', (resolve) => {
      expect(resolve, { stored: { valid_from: LATER }, incoming: { valid_from: PAST, assertedAt: LATER } }, 'stored-newer',
        { incomingAt: PAST, storedAt: LATER });
    }],
    ['equal instants -> ambiguous', (resolve) => {
      expect(resolve, { stored: { valid_from: T0 }, incoming: { valid_from: T0, assertedAt: T0 } }, 'ambiguous',
        { incomingAt: T0, storedAt: T0 });
    }],
  ],

  D2: [
    ['stored without valid_from -> ambiguous, storedAt null', (resolve) => {
      expect(resolve, { stored: {}, incoming: { valid_from: PAST, assertedAt: T0 } }, 'ambiguous', { storedAt: null });
    }],
  ],

  D3: [
    ['stored carrying only the decision-date field -> ambiguous (not read)', (resolve) => {
      expect(resolve, { stored: { decided_at: PAST }, incoming: { valid_from: LATER, assertedAt: LATER } }, 'ambiguous', { storedAt: null });
    }],
  ],

  D4: [
    ['incoming carrying the decision-date field and no valid_from -> incomingAt is the re-serialised assertedAt', (resolve) => {
      expect(resolve, { stored: { valid_from: PAST }, incoming: { decided_at: '2020-01-01', assertedAt: T0 } }, 'incoming-newer',
        { incomingAt: T0, storedAt: PAST });
    }],
  ],

  D5: [
    ['unusable stored values each -> ambiguous', (resolve) => {
      for (const v of ['', null, 'not a date', 12345]) {
        expect(resolve, { stored: { valid_from: v }, incoming: { valid_from: PAST, assertedAt: T0 } }, 'ambiguous', { storedAt: null });
      }
    }],
    ['unusable incoming values each -> falls back to assertedAt', (resolve) => {
      for (const v of ['', null, 'not a date', 12345]) {
        expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: v, assertedAt: T0 } }, 'incoming-newer', { incomingAt: T0 });
      }
    }],
  ],

  D6: [
    ['assertedAt missing -> ambiguous', (resolve) => {
      expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: LATER } }, 'ambiguous');
    }],
    ['assertedAt unusable -> ambiguous', (resolve) => {
      for (const v of ['', null, 'not a date', 12345]) {
        expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: LATER, assertedAt: v } }, 'ambiguous');
      }
    }],
  ],

  D7: [
    ['missing or non-object arguments -> ambiguous', (resolve) => {
      expect(resolve, undefined, 'ambiguous');
      expect(resolve, null, 'ambiguous');
      expect(resolve, 'x', 'ambiguous');
      expect(resolve, {}, 'ambiguous');
      expect(resolve, { stored: null, incoming: { valid_from: LATER, assertedAt: LATER } }, 'ambiguous');
      expect(resolve, { stored: 'x', incoming: { valid_from: LATER, assertedAt: LATER } }, 'ambiguous');
      expect(resolve, { stored: { valid_from: PAST }, incoming: null }, 'ambiguous');
      expect(resolve, { stored: { valid_from: PAST }, incoming: 7 }, 'ambiguous');
    }],
  ],

  D8: [
    ['stored exactly now + tolerance -> stored-newer (boundary is inclusive)', (resolve) => {
      const storedMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS;
      expect(resolve, { stored: { valid_from: iso(storedMs) }, incoming: { assertedAt: T0 }, now: T0 }, 'stored-newer',
        { storedAt: iso(storedMs) });
    }],
    ['stored one ms beyond now + tolerance -> stored-future', (resolve) => {
      const storedMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS + 1;
      expect(resolve, { stored: { valid_from: iso(storedMs) }, incoming: { assertedAt: T0 }, now: T0 }, 'stored-future',
        { storedAt: iso(storedMs) });
    }],
    ['stored at the Date maximum -> stored-future', (resolve) => {
      expect(resolve, { stored: { valid_from: iso(8.64e15) }, incoming: { assertedAt: T0 }, now: T0 }, 'stored-future',
        { storedAt: iso(8.64e15) });
    }],
  ],

  D9: [
    ['now omitted -> behaves as assertedAt (a stored instant just past assertedAt + tolerance is future)', (resolve) => {
      const storedMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS + 1;
      expect(resolve, { stored: { valid_from: iso(storedMs) }, incoming: { assertedAt: T0 } }, 'stored-future');
    }],
    ['now later than a PAST assertedAt with stored between them -> stored-newer, not poisoned', (resolve) => {
      const storedMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS + 1;
      expect(resolve, { stored: { valid_from: iso(storedMs) }, incoming: { assertedAt: T0 }, now: LATER }, 'stored-newer');
    }],
    ['unusable now -> falls back to assertedAt', (resolve) => {
      const storedMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS + 1;
      for (const v of ['', null, 'not a date', 12345]) {
        expect(resolve, { stored: { valid_from: iso(storedMs) }, incoming: { assertedAt: T0 }, now: v }, 'stored-future');
      }
    }],
    ['now EARLIER than assertedAt is honoured, not floored: a stored instant past now + tolerance is future', (resolve) => {
      const storedMs = T0_MS - 24 * 60 * 60 * 1000; // a day before assertedAt, long after `now`
      expect(resolve, { stored: { valid_from: iso(storedMs) }, incoming: { assertedAt: T0 }, now: PAST }, 'stored-future');
    }],
  ],

  D11: [
    // #318: the stored side was bounded against the future from the start; the incoming side was
    // not, so one caller-posted far-future valid_from resolved incoming-newer against every dated
    // stored point. Same bound, same skew, same abstain polarity, a distinct label for the operator.
    ['a far-future INCOMING truth time abstains as incoming-future — a caller-settable valid_from beyond now + skew cannot displace a dated stored point', (resolve) => {
      expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: '2099-01-01T00:00:00.000Z', assertedAt: T0 }, now: T0 }, 'incoming-future',
        { incomingAt: '2099-01-01T00:00:00.000Z', storedAt: PAST });
    }],
    ['incoming exactly now + tolerance -> incoming-newer (the boundary is inclusive, as for the stored side)', (resolve) => {
      const incomingMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS;
      expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: iso(incomingMs), assertedAt: T0 }, now: T0 }, 'incoming-newer',
        { incomingAt: iso(incomingMs), storedAt: PAST });
    }],
    ['incoming one ms beyond now + tolerance -> incoming-future; measured against now, not assertedAt (a windowed backfill\'s past bound does not make an ordinary incoming instant future)', (resolve) => {
      const incomingMs = T0_MS + CLOCK_SKEW_TOLERANCE_MS + 1;
      expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: iso(incomingMs), assertedAt: T0 }, now: T0 }, 'incoming-future',
        { incomingAt: iso(incomingMs), storedAt: PAST });
      expect(resolve, { stored: { valid_from: PAST }, incoming: { valid_from: iso(incomingMs), assertedAt: PAST }, now: LATER }, 'incoming-newer',
        { incomingAt: iso(incomingMs), storedAt: PAST });
    }],
    ['both sides future -> stored-future (evaluated first; two caller-chosen future instants are never compared)', (resolve) => {
      expect(resolve, { stored: { valid_from: '2098-01-01T00:00:00.000Z' }, incoming: { valid_from: '2099-01-01T00:00:00.000Z', assertedAt: T0 }, now: T0 }, 'stored-future',
        { incomingAt: '2099-01-01T00:00:00.000Z', storedAt: '2098-01-01T00:00:00.000Z' });
    }],
    ['no incoming valid_from and a now more than the skew EARLIER than assertedAt -> incoming-future (the assertedAt fallback is the incoming truth time; a client until-bound ahead of the wall clock abstains, deliberately)', (resolve) => {
      expect(resolve, { stored: { valid_from: PAST }, incoming: { assertedAt: T0 }, now: PAST }, 'incoming-future',
        { incomingAt: T0, storedAt: PAST });
      // Within the skew it is an ordinary incoming-newer.
      expect(resolve, { stored: { valid_from: PAST }, incoming: { assertedAt: T0 }, now: iso(T0_MS - CLOCK_SKEW_TOLERANCE_MS) }, 'incoming-newer',
        { incomingAt: T0, storedAt: PAST });
    }],
  ],

  D10: [
    ['a usable date with a 300-char parenthesised tail is re-serialised; the tail reaches nothing', (resolve) => {
      const tail = 'A'.repeat(300);
      const raw = 'Thu Jan 01 2026 00:00:00 GMT+0000 (' + tail + ')';
      const r1 = expect(resolve, { stored: { valid_from: raw }, incoming: { valid_from: LATER, assertedAt: LATER } }, 'incoming-newer',
        { storedAt: '2026-01-01T00:00:00.000Z' });
      assert.ok(!JSON.stringify(r1).includes(tail), 'stored tail must not appear in the result');
      const r2 = expect(resolve, { stored: { valid_from: LATER }, incoming: { valid_from: raw, assertedAt: LATER } }, 'stored-newer',
        { incomingAt: '2026-01-01T00:00:00.000Z' });
      assert.ok(!JSON.stringify(r2).includes(tail), 'incoming tail must not appear in the result');
    }],
  ],
};

export function runCase(id, resolve, mod) {
  for (const [label, run] of CASES[id]) {
    try { run(resolve, mod); } catch (error) { return { passed: false, error, label }; }
  }
  return { passed: true };
}
