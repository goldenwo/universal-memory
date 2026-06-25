// server/eval/lib/corpus-distractors.mjs
// Pure, fixture-lane-driven distractor generator for the recall-vs-corpus-size
// eval (#14). No live calls — importing this stays fully offline.

/** Distinct lanes present in a recall-set's seed_facts, in first-seen order. */
export function lanesFromRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows ?? []) {
    for (const f of r.seed_facts ?? []) {
      if (typeof f.lane === 'string' && !seen.has(f.lane)) { seen.add(f.lane); out.push(f.lane); }
    }
  }
  return out;
}

// Shared slot vocab. Values are chosen DISJOINT from the recall-set target answers
// (Task 3's non-target test is the gate that finalizes this). Keep each list short
// but varied; variety across templates (not within one slot) drives distinctness.
const SLOTS = {
  room: ['hallway', 'study', 'porch', 'landing', 'pantry', 'garage'],
  fixture: ['curtains', 'blinds', 'doormat', 'shelving', 'lighting'],
  material: ['oak', 'linen', 'bamboo', 'wicker', 'felt'],
  chore: ['gutters', 'filters', 'hedges', 'grout', 'driveway'],
  svc: ['billing', 'search', 'auth', 'ingest', 'notify', 'gateway'],
  lib: ['logging', 'retry', 'caching', 'metrics', 'config'],
  cadence: ['nightly', 'weekly', 'on-merge', 'hourly'],
  dep: ['the http client', 'the test runner', 'the linter', 'the bundler'],
  acct: ['the rainy-day', 'the holiday', 'the gadget', 'the books'],
  sub: ['the music', 'the news', 'the storage', 'the gym'],
  day: ['the 1st', 'the 15th', 'the last weekday', 'payday'],
  reward: ['groceries', 'transit', 'fuel', 'streaming'],
};

// Per-lane templates: >=3 structurally-distinct shapes each. WORKED SET = home/dev/finance.
// EXTEND to the remaining recall-set lanes (travel, hobby, health, work, learning, food,
// family) following this exact shape — >=3 sub-topic templates/lane, slot vocab disjoint
// from the recall-set answers (Task 3 enforces non-collision). A lane with no entry here is
// simply skipped by generateDistractors (its targets are still seeded by the sweep).
const LANE_TEMPLATES = {
  home: [
    { slots: ['fixture', 'room'], render: (s) => `New ${s.fixture} went up in the ${s.room} over the weekend` },
    { slots: ['room', 'material'], render: (s) => `The ${s.room} floor was redone in ${s.material} last month` },
    { slots: ['chore'], render: (s) => `Cleaning the ${s.chore} got added to the monthly home list` },
  ],
  dev: [
    { slots: ['lib', 'svc'], render: (s) => `The ${s.svc} service swapped in a new ${s.lib} module last sprint` },
    { slots: ['svc', 'cadence'], render: (s) => `Deploys for the ${s.svc} repo moved to a ${s.cadence} cadence` },
    { slots: ['dep'], render: (s) => `${s.dep[0].toUpperCase()}${s.dep.slice(1)} was upgraded a major version` },
  ],
  finance: [
    { slots: ['acct'], render: (s) => `${s.acct[0].toUpperCase()}${s.acct.slice(1)} fund got a standing top-up set up` },
    { slots: ['sub', 'day'], render: (s) => `${s.sub[0].toUpperCase()}${s.sub.slice(1)} subscription now renews on ${s.day}` },
    { slots: ['reward'], render: (s) => `The rewards card started earning extra points on ${s.reward}` },
  ],
};

function fillTemplate(template, combo) {
  const s = {};
  let c = combo;
  for (const slot of template.slots) {
    const vals = SLOTS[slot];
    s[slot] = vals[c % vals.length];
    c = Math.floor(c / vals.length);
  }
  return template.render(s);
}

/**
 * Deterministic, prefix-stable, lane-balanced distractor facts. `lanes` MUST be
 * derived from the fixture (see lanesFromRows) — only lanes with a LANE_TEMPLATES
 * entry produce distractors; others are skipped. Throws if none are usable.
 *
 * @param {number} count
 * @param {{ seed?: number, lanes: string[] }} opts
 * @returns {{text: string, lane: string}[]}
 */
export function generateDistractors(count, { seed = 0, lanes } = {}) {
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error('generateDistractors: lanes required (derive from the fixture)');
  const usable = lanes.filter((l) => LANE_TEMPLATES[l]?.length);
  if (usable.length === 0) throw new Error(`generateDistractors: no templates for lanes [${lanes.join(', ')}]`);
  const out = [];
  for (let i = 0; i < count; i++) {
    const lane = usable[i % usable.length];
    const within = Math.floor(i / usable.length) + seed;
    const templates = LANE_TEMPLATES[lane];
    const template = templates[within % templates.length];
    const combo = Math.floor(within / templates.length);
    out.push({ text: fillTemplate(template, combo), lane });
  }
  return out;
}
