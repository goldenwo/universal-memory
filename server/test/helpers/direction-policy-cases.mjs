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
    ["live pair, registration form (today's stored fields): the decision-date field is NOT read -> incoming-newer", (resolve) => {
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
