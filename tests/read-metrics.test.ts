import { describe, expect, it } from 'vitest';
import type { DictionaryLookup } from '../src/dictionary';
import {
	frequencyRank,
	readingMetrics,
	shouldHintWord,
} from '../src/read/metrics';

function lookup(word: string, bnc: number | null, frq: number | null): DictionaryLookup {
	return {
		surface: word,
		lemma: word,
		match: 'direct',
		entry: {
			lookup: word,
			word,
			phonetic: '',
			pos: '',
			translations: [],
			definition: '',
			tags: [],
			collins: null,
			oxford: false,
			bnc,
			frq,
		},
	};
}

describe('reading metrics', () => {
	it('uses the better corpus rank', () => {
		expect(frequencyRank(lookup('word', 4200, 2100))).toBe(2100);
		expect(frequencyRank(null)).toBeNull();
	});

	it('calculates text coverage by occurrences and saved words by unique form', () => {
		const counts = new Map([
			['common', 8],
			['rare', 2],
		]);
		const lookups = new Map([
			['common', lookup('common', 100, null)],
			['rare', lookup('rare', 9000, null)],
		]);
		const metrics = readingMetrics(counts, lookups, (word) =>
			word === 'rare' ? 'learning' : null,
		);

		expect(metrics).toEqual({
			tokenCount: 10,
			commonTokenCount: 8,
			commonPercent: 80,
			savedWords: 1,
		});
	});

	it('only hints untracked dictionary words outside the selected rank', () => {
		const rare = lookup('rare', 9000, null);
		expect(shouldHintWord(rare, null, 5000)).toBe(true);
		expect(shouldHintWord(rare, 'new', 5000)).toBe(false);
		expect(shouldHintWord(rare, null, 0)).toBe(false);
		expect(shouldHintWord(null, null, 5000)).toBe(false);
	});
});
