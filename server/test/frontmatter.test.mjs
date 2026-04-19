/**
 * Tests for server/lib/frontmatter.mjs
 *
 * Run with: node --test server/test/frontmatter.test.mjs
 *
 * Malformed-YAML choice: when the --- block contains invalid YAML, we return
 * { frontmatter: {}, body: <full original text> }. The original text is
 * preserved so the caller can still store / display the document.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';

// ---------------------------------------------------------------------------
// 1. Happy round-trip
// ---------------------------------------------------------------------------
test('round-trip: parse then serialize produces equivalent document', () => {
  const original = `---
title: My Note
tags:
  - alpha
  - beta
created: 2026-04-17T00:00:00.000Z
---

# My Note

Body text here.
`;

  const { frontmatter, body } = parseFrontmatter(original);

  assert.equal(frontmatter.title, 'My Note');
  assert.deepEqual(frontmatter.tags, ['alpha', 'beta']);
  // ISO date comes back as a JS Date; check the year
  assert.ok(
    frontmatter.created instanceof Date || typeof frontmatter.created === 'string',
    'created should parse to a Date or string'
  );

  const serialized = serializeFrontmatter(frontmatter, body);

  // Re-parse the serialized form and verify fields survive
  const reparsed = parseFrontmatter(serialized);
  assert.equal(reparsed.frontmatter.title, 'My Note');
  assert.deepEqual(reparsed.frontmatter.tags, ['alpha', 'beta']);
  assert.equal(reparsed.body, body);
});

// ---------------------------------------------------------------------------
// 2. No frontmatter — pure markdown
// ---------------------------------------------------------------------------
test('no frontmatter: entire text is returned as body, frontmatter is {}', () => {
  const input = '# Just Markdown\n\nNo YAML here.\n';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.deepEqual(frontmatter, {});
  assert.equal(body, input);
});

// ---------------------------------------------------------------------------
// 3. Malformed YAML — graceful fallback
// ---------------------------------------------------------------------------
test('malformed YAML: returns empty frontmatter and original text as body', () => {
  // Unclosed bracket → definitely invalid YAML
  const input = '---\nkey: [unclosed bracket\n---\n\nSome body.\n';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.deepEqual(frontmatter, {});
  assert.equal(body, input);
});

// ---------------------------------------------------------------------------
// 4. Frontmatter only, no body
// ---------------------------------------------------------------------------
test('frontmatter only: no body text after closing ---', () => {
  const input = '---\nkey: value\n---';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.equal(frontmatter.key, 'value');
  assert.equal(body, '');
});

// ---------------------------------------------------------------------------
// 5. Nested values — arrays, objects, ISO dates
// ---------------------------------------------------------------------------
test('nested values: arrays, nested objects, ISO-8601 strings parse correctly', () => {
  const input = `---
title: Complex
metadata:
  author: Alice
  version: 3
items:
  - id: 1
    label: first
  - id: 2
    label: second
updated: 2026-01-15T12:00:00.000Z
---

Body.
`;

  const { frontmatter, body } = parseFrontmatter(input);

  assert.equal(frontmatter.title, 'Complex');
  assert.equal(frontmatter.metadata.author, 'Alice');
  assert.equal(frontmatter.metadata.version, 3);
  assert.equal(frontmatter.items.length, 2);
  assert.equal(frontmatter.items[0].label, 'first');
  assert.equal(frontmatter.items[1].id, 2);
  assert.ok(
    frontmatter.updated instanceof Date || typeof frontmatter.updated === 'string',
    'updated should be a Date or string'
  );
  assert.equal(body, '\nBody.\n');
});

// ---------------------------------------------------------------------------
// 6. serialize: empty frontmatter returns body as-is
// ---------------------------------------------------------------------------
test('serializeFrontmatter: empty frontmatter returns body unchanged', () => {
  const body = '# Plain doc\n\nNo metadata.\n';
  const result = serializeFrontmatter({}, body);
  assert.equal(result, body);
});

// ---------------------------------------------------------------------------
// 7. serialize: null frontmatter also returns body as-is
// ---------------------------------------------------------------------------
test('serializeFrontmatter: null frontmatter returns body unchanged', () => {
  const body = 'Just text.\n';
  const result = serializeFrontmatter(null, body);
  assert.equal(result, body);
});

// ---------------------------------------------------------------------------
// 8. Non-map YAML root: scalar
// ---------------------------------------------------------------------------
test('non-map YAML root (scalar): falls back to empty frontmatter, full text as body', () => {
  const input = '---\nhello\n---\nbody';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.deepEqual(frontmatter, {});
  assert.equal(body, input);
});

// ---------------------------------------------------------------------------
// 9. Non-map YAML root: array
// ---------------------------------------------------------------------------
test('non-map YAML root (array): falls back to empty frontmatter, full text as body', () => {
  const input = '---\n- a\n- b\n---\nbody';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.deepEqual(frontmatter, {});
  assert.equal(body, input);
});

// ---------------------------------------------------------------------------
// 10. Closing delimiter with trailing whitespace
// ---------------------------------------------------------------------------
test('trailing whitespace on closing delimiter: parses correctly, no corrupt leading whitespace in body', () => {
  const input = '---\ntitle: hi\n--- \nbody';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.equal(frontmatter.title, 'hi');
  assert.equal(body, 'body');
});

// ---------------------------------------------------------------------------
// 11. Body containing horizontal rule (---)
// ---------------------------------------------------------------------------
test('body containing horizontal rule: frontmatter and full body preserved', () => {
  const input = '---\ntitle: Post\n---\n\n# Heading\n\n---\n\nBelow the rule.';

  const { frontmatter, body } = parseFrontmatter(input);

  assert.equal(frontmatter.title, 'Post');
  assert.ok(body.includes('---'), 'horizontal rule preserved in body');
  assert.ok(body.includes('Below the rule.'), 'body after horizontal rule preserved');
});
