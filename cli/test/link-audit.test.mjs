import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseNote, buildLinkGraph, densestEgo } from '../lib/link-audit.mjs';
import { renderReport, renderEgoSvg } from '../lib/link-audit-report.mjs';
import { parseArgs, readNotes } from '../memory-audit.mjs';
import { tempDir } from '../../server/test/helpers/tmpdir.mjs';

// ── parseNote ─────────────────────────────────────────────────────────────

test('parseNote keys on the frontmatter name when present', () => {
  const n = parseNote('some_file.md', '---\nname: my-slug\ndescription: x\n---\n\nbody\n');
  assert.equal(n.key, 'my-slug');
});

test('parseNote falls back to the filename stem without frontmatter', () => {
  assert.equal(parseNote('bare_note.md', '# heading\n').key, 'bare_note');
});

test('parseNote extracts wiki-link targets', () => {
  const n = parseNote('a.md', 'text [[target-one]] more [[target_two]] end\n');
  assert.deepEqual(n.links, ['target-one', 'target_two']);
});

test('parseNote strips alias and heading suffixes from link targets', () => {
  const n = parseNote('a.md', '[[target|shown text]] and [[other#section]]\n');
  assert.deepEqual(n.links, ['target', 'other']);
});

test('parseNote deduplicates repeated links to the same target', () => {
  const n = parseNote('a.md', '[[x]] then [[x]] again [[x]]\n');
  assert.deepEqual(n.links, ['x']);
});

test('parseNote returns no links for a note containing none', () => {
  assert.deepEqual(parseNote('a.md', 'plain prose, no brackets\n').links, []);
});

// ── buildLinkGraph ────────────────────────────────────────────────────────

const FILES = [
  { name: 'hub.md', text: '---\nname: hub\n---\n[[spoke-one]] [[spoke-two]]\n' },
  { name: 'spoke_one.md', text: '---\nname: spoke-one\n---\nrefers to [[hub]]\n' },
  { name: 'spoke_two.md', text: '---\nname: spoke-two\n---\nrefers to [[hub]] and [[spoke-one]]\n' },
  { name: 'lonely.md', text: '---\nname: lonely\n---\nno links here\n' },
];

test('buildLinkGraph counts unique undirected edges, not link instances', () => {
  // hub<->spoke-one is asserted from both ends; it is one edge.
  const g = buildLinkGraph(FILES);
  assert.equal(g.stats.nodes, 4);
  assert.equal(g.stats.edges, 3); // hub-spoke1, hub-spoke2, spoke1-spoke2
});

test('buildLinkGraph tracks inbound and outbound separately', () => {
  const g = buildLinkGraph(FILES);
  const hub = g.nodes.find((n) => n.key === 'hub');
  assert.equal(hub.inbound, 2);
  assert.equal(hub.outbound, 2);
});

test('buildLinkGraph ranks nodes by inbound links, descending', () => {
  const g = buildLinkGraph(FILES);
  assert.equal(g.ranking[0].key, 'hub');
  assert.equal(g.ranking[0].inbound, 2);
});

test('buildLinkGraph identifies orphans as zero inbound AND zero outbound', () => {
  const g = buildLinkGraph(FILES);
  assert.deepEqual(g.orphans, ['lonely']);
});

test('buildLinkGraph reports dangling links with their source', () => {
  const g = buildLinkGraph([{ name: 'a.md', text: '---\nname: a\n---\n[[nowhere]]\n' }]);
  assert.deepEqual(g.dangling, [{ from: 'a', to: 'nowhere' }]);
  assert.equal(g.stats.edges, 0, 'a dangling link is not an edge');
  assert.equal(g.stats.nodes, 1, 'a dangling link does not invent a node');
});

test('buildLinkGraph resolves hyphen/underscore spelling variants of a target', () => {
  const g = buildLinkGraph([
    { name: 'a.md', text: '---\nname: a-note\n---\n[[b_note]]\n' },
    { name: 'b.md', text: '---\nname: b-note\n---\nbody\n' },
  ]);
  assert.deepEqual(g.dangling, []);
  assert.equal(g.stats.edges, 1);
});

test('buildLinkGraph resolves a link written as the filename stem', () => {
  const g = buildLinkGraph([
    { name: 'a.md', text: '---\nname: a\n---\n[[weird_file]]\n' },
    { name: 'weird_file.md', text: '---\nname: canonical-slug\n---\nbody\n' },
  ]);
  assert.deepEqual(g.dangling, []);
});

test('buildLinkGraph ignores a self-link', () => {
  const g = buildLinkGraph([{ name: 'a.md', text: '---\nname: a\n---\n[[a]]\n' }]);
  assert.equal(g.stats.edges, 0);
  assert.deepEqual(g.orphans, ['a']);
});

test('buildLinkGraph computes connected components, largest first', () => {
  const g = buildLinkGraph(FILES);
  assert.equal(g.components.length, 2);
  assert.equal(g.components[0].length, 3);
  assert.deepEqual(g.components[1], ['lonely']);
});

test('buildLinkGraph flags notes whose name is a sentence, not a linkable slug', () => {
  const g = buildLinkGraph([
    { name: 'ok.md', text: '---\nname: fine-slug\n---\nbody\n' },
    { name: 'bad.md', text: "---\nname: Don't weaken tests to make CI green\n---\nbody\n" },
  ]);
  assert.deepEqual(g.unlinkable, [{ key: "Don't weaken tests to make CI green", file: 'bad.md' }]);
  assert.equal(g.stats.unlinkable, 1);
});

test('buildLinkGraph does not flag underscore or digit slugs as unlinkable', () => {
  const g = buildLinkGraph([
    { name: 'a.md', text: '---\nname: feedback_test_integrity\n---\nx\n' },
    { name: 'b.md', text: '---\nname: adr-0008-park\n---\nx\n' },
  ]);
  assert.deepEqual(g.unlinkable, []);
});

test('renderReport calls out unlinkable notes distinctly from orphans', () => {
  const g = buildLinkGraph([{ name: 'bad.md', text: '---\nname: A Sentence Name\n---\nbody\n' }]);
  const out = renderReport(g, { dir: '/notes' });
  assert.match(out, /Unlinkable notes/);
  assert.match(out, /A Sentence Name/);
});

test('buildLinkGraph reports excess_edges as edges minus nodes', () => {
  // A tree over N nodes has N-1 edges; excess exposes how far past a tree it is.
  const g = buildLinkGraph(FILES);
  assert.equal(g.stats.excess_edges, 3 - 4);
});

test('buildLinkGraph on an empty store yields zeroed stats, not a throw', () => {
  const g = buildLinkGraph([]);
  assert.equal(g.stats.nodes, 0);
  assert.equal(g.stats.edges, 0);
  assert.equal(g.stats.avg_degree, 0);
  assert.deepEqual(g.components, []);
});

test('buildLinkGraph output is deterministic across input order', () => {
  const a = buildLinkGraph(FILES);
  const b = buildLinkGraph([...FILES].reverse());
  assert.deepEqual(a, b);
});

// ── densestEgo ────────────────────────────────────────────────────────────

test('densestEgo prefers a clustered neighbourhood over a bigger pure star', () => {
  const g = buildLinkGraph([
    // star: 3 spokes, none linked to each other
    { name: 'star.md', text: '---\nname: star\n---\n[[s1]] [[s2]] [[s3]]\n' },
    { name: 's1.md', text: '---\nname: s1\n---\nx\n' },
    { name: 's2.md', text: '---\nname: s2\n---\nx\n' },
    { name: 's3.md', text: '---\nname: s3\n---\nx\n' },
    // cluster: 2 neighbours that also link to each other
    { name: 'cluster.md', text: '---\nname: cluster\n---\n[[c1]] [[c2]]\n' },
    { name: 'c1.md', text: '---\nname: c1\n---\n[[c2]]\n' },
    { name: 'c2.md', text: '---\nname: c2\n---\nx\n' },
  ]);
  // Inside a triangle every member has the same neighbourhood, so any of the
  // three is a correct answer; the contract is that it never picks the star,
  // whose neighbours link to nothing.
  assert.ok(['cluster', 'c1', 'c2'].includes(densestEgo(g)), `picked ${densestEgo(g)}`);
});

test('densestEgo picks the larger cluster when two clusters compete', () => {
  const g = buildLinkGraph([
    { name: 'small.md', text: '---\nname: small\n---\n[[sa]] [[sb]]\n' },
    { name: 'sa.md', text: '---\nname: sa\n---\n[[sb]]\n' },
    { name: 'sb.md', text: '---\nname: sb\n---\nx\n' },
    { name: 'big.md', text: '---\nname: big\n---\n[[ba]] [[bb]] [[bc]]\n' },
    { name: 'ba.md', text: '---\nname: ba\n---\n[[bb]]\n' },
    { name: 'bb.md', text: '---\nname: bb\n---\n[[bc]]\n' },
    { name: 'bc.md', text: '---\nname: bc\n---\n[[ba]]\n' },
  ]);
  assert.ok(['big', 'ba', 'bb', 'bc'].includes(densestEgo(g)), `picked ${densestEgo(g)}`);
});

test('densestEgo returns null when nothing is linked', () => {
  assert.equal(densestEgo(buildLinkGraph([{ name: 'a.md', text: 'no links' }])), null);
});

test('densestEgo is deterministic across input order', () => {
  const a = densestEgo(buildLinkGraph(FILES));
  const b = densestEgo(buildLinkGraph([...FILES].reverse()));
  assert.equal(a, b);
});

// ── renderReport ──────────────────────────────────────────────────────────

test('renderReport states the headline counts', () => {
  const out = renderReport(buildLinkGraph(FILES), { dir: '/notes' });
  assert.match(out, /4 notes/);
  assert.match(out, /3 links/);
});

test('renderReport surfaces dangling links as the actionable section', () => {
  const g = buildLinkGraph([{ name: 'a.md', text: '---\nname: a\n---\n[[nowhere]]\n' }]);
  const out = renderReport(g, { dir: '/notes' });
  assert.match(out, /Broken links/);
  assert.match(out, /a.*nowhere/);
});

test('renderReport says so explicitly when there is nothing to fix', () => {
  const g = buildLinkGraph([
    { name: 'a.md', text: '---\nname: a\n---\n[[b]]\n' },
    { name: 'b.md', text: '---\nname: b\n---\n[[a]]\n' },
  ]);
  const out = renderReport(g, { dir: '/notes' });
  assert.match(out, /No broken links/);
  assert.match(out, /No orphans/);
});

test('renderReport reports a fragmented store as multiple components', () => {
  const out = renderReport(buildLinkGraph(FILES), { dir: '/notes' });
  assert.match(out, /2 disconnected groups|largest holds/i);
});

// ── renderEgoSvg ──────────────────────────────────────────────────────────

test('renderEgoSvg centers the requested node and labels every node drawn', () => {
  const svg = renderEgoSvg(buildLinkGraph(FILES), 'hub');
  assert.match(svg, /<svg[^>]*viewBox/);
  assert.match(svg, />hub</);
  assert.match(svg, />spoke-one</);
  assert.match(svg, />spoke-two</);
});

test('renderEgoSvg is byte-identical across runs (no random layout)', () => {
  const g = buildLinkGraph(FILES);
  assert.equal(renderEgoSvg(g, 'hub'), renderEgoSvg(g, 'hub'));
  assert.equal(renderEgoSvg(g, 'hub'), renderEgoSvg(buildLinkGraph([...FILES].reverse()), 'hub'));
});

test('renderEgoSvg escapes XML metacharacters in note names', () => {
  const g = buildLinkGraph([
    { name: 'a.md', text: '---\nname: a&<b>\n---\n[[c]]\n' },
    { name: 'c.md', text: '---\nname: c\n---\nbody\n' },
  ]);
  const svg = renderEgoSvg(g, 'a&<b>');
  assert.match(svg, /a&amp;&lt;b&gt;/);
  assert.doesNotMatch(svg, /name: a&<b>/);
});

test('renderEgoSvg returns null when the store has no links to draw', () => {
  assert.equal(renderEgoSvg(buildLinkGraph([]), 'nope'), null);
});

test('renderEgoSvg widens the canvas so long labels are not clipped', () => {
  const long = 'a-very-long-note-name-that-would-overflow-a-fixed-canvas';
  const g = buildLinkGraph([
    { name: 'h.md', text: `---\nname: h\n---\n[[${long}]]\n` },
    { name: 'l.md', text: `---\nname: ${long}\n---\nx\n` },
  ]);
  const svg = renderEgoSvg(g, 'h');
  const width = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
  // ring radius + gap + the label itself must fit within half the canvas
  assert.ok(width / 2 >= 170 + 12 + long.length * 7, `canvas ${width} too narrow for a ${long.length}-char label`);
});

test('renderEgoSvg draws edges between neighbours, not just spokes to the hub', () => {
  const svg = renderEgoSvg(buildLinkGraph(FILES), 'hub');
  // 3 edges total in this fixture; all lie within the hub's neighbourhood.
  assert.equal((svg.match(/<line /g) || []).length, 3);
});

// ── entrypoint ────────────────────────────────────────────────────────────

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('parseArgs accepts --dir and --svg', () => {
  const a = parseArgs(['--dir', 'x/y', '--svg', 'out.svg']);
  assert.equal(a.dir, 'x/y');
  assert.equal(a.svg, 'out.svg');
});

test('readNotes reads only markdown, sorted, and skips the index file', async () => {
  const tmp = tempDir('link-audit-test-');
  try {
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, 'b.md'), 'b');
    await writeFile(path.join(tmp, 'a.md'), 'a');
    await writeFile(path.join(tmp, 'MEMORY.md'), 'index');
    await writeFile(path.join(tmp, 'notes.txt'), 'ignored');
    const notes = await readNotes(tmp);
    assert.deepEqual(notes.map((n) => n.name), ['a.md', 'b.md']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readNotes gives an actionable error for a missing directory', async () => {
  await assert.rejects(() => readNotes('no/such/dir'), /no such memory directory.*--dir/s);
});
