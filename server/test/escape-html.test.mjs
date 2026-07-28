// server/test/escape-html.test.mjs — the shared HTML escaper (Stage B task U1).
//
// esc() moved verbatim out of server/lib/oauth/consent.mjs:106-113 (entity
// order `& < > " '`, ampersand FIRST, is load-bearing: escaping `&` after the
// other entities would double-escape the `&` those replacements introduce).
// stripBidiControls() is a separate export (R1 S-N4) — escaping alone does
// nothing to reordering/invisible control characters, so callers that need
// that protection must call it explicitly before esc().
//
// Control/bidi test characters are built with String.fromCodePoint rather
// than typed as literal invisible characters in this file's source — the
// whole point of these characters is that they render as nothing (or
// reorder surrounding text), which makes a literal copy unreviewable in a
// diff and easy to silently corrupt in an editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, stripBidiControls } from '../lib/escape-html.mjs';

// ---- esc(): the five HTML entities ----------------------------------------

test('esc: escapes all five entities', () => {
  assert.equal(esc('&'), '&amp;');
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('>'), '&gt;');
  assert.equal(esc('"'), '&quot;');
  assert.equal(esc("'"), '&#39;');
});

test('esc: ampersand-ordering — does not double-escape entities it introduces', () => {
  // If `&` were escaped last (or the replace order otherwise wrong), the `&`
  // introduced by escaping `<` etc. would itself get re-escaped into `&amp;lt;`.
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('&lt;'), '&amp;lt;'); // literal input "&lt;" — & escaped once, lt untouched
  assert.equal(esc('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});

test('esc: leaves ordinary text untouched', () => {
  assert.equal(esc('Acme MCP'), 'Acme MCP');
  assert.equal(esc(''), '');
});

test('esc: coerces null/undefined to empty string, numbers to string form', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('esc: escapes a mixed XSS-shaped payload fully', () => {
  const html = esc(`<script>alert("x")</script>`);
  assert.ok(!html.includes('<script>'));
  assert.equal(html, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('esc: repeated entities all get escaped (global replace, not just first match)', () => {
  assert.equal(esc('&&&'), '&amp;&amp;&amp;');
  assert.equal(esc('<<>>'), '&lt;&lt;&gt;&gt;');
});

// ---- stripBidiControls(): C0/C1 + bidi override/isolate ranges ------------

test('stripBidiControls: strips C0 control characters (except common whitespace)', () => {
  const c0 = String.fromCodePoint(0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f);
  assert.equal(stripBidiControls(`a${c0}b`), 'ab');
});

test('stripBidiControls: strips DEL and C1 control characters (U+007F, U+0080-U+009F)', () => {
  const del = String.fromCodePoint(0x7f);
  const c1 = String.fromCodePoint(0x80, 0x9f);
  assert.equal(stripBidiControls(`a${del}${c1}b`), 'ab');
});

test('stripBidiControls: strips bidi override characters U+202A-U+202E', () => {
  // LRE, RLE, PDF, LRO, RLO
  const overrides = String.fromCodePoint(0x202a, 0x202b, 0x202c, 0x202d, 0x202e);
  assert.equal(stripBidiControls(`a${overrides}b`), 'ab');
});

test('stripBidiControls: strips bidi isolate characters U+2066-U+2069', () => {
  // LRI, RLI, FSI, PDI
  const isolates = String.fromCodePoint(0x2066, 0x2067, 0x2068, 0x2069);
  assert.equal(stripBidiControls(`a${isolates}b`), 'ab');
});

test('stripBidiControls: a Trojan-Source-style RLO/PDI payload is neutralized', () => {
  const rlo = String.fromCodePoint(0x202e); // RLO
  const pdi = String.fromCodePoint(0x2069); // PDI
  const payload = `safe${rlo}evil${pdi}tail`;
  assert.equal(stripBidiControls(payload), 'safeeviltail');
});

test('stripBidiControls: preserves ordinary whitespace (tab, newline, CR, space)', () => {
  assert.equal(stripBidiControls('a\tb\nc\rd e'), 'a\tb\nc\rd e');
});

test('stripBidiControls: leaves ordinary printable text (incl. non-ASCII) untouched', () => {
  assert.equal(stripBidiControls('Café — 日本語'), 'Café — 日本語');
});

test('stripBidiControls: coerces null/undefined to empty string', () => {
  assert.equal(stripBidiControls(null), '');
  assert.equal(stripBidiControls(undefined), '');
});

// ---- composition: control page composes stripBidiControls then esc -------

test('composition: stripBidiControls then esc removes both control chars and entity risk', () => {
  const rlo = String.fromCodePoint(0x202e);
  const pdi = String.fromCodePoint(0x2069);
  const raw = `<script>${rlo}alert(1)${pdi}</script>`;
  const composed = esc(stripBidiControls(raw));
  assert.ok(!composed.includes('<script>'));
  assert.ok(!composed.includes(rlo));
  assert.ok(!composed.includes(pdi));
  assert.equal(composed, '&lt;script&gt;alert(1)&lt;/script&gt;');
});
