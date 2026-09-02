const YOUTUBE_HOSTS = new Set([
	'youtube.com',
	'www.youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtube-nocookie.com',
	'www.youtube-nocookie.com',
	'youtu.be',
]);

/**
 * Extract a YouTube video id from watch / youtu.be / embed / shorts URLs.
 * Returns null when the input is not a recognizable YouTube video link.
 */
export function parseYouTubeVideoId(input: string): string | null {
	const raw = input.trim();
	if (!raw) {
		return null;
	}
	if (/^[\w-]{11}$/.test(raw)) {
		return raw;
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		try {
			url = new URL(`https://${raw}`);
		} catch {
			return null;
		}
	}

	const host = url.hostname.toLowerCase();
	if (!YOUTUBE_HOSTS.has(host)) {
		return null;
	}

	if (host === 'youtu.be') {
		const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
		return /^[\w-]{11}$/.test(id) ? id : null;
	}

	const parts = url.pathname.split('/').filter(Boolean);
	if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') {
		const id = parts[1] ?? '';
		return /^[\w-]{11}$/.test(id) ? id : null;
	}

	const fromQuery = url.searchParams.get('v') ?? '';
	return /^[\w-]{11}$/.test(fromQuery) ? fromQuery : null;
}

export function youtubeSourcePath(videoId: string): string {
	return `youtube:${videoId}`;
}

export function parseYouTubeSourcePath(sourcePath: string): string | null {
	const trimmed = sourcePath.trim();
	if (!trimmed.toLowerCase().startsWith('youtube:')) {
		return null;
	}
	const id = trimmed.slice('youtube:'.length).trim();
	return /^[\w-]{11}$/.test(id) ? id : null;
}

export function youtubeWatchUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeShortUrl(videoId: string): string {
	return `https://youtu.be/${videoId}`;
}
