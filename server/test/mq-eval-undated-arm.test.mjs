// server/test/mq-eval-undated-arm.test.mjs — the isolated undated-arm fixture and its
// entry point.
//
// ISOLATION IS THE POINT. memory-quality-eval is the repo's nightly drift gate
// (.github/workflows/nightly.yml runs the same runOnce --gate mq-gate-thresholds.json),
// and that gate's floors were pinned from two live runs under a comment reading "never
// weaken to make CI green; re-pin only with a committed 2-run re-measurement". So this arm
// gets its OWN fixture and its OWN entry point, and the default corpus must not move by a
// single row. The last two tests here are that guarantee.
//
// THE ARM SIZE IS PINNED IN ADVANCE, in code (UNDATED_ARM), because a subset size chosen
// after seeing results is a choice about the result.
//
// AGES, NOT DATES. The fixture stores `days_ago` per seed fact and derives `valid_from` at
// seed time. A hardcoded absolute date drifts one day older every day, which would silently
// change the decay factors this fixture exists to hold fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  loadFixtureJsonl,
  materialiseValidFrom,
  UNDATED_ARM,
} from '../eval/memory-quality-eval.mjs';
import { isUsableDate } from '../lib/ranking.mjs';
// The repo's own nearest-rank percentile: the fixture's spread assertions and the eval's
// reported percentiles must use ONE definition, or the fixture can satisfy a spread the
// eval would never report.
import { percentile } from '../eval/lib/stats.mjs';

// fileURLToPath, NOT `new URL(...).pathname` — on POSIX, pathname is already absolute and
// stripping its leading slash yields a RELATIVE path that resolves against cwd. That fails
// only on Linux, i.e. only in CI, which is the one place these ISOLATION assertions matter.
const evalPath = (rel) => fileURLToPath(new URL(`../eval/${rel}`, import.meta.url));
// Derived from the exported constant, so a rename of the fixture cannot leave the entry
// point pointing at a file that no longer exists while the tests stay green.
const FIXTURE = evalPath(UNDATED_ARM.fixture.replace(/^eval\//, ''));
const RECALL = evalPath('recall-set.jsonl');
const NOW = Date.parse('2026-08-06T00:00:00.000Z');

const load = (p) => loadFixtureJsonl(p);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// --- entry point -----------------------------------------------------------

test('parseArgs: --undated-arm sets the flag', () => {
  assert.equal(parseArgs(['node', 'x', '--undated-arm']).undatedArm, true);
});

test('parseArgs: absent --undated-arm leaves the flag falsy (default runs unaffected)', () => {
  assert.ok(!parseArgs(['node', 'x']).undatedArm);
  assert.ok(!parseArgs(['node', 'x', '--recall', 'a.jsonl', '--gate', 'g.json']).undatedArm);
});

test('parseArgs: --undated-arm consumes no value and does not disturb its neighbours', () => {
  // It is a boolean flag: if it ever swallowed the next argv entry, the following
  // option would silently go missing — the kind of break a smoke run would not show.
  const a = parseArgs(['node', 'x', '--undated-arm', '--recall', 'r.jsonl', '--out', 'o.json']);
  assert.equal(a.undatedArm, true);
  assert.equal(a.recall, 'r.jsonl');
  assert.equal(a.out, 'o.json');
});

// --- the pinned arm size ---------------------------------------------------

test('UNDATED_ARM: the pinned sizes are internally consistent and frozen', () => {
  assert.equal(UNDATED_ARM.undatedGold + UNDATED_ARM.dated, UNDATED_ARM.rows);
  assert.ok(Object.isFrozen(UNDATED_ARM));
});

test('fixture: matches the PINNED arm size exactly', async () => {
  const rows = await load(FIXTURE);
  assert.equal(rows.length, UNDATED_ARM.rows);
  assert.equal(rows.filter((r) => r.undated_gold === true).length, UNDATED_ARM.undatedGold);
  assert.equal(rows.filter((r) => r.undated_gold === false).length, UNDATED_ARM.dated);
});

test('fixture: every row declares undated_gold explicitly as a boolean', async () => {
  // An absent marker would silently fall into the dated cohort and shrink the arm.
  for (const r of await load(FIXTURE)) {
    assert.equal(typeof r.undated_gold, 'boolean', `${r.id} has a non-boolean undated_gold`);
  }
});

// --- fixture integrity -----------------------------------------------------

test('fixture: ids, queries and fact texts are all unique', async () => {
  const rows = await load(FIXTURE);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'duplicate row id');
  assert.equal(new Set(rows.map((r) => r.query)).size, rows.length, 'duplicate query');
  const texts = rows.flatMap((r) => r.seed_facts.map((f) => f.text));
  assert.equal(new Set(texts).size, texts.length, 'duplicate fact text — dedup would merge the seeds');
});

test('fixture: every target_ref resolves to one of its own row\'s seed facts', async () => {
  for (const r of await load(FIXTURE)) {
    const [rowId, idx] = r.target_ref.split(':');
    assert.equal(rowId, r.id, `${r.target_ref} points at another row`);
    assert.ok(r.seed_facts[Number(idx)], `${r.target_ref} indexes a non-existent seed fact`);
  }
});

test('fixture: rows carry the same schema fields the default recall corpus uses', async () => {
  const lanes = new Set((await load(RECALL)).flatMap((r) => r.seed_facts.map((f) => f.lane)));
  for (const r of await load(FIXTURE)) {
    assert.ok(r.query && r.category && r.paraphrase_level, `${r.id} is missing a schema field`);
    for (const f of r.seed_facts) {
      assert.ok(f.text && f.lane, `${r.id} has an incomplete seed fact`);
      assert.ok(lanes.has(f.lane), `${r.id} uses lane '${f.lane}' which the default corpus never uses`);
    }
  }
});

// --- ages, not dates -------------------------------------------------------

test('fixture: stores days_ago and NOT a hardcoded valid_from', async () => {
  // A committed absolute date drifts a day older every day, silently changing the decay
  // factors. Ages are the only representation that stays true for the fixture's lifetime.
  for (const r of await load(FIXTURE)) {
    for (const f of r.seed_facts) {
      assert.equal(typeof f.days_ago, 'number', `${r.id} seed fact has no numeric days_ago`);
      assert.ok(f.days_ago >= 0, `${r.id} has a negative age — a future date defeats the intended aging (factor clamps to 1, #238)`);
      assert.equal(f.valid_from, undefined, `${r.id} hardcodes a valid_from; it must be derived from days_ago`);
    }
  }
});

test('fixture: the DATED cohort mirrors the measured live age spread', async () => {
  // The live corpus measured median ~6d, p90 ~13d, max ~19d. The dated cohort is the one
  // that matters: it is what the undated points are ranked against.
  const ages = (await load(FIXTURE)).filter((r) => !r.undated_gold).flatMap((r) => r.seed_facts.map((f) => f.days_ago));
  assert.equal(ages.length, UNDATED_ARM.dated);
  assert.equal(median(ages), 6);
  assert.equal(percentile(ages, 0.90), 13);
  assert.equal(Math.max(...ages), 19);
  assert.equal(Math.min(...ages), 1);
});

test('fixture: UNDATED_ARM.fixture actually resolves to a readable file', async () => {
  // The path string the entry point will consume — nothing else checks it.
  const rows = await load(FIXTURE);
  assert.equal(rows.length, UNDATED_ARM.rows);
});

test('fixture: ages are spread, not clustered at one value', async () => {
  // A single-valued spread would satisfy a median assertion while giving every dated
  // point an identical factor — decay would become an ordering no-op within the cohort.
  const ages = (await load(FIXTURE)).flatMap((r) => r.seed_facts.map((f) => f.days_ago));
  assert.ok(new Set(ages).size >= 10, `only ${new Set(ages).size} distinct ages — too clustered to discriminate`);
});

// --- materialiseValidFrom --------------------------------------------------

test('materialiseValidFrom: derives a valid_from the WRITE PATH will keep', async () => {
  const rows = materialiseValidFrom(await load(FIXTURE), NOW);
  for (const r of rows) {
    for (const f of r.seed_facts) {
      assert.ok(isUsableDate(f.valid_from), `${r.id} produced a valid_from the read path rejects`);
    }
  }
});

test('materialiseValidFrom: the derived date is exactly days_ago before now', async () => {
  for (const r of materialiseValidFrom(await load(FIXTURE), NOW)) {
    for (const f of r.seed_facts) {
      assert.equal(NOW - Date.parse(f.valid_from), f.days_ago * 86400000, `${r.id} age mismatch`);
    }
  }
});

test('materialiseValidFrom: is pure — the input rows are not mutated', async () => {
  const rows = await load(FIXTURE);
  const before = JSON.stringify(rows);
  materialiseValidFrom(rows, NOW);
  assert.equal(JSON.stringify(rows), before, 'input was mutated');
});

test('materialiseValidFrom: passes through seed facts that carry no days_ago', () => {
  const out = materialiseValidFrom([{ id: 'r1', seed_facts: [{ text: 't', lane: 'work' }] }], NOW);
  assert.equal(out[0].seed_facts[0].valid_from, undefined);
  assert.deepEqual(out[0].seed_facts[0], { text: 't', lane: 'work' });
});

test('materialiseValidFrom: preserves the undated_gold marker and every other row field', async () => {
  const src = await load(FIXTURE);
  const out = materialiseValidFrom(src, NOW);
  assert.equal(out.length, src.length);
  for (let i = 0; i < src.length; i++) {
    assert.equal(out[i].undated_gold, src[i].undated_gold);
    assert.equal(out[i].target_ref, src[i].target_ref);
    assert.equal(out[i].query, src[i].query);
  }
});

// --- ISOLATION: the nightly drift gate must not move -----------------------

test('ISOLATION: the default recall corpus still has exactly 66 rows', async () => {
  assert.equal((await load(RECALL)).length, 66);
});

test('ISOLATION: no default-corpus row carries undated_gold, days_ago or valid_from', async () => {
  // If the arm's fields ever leak into the shared corpus, the nightly gate's own numbers
  // move and its pinned floors become meaningless.
  for (const r of await load(RECALL)) {
    assert.equal(r.undated_gold, undefined, `${r.id} leaked undated_gold into the default corpus`);
    for (const f of r.seed_facts) {
      assert.equal(f.days_ago, undefined, `${r.id} leaked days_ago into the default corpus`);
      assert.equal(f.valid_from, undefined, `${r.id} leaked valid_from into the default corpus`);
    }
  }
});

test('ISOLATION: the two fixtures share no row id and no fact text', async () => {
  const [arm, recall] = [await load(FIXTURE), await load(RECALL)];
  const recallIds = new Set(recall.map((r) => r.id));
  const recallTexts = new Set(recall.flatMap((r) => r.seed_facts.map((f) => f.text)));
  for (const r of arm) {
    assert.ok(!recallIds.has(r.id), `${r.id} collides with a default-corpus row id`);
    for (const f of r.seed_facts) assert.ok(!recallTexts.has(f.text), `${r.id} duplicates a default-corpus fact`);
  }
});
