import type { DictionaryLookup } from '../dictionary';
import type { WordStatus } from '../lexicon/note';

export const READING_COVERAGE_RANK = 3000;
export const DEFAULT_READING_HINT_RANK: ReadingHintRank = 5000;

export type ReadingHintRank = 0 | 3000 | 5000 | 8000;

export interface ReadingMetrics {
	tokenCount: number;
	commonTokenCount: number;
	commonPercent: number;
	savedWords: number;
}

export function frequencyRank(lookup: DictionaryLookup | null): number | null {
	const ranks = [lookup?.entry?.bnc, lookup?.entry?.frq].filter(
		(rank): rank is number => rank !== null && rank !== undefined && rank > 0,
	);
	return ranks.length > 0 ? Math.min(...ranks) : null;
}

export function shouldHintWord(
	lookup: DictionaryLookup | null,
	status: WordStatus | null,
	hintRank: ReadingHintRank,
): boolean {
	if (hintRank === 0 || status !== null) {
		return false;
	}
	const rank = frequencyRank(lookup);
	return rank !== null && rank > hintRank;
}

/**
 * Text coverage uses occurrences rather than unique forms. It is a property
 * of the article and never guesses which words the reader knows.
 */
export function readingMetrics(
	counts: ReadonlyMap<string, number>,
	lookups: ReadonlyMap<string, DictionaryLookup | null>,
	statusOf: (word: string) => WordStatus | null,
): ReadingMetrics {
	let tokenCount = 0;
	let commonTokenCount = 0;
	let savedWords = 0;

	for (const [word, count] of counts) {
		tokenCount += count;
		const rank = frequencyRank(lookups.get(word) ?? null);
		if (rank !== null && rank <= READING_COVERAGE_RANK) {
			commonTokenCount += count;
		}
		const status = statusOf(word);
		if (status === 'new' || status === 'learning') {
			savedWords += 1;
		}
	}

	return {
		tokenCount,
		commonTokenCount,
		commonPercent:
			tokenCount === 0 ? 0 : Math.round((100 * commonTokenCount) / tokenCount),
		savedWords,
	};
}
