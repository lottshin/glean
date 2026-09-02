import { EcdictFile } from './ecdict';
import { LemmaFile } from './lemma';
import type { DictionaryLookup, DictionaryMatch } from './types';
import { normalizeLexiconKey } from '../normalize';

const CACHE_LIMIT = 200;

export const normalizeDictionaryKey = normalizeLexiconKey;

function possessiveBase(key: string): string | null {
	if (key.endsWith("'s") && key.length > 2) {
		return key.slice(0, -2);
	}
	if (key.endsWith("s'") && key.length > 2) {
		return key.slice(0, -1);
	}
	return null;
}

export class DictionaryService {
	private cache = new Map<string, DictionaryLookup>();

	private constructor(
		private dictionary: EcdictFile,
		private lemmas: LemmaFile,
	) {}

	static async open(dictionaryPath: string, inflectionPath: string): Promise<DictionaryService> {
		const dictionary = await EcdictFile.open(dictionaryPath);
		try {
			const lemmas = await LemmaFile.open(inflectionPath);
			return new DictionaryService(dictionary, lemmas);
		} catch (error) {
			await dictionary.close();
			throw error;
		}
	}

	static fromText(dictionary: string, inflections: string): DictionaryService {
		return new DictionaryService(
			EcdictFile.fromText(dictionary),
			LemmaFile.fromText(inflections),
		);
	}

	async lookup(surface: string): Promise<DictionaryLookup> {
		const key = normalizeDictionaryKey(surface);
		const cached = this.cache.get(key);
		if (cached) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}

		const result = await this.lookupUncached(surface, key);
		this.cache.set(key, result);
		if (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
		return result;
	}

	async close(): Promise<void> {
		this.cache.clear();
		await Promise.all([this.dictionary.close(), this.lemmas.close()]);
	}

	private async lookupUncached(surface: string, key: string): Promise<DictionaryLookup> {
		const direct = await this.dictionary.lookup(key);
		if (direct) {
			return { surface, lemma: direct.lookup, match: 'direct', entry: direct };
		}

		const possessive = possessiveBase(key);
		if (possessive) {
			const result = await this.lookupLemmaOrDirect(possessive, 'possessive');
			if (result) {
				return { surface, ...result };
			}
		}

		const inflected = await this.lookupLemmaOrDirect(key, 'inflection', false);
		if (inflected) {
			return { surface, ...inflected };
		}

		return { surface, lemma: key, match: 'missing', entry: null };
	}

	private async lookupLemmaOrDirect(
		key: string,
		match: Exclude<DictionaryMatch, 'direct' | 'missing'>,
		tryDirect = true,
	): Promise<Omit<DictionaryLookup, 'surface'> | null> {
		if (tryDirect) {
			const direct = await this.dictionary.lookup(key);
			if (direct) {
				return { lemma: direct.lookup, match, entry: direct };
			}
		}
		const lemma = await this.lemmas.lookup(key);
		if (!lemma) {
			return null;
		}
		const entry = await this.dictionary.lookup(lemma);
		return entry ? { lemma, match, entry } : null;
	}
}

export type { DictionaryEntry, DictionaryLookup, DictionaryMatch } from './types';
