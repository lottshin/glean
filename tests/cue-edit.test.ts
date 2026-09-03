import { describe, expect, it } from 'vitest';
import {
	explainSplitCueFailure,
	mergeCueWithNext,
	nudgeCueEdge,
	splitCueAtMidpoint,
	splitCueBeforeWord,
} from '../src/media/cue-edit';
import { parseSubtitles, serializeSubtitles } from '../src/media/srt';
import type { Cue } from '../src/media/types';
import {
	alignWordsFromTimeline,
	formatGleanTimelineNote,
	hydrateCueWordsFromTimeline,
} from '../src/media/word-timeline';

function cues(...rows: Array<[number, number, string]>): Cue[] {
	return rows.map(([start, end, text], index) => ({ index, start, end, text }));
}

describe('cue edit', () => {
	it('merges with the next cue and keeps the outer timestamps', () => {
		const next = mergeCueWithNext(
			cues([0, 2, 'Hey everyone,'], [2, 4, 'I am Ingrid'], [4, 6, 'later']),
			0,
		);
		expect(next?.map((cue) => cue.text)).toEqual(['Hey everyone, I am Ingrid', 'later']);
		expect(next?.[0]).toMatchObject({ start: 0, end: 4, index: 0 });
		expect(next?.[1]?.index).toBe(1);
	});

	it('refuses to invent time when word clocks are missing', () => {
		expect(
			splitCueBeforeWord(cues([0, 4, 'Hey everyone I am Ingrid']), 0, 2),
		).toBeNull();
		expect(
			explainSplitCueFailure(cues([0, 4, 'Hey everyone I am Ingrid']), 0, 2),
		).toBe('missing-word-clocks');
	});

	it('manual split lands on the real ASR start of the cut word', () => {
		const source: Cue[] = [
			{
				index: 0,
				start: 2.72,
				end: 32,
				text: 'all right welcome to China',
				words: [
					{ text: 'all', start: 2.72 },
					{ text: 'right', start: 3.52 },
					{ text: 'welcome', start: 7.311 },
					{ text: 'to', start: 7.6 },
					{ text: 'China', start: 7.9 },
				],
			},
		];
		const next = splitCueBeforeWord(source, 0, 2);
		expect(next?.[0]?.text).toBe('all right');
		expect(next?.[1]?.text).toBe('welcome to China');
		expect(next?.[1]?.start).toBeCloseTo(7.311, 2);
		expect(next?.[0]?.end).toBeCloseTo(7.311, 2);
	});

	it('refuses the Shanghai short-opener long-span case without clocks', () => {
		expect(
			splitCueBeforeWord(cues([2.72, 32, 'all right welcome to China']), 0, 2),
		).toBeNull();
	});

	it('refuses to split a one-word cue', () => {
		expect(splitCueAtMidpoint(cues([0, 1, 'Ingrid']), 0)).toBeNull();
	});

	it('nudges start and end without inverting the span', () => {
		const source = cues([1, 3, 'hello there']);
		const later = nudgeCueEdge(source, 0, 'start', 0.4);
		expect(later?.[0]?.start).toBeCloseTo(1.4);
		const earlier = nudgeCueEdge(source, 0, 'end', -2);
		expect(earlier?.[0]?.end).toBeCloseTo(1.25);
		expect(nudgeCueEdge(source, 0, 'start', -8)?.[0]?.start).toBe(0);
	});
});

describe('word timeline', () => {
	it('hydrates cue words from a file-level timeline after clocks were lost', () => {
		const timeline = [
			{ text: 'all', start: 2.72 },
			{ text: 'right', start: 3.52 },
			{ text: 'welcome', start: 7.311 },
			{ text: 'to', start: 7.6 },
			{ text: 'China', start: 7.9 },
		];
		const aligned = alignWordsFromTimeline(
			'all right welcome to China',
			2.72,
			timeline,
		);
		expect(aligned?.[2]?.start).toBeCloseTo(7.311, 2);

		const hydrated = hydrateCueWordsFromTimeline(
			[{ index: 0, start: 2.72, end: 32, text: 'all right welcome to China' }],
			timeline,
		);
		const next = splitCueBeforeWord(hydrated, 0, 2);
		expect(next?.[1]?.start).toBeCloseTo(7.311, 2);
	});

	it('round-trips timeline through serialize/parse so re-open can rehydrate', () => {
		const source: Cue[] = [
			{
				index: 0,
				start: 2.72,
				end: 8.5,
				text: 'all right welcome to China',
				words: [
					{ text: 'all', start: 2.72 },
					{ text: 'right', start: 3.52 },
					{ text: 'welcome', start: 7.311 },
					{ text: 'to', start: 7.6 },
					{ text: 'China', start: 7.9 },
				],
			},
		];
		const body = serializeSubtitles(source, 'vtt');
		expect(body).toContain('NOTE glean-timeline');
		expect(formatGleanTimelineNote(source[0]!.words!).startsWith('NOTE glean-timeline')).toBe(
			true,
		);

		// Strip per-cue glean-words to simulate an older edited file that only
		// kept the timeline header — parse must still recover clocks.
		const withoutCueWords = body
			.split('\n')
			.filter((line) => !/^NOTE glean-words\b/i.test(line))
			.join('\n');
		const parsed = parseSubtitles(withoutCueWords);
		expect(parsed[0]?.words?.[2]?.start).toBeCloseTo(7.311, 2);
		expect(splitCueBeforeWord(parsed, 0, 2)?.[1]?.start).toBeCloseTo(7.311, 2);
	});
});
