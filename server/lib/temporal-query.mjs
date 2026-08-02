/**
 * temporal-query.mjs — deterministic date-expression parsing for the read path.
 *
 * Spec: docs/plans/2026-08-01-temporal-query-v1-spec.md, decision D-d.
 *
 * Resolves a bounded inventory of time phrases in a search query into a UTC
 * window. Pure, no I/O, no dependency, no LLM — an LLM pass per search is a
 * rejected shape (the parked read-path bouncer's cost/latency precedent).
 *
 * Contract:
 *   parseTemporalWindow(query, { now }) → { start, end, kind, matched } | null
 *
 * `null` means "no window" and callers must treat it as today's behavior. The
 * body is wrapped so ANY throw degrades to null — a parser bug must never be
 * able to fail a search.
 *
 * Two safety properties are structural, not incidental:
 *
 *   1. Input is capped at TEMPORAL_PARSE_MAX_CHARS before any regex runs. The
 *      query is attacker-controlled on every surface and the request body cap
 *      is 2 MB; V8's regex engine backtracks with no timeout, so an unbounded
 *      scan on the hottest path is a DoS vector. Capping makes per-request
 *      parse cost constant.
 *   2. No pattern may contain a nested quantifier or an unbounded alternation
 *      over \s/\w. Enforced by test (syntactic tripwire + measured timing),
 *      because one catastrophic pattern hangs the whole single-threaded process.
 *
 * All arithmetic is UTC epoch-ms via Date.UTC component math — never local-time
 * constructors, never string slicing. `valid_from` is stored as ISO-8601 UTC,
 * so the window and the corpus share one clock.
 */

/** Match only over this prefix of the query. See safety property 1 above. */
export const TEMPORAL_PARSE_MAX_CHARS = 512;

/** Upper bound on N in "last N days|weeks|months" — an unbounded N overflows
 *  Date.UTC component math to NaN, which would reach the wire as null scores. */
export const MAX_RELATIVE_N = 3650;

const MONTHS = [
	'january', 'february', 'march', 'april', 'may', 'june',
	'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ALT = MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|');

const DAY_MS = 86400000;
const endOfDay = (ms) => ms + DAY_MS - 1;

const startOfUTCDay = (ms) => {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const startOfUTCMonth = (ms) => {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const startOfUTCYear = (ms) => Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);

/** Monday 00:00 UTC of the ISO week containing `ms`. getUTCDay(): 0=Sun. */
const startOfISOWeek = (ms) => {
	const day = new Date(ms).getUTCDay();
	const backToMonday = (day + 6) % 7;
	return startOfUTCDay(ms) - backToMonday * DAY_MS;
};

/** Full calendar month containing `ms`, as [start, end]. */
const monthSpan = (year, monthIdx) => [
	Date.UTC(year, monthIdx, 1),
	Date.UTC(year, monthIdx + 1, 1) - 1,
];

/**
 * Subtract `n` calendar months, clamping to the target month's last day.
 * 2026-03-31 minus 1 month is 2026-02-28, not an overflow into March.
 */
const minusMonths = (ms, n) => {
	const d = new Date(ms);
	const targetMonth = d.getUTCMonth() - n;
	const year = d.getUTCFullYear() + Math.floor(targetMonth / 12);
	const month = ((targetMonth % 12) + 12) % 12;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return Date.UTC(
		year, month, Math.min(d.getUTCDate(), lastDay),
		d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
	);
};

/** Parse YYYY-MM-DD as UTC midnight; null unless it is a real calendar date. */
const parseISODate = (y, m, d) => {
	const year = Number(y), month = Number(m), day = Number(d);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const ms = Date.UTC(year, month - 1, day);
	const back = new Date(ms);
	// Rejects 2026-02-31 and friends, which Date.UTC would silently roll over.
	if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
	return ms;
};

/**
 * Pattern table, tried in order — most specific first, FIRST MATCH WINS and the
 * rest are ignored. Order is the whole disambiguation rule, so it is data, not
 * control flow, and the tests assert it directly.
 *
 * Exported so the ReDoS constraint tests can inspect every pattern source.
 */
export const TEMPORAL_PATTERNS = Object.freeze([
	{
		kind: 'on_date',
		re: /\bon (\d{4})-(\d{2})-(\d{2})\b/i,
		resolve: (m) => {
			const start = parseISODate(m[1], m[2], m[3]);
			return start === null ? null : { start, end: endOfDay(start) };
		},
	},
	{
		kind: 'since_date',
		re: /\bsince (\d{4})-(\d{2})-(\d{2})\b/i,
		resolve: (m, now) => {
			const start = parseISODate(m[1], m[2], m[3]);
			return start === null ? null : { start, end: now };
		},
	},
	{
		// Preposition REQUIRED. This is the load-bearing false-positive guard:
		// a bare "March" (project name, "the March release notes") must not
		// mint a window. Costs nothing, removes the dominant failure mode.
		kind: 'in_month',
		re: new RegExp(`\\b(?:in|during) (${MONTH_ALT})(?: (\\d{4}))?\\b`, 'i'),
		resolve: (m, now) => {
			const monthIdx = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3)));
			if (monthIdx < 0) return null;
			if (m[2]) return monthSpan(Number(m[2]), monthIdx);
			// No explicit year: the most recent occurrence at or before `now`.
			// In January, "in December" means last December.
			const d = new Date(now);
			const year = d.getUTCFullYear() - (monthIdx > d.getUTCMonth() ? 1 : 0);
			return monthSpan(year, monthIdx);
		},
	},
	{
		kind: 'last_n',
		re: /\b(?:last|past) (\d{1,10}) (day|week|month)s?\b/i,
		resolve: (m, now) => {
			const n = Number(m[1]);
			if (!Number.isFinite(n) || n < 1 || n > MAX_RELATIVE_N) return null;
			const unit = m[2].toLowerCase();
			if (unit === 'month') return { start: minusMonths(now, n), end: now };
			const days = unit === 'week' ? n * 7 : n;
			return { start: now - days * DAY_MS, end: now };
		},
	},
	{
		kind: 'yesterday',
		re: /\byesterday\b/i,
		resolve: (_m, now) => {
			const start = startOfUTCDay(now) - DAY_MS;
			return { start, end: endOfDay(start) };
		},
	},
	{
		kind: 'today',
		re: /\btoday\b/i,
		resolve: (_m, now) => ({ start: startOfUTCDay(now), end: now }),
	},
	{
		kind: 'last_week',
		re: /\blast week\b/i,
		resolve: (_m, now) => {
			const start = startOfISOWeek(now) - 7 * DAY_MS;
			return { start, end: start + 7 * DAY_MS - 1 };
		},
	},
	{
		// End edge is `now`, never the end of the period — the window must not
		// extend into the future, so a just-captured item is always inside it.
		kind: 'this_week',
		re: /\bthis week\b/i,
		resolve: (_m, now) => ({ start: startOfISOWeek(now), end: now }),
	},
	{
		kind: 'last_month',
		re: /\blast month\b/i,
		resolve: (_m, now) => {
			const d = new Date(startOfUTCMonth(now));
			return monthSpan(d.getUTCFullYear(), d.getUTCMonth() - 1);
		},
	},
	{
		kind: 'this_month',
		re: /\bthis month\b/i,
		resolve: (_m, now) => ({ start: startOfUTCMonth(now), end: now }),
	},
	{
		kind: 'last_year',
		re: /\blast year\b/i,
		resolve: (_m, now) => {
			const year = new Date(now).getUTCFullYear() - 1;
			return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) - 1 };
		},
	},
	{
		kind: 'this_year',
		re: /\bthis year\b/i,
		resolve: (_m, now) => ({ start: startOfUTCYear(now), end: now }),
	},
]);

/**
 * The bounded vocabulary written into the counters table's `outcome` column.
 *
 * Immutable deliberately: `outcome` is part of the counters PRIMARY KEY and,
 * unlike `surface`, carries no length cap. A future pattern emitting an
 * interpolated kind would mint one durable row per distinct query on a table
 * with 400d retention, and the fire-and-forget writer would fail silently while
 * doing it.
 *
 * A frozen ARRAY, not a frozen Set — `Object.freeze(new Set(…))` does not
 * prevent `.add()`, so a "frozen" Set would have advertised a guarantee it does
 * not provide. Caught by the vocabulary test.
 */
export const TEMPORAL_KINDS = Object.freeze(TEMPORAL_PATTERNS.map((p) => p.kind));

/** Membership check for the bounded vocabulary — the telemetry seam's gate. */
export function isTemporalKind(kind) {
	return TEMPORAL_KINDS.includes(kind);
}

/**
 * Blank out quoted spans so a temporal phrase inside quotes cannot mint a
 * window: `what did we decide "last week" about X` is asking for the literal
 * string, not filtering by time. Replaced with spaces rather than removed so
 * every surviving offset still lines up with the original text.
 */
export const QUOTE_SPAN_PATTERN = /(?:"[^"\n]*"|`[^`\n]*`|(?<=^|\s)'[^'\n]*'(?=\s|$|[.,;:!?]))/g;

function blankQuotedSpans(text) {
	return text.replace(QUOTE_SPAN_PATTERN, (m) => ' '.repeat(m.length));
}

/**
 * Resolve a time expression in `query` to a UTC window.
 *
 * @param {string} query
 * @param {{ now?: number }} [opts] - `now` is the reference instant (DI seam for
 *   deterministic tests and eval reproducibility; there is no public API param).
 * @returns {{ start: number, end: number, kind: string, matched: string } | null}
 */
export function parseTemporalWindow(query, { now = Date.now() } = {}) {
	try {
		if (typeof query !== 'string' || query.length === 0) return null;
		if (!Number.isFinite(now)) return null;
		const text = blankQuotedSpans(query.slice(0, TEMPORAL_PARSE_MAX_CHARS));

		for (const { kind, re, resolve } of TEMPORAL_PATTERNS) {
			const m = re.exec(text);
			if (!m) continue;
			const span = resolve(m, now);
			// A matched-but-unresolvable phrase (2026-02-31, an out-of-range N)
			// falls through to "no window" rather than to a later pattern — the
			// caller's phrase was temporal, it just did not denote a real range.
			if (!span) return null;
			const [start, end] = Array.isArray(span) ? span : [span.start, span.end];
			if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
			return { start, end, kind, matched: m[0] };
		}
		return null;
	} catch {
		// Fail-open: any unexpected throw is "no window", i.e. today's behavior.
		return null;
	}
}
