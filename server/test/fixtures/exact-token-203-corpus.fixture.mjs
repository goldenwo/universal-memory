// server/test/fixtures/exact-token-203-corpus.fixture.mjs — #203 PR 2 (plan T6,
// T7, P2). A SYNTHETIC corpus of 12 targetable points (plus the embedding stamp)
// for the exact-token harness, with stubbed LLMs and a stubbed retrieval. Every
// string is invented for the test; none is corpus content.
//
// Population it produces (each doc is a summary, so `isDoc`):
//   primary (doc, df <= 5, one project): FAKE_ALPHA_FLAG (df 2), lib/widget.mjs,
//     v7.1.2 (collapsed with the nested 7.1.2), --dry-crank, --slow-crank,
//     spin_up(), relay-a:8080, /srv/demo/vault, #4101   -> E = 9
//   fact control: FAKE_GAMMA_FLAG, FAKE_DELTA_FLAG
//   non-primary: UM_COMMON_TAG (df 6), FAKE_BETA_FLAG (two projects)
// Each doc carries one `topic*` word so the J3 stub can tell a split referent.

const doc = (id, project, text) => ({
  id: `pt-${id}`,
  vector: [0.01, 0.02, 0.03],
  payload: { id, data: text, userId: 'golden', project, createdAt: '2026-09-15T00:00:00.000Z' },
});

export const CORPUS_POINTS = Object.freeze([
  doc('d01', 'proj-a', 'Session summary: topicalpha. FAKE_ALPHA_FLAG gates the crank spinner warmup; the toggle source sits in lib/widget.mjs. UM_COMMON_TAG.'),
  doc('d02', 'proj-a', 'Session summary: topicalpha. The crank spinner warmup gate FAKE_ALPHA_FLAG stayed enabled overnight. UM_COMMON_TAG.'),
  doc('d03', 'proj-a', 'Session summary: topicbeta. Shipped v7.1.2 of the lantern exporter (tag 7.1.2). UM_COMMON_TAG.'),
  doc('d04', 'proj-a', 'Session summary: topicgamma. The --dry-crank option previews the gearbox rotation. UM_COMMON_TAG.'),
  doc('d05', 'proj-a', 'Session summary: topicdelta. Calling spin_up() boots the turbine harness. UM_COMMON_TAG.'),
  doc('d06', 'proj-a', 'Session summary: topicepsilon. The mirror relay listens on relay-a:8080 for heartbeat pings. UM_COMMON_TAG.'),
  doc('d07', 'proj-b', 'Session summary: topiczeta. FAKE_BETA_FLAG toggles the orchard sprinkler schedule.'),
  doc('d08', 'proj-a', 'Session summary: topiczeta. FAKE_BETA_FLAG toggles the orchard sprinkler schedule too.'),
  doc('d09', 'proj-a', 'Session summary: topiceta. Config lives under /srv/demo/vault for the archive keeper.'),
  doc('d10', 'proj-a', 'Session summary: topictheta. Issue #4101 tracks the beacon dimmer flicker.'),
  doc('d11', 'proj-a', 'Session summary: topiciota. The --slow-crank option throttles the gearbox rotation.'),
  { id: 'pt-f01', vector: [0.04, 0.05, 0.06], payload: { data: 'topickappa: the gauge reader polls FAKE_GAMMA_FLAG at boot.', userId: 'golden', project: 'proj-a', createdAt: '2026-09-16T00:00:00.000Z' } },
  { id: 'pt-f02', vector: [0.07, 0.08, 0.09], payload: { data: 'topiclambda: remember FAKE_DELTA_FLAG for the kiln timer.', userId: 'golden', project: 'proj-a', createdAt: '2026-09-17T00:00:00.000Z' } },
  { id: 'pt-stamp', vector: [1, 0, 0], payload: { id: '_um_embedding_stamp', data: 'embedding stamp', userId: '_um_system' } },
]);

/** The gloss the stub generator writes for each identifier (UNKNOWN = unglossable). */
export const STUB_GLOSSES = Object.freeze({
  FAKE_ALPHA_FLAG: 'crank spinner warmup gate',
  'lib/widget.mjs': 'crank toggle source',
  'v7.1.2': 'lantern exporter build',
  '7.1.2': 'lantern exporter tag',
  '--dry-crank': 'gearbox rotation preview',
  '--slow-crank': 'gearbox rotation throttle',
  'spin_up()': 'turbine harness boot',
  'relay-a:8080': 'mirror relay listener',
  '/srv/demo/vault': 'archive keeper storage',
  '#4101': 'UNKNOWN',
  FAKE_GAMMA_FLAG: 'gauge reader switch',
  FAKE_DELTA_FLAG: 'kiln timer reminder',
  UM_COMMON_TAG: 'shared marker label',
  FAKE_BETA_FLAG: 'orchard sprinkler schedule',
});

/** The first attempt for this identifier fails G-shape (a digit), the retry passes. */
export const STUB_RETRY_FIRST = Object.freeze({ 'relay-a:8080': 'relay listener on port eighty 8080' });

export const leakyPhrase = (identifier) => {
  const g = STUB_GLOSSES[identifier];
  return g && g !== 'UNKNOWN' ? `${g.split(' ').slice(0, 3).join(' ')} failed overnight` : 'UNKNOWN';
};

/**
 * Stub LLMs. `generate` / `judge` receive { kind, prompt, meta }; the stubs decide
 * from `meta` (identifier, phrase, options, windows), never from corpus access.
 * Every call is recorded (kind + prompt) so tests can inspect the fences.
 */
export function makeStubLlm({ judgeOverride } = {}) {
  const calls = [];
  const glossToIdent = new Map(Object.entries(STUB_GLOSSES).map(([k, v]) => [v, k]));
  const leaky = new Set(Object.keys(STUB_GLOSSES).map(leakyPhrase));
  return {
    calls,
    async generate({ kind, prompt, meta }) {
      calls.push({ kind, prompt, meta });
      if (kind === 'leaky') return leakyPhrase(meta.identifier);
      if (meta.attempt === 0 && STUB_RETRY_FIRST[meta.identifier]) return STUB_RETRY_FIRST[meta.identifier];
      return STUB_GLOSSES[meta.identifier] ?? 'UNKNOWN';
    },
    async judge({ kind, prompt, meta }) {
      calls.push({ kind, prompt, meta });
      if (judgeOverride) {
        const o = judgeOverride({ kind, prompt, meta });
        if (o !== undefined) return o;
      }
      if (kind === 'j1') return leaky.has(meta.phrase) ? 'NO' : 'YES';
      if (kind === 'j2') {
        const ident = glossToIdent.get(meta.phrase);
        const i = meta.options.indexOf(ident);
        return i >= 0 ? String(i + 1) : 'NONE';
      }
      if (kind === 'j3') {
        const tags = new Set(meta.windows.flatMap((w) => w.match(/topic[a-z]+/g) ?? []));
        return tags.size > 1 ? 'DIFFERENT' : 'SAME';
      }
      throw new Error(`unknown judge kind ${kind}`);
    },
  };
}

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));

/**
 * A deterministic stand-in for the qdrant clone + doSearch: ranks projected ids
 * by Jaccard overlap of lowercase word tokens, returns only positive overlaps,
 * in doSearch's (query, limit, includeSuperseded, full, ctx) shape.
 */
export function makeStubIndex(points, { inject } = {}) {
  const docs = points
    .filter((p) => p.payload?.userId !== '_um_system')
    .map((p) => ({ id: String(p.payload?.id ?? p.id), t: tokens(p.payload?.data ?? '') }));
  const searches = [];
  return {
    searches,
    qdrantVersion: '1.7.3',
    count: points.length,
    memory: { stub: true },
    async doSearch(query, limit) {
      searches.push(query);
      const q = tokens(query);
      const scored = docs.map((d) => {
        let inter = 0;
        for (const x of q) if (d.t.has(x)) inter++;
        const union = q.size + d.t.size - inter;
        return { id: d.id, score: union ? inter / union : 0 };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      let results = scored.slice(0, limit).map((x) => ({ id: x.id, title: x.id, score: x.score, body: '' }));
      if (inject) results = inject(query, results);
      return { results };
    },
    async close() {},
  };
}
