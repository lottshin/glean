import {
	parseSubtitleTracks,
	type BilibiliSubtitleTrack,
} from '../../src/bilibili/subtitle';
import { parseBilibiliVideoId } from '../../src/bilibili/id';

export interface BilibiliPart {
	cid: number;
	page: number;
	title: string;
}

export interface BilibiliCapture {
	bvid: string;
	aid: number;
	cid: number;
	page: number;
	title: string;
	owner: string;
	url: string;
	tracks: BilibiliSubtitleTrack[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Read the part list from an /x/web-interface/view response. */
export function parseParts(response: unknown): BilibiliPart[] {
	const data = asRecord(asRecord(response)?.data);
	const pages = data?.pages;
	if (!Array.isArray(pages)) {
		return [];
	}
	const parts: BilibiliPart[] = [];
	for (const item of pages) {
		const record = asRecord(item);
		const cid = num(record?.cid);
		if (!cid) {
			continue;
		}
		parts.push({
			cid,
			page: num(record?.page) || parts.length + 1,
			title: typeof record?.part === 'string' ? record.part : '',
		});
	}
	return parts;
}

export interface BilibiliVideoInfo {
	bvid: string;
	aid: number;
	title: string;
	owner: string;
	parts: BilibiliPart[];
}

export function parseVideoInfo(response: unknown): BilibiliVideoInfo | null {
	const root = asRecord(response);
	const data = asRecord(root?.data);
	if (!data) {
		return null;
	}
	const bvid = typeof data.bvid === 'string' ? data.bvid : '';
	if (!bvid) {
		return null;
	}
	return {
		bvid,
		aid: num(data.aid),
		title: typeof data.title === 'string' ? data.title : bvid,
		owner: typeof asRecord(data.owner)?.name === 'string'
			? (asRecord(data.owner)?.name as string)
			: '',
		parts: parseParts(response),
	};
}

/** Which part the URL points at; multi-part videos share one BV id. */
export function parsePageNumber(locationHref: string): number {
	try {
		const raw = new URL(locationHref).searchParams.get('p');
		const page = raw ? Number(raw) : 1;
		return Number.isInteger(page) && page > 0 ? page : 1;
	} catch {
		return 1;
	}
}

export function selectPart(parts: BilibiliPart[], page: number): BilibiliPart | null {
	return parts.find((part) => part.page === page) ?? parts[0] ?? null;
}

/**
 * Reuse the exact WBI URL the Bilibili page has already signed. The unsigned
 * /x/player/v2 endpoint is observably inconsistent: for the same signed-in
 * account and video it can alternate between full tracks, AI-only, and empty.
 */
export function findSignedPlayerUrl(
	resourceUrls: readonly string[],
	aid: number,
	cid: number,
): string | null {
	for (let i = resourceUrls.length - 1; i >= 0; i -= 1) {
		const raw = resourceUrls[i];
		if (!raw?.includes('/x/player/wbi/v2?')) {
			continue;
		}
		try {
			const url = new URL(raw);
			if (
				url.searchParams.get('aid') === String(aid) &&
				url.searchParams.get('cid') === String(cid) &&
				url.searchParams.has('w_rid') &&
				url.searchParams.has('wts')
			) {
				return url.toString();
			}
		} catch {
			// Ignore malformed performance entries.
		}
	}
	return null;
}

function currentResourceUrls(): string[] {
	if (typeof performance === 'undefined') {
		return [];
	}
	return performance
		.getEntriesByType('resource')
		.map((entry) => entry.name);
}

/**
 * Collect everything needed to sync one Bilibili video.
 *
 * Runs from the content script so requests carry the user's bilibili.com
 * cookies. That matters for the subtitle list: Bilibili returns an empty list
 * to anonymous callers, and there is no way around it other than being
 * signed in.
 */
export async function captureBilibiliPage(
	locationHref: string,
	fetchImpl: typeof fetch = fetch,
): Promise<BilibiliCapture | null> {
	const bvid = parseBilibiliVideoId(locationHref);
	if (!bvid) {
		return null;
	}

	const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
	const viewResponse = await fetchImpl(viewUrl, { credentials: 'include' });
	if (!viewResponse.ok) {
		throw new Error(`读取视频信息失败（HTTP ${viewResponse.status}）`);
	}
	const info = parseVideoInfo(await viewResponse.json());
	if (!info) {
		throw new Error('读取视频信息失败');
	}

	const page = parsePageNumber(locationHref);
	const part = selectPart(info.parts, page);
	if (!part) {
		throw new Error('这个视频没有可播放的分P');
	}

	return {
		bvid: info.bvid,
		aid: info.aid,
		cid: part.cid,
		page: part.page,
		title: part.title && info.parts.length > 1
			? `${info.title} - ${part.title}`
			: info.title,
		owner: info.owner,
		url: `https://www.bilibili.com/video/${info.bvid}${part.page > 1 ? `?p=${part.page}` : ''}`,
		tracks: await fetchSubtitleTracks(
			info.aid,
			part.cid,
			fetchImpl,
			findSignedPlayerUrl(currentResourceUrls(), info.aid, part.cid),
		),
	};
}

/**
 * Prefer the page's WBI-signed endpoint. The plain endpoint remains a fallback
 * for tests and pages where the resource entry has already been cleared.
 */
export async function fetchSubtitleTracks(
	aid: number,
	cid: number,
	fetchImpl: typeof fetch = fetch,
	signedUrl: string | null = null,
): Promise<BilibiliSubtitleTrack[]> {
	if (signedUrl) {
		try {
			const signed = await fetchImpl(signedUrl, {
				credentials: 'include',
				cache: 'no-store',
			});
			if (signed.ok) {
				return parseSubtitleTracks(await signed.json());
			}
		} catch {
			// Fall through to the legacy endpoint with an actionable result.
		}
	}
	const url = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`;
	const response = await fetchImpl(url, { credentials: 'include' });
	if (!response.ok) {
		throw new Error(`读取字幕列表失败（HTTP ${response.status}）`);
	}
	return parseSubtitleTracks(await response.json());
}

/** Download one track's cue body. */
export async function fetchSubtitleBody(
	track: BilibiliSubtitleTrack,
	fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
	const response = await fetchImpl(track.subtitleUrl, { credentials: 'include' });
	if (!response.ok) {
		throw new Error(`下载字幕失败（HTTP ${response.status}）`);
	}
	return response.json();
}
