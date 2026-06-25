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
// (Task 3's non-target test is the gate that finalizes this). Each single-slot
// template needs enough values to stay distinct across at least 8 combos per
// template (covers generateDistractors(60, {lanes:3}) without wrap-around).
const SLOTS = {
  // --- home ---
  room: ['hallway', 'study', 'porch', 'landing', 'pantry', 'garage'],
  fixture: ['curtains', 'blinds', 'doormat', 'shelving', 'lighting'],
  material: ['oak', 'linen', 'bamboo', 'wicker', 'felt'],
  chore: ['gutters', 'filters', 'hedges', 'grout', 'driveway', 'insulation', 'weatherstripping', 'chimney'],
  // --- dev ---
  svc: ['billing', 'search', 'auth', 'ingest', 'notify', 'gateway'],
  lib: ['logging', 'retry', 'caching', 'metrics', 'config'],
  cadence: ['nightly', 'weekly', 'on-merge', 'hourly'],
  dep: ['the http client', 'the test runner', 'the linter', 'the bundler', 'the formatter', 'the schema validator', 'the mock server', 'the cli adapter'],
  // --- finance ---
  acct: ['the rainy-day', 'the holiday', 'the gadget', 'the books', 'the moving', 'the vehicle', 'the tutoring', 'the travel', 'the renovation', 'the pet', 'the medical', 'the clothing'],
  sub: ['the music', 'the news', 'the storage', 'the gym', 'the magazine', 'the software', 'the meal-kit', 'the podcast'],
  day: ['the first of the month', 'mid-month', 'the last weekday', 'payday', 'the fifth of the month', 'the twentieth', 'the last calendar day'],
  reward: ['groceries', 'transit', 'fuel', 'streaming', 'dining', 'parking', 'utilities', 'internet', 'travel bookings', 'pharmacy'],

  // --- travel ---
  dest: ['Berlin', 'Reykjavik', 'Nairobi', 'Vancouver', 'Kyoto', 'Oaxaca', 'Edinburgh', 'Dubrovnik'],
  tripType: ['long weekend', 'two-week', 'solo', 'group', 'budget', 'business'],
  travelItem: ['adapter plug', 'neck pillow', 'packing cubes', 'rain jacket', 'money belt', 'portable charger', 'eye mask', 'reusable bottle'],
  airline: ['the budget carrier', 'the regional airline', 'the connecting flight', 'the red-eye', 'the codeshare leg'],
  loyaltyProg: ['the hotel points', 'the airline miles', 'the credit rewards', 'the car-hire credits'],

  // --- hobby ---
  craft: ['woodworking', 'watercolour', 'embroidery', 'pottery', 'calligraphy', 'leatherwork'],
  hobbyGear: ['the hand plane', 'the lathe', 'the kiln', 'the sewing machine', 'the darkroom enlarger', 'the soldering iron'],
  hobbyVenue: ['the community workshop', 'the craft fair', 'the local club', 'the online forum', 'the studio'],
  craftProject: ['a side table', 'a wall hanging', 'a set of bowls', 'a bound journal', 'a folded screen', 'a lamp shade'],
  boardGame: ['the strategy game', 'the co-op game', 'the card game', 'the puzzle', 'the word game'],

  // --- health ---
  supplement: ['magnesium', 'omega-3', 'zinc', 'probiotics', 'iron', 'b-complex', 'ashwagandha', 'folate', 'creatine', 'collagen'],
  exercise: ['cycling', 'swimming', 'yoga', 'weight-training', 'pilates', 'hiking', 'rowing', 'martial arts', 'dance class', 'rock climbing'],
  sleepHabit: ['screen curfew', 'bedtime tea', 'cool room', 'white noise', 'consistent wake time', 'blackout blinds', 'journalling before bed', 'no caffeine after noon', 'evening stretching', 'mouth tape trial'],
  medAppt: ['physio', 'eye exam', 'blood panel', 'dermatology check', 'allergy review', 'cardiology follow-up'],
  healthMetric: ['blood pressure', 'fasting glucose', 'aerobic capacity', 'body weight', 'waist measurement', 'sleep score'],

  // --- work ---
  meetingType: ['the weekly stand-up', 'the planning session', 'the all-hands', 'the retrospective', 'the design review', 'the sync call'],
  colleague: ['the project manager', 'the design lead', 'the product owner', 'the data analyst', 'the QA engineer', 'the scrum master'],
  workTool: ['the project tracker', 'the wiki', 'the shared calendar', 'the code review queue', 'the incident log', 'the documentation portal', 'the deployment dashboard', 'the expense system', 'the team channel', 'the knowledge base'],
  deliverable: ['the roadmap doc', 'the risk register', 'the onboarding guide', 'the status report', 'the incident summary'],
  workProcess: ['sprint planning', 'code freeze', 'peer review', 'sign-off', 'go-live', 'post-mortem'],

  // --- learning ---
  subject: ['German', 'data analysis', 'music theory', 'public speaking', 'Python', 'watercolour technique', 'chess openings'],
  studyMethod: ['spaced repetition', 'mind-mapping', 'practice problems', 'recorded lectures', 'group study', 'project-based practice'],
  learningVenue: ['the online platform', 'the evening class', 'the weekend workshop', 'the study group', 'the library'],
  courseUnit: ['the first module', 'the midpoint unit', 'the review section', 'the capstone project', 'the final assessment'],
  studySchedule: ['weekday mornings', 'weekend afternoons', 'lunch breaks', 'commute slots', 'evenings after dinner'],

  // --- food ---
  ingredient: ['miso paste', 'smoked paprika', 'tahini', 'lemongrass', 'black cardamom', 'fish sauce', 'sumac', 'gochujang'],
  mealType: ['the weeknight stir-fry', 'the batch-cooked grains', 'the slow-cooker stew', 'the sheet-pan roast', 'the cold noodle salad', 'the one-pot curry', 'the grain bowl', 'the frittata', 'the dumplings batch', 'the overnight oats'],
  kitchenTool: ['the cast-iron pan', 'the mandoline', 'the immersion blender', 'the stand mixer', 'the wok', 'the pressure cooker'],
  cuisine: ['Lebanese', 'Ethiopian', 'Peruvian', 'Georgian', 'Vietnamese', 'Moroccan'],
  foodShop: ['the deli counter', 'the spice market', 'the weekend market stall', 'the bulk-foods section', 'the fishmonger'],

  // --- family ---
  relative: ['my cousin', 'my aunt', 'my sibling', 'my mother-in-law', 'my grandfather', 'my niece'],
  familyEvent: ['the reunion', 'the graduation', 'the anniversary dinner', 'the holiday gathering', 'the housewarming'],
  familyTradition: ['the annual camping trip', 'the holiday cookie bake', 'the board-game night', 'the summer barbecue', 'the winter fondue evening', 'the spring gardening day', 'the autumn apple-picking trip', 'the family film marathon', 'the potluck dinner rotation', 'the beach day tradition'],
  familyTask: ['clearing out the attic', 'updating the shared calendar', 'organising old photos', 'planning the holiday rota', 'booking the group accommodation'],
  giftOccasion: ['a birthday', 'a graduation', 'a new arrival', 'a milestone anniversary', 'a housewarming'],
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

  travel: [
    { slots: ['dest', 'tripType'], render: (s) => `The ${s.tripType} trip to ${s.dest} got pencilled in for the autumn` },
    { slots: ['travelItem'], render: (s) => `${s.travelItem[0].toUpperCase()}${s.travelItem.slice(1)} went straight onto the packing list this time` },
    { slots: ['airline', 'dest'], render: (s) => `${s.airline[0].toUpperCase()}${s.airline.slice(1)} to ${s.dest} has a checked-bag allowance included` },
    { slots: ['loyaltyProg', 'dest'], render: (s) => `${s.loyaltyProg[0].toUpperCase()}${s.loyaltyProg.slice(1)} should cover the accommodation in ${s.dest}` },
  ],

  hobby: [
    { slots: ['craft', 'craftProject'], render: (s) => `The ${s.craft} project this month is ${s.craftProject}` },
    { slots: ['hobbyGear', 'hobbyVenue'], render: (s) => `${s.hobbyGear[0].toUpperCase()}${s.hobbyGear.slice(1)} is being borrowed from ${s.hobbyVenue} for the week` },
    { slots: ['boardGame', 'hobbyVenue'], render: (s) => `${s.boardGame[0].toUpperCase()}${s.boardGame.slice(1)} tournament is happening at ${s.hobbyVenue} next weekend` },
    { slots: ['craft', 'hobbyVenue'], render: (s) => `Signed up for the ${s.craft} beginner session at ${s.hobbyVenue}` },
  ],

  health: [
    { slots: ['supplement'], render: (s) => `Started taking ${s.supplement} every morning on the doctor's advice` },
    { slots: ['exercise'], render: (s) => `Added ${s.exercise} to the weekly routine on alternate days` },
    { slots: ['sleepHabit'], render: (s) => `Trying a strict ${s.sleepHabit} to see if it helps with sleep quality` },
    { slots: ['medAppt', 'healthMetric'], render: (s) => `The ${s.medAppt} appointment included checking ${s.healthMetric}` },
  ],

  work: [
    { slots: ['meetingType', 'colleague'], render: (s) => `${s.meetingType[0].toUpperCase()}${s.meetingType.slice(1)} is now facilitated by ${s.colleague}` },
    { slots: ['workTool'], render: (s) => `${s.workTool[0].toUpperCase()}${s.workTool.slice(1)} got a permissions update this cycle` },
    { slots: ['deliverable', 'workProcess'], render: (s) => `${s.deliverable[0].toUpperCase()}${s.deliverable.slice(1)} needs sign-off before ${s.workProcess} begins` },
    { slots: ['colleague', 'workProcess'], render: (s) => `${s.colleague[0].toUpperCase()}${s.colleague.slice(1)} will own the ${s.workProcess} notes going forward` },
  ],

  learning: [
    { slots: ['subject', 'studyMethod'], render: (s) => `Switched to ${s.studyMethod} for the ${s.subject} lessons` },
    { slots: ['learningVenue', 'subject'], render: (s) => `${s.learningVenue[0].toUpperCase()}${s.learningVenue.slice(1)} has a new ${s.subject} track starting next month` },
    { slots: ['studySchedule', 'courseUnit'], render: (s) => `${s.studySchedule[0].toUpperCase()}${s.studySchedule.slice(1)} are reserved for getting through ${s.courseUnit}` },
    { slots: ['subject', 'courseUnit'], render: (s) => `${s.subject} ${s.courseUnit} turned out to be the trickiest part of the course` },
  ],

  food: [
    { slots: ['ingredient', 'mealType'], render: (s) => `Added ${s.ingredient} to ${s.mealType} and it made a big difference` },
    { slots: ['kitchenTool', 'cuisine'], render: (s) => `${s.kitchenTool[0].toUpperCase()}${s.kitchenTool.slice(1)} is getting a lot of use for the ${s.cuisine} recipes` },
    { slots: ['foodShop', 'ingredient'], render: (s) => `${s.foodShop[0].toUpperCase()}${s.foodShop.slice(1)} is the only place that stocks decent ${s.ingredient}` },
    { slots: ['mealType'], render: (s) => `${s.mealType[0].toUpperCase()}${s.mealType.slice(1)} has become the default option on busy days` },
  ],

  family: [
    { slots: ['relative', 'familyEvent'], render: (s) => `${s.relative[0].toUpperCase()}${s.relative.slice(1)} is hosting ${s.familyEvent} this year` },
    { slots: ['familyTradition'], render: (s) => `${s.familyTradition[0].toUpperCase()}${s.familyTradition.slice(1)} is back on the calendar for this year` },
    { slots: ['familyTask', 'relative'], render: (s) => `${s.familyTask[0].toUpperCase()}${s.familyTask.slice(1)} got assigned to ${s.relative} this time around` },
    { slots: ['relative', 'giftOccasion'], render: (s) => `Need to sort something out for ${s.relative}'s upcoming ${s.giftOccasion}` },
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
