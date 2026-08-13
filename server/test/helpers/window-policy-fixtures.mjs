// Shared fixtures for the window-policy case table. One fixed window, items relative to it.
export const WINDOW = Object.freeze({ start: Date.UTC(2026, 6, 13), end: Date.UTC(2026, 6, 19, 23, 59, 59, 999) }); // 2026-07-13..19
export const IN_MS = Date.UTC(2026, 6, 15, 12);
export const OUT_MS = Date.UTC(2026, 4, 1, 12); // ~2.4 months before — deep demotion, clamps at the DEMOTION_FLOOR
export const dated = (id, score, ms) => ({ id, score, metadata: { valid_from: new Date(ms).toISOString() } });
export const undated = (id, score) => (score === undefined ? { id, metadata: {} } : { id, score, metadata: {} });
/** Numeric-nonzero mixed pool — LOAD-BEARING for RCW2's must-pass set (spec §6.1 W1). */
export const mixedPool = () => [
  dated('d-in', 0.9, IN_MS), dated('d-out', 0.7, OUT_MS),
  undated('u-high', 0.8), undated('u-low', 0.2),
];
