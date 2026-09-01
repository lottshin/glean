import type { DictionaryLookup } from '../dictionary';
import type { WordStatus } from '../lexicon/note';
import { tokenizeSubtitle } from '../media/subtitle-tokens';

/** Function words carry no lookup value and would bury the real vocabulary. */
const STOPWORDS = new Set([
	'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and',
	'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
	'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
	'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
	'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself',
	'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
	'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not',
	'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our',
	'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so',
	'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
	'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
	'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
	'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
	'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

/** A wall of entries is unreadable and pointlessly slow to build. */
export const MAX_GLOSS_ITEMS = 80;

export interface GlossItem {
	surface: string;
	lemma: string;
	phonetic: string;
	pos: string;
	senses: string[];
	status: WordStatus | null;
	missing: boolean;
}

export interface PassageGloss {
	items: GlossItem[];
	/** Content words dropped because the panel hit MAX_GLOSS_ITEMS. */
	truncated: number;
}

export function isContentWord(word: string): boolean {
	if (!/^[a-z][a-z'-]*$/i.test(word)) {
		return false;
	}
	return word.length > 1 && !STOPWORDS.has(word.toLowerCase());
}

/**
 * Offline reading aid: every distinct content word of a passage with its
 * ECDICT entry, in first-appearance order. No network, no sentence model.
 */
export async function glossPassage(
	text: string,
	lookup: (word: string) => Promise<DictionaryLookup | null>,
	statusOf: (word: string) => WordStatus | null,
): Promise<PassageGloss> {
	const order: string[] = [];
	const surfaces = new Map<string, string>();
	for (const token of tokenizeSubtitle(text)) {
		if (token.kind !== 'word' || !token.lookup || !isContentWord(token.text)) {
			continue;
		}
		if (surfaces.has(token.lookup)) {
			continue;
		}
		surfaces.set(token.lookup, token.text);
		order.push(token.lookup);
	}

	const items: GlossItem[] = [];
	const seenLemmas = new Set<string>();
	let truncated = 0;

	for (const key of order) {
		if (items.length >= MAX_GLOSS_ITEMS) {
			truncated += 1;
			continue;
		}
		const surface = surfaces.get(key) ?? key;
		const result = await lookup(key);
		const lemma = result?.lemma ?? key;
		if (seenLemmas.has(lemma)) {
			continue;
		}
		seenLemmas.add(lemma);
		const entry = result?.entry ?? null;
		items.push({
			surface,
			lemma,
			phonetic: entry?.phonetic ?? '',
			pos: entry?.pos ?? '',
			senses: senseList(entry),
			status: statusOf(lemma),
			missing: !entry,
		});
	}

	return { items, truncated };
}

function senseList(entry: DictionaryLookup['entry']): string[] {
	if (!entry) {
		return [];
	}
	if (entry.translations.length > 0) {
		return entry.translations;
	}
	return entry.definition ? [entry.definition] : [];
}
