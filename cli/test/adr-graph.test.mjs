import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAdrFile, buildAdrGraph, toMermaid, toDot } from '../lib/adr-graph.mjs';
import { parseArgs, readDecisionFiles } from '../adr-graph.mjs';
import { tempDir } from '../../server/test/helpers/tmpdir.mjs';

// ── parseAdrFile ──────────────────────────────────────────────────────────

test('parseAdrFile reads flow-list supersedes', () => {
  const adr = parseAdrFile('0008-park.md', [
    '---',
    'id: 0008-park-graph-memory-kuzu-superseded',
    'title: "Park graph memory"',
    'status: Accepted',
    'supersedes: ["0004-kuzu-for-graph-memory"]',
    'superseded_by: null',
    '---',
    '',
    '# body',
  ].join('\n'));
  assert.equal(adr.key, '0008');
  assert.equal(adr.title, 'Park graph memory');
  assert.equal(adr.status, 'Accepted');
  assert.deepEqual(adr.supersedes, ['0004']);
  assert.equal(adr.supersededBy, null);
});

test('parseAdrFile reads block-list supersedes', () => {
  const adr = parseAdrFile('0009-x.md', [
    '---',
    'id: 0009-x',
    'title: Multi',
    'status: Accepted',
    'supersedes:',
    '  - "0004-kuzu-for-graph-memory"',
    '  - 0005-adr-invocation-model',
    '---',
  ].join('\n'));
  assert.deepEqual(adr.supersedes, ['0004', '0005']);
});

test('parseAdrFile reads superseded_by and normalizes the slug to a 4-digit key', () => {
  const adr = parseAdrFile('0004-kuzu.md', [
    '---',
    'id: 0004-kuzu-for-graph-memory',
    'title: Kuzu for graph memory',
    'status: Superseded',
    'supersedes: []',
    'superseded_by: 0008-park-graph-memory-kuzu-superseded',
    '---',
  ].join('\n'));
  assert.equal(adr.key, '0004');
  assert.equal(adr.supersededBy, '0008');
  assert.deepEqual(adr.supersedes, []);
});

test('parseAdrFile tolerates CRLF frontmatter (the bash parser does not)', () => {
  const adr = parseAdrFile('0008-park.md', [
    '---',
    'id: 0008-park',
    'title: Park',
    'status: Accepted',
    'supersedes: ["0004-kuzu"]',
    '---',
  ].join('\r\n'));
  assert.equal(adr.key, '0008');
  assert.equal(adr.status, 'Accepted');
  assert.deepEqual(adr.supersedes, ['0004']);
});

test('parseAdrFile returns null when the file has no frontmatter', () => {
  // 5 of universal-memory's 8 ADRs are in this shape — they must not crash the walk.
  assert.equal(parseAdrFile('0001-frame.md', '# ADR-0001: Adopt frame\n\nBody.\n'), null);
});

test('parseAdrFile falls back to the filename when id is absent', () => {
  const adr = parseAdrFile('0006-cross-surface-dedup.md', [
    '---',
    'title: Cross-surface dedup',
    'status: Accepted',
    '---',
  ].join('\n'));
  assert.equal(adr.key, '0006');
});

test('parseAdrFile strips surrounding quotes from scalar values', () => {
  const adr = parseAdrFile('0007-x.md', ['---', "id: '0007-x'", 'title: "Quoted title"', 'status: Accepted', '---'].join('\n'));
  assert.equal(adr.title, 'Quoted title');
  assert.equal(adr.key, '0007');
});

// ── buildAdrGraph ─────────────────────────────────────────────────────────

const FILES = [
  { name: '0004-kuzu.md', text: ['---', 'id: 0004-kuzu-for-graph-memory', 'title: Kuzu for graph memory', 'status: Superseded', 'supersedes: []', 'superseded_by: 0008-park-graph-memory-kuzu-superseded', '---'].join('\n') },
  { name: '0008-park.md', text: ['---', 'id: 0008-park-graph-memory-kuzu-superseded', 'title: Park graph memory', 'status: Accepted', 'supersedes: ["0004-kuzu-for-graph-memory"]', 'superseded_by: null', '---'].join('\n') },
  { name: '0001-frame.md', text: '# ADR-0001: Adopt frame\n' },
];

test('buildAdrGraph emits one logical edge when both ends assert the same relation', () => {
  // 0008 says supersedes:[0004] AND 0004 says superseded_by:0008 — one edge, not two.
  const g = buildAdrGraph(FILES);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { from: '0008', to: '0004' });
});

test('buildAdrGraph reports files skipped for missing frontmatter', () => {
  const g = buildAdrGraph(FILES);
  assert.deepEqual(g.skipped, ['0001-frame.md']);
  assert.equal(g.nodes.length, 2);
});

test('buildAdrGraph sorts nodes by key for deterministic output', () => {
  const g = buildAdrGraph([...FILES].reverse());
  assert.deepEqual(g.nodes.map((n) => n.key), ['0004', '0008']);
});

test('buildAdrGraph records a dangling reference without inventing a node', () => {
  const g = buildAdrGraph([
    { name: '0009-x.md', text: ['---', 'id: 0009-x', 'title: X', 'status: Accepted', 'supersedes: ["0099-nonexistent"]', '---'].join('\n') },
  ]);
  assert.deepEqual(g.dangling, [{ from: '0009', to: '0099' }]);
  assert.equal(g.edges.length, 0);
  assert.equal(g.nodes.length, 1);
});

test('buildAdrGraph on an empty decisions directory yields an empty graph, not a throw', () => {
  const g = buildAdrGraph([]);
  assert.deepEqual(g, { nodes: [], edges: [], skipped: [], dangling: [] });
});

// ── renderers ─────────────────────────────────────────────────────────────

test('toMermaid renders nodes, the edge, and marks superseded status', () => {
  const out = toMermaid(buildAdrGraph(FILES));
  assert.match(out, /^graph LR$/m);
  assert.match(out, /0008\["0008: Park graph memory"\]/);
  assert.match(out, /0008 -->\|supersedes\| 0004/);
  assert.match(out, /class 0004 superseded/);
});

test('toMermaid escapes double quotes in titles so the diagram cannot break', () => {
  const out = toMermaid(buildAdrGraph([
    { name: '0010-q.md', text: ['---', 'id: 0010-q', 'title: The "quoted" decision', 'status: Accepted', '---'].join('\n') },
  ]));
  assert.doesNotMatch(out, /"The "quoted" decision"/);
  assert.match(out, /0010: The #quot;quoted#quot; decision/);
});

test('toDot renders a digraph with the same single edge', () => {
  const out = toDot(buildAdrGraph(FILES));
  assert.match(out, /^digraph adrs \{$/m);
  assert.match(out, /"0008" -> "0004"/);
  assert.match(out, /\}\s*$/);
});

test('renderers produce byte-identical output across repeated builds', () => {
  assert.equal(toMermaid(buildAdrGraph(FILES)), toMermaid(buildAdrGraph([...FILES].reverse())));
  assert.equal(toDot(buildAdrGraph(FILES)), toDot(buildAdrGraph([...FILES].reverse())));
});

// ── entrypoint ────────────────────────────────────────────────────────────

test('parseArgs defaults to mermaid from docs/decisions', () => {
  assert.deepEqual(parseArgs([]), { format: 'mermaid', dir: 'docs/decisions' });
});

test('parseArgs accepts --format and --dir', () => {
  const a = parseArgs(['--format', 'dot', '--dir', 'other/adrs']);
  assert.equal(a.format, 'dot');
  assert.equal(a.dir, 'other/adrs');
});

test('parseArgs rejects an unknown format rather than emitting nothing', () => {
  assert.throws(() => parseArgs(['--format', 'graphml']), /unknown format: graphml/);
});

test('parseArgs rejects unknown arguments', () => {
  assert.throws(() => parseArgs(['--wat']), /unknown argument: --wat/);
});

test('readDecisionFiles returns only .md files, sorted', async () => {
  const tmp = tempDir('adr-graph-test-');
  try {
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, '0002-b.md'), '# b\n');
    await writeFile(path.join(tmp, '0001-a.md'), '# a\n');
    await writeFile(path.join(tmp, 'notes.txt'), 'ignored');
    const files = await readDecisionFiles(tmp);
    assert.deepEqual(files.map((f) => f.name), ['0001-a.md', '0002-b.md']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readDecisionFiles gives an actionable error when the directory is absent', async () => {
  await assert.rejects(() => readDecisionFiles('does/not/exist'), /no decisions directory.*pass --dir/s);
});
