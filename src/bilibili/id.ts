const BILIBILI_HOSTS = new Set([
	'bilibili.com',
	'www.bilibili.com',
	'm.bilibili.com',
	'b23.tv',
]);

/**
 * BV ids are "BV" plus 10 characters from a base58 alphabet, so the ambiguous
 * glyphs 0, I, O and l never appear. Matching that alphabet rather than \w
 * keeps a mistyped id from being accepted as real.
 */
const BV_PATTERN = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;

export function isBilibiliVideoId(value: string): boolean {
	return BV_PATTERN.test(value.trim());
}

/**
 * Extract a BV id from a watch / b23.tv / mobile URL.
 * Returns null when the input is not a recognizable Bilibili video link.
 *
 * A b23.tv short link only carries an opaque slug, so it resolves to null here;
 * following the redirect needs the network and belongs in the extension.
 */
export function parseBilibiliVideoId(input: string): string | null {
	const raw = input.trim();
	if (!raw) {
		return null;
	}
	if (isBilibiliVideoId(raw)) {
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

	if (!BILIBILI_HOSTS.has(url.hostname.toLowerCase())) {
		return null;
	}

	for (const part of url.pathname.split('/').filter(Boolean)) {
		if (isBilibiliVideoId(part)) {
			return part;
		}
	}
	const fromQuery = url.searchParams.get('bvid') ?? '';
	return isBilibiliVideoId(fromQuery) ? fromQuery : null;
}

export function bilibiliSourcePath(videoId: string): string {
	return `bilibili:${videoId}`;
}

export function parseBilibiliSourcePath(sourcePath: string): string | null {
	const trimmed = sourcePath.trim();
	if (!trimmed.toLowerCase().startsWith('bilibili:')) {
		return null;
	}
	const id = trimmed.slice('bilibili:'.length).trim();
	return isBilibiliVideoId(id) ? id : null;
}

export function bilibiliWatchUrl(videoId: string, page?: number): string {
	const base = `https://www.bilibili.com/video/${videoId}`;
	// Multi-part videos keep every part under one BV id; p=1 is implied.
	return page && page > 1 ? `${base}?p=${page}` : base;
}
