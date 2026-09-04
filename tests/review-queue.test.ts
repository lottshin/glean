import { describe, expect, it } from 'vitest';

import {
	BLANK,
	buildReviewQueue,
	dueCards,
	maskWord,
	parseReviewPrompt,
	parseSense,
	reviewQueueStats,
	splitOnBlank,
	type ReviewCard,
} from '../src/review/queue';
import { DEFAULT_EASE, type ReviewState } from '../src/review/schedule';
import { isAcceptedSpelling } from '../src/views/review';

const TODAY = '2026-09-04';

function card(overrides: Partial<ReviewCard> & { lemma: string }): ReviewCard {
	const review: ReviewState = {
		interval: 0,
		ease: DEFAULT_EASE,
		reps: 0,
		lapses: 0,
		due: TODAY,
		...overrides.review,
	};
	return {
		path: `Glean/Words/${overrides.lemma[0]}/${overrides.lemma}.md`,
		forms: [],
		status: 'new',
		...overrides,
		review,
	};
}

describe('queue selection', () => {
	it('drops ignored cards but keeps graduated ones that came due', () => {
		const cards = [
			card({ lemma: 'go' }),
			card({ lemma: 'skip', status: 'ignored' }),
			card({
				lemma: 'mature',
				status: 'known',
				review: { interval: 30, ease: 2.5, reps: 6, lapses: 0, due: TODAY },
			}),
		];
		expect(dueCards(cards, TODAY).map((item) => item.lemma)).toEqual([
			'go',
			'mature',
		]);
	});

	it('holds back cards scheduled for a later day', () => {
		const cards = [
			card({ lemma: 'now' }),
			card({
				lemma: 'later',
				review: { interval: 6, ease: 2.5, reps: 2, lapses: 0, due: '2026-09-20' },
			}),
		];
		expect(dueCards(cards, TODAY).map((item) => item.lemma)).toEqual(['now']);
	});

	it('drains the oldest backlog first, hardest word breaking ties', () => {
		const cards = [
			card({ lemma: 'today' }),
			card({
				lemma: 'ancient',
				review: { interval: 1, ease: 2.5, reps: 1, lapses: 0, due: '2026-08-01' },
			}),
			card({
				lemma: 'stubborn',
				review: { interval: 1, ease: 1.8, reps: 1, lapses: 4, due: '2026-08-01' },
			}),
		];
		expect(
			buildReviewQueue(cards, { today: TODAY, limit: 0 }).map((item) => item.lemma),
		).toEqual(['stubborn', 'ancient', 'today']);
	});

	it('caps the session, and treats 0 as no cap', () => {
		const cards = ['a', 'b', 'c', 'd'].map((lemma) => card({ lemma }));
		expect(buildReviewQueue(cards, { today: TODAY, limit: 2 })).toHaveLength(2);
		expect(buildReviewQueue(cards, { today: TODAY, limit: 0 })).toHaveLength(4);
	});

	it('counts fresh and overdue separately', () => {
		const cards = [
			card({ lemma: 'fresh' }),
			card({
				lemma: 'late',
				review: { interval: 3, ease: 2.5, reps: 2, lapses: 1, due: '2026-08-20' },
			}),
			card({
				lemma: 'future',
				review: { interval: 9, ease: 2.5, reps: 3, lapses: 0, due: '2026-10-01' },
			}),
		];
		expect(reviewQueueStats(cards, TODAY)).toEqual({
			due: 2,
			fresh: 1,
			overdue: 1,
		});
	});
});

describe('masking', () => {
	it('blanks every inflection, longest first', () => {
		expect(maskWord('He goes where we go.', ['go', 'goes'])).toBe(
			`He ${BLANK} where we ${BLANK}.`,
		);
	});

	it('ignores the word inside a longer one', () => {
		expect(maskWord('The goal is good.', ['go'])).toBe('The goal is good.');
	});

	it('matches regardless of case', () => {
		expect(maskWord('Went home. We went back.', ['went'])).toBe(
			`${BLANK} home. We ${BLANK} back.`,
		);
	});

	it('treats a form with regex characters literally', () => {
		expect(maskWord('a c++ thing', ['c++'])).toBe(`a ${BLANK} thing`);
	});

	it('splits into the runs around each gap', () => {
		expect(splitOnBlank(maskWord('We went home.', ['went']))).toEqual([
			'We ',
			' home.',
		]);
	});
});

describe('sense parsing', () => {
	it('separates a part-of-speech marker from the meaning', () => {
		expect(parseSense('n. 支架, 括弧, 托架')).toEqual({
			pos: 'n.',
			gloss: '支架, 括弧, 托架',
		});
		expect(parseSense('vt. 装托架')).toEqual({ pos: 'vt.', gloss: '装托架' });
	});

	it('handles a bracketed domain label', () => {
		expect(parseSense('[计] 方括号; 括号')).toEqual({
			pos: '[计]',
			gloss: '方括号; 括号',
		});
	});

	it('leaves a bare gloss alone', () => {
		expect(parseSense('去；离开')).toEqual({ pos: '', gloss: '去；离开' });
	});

	it('does not mistake an English gloss for a marker', () => {
		expect(parseSense('move from one place to another')).toEqual({
			pos: '',
			gloss: 'move from one place to another',
		});
	});
});

describe('prompt parsing', () => {
	const note = [
		'---',
		'glean: true',
		'---',
		'',
		'# go',
		'',
		'> 去；离开',
		'',
		'## Senses',
		'',
		'- 去；离开',
		'- 进行',
		'',
		'## Contexts',
		'<!-- glean-contexts -->',
		'',
		'- [[Media/talk.mp4]] — "Nothing to see."',
		'- [00:12](obsidian://glean?src=x&t=12) · [[Media/talk.mp4]] — "We went home."',
		'',
	].join('\n');

	it('reads the senses list', () => {
		expect(parseReviewPrompt(note, ['go', 'went']).senses).toEqual([
			'去；离开',
			'进行',
		]);
	});

	it('picks the example that contains the word and blanks it', () => {
		expect(parseReviewPrompt(note, ['go', 'went']).sentence).toBe(
			`We ${BLANK} home.`,
		);
	});

	it('returns no sentence when no example contains the word', () => {
		expect(parseReviewPrompt(note, ['absent']).sentence).toBeNull();
	});

	it('survives a card with no contexts section', () => {
		const bare = '---\nglean: true\n---\n\n# go\n\n## Senses\n\n- 去\n';
		expect(parseReviewPrompt(bare, ['go'])).toEqual({
			senses: ['去'],
			sentence: null,
		});
	});

	it('stops at the next heading instead of swallowing it', () => {
		const extra = `${note}\n## Notes\n\n- 不该被当成例句\n`;
		expect(parseReviewPrompt(extra, ['go', 'went']).senses).toEqual([
			'去；离开',
			'进行',
		]);
	});
});

describe('spelling check', () => {
	const target = { lemma: 'go', forms: ['went', 'gone'] };

	it('accepts the lemma', () => {
		expect(isAcceptedSpelling('go', target)).toBe(true);
	});

	it('accepts an inflection, since the sentence may call for one', () => {
		expect(isAcceptedSpelling('went', target)).toBe(true);
		expect(isAcceptedSpelling('gone', target)).toBe(true);
	});

	it('ignores case and stray whitespace', () => {
		expect(isAcceptedSpelling('  GO ', target)).toBe(true);
	});

	it('rejects a near miss', () => {
		expect(isAcceptedSpelling('goe', target)).toBe(false);
		expect(isAcceptedSpelling('going', target)).toBe(false);
	});

	it('rejects an empty answer', () => {
		expect(isAcceptedSpelling('   ', target)).toBe(false);
	});
});
