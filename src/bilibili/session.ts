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
	audioUrls: string[];
}

export interface BilibiliImportResult {
	ok: true;
	bvid: string;
	title: string;
	notePath: string;
	subtitlePath: string;
	audioPath: string;
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

export function bilibiliAudioPath(
	folder: string,
	bvid: string,
	page: number,
): string {
	return `${folder.replace(/\/+$/, '')}/${bvid}${partSuffix(page)}.m4a`;
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

export function buildBilibiliSessionNote(input: {
	title: string;
	bvid: string;
	page: number;
	cid: number;
	owner: string;
	url: string;
	lang: string;
	subtitlePath: string;
	audioPath: string;
}): string {
	return [
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
		`audio: ${JSON.stringify(input.audioPath)}`,
		'---',
		'',
		`# ${input.title}`,
		'',
		`- UP 主：${input.owner || '未知'}`,
		`- 链接：${input.url}`,
		`- 字幕：[[${input.subtitlePath}]]`,
		`- 音频：[[${input.audioPath}]]`,
		'',
		'打开此笔记后，点右上角麦穗即可进入精听。',
		'',
	].join('\n');
}

function isAllowedAudioUrl(value: string): boolean {
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
	const audioUrls = Array.isArray(record.audioUrls)
		? record.audioUrls.filter(
				(value): value is string =>
					typeof value === 'string' && isAllowedAudioUrl(value),
			)
		: [];

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
	if (audioUrls.length === 0) {
		return { ok: false, error: '缺少可用的 B 站音频地址' };
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
			audioUrls,
		},
	};
}
