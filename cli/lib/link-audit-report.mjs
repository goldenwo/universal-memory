/**
 * cli/lib/link-audit-report.mjs — render a link audit as markdown, plus an
 * optional neighbourhood diagram.
 *
 * Two rendering rules, both load-bearing:
 *
 *   1. The report leads with what is BROKEN, not with what is impressive.
 *      Broken links are the one finding here that is unambiguously a defect and
 *      invisible from any other surface.
 *   2. The diagram is LOCAL, LABELLED and DETERMINISTIC. Local because the only
 *      graph rendering practitioners consistently defend is a single node's
 *      neighbourhood, not the global view. Labelled because these nodes are
 *      named notes and the names are the information. Deterministic because a
 *      layout that shuffles between runs never becomes a picture you know.
 *
 * Zero dependencies; the SVG is hand-emitted.
 */

import { egoNetwork } from './link-audit.mjs';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Render the audit as a markdown report.
 *
 * @param {ReturnType<import('./link-audit.mjs').buildLinkGraph>} graph
 * @param {{dir?: string}} [opts]
 */
export function renderReport(graph, { dir = '' } = {}) {
  const s = graph.stats;
  const out = [];

  out.push('# Memory link audit');
  out.push('');
  if (dir) out.push(`\`${dir}\``);
  out.push('');
  out.push(`**${s.nodes} notes, ${s.edges} links.** ${s.orphans} orphaned, ${s.dangling} broken, ${s.components} disconnected groups (largest holds ${s.largest_component}).`);
  out.push('');

  // ── what to fix ─────────────────────────────────────────────────────────
  out.push('## Broken links');
  out.push('');
  if (!graph.dangling.length) {
    out.push('No broken links — every `[[target]]` resolves to a real note.');
  } else {
    out.push('Each of these points at a note that does not exist. Either the target was renamed, or the text was never meant to be a link.');
    out.push('');
    out.push('| in note | points at |');
    out.push('| --- | --- |');
    for (const d of graph.dangling) out.push(`| \`${d.from}\` | \`${d.to}\` |`);
  }
  out.push('');

  out.push('## Orphans');
  out.push('');
  if (!graph.orphans.length) {
    out.push('No orphans — every note is connected to at least one other.');
  } else {
    out.push(`${graph.orphans.length} note(s) with no links in or out. Not automatically wrong — some facts stand alone — but this is where an un-filed memory hides.`);
    out.push('');
    for (const o of graph.orphans) out.push(`- \`${o}\``);
  }
  out.push('');

  out.push('## Unlinkable notes');
  out.push('');
  if (!graph.unlinkable.length) {
    out.push('Every note has a slug-shaped `name:`, so anything can be linked to.');
  } else {
    out.push(`${graph.unlinkable.length} note(s) whose \`name:\` is a sentence rather than a slug. Nothing can write \`[[...]]\` to reach these, so they cannot be linked even when they should be — a different problem from being merely unlinked.`);
    out.push('');
    out.push('| file | current `name:` |');
    out.push('| --- | --- |');
    for (const u of graph.unlinkable) out.push(`| \`${u.file}\` | ${u.key} |`);
  }
  out.push('');

  // ── what the shape is ───────────────────────────────────────────────────
  out.push('## Most referenced');
  out.push('');
  const top = graph.ranking.filter((n) => n.inbound > 0).slice(0, 10);
  if (!top.length) {
    out.push('Nothing is referenced by anything else.');
  } else {
    out.push('| note | in | out |');
    out.push('| --- | ---: | ---: |');
    for (const n of top) out.push(`| \`${n.key}\` | ${n.inbound} | ${n.outbound} |`);
  }
  out.push('');

  out.push('## Structure');
  out.push('');
  out.push(`- Average degree: **${s.avg_degree}**`);
  out.push(`- Links minus notes: **${s.excess_edges >= 0 ? '+' : ''}${s.excess_edges}**${treeNote(s)}`);
  out.push(`- Connected groups: **${s.components}**${s.components > 1 ? ` (largest ${s.largest_component} of ${s.nodes})` : ''}`);
  if (graph.components.length > 1) {
    const frags = graph.components.slice(1).filter((c) => c.length > 1);
    if (frags.length) {
      out.push('');
      out.push('Separate groups, not joined to the main body:');
      for (const c of frags) out.push(`- ${c.map((k) => `\`${k}\``).join(', ')}`);
    }
  }
  out.push('');
  return out.join('\n');
}

/**
 * A tree over N nodes has exactly N-1 edges. Reporting the gap tells the
 * operator whether the store is a genuine web or effectively a hierarchy —
 * which decides whether any graph rendering could show them something a
 * plain outline would not.
 */
function treeNote(s) {
  if (!s.nodes) return '';
  const excess = s.edges - (s.nodes - 1);
  if (excess <= 0) return ' — sparser than a tree; parts of this store are disconnected, not woven';
  if (excess <= s.nodes * 0.25) return ` — only ${excess} link(s) more than a plain tree, so this is close to a hierarchy`;
  return ' — genuinely more interconnected than a hierarchy';
}

// ── neighbourhood diagram ──────────────────────────────────────────────────

const H = 520;
const R = 170;
const PAD = 16;
const GAP = 12;
/** Monospace advance widths, near enough to size a canvas without measuring text. */
const CH = 7.25;   // 12px label
const CH_HUB = 7.9; // 13px hub label

/**
 * Width is derived from the longest label rather than fixed. Ring labels are
 * anchored outward from a ring of radius R, so a fixed canvas silently clips
 * long note names — and these labels ARE the content.
 */
function canvasWidth(center, ring) {
  const widest = ring.reduce((m, k) => Math.max(m, k.length), 0) * CH;
  const byRing = 2 * (R + GAP + widest) + 2 * PAD;
  const byHub = center.length * CH_HUB + 2 * PAD;
  return Math.round(Math.max(560, byRing, byHub));
}

/**
 * Render one node's neighbourhood as a labelled 2D SVG with a fixed radial
 * layout: the subject at centre, its neighbours evenly spaced on a ring in
 * descending-degree order. Every edge among the drawn nodes is included, so
 * clustering between neighbours is visible rather than implied.
 *
 * Returns null when the node has no connections to draw.
 *
 * @param {ReturnType<import('./link-audit.mjs').buildLinkGraph>} graph
 * @param {string} key - Node to centre on.
 */
export function renderEgoSvg(graph, key) {
  const ego = egoNetwork(graph, key);
  if (!ego) return null;

  const W = canvasWidth(ego.center, ego.ring);
  const cx = W / 2;
  const cy = H / 2;
  const pos = new Map([[ego.center, { x: cx, y: cy }]]);
  ego.ring.forEach((k, i) => {
    // Start at the top and go clockwise; fixed order in, fixed picture out.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / ego.ring.length;
    pos.set(k, { x: round(cx + R * Math.cos(angle)), y: round(cy + R * Math.sin(angle)) });
  });

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Link neighbourhood of ${esc(key)}">`);
  parts.push(`<style>
    .bg { fill: #fbfbfd; }
    .edge { stroke: #b9b9c6; stroke-width: 1.25; }
    .node { fill: #ffffff; stroke: #8b8ba0; stroke-width: 1.25; }
    .hub { fill: #7c7ce8; stroke: #5b5bd6; }
    .label { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #24243a; }
    .label-hub { font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #24243a; }
    .caption { font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #6a6a80; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #16161e; }
      .edge { stroke: #45455a; }
      .node { fill: #1e1e2a; stroke: #6a6a85; }
      .hub { fill: #7c7ce8; stroke: #9a9af0; }
      .label, .label-hub { fill: #d8d8e4; }
      .caption { fill: #8a8aa0; }
    }
  </style>`);
  parts.push(`<rect class="bg" width="${W}" height="${H}"/>`);

  for (const e of ego.edges) {
    const p = pos.get(e.a);
    const q = pos.get(e.b);
    if (!p || !q) continue;
    parts.push(`<line class="edge" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`);
  }

  for (const k of [...ego.ring, ego.center]) {
    const p = pos.get(k);
    const isHub = k === ego.center;
    parts.push(`<circle class="node${isHub ? ' hub' : ''}" cx="${p.x}" cy="${p.y}" r="${isHub ? 9 : 6}"/>`);
    const { dx, anchor } = labelPlacement(p, cx, isHub);
    parts.push(`<text class="${isHub ? 'label-hub' : 'label'}" x="${p.x + dx}" y="${p.y + (isHub ? -16 : 4)}" text-anchor="${anchor}">${esc(k)}</text>`);
  }

  parts.push(`<text class="caption" x="16" y="${H - 16}">neighbourhood of ${esc(key)} — ${ego.ring.length} linked note(s), ${ego.edges.length} link(s)</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/** Push labels away from the centre so they never overlap the ring. */
function labelPlacement(p, cx, isHub) {
  if (isHub) return { dx: 0, anchor: 'middle' };
  if (p.x > cx + 1) return { dx: 12, anchor: 'start' };
  if (p.x < cx - 1) return { dx: -12, anchor: 'end' };
  return { dx: 0, anchor: 'middle' };
}

const round = (n) => Math.round(n * 100) / 100;
