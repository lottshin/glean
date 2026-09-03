import { cuesToWebVtt, refineCaptionCues, type CaptionCue } from '../youtube/vtt';

/**
 * Shape returned by aisubtitle.hdslb.com. Unlike YouTube's json3, Bilibili
 * hands back cues that are already sentence-sized and carries no word-level
 * timing, so there is no timeline to rebuild — only cues to clean up.
 */
export interface BilibiliSubtitlePayload {
	body?: Array<{
		from?: number;
		to?: number;
		content?: string;
	}>;
}

export interface BilibiliSubtitleTrack {
	/** e.g. "zh-CN", "en-US", or "ai-zh" for machine-generated Chinese. */
	lan: string;
	/** Human-readable name from the API, e.g. "中文（自动生成）". */
	lanDoc: string;
	/** Protocol-relative in the raw API response; callers must normalize. */
	subtitleUrl: string;
	isAi: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** The API omits the scheme on subtitle_url, which breaks a bare fetch. */
export function normalizeSubtitleUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) {
		return '';
	}
	if (trimmed.startsWith('//')) {
		return `https:${trimmed}`;
	}
	return trimmed;
}

/** Read the subtitle track list out of an /x/player/v2 response. */
export function parseSubtitleTracks(response: unknown): BilibiliSubtitleTrack[] {
	const root = asRecord(response);
	const data = asRecord(root?.data) ?? root;
	const subtitle = asRecord(data?.subtitle);
	const list = subtitle?.subtitles ?? subtitle?.list;
	if (!Array.isArray(list)) {
		return [];
	}

	const tracks: BilibiliSubtitleTrack[] = [];
	for (const item of list) {
		const track = asRecord(item);
		const rawUrl = typeof track?.subtitle_url === 'string' ? track.subtitle_url : '';
		const url = normalizeSubtitleUrl(rawUrl);
		if (!url) {
			continue;
		}
		const lan = typeof track?.lan === 'string' ? track.lan : 'und';
		tracks.push({
			lan,
			lanDoc: typeof track?.lan_doc === 'string' ? track.lan_doc : lan,
			subtitleUrl: url,
			// Bilibili flags machine subtitles with an ai_type/ai_status pair, but
			// the lan prefix is the only field present across all responses.
			isAi: lan.startsWith('ai-') || track?.ai_status === 1,
		});
	}
	return tracks;
}

/** Prefer a human English track, then AI English, then any human track. */
export function pickDefaultTrack(
	tracks: BilibiliSubtitleTrack[],
): BilibiliSubtitleTrack | null {
	if (tracks.length === 0) {
		return null;
	}
	const byLang = (prefix: string, ai: boolean | null = null) =>
		tracks.find((track) => {
			const lang = track.lan.toLowerCase().replace(/^ai-/, '');
			if (!lang.startsWith(prefix)) {
				return false;
			}
			return ai === null ? true : track.isAi === ai;
		});

	return (
		byLang('en', false) ??
		byLang('en', true) ??
		byLang('zh', false) ??
		byLang('zh', true) ??
		tracks.find((track) => !track.isAi) ??
		tracks[0] ??
		null
	);
}

export function cuesFromBilibiliSubtitle(
	payload: BilibiliSubtitlePayload,
): CaptionCue[] {
	const body = Array.isArray(payload?.body) ? payload.body : [];
	const cues: CaptionCue[] = [];
	for (const entry of body) {
		const start = typeof entry?.from === 'number' ? entry.from : NaN;
		const end = typeof entry?.to === 'number' ? entry.to : NaN;
		const text = typeof entry?.content === 'string' ? entry.content.trim() : '';
		if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
			continue;
		}
		if (end <= start) {
			continue;
		}
		cues.push({ start, end, text });
	}
	cues.sort((a, b) => a.start - b.start);
	return cues;
}

/**
 * Convert a fetched Bilibili subtitle into the VTT the vault stores.
 *
 * `refine` re-runs the English grammar-aware resegmentation. It is off by
 * default because those rules assume whitespace-delimited words and would
 * mangle Chinese cues.
 */
export function bilibiliSubtitleToWebVtt(
	payload: BilibiliSubtitlePayload,
	options: { refine?: boolean } = {},
): string {
	const cues = cuesFromBilibiliSubtitle(payload);
	if (cues.length === 0) {
		return '';
	}
	return cuesToWebVtt(options.refine ? refineCaptionCues(cues) : cues);
}
