// server/lib/bouncer.mjs — the read-path answer bouncer (spec 2026-06-22).
//
// Pure, injectable decision helper (the evaluateInBandSupersession pattern): given the
// SURFACED top-1 of a memory_search, decide whether to attach an advisory `answered:false`
// flag. NEVER mutates results — the caller owns the envelope + the metric. The ONLY live
// call site is the memory_search handler; the mq-eval calls this SAME function so the pinned
// gate is measured on the live path.
//
// Fail-open: any grader error/timeout → { answered:true, ok:false } (best-effort; an outage
// must never blank or wrongly flag a hot-path search). This INVERTS the offline grader's
// ok:false→"didn't answer" — deliberate (spec §2.3).
import { gradeAnswer as defaultGradeAnswer, TAU_ANSWER } from './answer-grader.mjs';

// Score gate: top hits scoring ABOVE this skip the LLM (trusted as answering). PROVISIONAL —
// pinned from the live sweep in P1 Task 4. Non-answers cluster in 0.30–0.45 (the parked
// no-answer-floor data); a gate above that band leaves them graded while clearly-strong hits
// skip. RE-EVAL TRIGGER: grader model OR text-embedding-3-small change → re-run the sweep.
export const BOUNCER_SCORE_GATE = 0.55;

// Opt-IN, default OFF (inverts the D1/D3 opt-OUT `!== 'false'` house convention — correct
// while the bouncer ships inert; flips to opt-out at the default-on decision). Trim-aware.
export function bouncerEnabled(env = process.env) {
  return env.UM_BOUNCER_ENABLED?.trim() === 'true';
}

export function bouncerTimeoutMs(env = process.env) {
  const n = parseInt(env.UM_BOUNCER_TIMEOUT_MS ?? '1500', 10);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('bouncer-timeout')), ms); });
  // The race loser (a slow grade) is discarded: when `timer` rejects we reject the race and
  // the late grade resolution has nothing attached — it can never mutate the returned value.
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/**
 * @param {string} query
 * @param {{score?:number, body?:string}|undefined} topItem  the SURFACED (post-filter) top-1
 * @param {object} [opts]
 * @returns {Promise<{answered:boolean, ok:boolean, graded:boolean, skippedHigh?:boolean}>}
 */
export async function bounceTopHit(query, topItem, {
  enabled = bouncerEnabled(),
  high = BOUNCER_SCORE_GATE,
  tau = TAU_ANSWER,
  timeoutMs = bouncerTimeoutMs(),
  gradeAnswer = defaultGradeAnswer,
} = {}) {
  if (!enabled || !topItem) return { answered: true, ok: true, graded: false };
  if (typeof topItem.score === 'number' && topItem.score > high) {
    return { answered: true, ok: true, graded: false, skippedHigh: true };
  }
  let v;
  try {
    v = await withTimeout(gradeAnswer(query, topItem.body ?? '', {}), timeoutMs);
  } catch {
    return { answered: true, ok: false, graded: true }; // fail-open (timeout or throw)
  }
  if (!v || v.ok !== true) return { answered: true, ok: false, graded: true }; // fail-open
  return { answered: v.answers === true && v.confidence >= tau, ok: true, graded: true };
}
