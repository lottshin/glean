import { isBilibiliVideoId } from './id';
import { sanitizeImportFileName } from '../youtube/session';

export interface BilibiliImportPayload {
	token: string;
	bvid: string;
	page: number;
	cid: number;
	title: string;
	owner: string;
	url: string;
	lang: string;
	vtt: string;
	/** Muxed MP4 links, streamed directly instead of being written to the vault. */
	mediaUrls: string[];
	mediaSize: number;
	mediaQuality: string;
	/** Unix seconds; the CDN signature dies about two hours after issue. */
	mediaExpiresAt: number | null;
}

/** A Bilibili note resolved from its frontmatter. */
export interface BilibiliSession {
	bvid: string;
	page: number;
	title: string;
	subtitlePath: string;
	/** Empty when only a local copy is on record (pre-streaming imports). */
	mediaUrl: string;
	mediaSize: number;
	mediaExpiresAt: number | null;
	localPath: string | null;
	notePath: string;
}

export interface BilibiliImportResult {
	ok: true;
	bvid: string;
	title: string;
	notePath: string;
	subtitlePath: string;
	mediaSize: number;
}

export interface BilibiliImportError {
	ok: false;
	error: string;
}

export type BilibiliImportResponse =
	| BilibiliImportResult
	| BilibiliImportError;

function partSuffix(page: number): string {
	return page > 1 ? `.p${page}` : '';
}

export function bilibiliSubtitlePath(
	folder: string,
	bvid: string,
	page: number,
	lang: string,
): string {
	const safeLang = lang.replace(/[^\w-]+/g, '_') || 'und';
	return `${folder.replace(/\/+$/, '')}/${bvid}${partSuffix(page)}.${safeLang}.vtt`;
}

/** Only used by the explicit "save a local copy" action. */
export function bilibiliMediaPath(
	folder: string,
	bvid: string,
	page: number,
): string {
	return `${folder.replace(/\/+$/, '')}/${bvid}${partSuffix(page)}.mp4`;
}

export function bilibiliNotePath(
	folder: string,
	title: string,
	bvid: string,
	page: number,
): string {
	const base = sanitizeImportFileName(title);
	const identity = page > 1 ? `${bvid} p${page}` : bvid;
	return `${folder.replace(/\/+$/, '')}/${base} (${identity}).md`;
}

export function formatMediaSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '未知大小';
	}
	const mb = bytes / 1048576;
	return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function buildBilibiliSessionNote(input: {
	title: string;
	bvid: string;
	page: number;
	cid: number;
	owner: string;
	url: string;
	lang: string;
	subtitlePath: string;
	mediaUrl: string;
	mediaSize: number;
	mediaQuality: string;
	mediaExpiresAt: number | null;
}): string {
	const front = [
		'---',
		'glean-kind: bilibili',
		`glean-video-id: ${JSON.stringify(input.bvid)}`,
		`glean-page: ${input.page}`,
		`glean-cid: ${input.cid}`,
		`title: ${JSON.stringify(input.title)}`,
		`owner: ${JSON.stringify(input.owner)}`,
		`url: ${JSON.stringify(input.url)}`,
		`lang: ${JSON.stringify(input.lang)}`,
		`subtitle: ${JSON.stringify(input.subtitlePath)}`,
		`media-url: ${JSON.stringify(input.mediaUrl)}`,
		`media-quality: ${JSON.stringify(input.mediaQuality)}`,
		`media-size: ${Math.max(0, Math.round(input.mediaSize))}`,
	];
	if (input.mediaExpiresAt !== null) {
		front.push(`media-expires: ${input.mediaExpiresAt}`);
	}
	front.push('---');

	const quality = input.mediaQuality || '未知清晰度';
	return [
		...front,
		'',
		`# ${input.title}`,
		'',
		`- UP 主：${input.owner || '未知'}`,
		`- 链接：${input.url}`,
		`- 字幕：[[${input.subtitlePath}]]`,
		`- 画面：在线播放 · ${quality} · ${formatMediaSize(input.mediaSize)}`,
		'',
		'打开此笔记后，点右上角麦穗即可进入精听。',
		'',
		'画面走 B 站直链，不占 vault 空间。直链约两小时后失效，',
		'届时回 B 站页面再点一次麦穗即可续上；想长期离线复习，',
		'在精听工具栏选「存为本地副本」。',
		'',
	].join('\n');
}

function isAllowedMediaUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		return (
			url.protocol === 'https:' &&
			(host.endsWith('.bilivideo.com') ||
				host.endsWith('.bilivideo.cn'))
		);
	} catch {
		return false;
	}
}

export function validateBilibiliImportPayload(
	body: unknown,
):
	| { ok: true; payload: BilibiliImportPayload }
	| { ok: false; error: string } {
	if (!body || typeof body !== 'object') {
		return { ok: false, error: '请求体无效' };
	}
	const record = body as Record<string, unknown>;
	const token = typeof record.token === 'string' ? record.token.trim() : '';
	const bvid = typeof record.bvid === 'string' ? record.bvid.trim() : '';
	const page = typeof record.page === 'number' ? record.page : 1;
	const cid = typeof record.cid === 'number' ? record.cid : 0;
	const title = typeof record.title === 'string' ? record.title.trim() : '';
	const owner = typeof record.owner === 'string' ? record.owner.trim() : '';
	const url = typeof record.url === 'string' ? record.url.trim() : '';
	const lang = typeof record.lang === 'string' ? record.lang.trim() : '';
	const vtt = typeof record.vtt === 'string' ? record.vtt : '';
	const mediaUrls = Array.isArray(record.mediaUrls)
		? record.mediaUrls.filter(
				(value): value is string =>
					typeof value === 'string' && isAllowedMediaUrl(value),
			)
		: [];
	const mediaSize =
		typeof record.mediaSize === 'number' && record.mediaSize > 0
			? Math.round(record.mediaSize)
			: 0;
	const mediaQuality =
		typeof record.mediaQuality === 'string' ? record.mediaQuality.trim() : '';
	const mediaExpiresAt =
		typeof record.mediaExpiresAt === 'number' &&
		Number.isSafeInteger(record.mediaExpiresAt) &&
		record.mediaExpiresAt > 0
			? record.mediaExpiresAt
			: null;

	if (!token) {
		return { ok: false, error: '缺少 token' };
	}
	if (!isBilibiliVideoId(bvid)) {
		return { ok: false, error: 'BV 号无效' };
	}
	if (!Number.isInteger(page) || page < 1) {
		return { ok: false, error: '分 P 编号无效' };
	}
	if (!Number.isSafeInteger(cid) || cid <= 0) {
		return { ok: false, error: 'cid 无效' };
	}
	if (!title) {
		return { ok: false, error: '缺少标题' };
	}
	if (!/^en(?:[-_]|$)/i.test(lang) && !/^ai-en(?:[-_]|$)/i.test(lang)) {
		return { ok: false, error: '当前只接收英文字幕轨' };
	}
	if (!vtt.trim()) {
		return { ok: false, error: '缺少字幕内容' };
	}
	if (mediaUrls.length === 0) {
		return { ok: false, error: '缺少可用的 B 站媒体地址' };
	}

	return {
		ok: true,
		payload: {
			token,
			bvid,
			page,
			cid,
			title,
			owner,
			url: url || `https://www.bilibili.com/video/${bvid}`,
			lang,
			vtt,
			mediaUrls,
			mediaSize,
			mediaQuality,
			mediaExpiresAt,
		},
	};
}
