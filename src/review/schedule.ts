/**
 * SM-2 with four grades. Anki descends from the same algorithm, so intervals
 * stay recognisable if a deck is exported there later.
 */

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

/** Scheduling state, persisted in a word note's frontmatter. */
export interface ReviewState {
	/** Days until the next review. 0 means the card is still being learned. */
	interval: number;
	/** Higher ease grows the interval faster. */
	ease: number;
	/** Consecutive successes. Reset to 0 on a lapse. */
	reps: number;
	/** How often the card was forgotten after having been learned. */
	lapses: number;
	/** `YYYY-MM-DD`; the first day the card comes back. */
	due: string;
}

export const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.2;
/** Beyond a year the exact number stops carrying information. */
const MAX_INTERVAL = 365;

/** A card that survives this long is mature enough to call 掌握. */
export const GRADUATION_DAYS = 21;

const EASE_DELTA: Record<ReviewGrade, number> = {
	again: -0.2,
	hard: -0.15,
	good: 0,
	easy: 0.15,
};

const DAY_MS = 86_400_000;

/** Local date, because a learner's day ends at their midnight, not UTC's. */
export function todayString(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function isDateString(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Dates are added in UTC so a DST shift cannot swallow or repeat a day. */
export function addDays(date: string, days: number): string {
	const parsed = Date.parse(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed)) {
		throw new Error(`无效日期：${date}`);
	}
	return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
	const start = Date.parse(`${from}T00:00:00Z`);
	const end = Date.parse(`${to}T00:00:00Z`);
	if (Number.isNaN(start) || Number.isNaN(end)) {
		return 0;
	}
	return Math.round((end - start) / DAY_MS);
}

export function newReviewState(today: string): ReviewState {
	return { interval: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0, due: today };
}

/** Overdue cards count as due, so a skipped week does not strand them. */
export function isDue(state: ReviewState, today: string): boolean {
	return daysBetween(state.due, today) >= 0;
}

function clampEase(value: number): number {
	return Math.min(MAX_EASE, Math.max(MIN_EASE, Number(value.toFixed(2))));
}

function nextInterval(
	state: ReviewState,
	grade: Exclude<ReviewGrade, 'again'>,
	ease: number,
): number {
	if (state.reps === 0) {
		return grade === 'easy' ? 4 : 1;
	}
	if (state.reps === 1) {
		return grade === 'hard' ? 3 : grade === 'easy' ? 10 : 6;
	}
	const base = Math.max(1, state.interval);
	const factor = grade === 'hard' ? 1.2 : grade === 'easy' ? ease * 1.3 : ease;
	// Always move forward: rounding alone can leave a short interval in place.
	const grown = Math.max(state.interval + 1, Math.round(base * factor));
	return Math.min(MAX_INTERVAL, grown);
}

export function gradeReview(
	state: ReviewState,
	grade: ReviewGrade,
	today: string,
): ReviewState {
	const ease = clampEase(state.ease + EASE_DELTA[grade]);
	if (grade === 'again') {
		// Due today keeps the card in this session and in tomorrow's queue if
		// the session is abandoned.
		return { interval: 0, ease, reps: 0, lapses: state.lapses + 1, due: today };
	}
	const interval = nextInterval(state, grade, ease);
	return {
		interval,
		ease,
		reps: state.reps + 1,
		lapses: state.lapses,
		due: addDays(today, interval),
	};
}

/** What a spelling attempt says about recall, so nobody has to self-report. */
export function gradeFromSpelling(input: {
	correct: boolean;
	attempts: number;
	revealed: boolean;
}): ReviewGrade {
	if (!input.correct || input.revealed) {
		return 'again';
	}
	return input.attempts > 1 ? 'hard' : 'good';
}

export function hasGraduated(state: ReviewState): boolean {
	return state.interval >= GRADUATION_DAYS;
}

export function parseReviewState(
	frontmatter: Record<string, unknown>,
	fallbackDue: string,
): ReviewState {
	const number = (value: unknown, fallback: number): number =>
		typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return {
		interval: Math.max(0, Math.round(number(frontmatter.interval, 0))),
		ease: clampEase(number(frontmatter.ease, DEFAULT_EASE)),
		reps: Math.max(0, Math.round(number(frontmatter.reps, 0))),
		lapses: Math.max(0, Math.round(number(frontmatter.lapses, 0))),
		due: isDateString(frontmatter.due) ? frontmatter.due : fallbackDue,
	};
}

/** Human summary for the card footer, e.g. 「3 天后」. */
export function describeDue(state: ReviewState, today: string): string {
	const days = daysBetween(today, state.due);
	if (days <= 0) {
		return '今天';
	}
	if (days === 1) {
		return '明天';
	}
	return `${days} 天后`;
}
