export interface BilibiliAudioTrack {
	id: number;
	bandwidth: number;
	mimeType: string;
	codecs: string;
	urls: string[];
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

/** Parse either window.__playinfo__ or a raw playurl API response. */
export function audioTracksFromPlayInfo(
	payload: unknown,
): BilibiliAudioTrack[] {
	const root = asRecord(payload);
	const data = asRecord(root?.data) ?? root;
	const dash = asRecord(data?.dash);
	const audio = Array.isArray(dash?.audio) ? dash.audio : [];
	const tracks: BilibiliAudioTrack[] = [];

	for (const item of audio) {
		const record = asRecord(item);
		if (!record) {
			continue;
		}
		const base =
			typeof record.baseUrl === 'string'
				? record.baseUrl
				: typeof record.base_url === 'string'
					? record.base_url
					: '';
		const backups = strings(record.backupUrl ?? record.backup_url);
		const urls = [base, ...backups].filter(Boolean);
		if (urls.length === 0) {
			continue;
		}
		tracks.push({
			id: typeof record.id === 'number' ? record.id : 0,
			bandwidth:
				typeof record.bandwidth === 'number'
					? record.bandwidth
					: Number.MAX_SAFE_INTEGER,
			mimeType:
				typeof record.mimeType === 'string'
					? record.mimeType
					: typeof record.mime_type === 'string'
						? record.mime_type
						: 'audio/mp4',
			codecs: typeof record.codecs === 'string' ? record.codecs : '',
			urls: Array.from(new Set(urls)),
		});
	}
	return tracks;
}

/** The lowest-bandwidth AAC track is enough for speech and keeps vaults small. */
export function pickSpeechAudioTrack(
	tracks: BilibiliAudioTrack[],
): BilibiliAudioTrack | null {
	const playable = tracks.filter(
		(track) =>
			track.urls.length > 0 &&
			(track.mimeType.includes('audio/mp4') ||
				track.codecs.toLowerCase().includes('mp4a')),
	);
	return (
		playable.sort((a, b) => a.bandwidth - b.bandwidth)[0] ??
		tracks.filter((track) => track.urls.length > 0)
			.sort((a, b) => a.bandwidth - b.bandwidth)[0] ??
		null
	);
}
