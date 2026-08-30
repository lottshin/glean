import { describe, expect, it } from 'vitest';
import {
	buildDictCells,
	isComplete,
	isTypedChar,
	nextDisplayIndex,
	normalizeChar,
} from '../src/media/dictation';

describe('dictation normalize', () => {
	it('only letters and digits need typing', () => {
		expect(isTypedChar('A')).toBe(true);
		expect(isTypedChar('9')).toBe(true);
		expect(isTypedChar(',')).toBe(false);
		expect(isTypedChar(' ')).toBe(false);
		expect(normalizeChar('H')).toBe('h');
	});
});

describe('buildDictCells', () => {
	it('maps typed chars onto a normalized string', () => {
		const { cells, norm } = buildDictCells('Hello, world!');
		expect(norm).toBe('helloworld');
		expect(cells).toHaveLength(13);
		expect(cells[0]).toEqual({ ch: 'H', normIndex: 0 });
		expect(cells[5]).toEqual({ ch: ',', normIndex: null });
		expect(cells[7]).toEqual({ ch: 'w', normIndex: 5 });
	});
});

describe('nextDisplayIndex / isComplete', () => {
	it('skips punctuation when finding the cursor', () => {
		const { cells, norm } = buildDictCells('Hi!');
		expect(nextDisplayIndex(cells, 0)).toBe(0);
		expect(nextDisplayIndex(cells, 1)).toBe(1);
		expect(nextDisplayIndex(cells, 2)).toBe(3);
		expect(isComplete(2, norm.length)).toBe(true);
		expect(isComplete(1, norm.length)).toBe(false);
	});
});
