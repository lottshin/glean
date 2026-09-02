import { normalizeLexiconKey } from '../normalize';
import type { WordStatus } from './note';

export interface LexiconCard {
	path: string;
	lemma: string;
	forms: string[];
	status: WordStatus;
}

function keyOf(value: string): string {
	return normalizeLexiconKey(value);
}

const STATUSES: WordStatus[] = ['new', 'learning', 'known', 'ignored'];

export function parseAliasList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((alias): alias is string => typeof alias === 'string');
	}
	return typeof value === 'string' ? [value] : [];
}

export function parseWordStatus(value: unknown): WordStatus {
	return STATUSES.includes(value as WordStatus) ? (value as WordStatus) : 'new';
}

/**
 * In-memory map of lemma/alias -> card.
 * Built from Obsidian's metadata cache, never by reading note bodies.
 */
export class LexiconCatalog {
	private byPath = new Map<string, LexiconCard>();
	private byKey = new Map<string, string>();

	replaceAll(cards: LexiconCard[]): void {
		this.byPath.clear();
		this.byKey.clear();
		for (const card of cards) {
			this.upsert(card);
		}
	}

	upsert(card: LexiconCard): void {
		const previous = this.byPath.get(card.path);
		if (previous) {
			this.dropKeys(previous, false);
		}
		this.byPath.set(card.path, card);
		this.indexKeys(card);
	}

	removePath(path: string): void {
		const previous = this.byPath.get(path);
		if (!previous) {
			return;
		}
		this.dropKeys(previous, true);
		this.byPath.delete(path);
	}

	rename(oldPath: string, newPath: string): void {
		const card = this.byPath.get(oldPath);
		if (!card) {
			return;
		}
		this.dropKeys(card, false);
		this.byPath.delete(oldPath);
		this.upsert({ ...card, path: newPath });
	}

	get(word: string): LexiconCard | null {
		const key = keyOf(word);
		const path = this.byKey.get(key);
		return path ? (this.byPath.get(path) ?? null) : null;
	}

	statusOf(word: string): WordStatus | null {
		return this.get(word)?.status ?? null;
	}

	get size(): number {
		return this.byPath.size;
	}

	list(): LexiconCard[] {
		return [...this.byPath.values()];
	}

	private indexKeys(card: LexiconCard): void {
		const lemmaKey = keyOf(card.lemma);
		if (!this.byKey.has(lemmaKey)) {
			this.byKey.set(lemmaKey, card.path);
		}
		for (const form of card.forms) {
			const key = keyOf(form);
			if (!this.byKey.has(key)) {
				this.byKey.set(key, card.path);
			}
		}
	}

	private dropKeys(card: LexiconCard, reclaim: boolean): void {
		const keys = [card.lemma, ...card.forms];
		for (const raw of keys) {
			const key = keyOf(raw);
			if (this.byKey.get(key) === card.path) {
				this.byKey.delete(key);
				if (reclaim) {
					this.reclaimKey(key, card.path);
				}
			}
		}
	}

	private reclaimKey(key: string, excludedPath: string): void {
		for (const candidate of this.byPath.values()) {
			if (
				candidate.path !== excludedPath &&
				[candidate.lemma, ...candidate.forms].some(
					(value) => keyOf(value) === key,
				)
			) {
				this.byKey.set(key, candidate.path);
				return;
			}
		}
	}
}
