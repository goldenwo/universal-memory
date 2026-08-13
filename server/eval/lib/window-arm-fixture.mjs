// window-arm-fixture.mjs — pure resolution + validation for the window-arm fixture.
// Spec: docs/plans/2026-08-12-window-undated-joint-imputation-spec.md §7.2 (F1/F2).
// F2 is satisfied BY CONSTRUCTION: `days_ago: null` derives the midpoint of the row's own
// parsed window, so calendar-anchored kinds stay in-window at any run time. The assertions
// here are regression tripwires, not the mechanism.
import { parseTemporalWindow } from '../../lib/temporal-query.mjs';

const DAY_MS = 86400000;

/** Allowed kinds (spec §7.2) — today/yesterday/this_* excluded. Membership alone does NOT
 *  guarantee the span ('last 3 days' is kind last_n): the span floor is enforced below. */
export const WINDOW_ARM_ALLOWED_KINDS = Object.freeze(
  ['since_date', 'in_month', 'last_n', 'last_week', 'last_month'],
);
const MIN_SPAN_MS = 7 * DAY_MS - 1; // >= 7 days, tolerant of inclusive-end windows

export function resolveWindowRows(rows, { now } = {}) {
  if (!Number.isFinite(now)) throw new Error('window-arm fixture: `now` must be finite — the one-clock guard');
  const windowsByRowId = {};
  const resolved = (rows ?? []).map((row) => {
    const w = parseTemporalWindow(row.query, { now });
    if (!w) throw new Error(`window-arm fixture: ${row.id} query does not parse to a window`);
    if (!WINDOW_ARM_ALLOWED_KINDS.includes(w.kind)) {
      throw new Error(`window-arm fixture: ${row.id} kind '${w.kind}' not allowed (span >= 7 days only)`);
    }
    if (w.end - w.start < MIN_SPAN_MS) {
      throw new Error(`window-arm fixture: ${row.id} window span < 7 days — kind membership does not floor the span ('last 3 days' is last_n)`);
    }
    windowsByRowId[row.id] = w;
    const facts = row.seed_facts ?? [];
    if (row.undated_gold && facts.length !== 2) {
      throw new Error(`window-arm fixture: ${row.id} undated_gold rows need exactly one dated companion`);
    }
    if (!row.undated_gold && facts.length !== 1) {
      throw new Error(`window-arm fixture: ${row.id} dated rows carry a single in-window target`);
    }
    const midDays = (now - (w.start + w.end) / 2) / DAY_MS;
    const seed_facts = facts.map((f, i) => {
      const days_ago = f.days_ago === null ? midDays : f.days_ago;
      // The target of an undated_gold row will be STRIPPED, so its date needs no window
      // check. Every date that survives (companions; dated targets) must sit in-window.
      const mustBeInWindow = !(row.undated_gold && i === 0);
      if (mustBeInWindow) {
        const ms = now - days_ago * DAY_MS;
        if (ms < w.start || ms > w.end) {
          throw new Error(`window-arm fixture: ${row.id} seed_facts[${i}] (days_ago ${days_ago}) is outside its window`);
        }
      }
      return { ...f, days_ago };
    });
    return { ...row, seed_facts };
  });
  return { rows: resolved, windowsByRowId };
}
