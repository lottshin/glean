import type { SpeakAccent } from './tts';

export type SpeakSource = 'system' | 'free-dictionary' | 'wiktionary';

export interface SpeakFetchResponse {
	status: number;
	json: unknown;
}

export type SpeakFetcher = (url: string) => Promise<SpeakFetchResponse>;

export interface CommunityAudioHit {
	url: string;
	source: Exclude<SpeakSource, 'system'>;
	/** Rough accent guess from the filename or phonetic label, when known. */
	accentHint: 'en-US' | 'en-GB' | null;
}

const FREE_DICTIONARY = 'https://api.dictionaryapi.dev/api/v2/entries/en';
const WIKTIONARY_API = 'https://en.wiktionary.org/w/api.php';

function normalizeAudioUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}
	if (trimmed.startsWith('//')) {
		return `https:${trimmed}`;
	}
	return trimmed;
}

function accentFromHint(text: string): 'en-US' | 'en-GB' | null {
	const lower = text.toLowerCase();
	if (/_gb_|[-_]uk[-_]|[-_]gb[-_]|british|en-gb|en_uk/.test(lower)) {
		return 'en-GB';
	}
	if (/_us_|[-_]us[-_]|american|en-us/.test(lower)) {
		return 'en-US';
	}
	return null;
}

function scoreAccent(
	hint: 'en-US' | 'en-GB' | null,
	wanted: SpeakAccent,
): number {
	if (wanted === 'auto' || hint === null) {
		return 0;
	}
	if (wanted === 'en-GB') {
		return hint === 'en-GB' ? 2 : hint === 'en-US' ? -1 : 0;
	}
	return hint === 'en-US' ? 2 : hint === 'en-GB' ? -1 : 0;
}

function pickPreferred(
	hits: CommunityAudioHit[],
	accent: SpeakAccent,
): CommunityAudioHit | null {
	if (hits.length === 0) {
		return null;
	}
	return [...hits].sort(
		(left, right) =>
			scoreAccent(right.accentHint, accent) - scoreAccent(left.accentHint, accent),
	)[0] ?? null;
}

/** Parse Free Dictionary API JSON into playable audio URLs. */
export function parseFreeDictionaryAudio(
	payload: unknown,
	accent: SpeakAccent,
): CommunityAudioHit | null {
	if (!Array.isArray(payload)) {
		return null;
	}
	const hits: CommunityAudioHit[] = [];
	for (const entry of payload) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const phonetics = (entry as { phonetics?: unknown }).phonetics;
		if (!Array.isArray(phonetics)) {
			continue;
		}
		for (const phonetic of phonetics) {
			if (!phonetic || typeof phonetic !== 'object') {
				continue;
			}
			const audio = (phonetic as { audio?: unknown }).audio;
			const text = (phonetic as { text?: unknown }).text;
			if (typeof audio !== 'string' || !audio.trim()) {
				continue;
			}
			const url = normalizeAudioUrl(audio);
			if (!url) {
				continue;
			}
			const label = `${typeof text === 'string' ? text : ''} ${url}`;
			hits.push({
				url,
				source: 'free-dictionary',
				accentHint: accentFromHint(label),
			});
		}
	}
	return pickPreferred(hits, accent);
}

/** MediaWiki `images` list titles that look like English pronunciation files. */
export function parseWiktionaryImageTitles(payload: unknown): string[] {
	if (!payload || typeof payload !== 'object') {
		return [];
	}
	const pages = (payload as { query?: { pages?: Record<string, unknown> } }).query
		?.pages;
	if (!pages || typeof pages !== 'object') {
		return [];
	}
	const titles: string[] = [];
	for (const page of Object.values(pages)) {
		if (!page || typeof page !== 'object') {
			continue;
		}
		const images = (page as { images?: unknown }).images;
		if (!Array.isArray(images)) {
			continue;
		}
		for (const image of images) {
			const title =
				image && typeof image === 'object'
					? (image as { title?: unknown }).title
					: null;
			if (typeof title !== 'string') {
				continue;
			}
			if (
				/^File:.*\.(ogg|oga|mp3|wav|flac)$/i.test(title) &&
				/en[-_ ]?(us|uk|gb)|british|american|pronunciation/i.test(title)
			) {
				titles.push(title);
			}
		}
	}
	return titles;
}

export function parseWiktionaryFileUrl(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const pages = (payload as { query?: { pages?: Record<string, unknown> } }).query
		?.pages;
	if (!pages) {
		return null;
	}
	for (const page of Object.values(pages)) {
		if (!page || typeof page !== 'object') {
			continue;
		}
		const info = (page as { imageinfo?: Array<{ url?: string }> }).imageinfo?.[0];
		if (info?.url) {
			return info.url;
		}
	}
	return null;
}

/** Guess common Commons filenames before scanning the whole page. */
export function wiktionaryCandidateFiles(word: string): string[] {
	const bare = word.trim().toLowerCase().replace(/[^a-z0-9'-]+/g, '');
	if (!bare) {
		return [];
	}
	const variants = [
		`en-us-${bare}.ogg`,
		`En-us-${bare}.ogg`,
		`en-uk-${bare}.ogg`,
		`En-uk-${bare}.ogg`,
		`en-gb-${bare}.ogg`,
		`En-gb-${bare}.ogg`,
		`en-us-${bare}.mp3`,
		`en-uk-${bare}.mp3`,
	];
	return variants.map((name) => `File:${name}`);
}

function imageInfoUrl(titles: string[]): string {
	const params = new URLSearchParams({
		action: 'query',
		format: 'json',
		prop: 'imageinfo',
		iiprop: 'url',
		titles: titles.slice(0, 10).join('|'),
		origin: '*',
	});
	return `${WIKTIONARY_API}?${params.toString()}`;
}

function pageImagesUrl(word: string): string {
	const params = new URLSearchParams({
		action: 'query',
		format: 'json',
		prop: 'images',
		titles: word.trim(),
		imlimit: '50',
		origin: '*',
	});
	return `${WIKTIONARY_API}?${params.toString()}`;
}

export async function resolveFreeDictionaryAudio(
	word: string,
	accent: SpeakAccent,
	fetchJson: SpeakFetcher,
): Promise<CommunityAudioHit | null> {
	const lemma = word.trim().toLowerCase();
	if (!lemma) {
		return null;
	}
	const response = await fetchJson(
		`${FREE_DICTIONARY}/${encodeURIComponent(lemma)}`,
	);
	if (response.status === 404) {
		return null;
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Free Dictionary 返回 ${response.status}`);
	}
	return parseFreeDictionaryAudio(response.json, accent);
}

export async function resolveWiktionaryAudio(
	word: string,
	accent: SpeakAccent,
	fetchJson: SpeakFetcher,
): Promise<CommunityAudioHit | null> {
	const lemma = word.trim().toLowerCase();
	if (!lemma) {
		return null;
	}

	const candidates = wiktionaryCandidateFiles(lemma);
	const preferredFirst =
		accent === 'en-GB'
			? [...candidates].sort((left, right) => {
					const leftGb = /uk|gb/i.test(left) ? 0 : 1;
					const rightGb = /uk|gb/i.test(right) ? 0 : 1;
					return leftGb - rightGb;
				})
			: candidates;

	const direct = await fetchJson(imageInfoUrl(preferredFirst));
	if (direct.status >= 200 && direct.status < 300) {
		const url = parseWiktionaryFileUrl(direct.json);
		if (url) {
			return {
				url,
				source: 'wiktionary',
				accentHint: accentFromHint(url) ?? accentFromHint(preferredFirst.join(' ')),
			};
		}
	}

	const listed = await fetchJson(pageImagesUrl(lemma));
	if (listed.status < 200 || listed.status >= 300) {
		throw new Error(`Wiktionary 返回 ${listed.status}`);
	}
	const titles = parseWiktionaryImageTitles(listed.json);
	if (titles.length === 0) {
		return null;
	}
	const ranked = [...titles].sort(
		(left, right) =>
			scoreAccent(accentFromHint(right), accent) -
			scoreAccent(accentFromHint(left), accent),
	);
	const info = await fetchJson(imageInfoUrl(ranked));
	if (info.status < 200 || info.status >= 300) {
		throw new Error(`Wiktionary 文件查询返回 ${info.status}`);
	}
	const url = parseWiktionaryFileUrl(info.json);
	if (!url) {
		return null;
	}
	return {
		url,
		source: 'wiktionary',
		accentHint: accentFromHint(url) ?? accentFromHint(ranked[0] ?? ''),
	};
}

export async function resolveCommunityAudio(
	source: SpeakSource,
	word: string,
	accent: SpeakAccent,
	fetchJson: SpeakFetcher,
): Promise<CommunityAudioHit | null> {
	if (source === 'free-dictionary') {
		return resolveFreeDictionaryAudio(word, accent, fetchJson);
	}
	if (source === 'wiktionary') {
		return resolveWiktionaryAudio(word, accent, fetchJson);
	}
	return null;
}
