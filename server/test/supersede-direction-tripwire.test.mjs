// server/test/supersede-direction-tripwire.test.mjs — #276 I1 tripwire.
//
// The supersession-direction rule keys on recorded truth time (`valid_from`) and must never
// consult the registration timestamp or the ADR decision-date field. A value test cannot see
// a future fallback to either (both are present on real points, so a `?? createdAt` fallback
// passes every table row that carries a usable valid_from). This scan is the durable guard:
// the direction module may not contain the bare tokens anywhere — comments included, by
// design. Name the fields descriptively ("the registration timestamp / arrival order", "the
// ADR decision-date field") and never loosen this scan to admit a comment.
//
// The path array is pinned so a module move fails loudly. When the batch detector
// (lib/contradiction-batch.mjs) gains the rule, add it here WITH a presence assertion that it
// calls the resolver — that is the second half of the spec's I1, deferred with the batch path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIRECTION_MODULES = [
  { path: '../lib/supersede.mjs', mustContain: 'export function resolveSupersessionDirection' },
];

const FORBIDDEN = [/\bcreatedAt\b/, /\bdecided_at\b/];

for (const { path, mustContain } of DIRECTION_MODULES) {
  test(`direction tripwire: ${path} names the excluded fields descriptively, never by token`, async () => {
    const src = await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    for (const re of FORBIDDEN) {
      const hit = src.match(re);
      assert.equal(hit, null,
        `${path} contains the bare token ${re} — direction code and its comments name these fields `
        + 'descriptively; rewrite the line, do not loosen this scan to admit a comment');
    }
    assert.ok(src.includes(mustContain), `${path} no longer contains "${mustContain}" — the rule moved; extend DIRECTION_MODULES`);
  });
}
