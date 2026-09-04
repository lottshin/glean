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

export type CommunityLookup =
	| { status: 'hit'; hit: CommunityAudioHit }
	| { status: 'miss' }
	| { status: 'rate-limited'; source: string };

const FREE_DICTIONARY = 'https://api.dictionaryapi.dev/api/v2/entries/en';
const WIKTIONARY_API = 'https://en.wiktionary.org/w/api.php';

/** Wikimedia asks for a descriptive UA; anonymous bursts get 429 otherwise. */
export const COMMUNITY_USER_AGENT =
	'GleanObsidianPlugin/0.0.1 (English learning; pronunciation lookup)';

const CACHE_TTL_MS = 30 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 90 * 1000;

interface CacheEntry {
	hit: CommunityAudioHit | null;
	expires: number;
}

const resolutionCache = new Map<string, CacheEntry>();
let rateLimitedUntil = 0;

export function clearCommunityAudioCache(): void {
	resolutionCache.clear();
	rateLimitedUntil = 0;
}

function cacheKey(source: SpeakSource, lemma: string, accent: SpeakAccent): string {
	return `${source}|${lemma}|${accent}`;
}

function readCache(
	source: SpeakSource,
	lemma: string,
	accent: SpeakAccent,
	now: number,
): CommunityAudioHit | null | undefined {
	const entry = resolutionCache.get(cacheKey(source, lemma, accent));
	if (!entry) {
		return undefined;
	}
	if (entry.expires <= now) {
		resolutionCache.delete(cacheKey(source, lemma, accent));
		return undefined;
	}
	return entry.hit;
}

function writeCache(
	source: SpeakSource,
	lemma: string,
	accent: SpeakAccent,
	hit: CommunityAudioHit | null,
	now: number,
): void {
	resolutionCache.set(cacheKey(source, lemma, accent), {
		hit,
		expires: now + (hit ? CACHE_TTL_MS : MISS_TTL_MS),
	});
}

function isRateLimited(now: number): boolean {
	return now < rateLimitedUntil;
}

function markRateLimited(now: number): void {
	rateLimitedUntil = Math.max(rateLimitedUntil, now + RATE_LIMIT_COOLDOWN_MS);
}

function isRateLimitStatus(status: number): boolean {
	return status === 429 || status === 503;
}

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
	const ranked = [...hits].sort(
		(left, right) =>
			scoreAccent(right.accentHint, accent) - scoreAccent(left.accentHint, accent),
	);
	if (accent === 'en-US' || accent === 'en-GB') {
		// Card buttons ask for a specific accent. Playing the other one makes
		// 美 and 英 sound identical — refuse and let the caller fall back to TTS.
		const exact = ranked.find((hit) => hit.accentHint === accent);
		if (exact) {
			return exact;
		}
		const unknown = ranked.filter((hit) => hit.accentHint === null);
		const conflicting = ranked.some(
			(hit) => hit.accentHint !== null && hit.accentHint !== accent,
		);
		if (!conflicting && unknown[0]) {
			return unknown[0];
		}
		return null;
	}
	return ranked[0] ?? null;
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
	return parseWiktionaryFileHits(payload)[0]?.url ?? null;
}

export function parseWiktionaryFileHits(payload: unknown): CommunityAudioHit[] {
	if (!payload || typeof payload !== 'object') {
		return [];
	}
	const pages = (payload as { query?: { pages?: Record<string, unknown> } }).query
		?.pages;
	if (!pages) {
		return [];
	}
	const hits: CommunityAudioHit[] = [];
	for (const [key, page] of Object.entries(pages)) {
		if (!page || typeof page !== 'object' || key.startsWith('-')) {
			continue;
		}
		const title =
			typeof (page as { title?: unknown }).title === 'string'
				? (page as { title: string }).title
				: '';
		const info = (page as { imageinfo?: Array<{ url?: string }> }).imageinfo?.[0];
		if (!info?.url) {
			continue;
		}
		hits.push({
			url: info.url,
			source: 'wiktionary',
			accentHint: accentFromHint(`${title} ${info.url}`),
		});
	}
	return hits;
}

/** Guess common Commons filenames before scanning the whole page. */
export function wiktionaryCandidateFiles(
	word: string,
	accent: SpeakAccent = 'auto',
): string[] {
	const bare = word.trim().toLowerCase().replace(/[^a-z0-9'-]+/g, '');
	if (!bare) {
		return [];
	}
	const us = [`File:en-us-${bare}.ogg`, `File:En-us-${bare}.ogg`, `File:en-us-${bare}.mp3`];
	const gb = [
		`File:en-uk-${bare}.ogg`,
		`File:En-uk-${bare}.ogg`,
		`File:en-gb-${bare}.ogg`,
		`File:En-gb-${bare}.ogg`,
		`File:en-uk-${bare}.mp3`,
	];
	if (accent === 'en-US') {
		return us;
	}
	if (accent === 'en-GB') {
		return gb;
	}
	return [...us, ...gb];
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
): Promise<CommunityLookup> {
	const lemma = word.trim().toLowerCase();
	if (!lemma) {
		return { status: 'miss' };
	}
	const response = await fetchJson(
		`${FREE_DICTIONARY}/${encodeURIComponent(lemma)}`,
	);
	if (response.status === 404) {
		return { status: 'miss' };
	}
	if (isRateLimitStatus(response.status)) {
		return { status: 'rate-limited', source: 'Free Dictionary' };
	}
	if (response.status < 200 || response.status >= 300) {
		return { status: 'miss' };
	}
	const hit = parseFreeDictionaryAudio(response.json, accent);
	return hit ? { status: 'hit', hit } : { status: 'miss' };
}

export async function resolveWiktionaryAudio(
	word: string,
	accent: SpeakAccent,
	fetchJson: SpeakFetcher,
): Promise<CommunityLookup> {
	const lemma = word.trim().toLowerCase();
	if (!lemma) {
		return { status: 'miss' };
	}

	// One narrow request for the accent the button asked for — scanning the
	// whole page doubles the chance of a 429.
	const candidates = wiktionaryCandidateFiles(lemma, accent);
	const direct = await fetchJson(imageInfoUrl(candidates));
	if (isRateLimitStatus(direct.status)) {
		return { status: 'rate-limited', source: 'Wiktionary' };
	}
	if (direct.status >= 200 && direct.status < 300) {
		const hit = pickPreferred(parseWiktionaryFileHits(direct.json), accent);
		if (hit) {
			return { status: 'hit', hit };
		}
	}

	const listed = await fetchJson(pageImagesUrl(lemma));
	if (isRateLimitStatus(listed.status)) {
		return { status: 'rate-limited', source: 'Wiktionary' };
	}
	if (listed.status < 200 || listed.status >= 300) {
		return { status: 'miss' };
	}
	const titles = parseWiktionaryImageTitles(listed.json);
	if (titles.length === 0) {
		return { status: 'miss' };
	}
	const ranked = [...titles].sort(
		(left, right) =>
			scoreAccent(accentFromHint(right), accent) -
			scoreAccent(accentFromHint(left), accent),
	);
	const info = await fetchJson(imageInfoUrl(ranked));
	if (isRateLimitStatus(info.status)) {
		return { status: 'rate-limited', source: 'Wiktionary' };
	}
	if (info.status < 200 || info.status >= 300) {
		return { status: 'miss' };
	}
	const hit = pickPreferred(parseWiktionaryFileHits(info.json), accent);
	return hit ? { status: 'hit', hit } : { status: 'miss' };
}

export async function resolveCommunityAudio(
	source: SpeakSource,
	word: string,
	accent: SpeakAccent,
	fetchJson: SpeakFetcher,
	now: number = Date.now(),
): Promise<CommunityLookup> {
	if (source === 'system') {
		return { status: 'miss' };
	}
	const lemma = word.trim().toLowerCase();
	if (!lemma) {
		return { status: 'miss' };
	}
	if (isRateLimited(now)) {
		return { status: 'rate-limited', source: sourceLabel(source) };
	}
	const cached = readCache(source, lemma, accent, now);
	if (cached !== undefined) {
		return cached ? { status: 'hit', hit: cached } : { status: 'miss' };
	}

	const result =
		source === 'free-dictionary'
			? await resolveFreeDictionaryAudio(lemma, accent, fetchJson)
			: await resolveWiktionaryAudio(lemma, accent, fetchJson);

	if (result.status === 'rate-limited') {
		markRateLimited(now);
		return result;
	}
	writeCache(source, lemma, accent, result.status === 'hit' ? result.hit : null, now);
	return result;
}

function sourceLabel(source: SpeakSource): string {
	if (source === 'free-dictionary') {
		return 'Free Dictionary';
	}
	if (source === 'wiktionary') {
		return 'Wiktionary';
	}
	return '社区源';
}
