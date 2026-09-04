// server/test/ranking-relative.test.mjs — the relative undated-imputation policy (#297):
// runs the shared table-resident R cases (R1, R2, R3-pure, R4, R5, R9, R12, R13) against the
// real lib/ranking.mjs. The case bodies live in ./helpers/relative-imputation-cases.mjs
// because test/red-controls/run.mjs runs the SAME table against deliberately-broken copies
// of ranking.mjs (RCR1-RCR6) to prove each case can actually fail.

import { test } from 'node:test';

import * as ranking from '../lib/ranking.mjs';
import { applyTemporalDecay } from '../lib/ranking.mjs';
import { CASES } from './helpers/relative-imputation-cases.mjs';

for (const [id, subCases] of Object.entries(CASES)) {
  for (const [label, run] of subCases) {
    test(`${id}: ${label}`, () => run(applyTemporalDecay, ranking));
  }
}
