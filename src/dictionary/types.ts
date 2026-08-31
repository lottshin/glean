export interface DictionaryEntry {
	lookup: string;
	word: string;
	phonetic: string;
	pos: string;
	translations: string[];
	definition: string;
	tags: string[];
	collins: number | null;
	oxford: boolean;
	bnc: number | null;
	frq: number | null;
}

export type DictionaryMatch = 'direct' | 'inflection' | 'possessive' | 'missing';

export interface DictionaryLookup {
	surface: string;
	lemma: string;
	match: DictionaryMatch;
	entry: DictionaryEntry | null;
}
