/**
 * frontmatter.mjs — parse and serialize markdown documents with YAML front matter.
 *
 * parseFrontmatter(text)         → { frontmatter, body }
 * serializeFrontmatter(fm, body) → text
 * validateSource(value)          → void (throws on unregistered source)
 *
 * Contracts:
 *  - No frontmatter present  → { frontmatter: {}, body: text }
 *  - Malformed YAML between delimiters → { frontmatter: {}, body: text }
 *    (original text preserved, error logged to stderr)
 *  - Round-trip: serialize(parse(x).frontmatter, parse(x).body) ≅ x
 *    (modulo YAML key ordering and whitespace normalization)
 *  - serializeFrontmatter injects source:'native' when fm.source is absent (§4.3.1 E2 fix).
 *    Every serialized record's source value must be registered in BRIDGES.md.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

// ---------------------------------------------------------------------------
// Module-init: parse BRIDGES.md and build the set of registered source values.
// Fail loud if the file is missing or has no parseable table rows — an empty
// set would silently allow all sources, which defeats the drift-gate.
// ---------------------------------------------------------------------------

// BRIDGES.md is co-located with the server's other build-time config under
// server/config/ so the Dockerfile's `COPY config/ ./config/` step ships it
// inside the image. Local dev: server/lib/frontmatter.mjs → server/config/BRIDGES.md.
// Container: /app/lib/frontmatter.mjs → /app/config/BRIDGES.md.
const _bridgesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../config/BRIDGES.md');

let _bridgesRaw;
try {
  _bridgesRaw = readFileSync(_bridgesPath, 'utf8');
} catch (err) {
  throw Object.assign(
    new Error(`frontmatter: could not read BRIDGES.md at ${_bridgesPath}: ${err.message}`),
    { code: 'SERVER_INIT_FAILURE' }
  );
}

/** Matches backtick-quoted source values in the table's first column: | `name` | */
const _SOURCE_ROW_RE = /^\|\s*`([a-z0-9-]+)`/gm;

const _registeredSources = new Set();
let _m;
while ((_m = _SOURCE_ROW_RE.exec(_bridgesRaw)) !== null) {
  _registeredSources.add(_m[1]);
}

if (_registeredSources.size === 0) {
  throw Object.assign(
    new Error(`frontmatter: BRIDGES.md at ${_bridgesPath} contains no parseable source rows — at least one is required`),
    { code: 'SERVER_INIT_FAILURE' }
  );
}

// ---------------------------------------------------------------------------
// validateSource — exported for callers and for bridge implementations.
// ---------------------------------------------------------------------------

// validateSource — assert that a `source` discriminator value is registered in
// BRIDGES.md per spec §4.3.1. The discriminator is TOTAL, not nullable: every
// vault record must declare a source so downstream queries can fence by
// provenance (native vs. each upstream bridge). Unknown sources are hard
// failures (INPUT_INVALID) rather than logged warnings — drift here would
// silently corrupt provenance metadata downstream. Called from any frontmatter
// write path (currently `serializeFrontmatter`) and explicitly by D.5+ bridge
// CLIs that need to validate before constructing markdown.

/**
 * Assert that `value` is a registered source in BRIDGES.md.
 * Throws with code 'INPUT_INVALID' if not.
 *
 * Non-string inputs throw with a distinct "expected string" message (code
 * 'INPUT_INVALID') rather than producing misleading "unknown source 'undefined'"
 * errors — consistent with the project's typeof-string guard pattern (§4.2).
 *
 * @param {string} value
 */
export function validateSource(value) {
  if (typeof value !== 'string') {
    throw Object.assign(
      new Error(`validateSource: expected string, got ${typeof value}`),
      { code: 'INPUT_INVALID' }
    );
  }
  if (!_registeredSources.has(value)) {
    throw Object.assign(
      new Error(`unknown source '${value}' — register in BRIDGES.md per §4.3.1`),
      { code: 'INPUT_INVALID' }
    );
  }
}

/** Matches `---\n<yaml>\n---[ \t]*\n?<body>` including CRLF line endings. */
const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/**
 * Parse a markdown document that may begin with YAML front matter.
 *
 * Note: source field is NOT validated on parse — read-permissive by design so
 * legacy/external files load without errors. Use `validateSource()` or rely on
 * `serializeFrontmatter` rejection at write time.
 *
 * @param {string} text - Raw document text.
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(text) {
  const match = FM_REGEX.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text };
  }

  try {
    const fm = yamlParse(match[1]);
    if (fm === null || fm === undefined || typeof fm !== 'object' || Array.isArray(fm)) {
      process.stderr.write(`[frontmatter] YAML root is not a mapping, falling back to empty frontmatter\n`);
      return { frontmatter: {}, body: text };
    }
    return { frontmatter: fm, body: match[2] };
  } catch (err) {
    process.stderr.write(`[frontmatter] malformed YAML, falling back to empty frontmatter: ${err.message}\n`);
    return { frontmatter: {}, body: text };
  }
}

/**
 * Serialize a frontmatter object and body back into a markdown document.
 * If `fm` is null, undefined, or empty, the body is returned as-is.
 *
 * §4.3.1 E2 fix: if `fm.source` is absent, injects `source: 'native'` so that
 * every serialized record carries a registered source discriminator.
 * Throws (INPUT_INVALID) if the resulting source value is not in BRIDGES.md.
 *
 * @param {object|null} fm   - Frontmatter key/value pairs.
 * @param {string}      body - Markdown body text.
 * @returns {string}
 */
export function serializeFrontmatter(fm, body) {
  if (!fm || Object.keys(fm).length === 0) {
    return body;
  }
  // E2 fix: inject 'native' when source is absent.
  if (fm.source == null) {
    fm = { ...fm, source: 'native' };
  }
  // Discriminator validation — throws INPUT_INVALID for unregistered sources.
  validateSource(fm.source);
  const yamlBlock = yamlStringify(fm).trimEnd();
  // body already starts with a newline (the blank line after ---) when parsed
  // by parseFrontmatter, so we do NOT add an extra \n here.
  return `---\n${yamlBlock}\n---\n${body}`;
}
