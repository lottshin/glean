import { timedTextToWebVtt, type TimedTextPayload } from '../../src/youtube/vtt';
import {
	bilibiliSubtitleToWebVtt,
	type BilibiliSubtitlePayload,
	type BilibiliSubtitleTrack,
} from '../../src/bilibili/subtitle';

interface SyncMessage {
	type: 'glean-sync';
	payload: {
		videoId: string;
		title: string;
		channel: string;
		url: string;
		lang: string;
		vtt: string;
	};
}

interface SegmentMessage {
	type: 'glean-segment-json3';
	raw: string;
	cacheKey?: string;
}

interface BilibiliVttMessage {
	type: 'glean-bilibili-vtt';
	track: BilibiliSubtitleTrack;
}

interface BilibiliSyncMessage {
	type: 'glean-sync-bilibili';
	payload: {
		bvid: string;
		page: number;
		cid: number;
		title: string;
		owner: string;
		url: string;
		lang: string;
		vtt: string;
		mediaUrls: string[];
		mediaSize: number;
		mediaQuality: string;
		mediaExpiresAt: number | null;
	};
}

const SEGMENT_CACHE_PREFIX = 'glean-seg:v4';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || typeof message !== 'object') {
		return false;
	}
	const type = (message as { type?: unknown }).type;
	if (type === 'glean-segment-json3') {
		void segmentJson3(message as SegmentMessage)
			.then((result) => sendResponse(result))
			.catch((error: unknown) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : '字幕分句失败',
				}),
			);
		return true;
	}
	if (type === 'glean-sync') {
		void syncToObsidian(message as SyncMessage)
			.then((result) => sendResponse(result))
			.catch((error: unknown) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : '同步失败',
				}),
			);
		return true;
	}
	if (type === 'glean-bilibili-vtt') {
		void fetchBilibiliVtt(message as BilibiliVttMessage)
			.then((result) => sendResponse(result))
			.catch((error: unknown) =>
				sendResponse({
					ok: false,
					error:
						error instanceof Error ? error.message : 'B 站字幕下载失败',
				}),
			);
		return true;
	}
	if (type === 'glean-sync-bilibili') {
		void syncBilibiliToObsidian(message as BilibiliSyncMessage)
			.then((result) => sendResponse(result))
			.catch((error: unknown) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : '同步失败',
				}),
			);
		return true;
	}
	return false;
});

async function fetchBilibiliVtt(
	message: BilibiliVttMessage,
): Promise<{ ok: boolean; vtt?: string; error?: string }> {
	const url = message.track?.subtitleUrl;
	if (!url) {
		return { ok: false, error: '字幕地址为空' };
	}
	const response = await fetch(url, { credentials: 'include' });
	if (!response.ok) {
		return {
			ok: false,
			error: `B 站字幕下载失败（HTTP ${response.status}）`,
		};
	}
	const payload = (await response.json()) as BilibiliSubtitlePayload;
	// Bilibili already supplies sentence-level cue boundaries. Keep those exact
	// timings instead of applying YouTube's ASR-specific resegmentation.
	const vtt = bilibiliSubtitleToWebVtt(payload);
	if (!vtt.includes('-->')) {
		return { ok: false, error: 'B 站字幕为空' };
	}
	return { ok: true, vtt };
}

async function segmentJson3(
	message: SegmentMessage,
): Promise<{ ok: boolean; vtt?: string; error?: string }> {
	const cacheKey =
		typeof message.cacheKey === 'string' && message.cacheKey
			? `${SEGMENT_CACHE_PREFIX}:${message.cacheKey}`
			: '';
	if (cacheKey) {
		try {
			const stored = await chrome.storage.local.get(cacheKey);
			const hit = stored[cacheKey];
			if (typeof hit === 'string' && hit.includes('-->')) {
				return { ok: true, vtt: hit };
			}
		} catch {
			// Ignore cache read failures.
		}
	}

	let payload: TimedTextPayload;
	try {
		payload = JSON.parse(message.raw) as TimedTextPayload;
	} catch {
		return { ok: false, error: '字幕 JSON 无效' };
	}
	if (!payload || !Array.isArray(payload.events)) {
		return { ok: false, error: '无效的字幕数据' };
	}
	const vtt = timedTextToWebVtt(payload);
	if (!vtt.includes('-->')) {
		return { ok: false, error: '字幕为空' };
	}
	if (cacheKey) {
		try {
			await chrome.storage.local.set({ [cacheKey]: vtt });
		} catch {
			// Best-effort cache.
		}
	}
	return { ok: true, vtt };
}

async function syncToObsidian(message: SyncMessage): Promise<{ ok: boolean; error?: string }> {
	return postToObsidian('/glean/import', message.payload);
}

async function syncBilibiliToObsidian(
	message: BilibiliSyncMessage,
): Promise<{ ok: boolean; error?: string }> {
	return postToObsidian('/glean/import/bilibili', message.payload);
}

async function postToObsidian(
	path: string,
	payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
	const stored = await chrome.storage.sync.get({
		port: 17865,
		token: '',
	});
	const port = typeof stored.port === 'number' ? stored.port : Number(stored.port) || 17865;
	const token = typeof stored.token === 'string' ? stored.token.trim() : '';
	if (!token) {
		return { ok: false, error: '未配置 token' };
	}

	const endpoint = `http://127.0.0.1:${port}${path}`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				token,
				...payload,
			}),
		});
	} catch {
		return {
			ok: false,
			error: '连不上 Obsidian。请确认桌面端已打开并启用 Glean 接收端。',
		};
	}

	const raw = await response.text();
	let body: { ok?: boolean; error?: string } = {};
	if (raw.trim()) {
		try {
			body = JSON.parse(raw) as { ok?: boolean; error?: string };
		} catch {
			return {
				ok: false,
				error: `接收端返回了无法解析的响应（HTTP ${response.status}）`,
			};
		}
	}

	if (!response.ok || body.ok === false) {
		return {
			ok: false,
			error: body.error ?? `接收端返回 HTTP ${response.status}`,
		};
	}
	return { ok: true };
}
