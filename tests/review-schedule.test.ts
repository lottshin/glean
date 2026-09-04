import { describe, expect, it } from 'vitest';

import {
	addDays,
	daysBetween,
	describeDue,
	DEFAULT_EASE,
	gradeFromSpelling,
	gradeReview,
	hasGraduated,
	isDue,
	newReviewState,
	parseReviewState,
	todayString,
	type ReviewState,
} from '../src/review/schedule';

const TODAY = '2026-09-04';

describe('date helpers', () => {
	it('adds days across a month boundary', () => {
		expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
	});

	it('adds days across a DST change without losing one', () => {
		// US DST ends 2026-11-01; UTC arithmetic must not turn 7 days into 6.
		expect(addDays('2026-10-29', 7)).toBe('2026-11-05');
	});

	it('measures signed distance between days', () => {
		expect(daysBetween('2026-09-04', '2026-09-07')).toBe(3);
		expect(daysBetween('2026-09-07', '2026-09-04')).toBe(-3);
	});

	it('formats today from local time, not UTC', () => {
		expect(todayString(new Date(2026, 8, 4, 23, 30))).toBe('2026-09-04');
	});
});

describe('grading', () => {
	it('walks a new card through the 1/6 day learning steps', () => {
		const fresh = newReviewState(TODAY);
		expect(fresh.ease).toBe(DEFAULT_EASE);

		const first = gradeReview(fresh, 'good', TODAY);
		expect(first.interval).toBe(1);
		expect(first.reps).toBe(1);
		expect(first.due).toBe('2026-09-05');

		const second = gradeReview(first, 'good', '2026-09-05');
		expect(second.interval).toBe(6);
		expect(second.due).toBe('2026-09-11');

		const third = gradeReview(second, 'good', '2026-09-11');
		expect(third.interval).toBe(Math.round(6 * DEFAULT_EASE));
	});

	it('resets the interval and counts a lapse on again', () => {
		const mature: ReviewState = {
			interval: 30,
			ease: 2.5,
			reps: 5,
			lapses: 1,
			due: TODAY,
		};
		const lapsed = gradeReview(mature, 'again', TODAY);
		expect(lapsed.interval).toBe(0);
		expect(lapsed.reps).toBe(0);
		expect(lapsed.lapses).toBe(2);
		expect(lapsed.due).toBe(TODAY);
		expect(lapsed.ease).toBeLessThan(mature.ease);
	});

	it('always moves a mature interval forward, even on hard', () => {
		const state: ReviewState = {
			interval: 1,
			ease: 1.3,
			reps: 3,
			lapses: 0,
			due: TODAY,
		};
		expect(gradeReview(state, 'hard', TODAY).interval).toBeGreaterThan(1);
	});

	it('keeps ease inside its bounds', () => {
		let state = newReviewState(TODAY);
		for (let index = 0; index < 20; index += 1) {
			state = gradeReview(state, 'again', TODAY);
		}
		expect(state.ease).toBeGreaterThanOrEqual(1.3);

		let easy = newReviewState(TODAY);
		for (let index = 0; index < 20; index += 1) {
			easy = gradeReview(easy, 'easy', easy.due);
		}
		expect(easy.ease).toBeLessThanOrEqual(3.2);
	});

	it('caps the interval at a year', () => {
		let state: ReviewState = {
			interval: 300,
			ease: 3.2,
			reps: 9,
			lapses: 0,
			due: TODAY,
		};
		state = gradeReview(state, 'easy', TODAY);
		expect(state.interval).toBeLessThanOrEqual(365);
	});
});

describe('spelling to grade', () => {
	it('reads a clean first try as good', () => {
		expect(gradeFromSpelling({ correct: true, attempts: 1, revealed: false })).toBe(
			'good',
		);
	});

	it('reads a retry as hard', () => {
		expect(gradeFromSpelling({ correct: true, attempts: 2, revealed: false })).toBe(
			'hard',
		);
	});

	it('reads a reveal as again even when finally typed right', () => {
		expect(gradeFromSpelling({ correct: true, attempts: 1, revealed: true })).toBe(
			'again',
		);
		expect(gradeFromSpelling({ correct: false, attempts: 3, revealed: false })).toBe(
			'again',
		);
	});
});

describe('queue predicates', () => {
	it('treats overdue cards as due', () => {
		const state = { ...newReviewState(TODAY), due: '2026-08-01' };
		expect(isDue(state, TODAY)).toBe(true);
	});

	it('holds back cards scheduled for later', () => {
		const state = { ...newReviewState(TODAY), due: '2026-09-05' };
		expect(isDue(state, TODAY)).toBe(false);
	});

	it('graduates only once the interval is mature', () => {
		expect(hasGraduated({ ...newReviewState(TODAY), interval: 20 })).toBe(false);
		expect(hasGraduated({ ...newReviewState(TODAY), interval: 21 })).toBe(true);
	});
});

describe('frontmatter parsing', () => {
	it('fills defaults when the card has never been reviewed', () => {
		const state = parseReviewState({}, TODAY);
		expect(state).toEqual({
			interval: 0,
			ease: DEFAULT_EASE,
			reps: 0,
			lapses: 0,
			due: TODAY,
		});
	});

	it('ignores values a user mangled by hand', () => {
		const state = parseReviewState(
			{ interval: 'soon', ease: 99, reps: -4, due: '09/05/2026' },
			TODAY,
		);
		expect(state.interval).toBe(0);
		expect(state.ease).toBeLessThanOrEqual(3.2);
		expect(state.reps).toBe(0);
		expect(state.due).toBe(TODAY);
	});

	it('keeps a valid stored schedule', () => {
		const state = parseReviewState(
			{ interval: 6, ease: 2.36, reps: 2, lapses: 1, due: '2026-09-11' },
			TODAY,
		);
		expect(state).toEqual({
			interval: 6,
			ease: 2.36,
			reps: 2,
			lapses: 1,
			due: '2026-09-11',
		});
	});
});

describe('due description', () => {
	it('names the near days instead of counting them', () => {
		expect(describeDue({ ...newReviewState(TODAY), due: TODAY }, TODAY)).toBe('今天');
		expect(
			describeDue({ ...newReviewState(TODAY), due: '2026-09-05' }, TODAY),
		).toBe('明天');
		expect(
			describeDue({ ...newReviewState(TODAY), due: '2026-09-11' }, TODAY),
		).toBe('7 天后');
	});
});
