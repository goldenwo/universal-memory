/**
 * server/lib/escape-html.mjs — the one shared HTML-entity escaper.
 *
 * Owns:
 *   - esc(s): HTML-entity-escapes `& < > " '` (ampersand FIRST — see below).
 *     Moved verbatim out of server/lib/oauth/consent.mjs:106-113 (Stage B task
 *     U1); behavior is byte-identical to the pre-extraction implementation
 *     (pinned by server/test/consent-snapshot.test.mjs).
 *   - stripBidiControls(s): strips C0/C1 control characters and the Unicode
 *     bidi override (U+202A-202E) / isolate (U+2066-2069) ranges. A SEPARATE
 *     export from esc() — escaping entities does nothing to characters that
 *     reorder or hide rendered text (Trojan Source-style attacks), so a
 *     caller that needs that protection must call this explicitly, typically
 *     before esc() (see composition note below).
 *
 * SINK ALLOWLIST (R1 S-I1) — esc() output is safe to interpolate ONLY into:
 *   - element text content (e.g. `<div>${esc(x)}</div>`), and
 *   - a FULLY DOUBLE-QUOTED attribute value (e.g. `<input value="${esc(x)}">`).
 *
 * esc() is INERT-OR-CORRUPTING (do not use it as the only defense) in any
 * other sink:
 *   - inside `<style>` or a `style=` attribute (CSS context has its own
 *     escaping/quoting rules; HTML entities do not neutralize CSS payloads);
 *   - in URL position, e.g. `href="${esc(x)}"` — a `javascript:` URL survives
 *     entity-escaping unchanged and still executes;
 *   - in an UNQUOTED attribute value — entity-escaping does not stop
 *     attribute-breakout via unescaped whitespace or `>`;
 *   - inside `<script>` (or any JS string/JSON literal) — HTML entities are
 *     not JS-string escapes and do nothing to `</script>`-style breakout or
 *     quote/backslash injection.
 *
 * Composition: for untrusted text that also needs bidi/control-char
 * neutralization (e.g. a client-supplied display name), call
 * `esc(stripBidiControls(x))` — strip first, then escape, since escaping does
 * not touch the characters stripBidiControls targets.
 *
 * Callers (>=2 required by task U1 — consent page now, control page later):
 *   - server/lib/oauth/consent.mjs (repointed here; no local esc() anymore).
 *   - server/lib/control/* (Stage B control-page work; not yet added).
 *
 * Zero dependencies; ESM `.mjs`; Node built-in `node:test` covers this file
 * (server/test/escape-html.test.mjs).
 */

// HTML-entity escape for text destined for element content or a fully
// double-quoted attribute value. & FIRST — escaping it after the other
// replacements would re-escape the `&` those replacements introduce (e.g.
// `<` -> `&lt;` would become `&amp;lt;` if `&` were handled last).
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Code-point ranges to strip, expressed as [start, end] hex pairs rather than
// literal escape sequences in the regex source — control/bidi characters are
// invisible and easy to mis-transcribe by hand, so the ranges are built
// programmatically and named here for auditability:
//   - C0 controls (0x00-0x1F) MINUS common whitespace TAB(0x09)/LF(0x0A)/CR(0x0D)
//   - DEL (0x7F)
//   - C1 controls (0x80-0x9F)
//   - bidi override: LRE/RLE/PDF/LRO/RLO (0x202A-0x202E)
//   - bidi isolate: LRI/RLI/FSI/PDI (0x2066-0x2069)
const STRIP_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x80, 0x9f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

const BIDI_AND_CONTROL_RE = new RegExp(
  `[${STRIP_RANGES.map(([lo, hi]) => `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`).join('')}]`,
  'gu',
);

export function stripBidiControls(s) {
  return String(s ?? '').replace(BIDI_AND_CONTROL_RE, '');
}
