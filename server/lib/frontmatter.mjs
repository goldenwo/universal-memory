/**
 * frontmatter.mjs — parse and serialize markdown documents with YAML front matter.
 *
 * parseFrontmatter(text)         → { frontmatter, body }
 * serializeFrontmatter(fm, body) → text
 *
 * Contracts:
 *  - No frontmatter present  → { frontmatter: {}, body: text }
 *  - Malformed YAML between delimiters → { frontmatter: {}, body: text }
 *    (original text preserved, error logged to stderr)
 *  - Round-trip: serialize(parse(x).frontmatter, parse(x).body) ≅ x
 *    (modulo YAML key ordering and whitespace normalization)
 */

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

/** Matches `---\n<yaml>\n---\n?<body>` including CRLF line endings. */
const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a markdown document that may begin with YAML front matter.
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
    const fm = yamlParse(match[1]) || {};
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
 * @param {object|null} fm   - Frontmatter key/value pairs.
 * @param {string}      body - Markdown body text.
 * @returns {string}
 */
export function serializeFrontmatter(fm, body) {
  if (!fm || Object.keys(fm).length === 0) {
    return body;
  }
  const yamlBlock = yamlStringify(fm).trimEnd();
  // body already starts with a newline (the blank line after ---) when parsed
  // by parseFrontmatter, so we do NOT add an extra \n here.
  return `---\n${yamlBlock}\n---\n${body}`;
}
