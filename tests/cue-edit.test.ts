import { describe, expect, it } from 'vitest';
import {
	mergeCueWithNext,
	nudgeCueEdge,
	splitCueAtMidpoint,
	splitCueBeforeWord,
} from '../src/media/cue-edit';
import type { Cue } from '../src/media/types';

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

	it('splits before a selected word and interpolates time', () => {
		const next = splitCueBeforeWord(
			cues([0, 4, 'Hey everyone I am Ingrid']),
			0,
			2,
		);
		expect(next).toHaveLength(2);
		expect(next?.[0]?.text).toBe('Hey everyone');
		expect(next?.[1]?.text).toBe('I am Ingrid');
		expect(next?.[1]?.start ?? 0).toBeGreaterThan(0);
		expect(next?.[0]?.end).toBe(next?.[1]?.start);
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
