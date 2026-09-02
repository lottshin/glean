import { timedTextToWebVtt, type TimedTextPayload } from '../../src/youtube/vtt';

export interface CaptionTrack {
	baseUrl: string;
	languageCode: string;
	name: string;
	kind: string;
	isAsr: boolean;
}

export interface YouTubeCapture {
	videoId: string;
	title: string;
	channel: string;
	url: string;
	tracks: CaptionTrack[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function trackName(value: unknown): string {
	const record = asRecord(value);
	if (!record) {
		return '';
	}
	if (typeof record.simpleText === 'string') {
		return record.simpleText;
	}
	const runs = record.runs;
	if (Array.isArray(runs)) {
		return runs
			.map((run) => {
				const item = asRecord(run);
				return typeof item?.text === 'string' ? item.text : '';
			})
			.join('');
	}
	return '';
}

function parsePlayerResponseFromText(text: string): Record<string, unknown> | null {
	const marker = 'ytInitialPlayerResponse';
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const index = text.indexOf(marker, searchFrom);
		if (index < 0) {
			return null;
		}
		const assign = text.indexOf('=', index);
		if (assign < 0) {
			searchFrom = index + marker.length;
			continue;
		}
		let cursor = assign + 1;
		while (cursor < text.length && /\s/.test(text[cursor] ?? '')) {
			cursor += 1;
		}
		if (text[cursor] !== '{') {
			searchFrom = index + marker.length;
			continue;
		}
		try {
			const sliced = text.slice(cursor);
			const end = findJsonObjectEnd(sliced);
			if (end < 0) {
				searchFrom = index + marker.length;
				continue;
			}
			const parsed: unknown = JSON.parse(sliced.slice(0, end + 1));
			const record = asRecord(parsed);
			if (record) {
				return record;
			}
		} catch {
			// Keep scanning later occurrences.
		}
		searchFrom = index + marker.length;
	}
	return null;
}

function readPlayerResponse(): Record<string, unknown> | null {
	const direct = asRecord((window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse);
	if (direct) {
		return direct;
	}
	const configured = asRecord(
		(window as unknown as {
			ytplayer?: { config?: { args?: { raw_player_response?: unknown } } };
		}).ytplayer?.config?.args?.raw_player_response,
	);
	if (configured) {
		return configured;
	}

	const scripts = Array.from(document.querySelectorAll('script'));
	for (const script of scripts) {
		const record = parsePlayerResponseFromText(script.textContent ?? '');
		if (record) {
			return record;
		}
	}
	return null;
}

/** Parse a watch-page HTML body when the live page world is unavailable. */
export function captureYouTubeFromHtml(
	html: string,
	locationHref: string,
): YouTubeCapture | null {
	const player = parsePlayerResponseFromText(html);
	if (!player) {
		return null;
	}
	return captureFromPlayerResponse(player, locationHref);
}

function findJsonObjectEnd(text: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') {
			depth += 1;
			continue;
		}
		if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

function captureFromPlayerResponse(
	player: Record<string, unknown>,
	locationHref: string,
	fallbackTitle = '',
): YouTubeCapture | null {
	const videoDetails = asRecord(player.videoDetails);
	const videoId =
		(typeof videoDetails?.videoId === 'string' && videoDetails.videoId) ||
		new URL(locationHref).searchParams.get('v') ||
		'';
	if (!/^[\w-]{11}$/.test(videoId)) {
		return null;
	}

	const captions = asRecord(player.captions);
	const tracklist = asRecord(captions?.playerCaptionsTracklistRenderer);
	const captionTracks = Array.isArray(tracklist?.captionTracks)
		? tracklist.captionTracks
		: [];

	const tracks: CaptionTrack[] = [];
	for (const item of captionTracks) {
		const track = asRecord(item);
		if (!track || typeof track.baseUrl !== 'string') {
			continue;
		}
		const languageCode =
			typeof track.languageCode === 'string' ? track.languageCode : 'und';
		const kind = typeof track.kind === 'string' ? track.kind : '';
		tracks.push({
			baseUrl: track.baseUrl,
			languageCode,
			name: trackName(track.name) || languageCode,
			kind,
			isAsr: kind === 'asr',
		});
	}

	return {
		videoId,
		title:
			(typeof videoDetails?.title === 'string' && videoDetails.title) ||
			fallbackTitle ||
			videoId,
		channel:
			(typeof videoDetails?.author === 'string' && videoDetails.author) || '',
		url: `https://www.youtube.com/watch?v=${videoId}`,
		tracks,
	};
}

export function captureYouTubePage(locationHref = location.href): YouTubeCapture | null {
	const player = readPlayerResponse();
	if (!player) {
		return null;
	}
	const fallbackTitle =
		typeof document !== 'undefined'
			? document.title.replace(/ - YouTube$/, '').trim()
			: '';
	return captureFromPlayerResponse(player, locationHref, fallbackTitle);
}

export function pickDefaultTrack(tracks: CaptionTrack[]): CaptionTrack | null {
	if (tracks.length === 0) {
		return null;
	}
	const byLang = (prefix: string, asr: boolean | null = null) =>
		tracks.find((track) => {
			if (!track.languageCode.toLowerCase().startsWith(prefix)) {
				return false;
			}
			if (asr === null) {
				return true;
			}
			return track.isAsr === asr;
		});

	return (
		byLang('en', false) ??
		byLang('en', true) ??
		byLang('zh', false) ??
		byLang('zh', true) ??
		tracks.find((track) => !track.isAsr) ??
		tracks[0] ??
		null
	);
}

function timedTextUrls(
	track: CaptionTrack,
	videoId?: string,
	pot?: string | null,
): Array<{ fmt: 'json3' | 'vtt'; url: string }> {
	const out: Array<{ fmt: 'json3' | 'vtt'; url: string }> = [];
	const seen = new Set<string>();
	const push = (fmt: 'json3' | 'vtt', href: string) => {
		if (seen.has(href)) {
			return;
		}
		seen.add(href);
		out.push({ fmt, url: href });
	};

	for (const fmt of ['json3', 'vtt'] as const) {
		push(fmt, prepareTimedTextUrl(track.baseUrl, { fmt, pot, client: 'WEB' }));
	}

	if (videoId && /^[\w-]{11}$/.test(videoId)) {
		for (const fmt of ['json3', 'vtt'] as const) {
			const rebuilt = new URL('https://www.youtube.com/api/timedtext');
			rebuilt.searchParams.set('v', videoId);
			rebuilt.searchParams.set('lang', track.languageCode);
			if (track.isAsr) {
				rebuilt.searchParams.set('kind', 'asr');
			}
			push(
				fmt,
				prepareTimedTextUrl(rebuilt.toString(), { fmt, pot, client: 'WEB' }),
			);
		}
	}

	return out;
}

export function prepareTimedTextUrl(
	baseUrl: string,
	options: {
		fmt: 'json3' | 'vtt';
		pot?: string | null;
		client?: string;
	},
): string {
	const url = new URL(baseUrl);
	url.searchParams.set('fmt', options.fmt);
	url.searchParams.set('c', options.client ?? 'WEB');
	// Never keep auto-translate target; we want the selected track's source language.
	url.searchParams.delete('tlang');
	if (options.pot) {
		url.searchParams.set('pot', options.pot);
	}
	return url.toString();
}

export function decodeTimedTextBody(
	text: string,
	fmt: 'json3' | 'vtt',
): string | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	if (fmt === 'json3') {
		try {
			const payload = JSON.parse(trimmed) as TimedTextPayload;
			const vtt = timedTextToWebVtt(payload);
			return vtt.includes('-->') ? vtt : null;
		} catch {
			return null;
		}
	}
	if (!/WEBVTT/i.test(trimmed)) {
		return null;
	}
	return /^WEBVTT/im.test(trimmed) ? text : `WEBVTT\n\n${text}`;
}

export async function fetchTrackVtt(
	track: CaptionTrack,
	fetchImpl: typeof fetch = fetch,
	videoId?: string,
	pot?: string | null,
): Promise<string> {
	const errors: string[] = [];

	for (const candidate of timedTextUrls(track, videoId, pot)) {
		let response: Response;
		try {
			response = await fetchImpl(candidate.url, {
				credentials: 'include',
				headers: { Accept: '*/*' },
			});
		} catch (error) {
			errors.push(
				`${candidate.fmt}: ${error instanceof Error ? error.message : '网络错误'}`,
			);
			continue;
		}
		if (!response.ok) {
			errors.push(`${candidate.fmt}: HTTP ${response.status}`);
			continue;
		}

		const text = await response.text();
		if (!text.trim()) {
			errors.push(`${candidate.fmt}: 空响应`);
			continue;
		}

		const decoded = decodeTimedTextBody(text, candidate.fmt);
		if (!decoded) {
			errors.push(
				`${candidate.fmt}: ${candidate.fmt === 'json3' ? '字幕 JSON 无效或为空' : '非 VTT 内容'}`,
			);
			continue;
		}
		return decoded;
	}

	throw new Error(`字幕下载失败（${errors.join('；') || '未知原因'}）`);
}
