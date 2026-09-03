/**
 * A single-file MP4 from the legacy `fnval=1` playurl response. Unlike DASH,
 * it already muxes video and audio, so `<video src>` can stream it directly.
 */
export interface BilibiliMediaTrack {
	urls: string[];
	quality: number;
	format: string;
	/** Bytes, reported by the API before any download. */
	size: number;
	durationMs: number;
	/** Unix seconds parsed from the CDN signature, ~2h after it is issued. */
	expiresAt: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

/** CDN links carry their own signature, so `deadline` is the real expiry. */
export function playUrlExpiry(url: string): number | null {
	const match = /[?&]deadline=(\d+)/.exec(url);
	if (!match) {
		return null;
	}
	const seconds = Number(match[1]);
	return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Read the muxed MP4 out of a `fnval=1` playurl response.
 *
 * Returns null when the video is split across several `durl` segments (older
 * uploads): concatenating MP4 parts needs a remux, so callers fall back instead.
 */
export function mediaTrackFromPlayUrl(
	payload: unknown,
): BilibiliMediaTrack | null {
	const root = asRecord(payload);
	const data = asRecord(root?.data) ?? root;
	const durl = Array.isArray(data?.durl) ? data.durl : [];
	if (durl.length !== 1) {
		return null;
	}
	const segment = asRecord(durl[0]);
	if (!segment) {
		return null;
	}
	const base = typeof segment.url === 'string' ? segment.url : '';
	const backups = strings(segment.backup_url ?? segment.backupUrl);
	const urls = Array.from(new Set([base, ...backups].filter(Boolean)));
	if (urls.length === 0) {
		return null;
	}
	return {
		urls,
		quality: typeof data?.quality === 'number' ? data.quality : 0,
		format: typeof data?.format === 'string' ? data.format : '',
		size: typeof segment.size === 'number' ? segment.size : 0,
		durationMs: typeof segment.length === 'number' ? segment.length : 0,
		expiresAt: playUrlExpiry(base),
	};
}
