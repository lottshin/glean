import type { IncomingMessage, Server, ServerResponse } from 'http';
import {
	normalizePath,
	Notice,
	requestUrl,
	TFile,
	type App,
} from 'obsidian';
import { loadNodeModule } from '../node-bridge';
import { parseSubtitles } from '../media/srt';
import {
	bilibiliNotePath,
	bilibiliSubtitlePath,
	buildBilibiliSessionNote,
	validateBilibiliImportPayload,
	type BilibiliImportPayload,
	type BilibiliImportResponse,
} from '../bilibili/session';
import {
	buildYouTubeSessionNote,
	validateImportPayload,
	youtubeNotePath,
	youtubeSubtitlePath,
	type YouTubeImportPayload,
	type YouTubeImportResponse,
} from '../youtube/session';
import { isGleanSegmentedSubtitles, refineWebVtt } from '../youtube/vtt';

export interface YouTubeReceiverOptions {
	port: number;
	token: string;
	folder: string;
	bilibiliFolder?: string;
	onImported?: (result: {
		videoId: string;
		title: string;
		notePath: string;
		subtitlePath: string;
	}) => void;
	onBilibiliImported?: (result: {
		bvid: string;
		title: string;
		notePath: string;
		subtitlePath: string;
		mediaUrl: string;
		mediaSize: number;
		mediaExpiresAt: number | null;
	}) => void;
}

export class YouTubeImportReceiver {
	private server: Server | null = null;
	private options: YouTubeReceiverOptions;

	constructor(
		private readonly app: App,
		options: YouTubeReceiverOptions,
	) {
		this.options = options;
	}

	get running(): boolean {
		return this.server !== null;
	}

	async start(): Promise<void> {
		if (this.server) {
			return;
		}
		const http = loadNodeModule<typeof import('http')>('http');
		const server = http.createServer((req, res) => {
			void this.handle(req, res);
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.options.port, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});
		this.server = server;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) {
			return;
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}

	async restart(options: YouTubeReceiverOptions): Promise<void> {
		this.options = options;
		await this.stop();
		await this.start();
	}

	updateOptions(options: YouTubeReceiverOptions): void {
		this.options = options;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		applyCors(res);
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (req.method === 'GET' && url.pathname === '/glean/health') {
			json(res, 200, { ok: true });
			return;
		}

		if (
			(req.method === 'GET' || req.method === 'HEAD') &&
			url.pathname === BILIBILI_PROXY_PATH
		) {
			this.proxyBilibiliMedia(req, res, url);
			return;
		}

		const isYouTubeImport =
			req.method === 'POST' && url.pathname === '/glean/import';
		const isBilibiliImport =
			req.method === 'POST' && url.pathname === '/glean/import/bilibili';
		if (!isYouTubeImport && !isBilibiliImport) {
			json(res, 404, { ok: false, error: 'not found' } satisfies YouTubeImportResponse);
			return;
		}

		try {
			const body = await readJson(req);
			if (isBilibiliImport) {
				const validated = validateBilibiliImportPayload(body);
				if (!validated.ok) {
					json(res, 400, { ok: false, error: validated.error });
					return;
				}
				if (validated.payload.token !== this.options.token) {
					json(res, 401, { ok: false, error: 'token 无效' });
					return;
				}
				const imported = await this.importBilibiliPayload(validated.payload);
				json(res, 200, { ok: true, ...imported } satisfies BilibiliImportResponse);
				this.options.onBilibiliImported?.(imported);
				return;
			}
			const validated = validateImportPayload(body);
			if (!validated.ok) {
				json(res, 400, { ok: false, error: validated.error });
				return;
			}
			if (validated.payload.token !== this.options.token) {
				json(res, 401, { ok: false, error: 'token 无效' });
				return;
			}

			const imported = await this.importPayload(validated.payload);
			json(res, 200, {
				ok: true,
				videoId: imported.videoId,
				title: imported.title,
				notePath: imported.notePath,
				subtitlePath: imported.subtitlePath,
			});
			this.options.onImported?.(imported);
		} catch (error) {
			json(res, 500, {
				ok: false,
				error: error instanceof Error ? error.message : '导入失败',
			});
		}
	}

	/**
	 * Streams a Bilibili CDN file through this local server.
	 *
	 * The CDN answers 403 unless the request carries both a `Referer` of
	 * bilibili.com and a browser `User-Agent`, and it also rejects anything with
	 * an `Origin` header. A browser cannot forge the first two nor suppress the
	 * third, so `<video>` can only reach the file via this hop.
	 */
	private proxyBilibiliMedia(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	): void {
		if (url.searchParams.get('token') !== this.options.token) {
			json(res, 401, { ok: false, error: 'token 无效' });
			return;
		}
		const target = url.searchParams.get('url') ?? '';
		if (!isBilibiliMediaUrl(target)) {
			json(res, 400, { ok: false, error: '只允许 B 站媒体地址' });
			return;
		}

		const https = loadNodeModule<typeof import('https')>('https');
		const headers: Record<string, string> = {
			Referer: 'https://www.bilibili.com/',
			'User-Agent': BILIBILI_USER_AGENT,
			Accept: '*/*',
		};
		// Forwarding Range is what makes seeking work instead of refetching.
		if (typeof req.headers.range === 'string') {
			headers.Range = req.headers.range;
		}

		const upstream = https.request(
			target,
			{ method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers },
			(source) => {
				const passthrough: Record<string, string> = {};
				for (const name of [
					'content-type',
					'content-length',
					'content-range',
					'accept-ranges',
					'cache-control',
				]) {
					const value = source.headers[name];
					if (typeof value === 'string') {
						passthrough[name] = value;
					}
				}
				res.writeHead(source.statusCode ?? 502, passthrough);
				source.pipe(res);
			},
		);
		upstream.on('error', () => {
			if (!res.headersSent) {
				json(res, 502, { ok: false, error: 'B 站媒体拉取失败' });
			} else {
				res.destroy();
			}
		});
		// Abandon the upstream fetch when the player seeks away or closes.
		req.on('close', () => upstream.destroy());
		upstream.end();
	}

	/**
	 * Writes captions and the note only. The picture streams from B 站 CDN, so a
	 * sync stays instant and costs no vault space.
	 */
	private async importBilibiliPayload(payload: BilibiliImportPayload): Promise<{
		bvid: string;
		title: string;
		notePath: string;
		subtitlePath: string;
		mediaUrl: string;
		mediaSize: number;
		mediaExpiresAt: number | null;
	}> {
		const folder = normalizePath(
			this.options.bilibiliFolder?.trim() || 'Glean/Bilibili',
		);
		await ensureFolder(this.app, folder);

		const cues = parseSubtitles(payload.vtt);
		if (cues.length === 0) {
			throw new Error('字幕解析结果为空');
		}
		const subtitlePath = normalizePath(
			bilibiliSubtitlePath(folder, payload.bvid, payload.page, payload.lang),
		);
		const notePath = normalizePath(
			bilibiliNotePath(folder, payload.title, payload.bvid, payload.page),
		);
		const mediaUrl = payload.mediaUrls[0];
		if (!mediaUrl) {
			throw new Error('缺少可用的 B 站媒体地址');
		}

		await writeTextFile(this.app, subtitlePath, payload.vtt);
		await writeTextFile(
			this.app,
			notePath,
			buildBilibiliSessionNote({
				title: payload.title,
				bvid: payload.bvid,
				page: payload.page,
				cid: payload.cid,
				owner: payload.owner,
				url: payload.url,
				lang: payload.lang,
				subtitlePath,
				mediaUrl,
				mediaSize: payload.mediaSize,
				mediaQuality: payload.mediaQuality,
				mediaExpiresAt: payload.mediaExpiresAt,
			}),
		);
		return {
			bvid: payload.bvid,
			title: payload.title,
			notePath,
			subtitlePath,
			mediaUrl,
			mediaSize: payload.mediaSize,
			mediaExpiresAt: payload.mediaExpiresAt,
		};
	}

	private async importPayload(payload: YouTubeImportPayload): Promise<{
		videoId: string;
		title: string;
		notePath: string;
		subtitlePath: string;
	}> {
		const folder = normalizePath(this.options.folder.trim() || 'Glean/YouTube');
		await ensureFolder(this.app, folder);

		// Extension Worker already writes glean-segmented VTT — do not re-run NLP
		// on Obsidian's UI thread during the HTTP request.
		const vtt = isGleanSegmentedSubtitles(payload.vtt)
			? payload.vtt
			: refineWebVtt(payload.vtt);
		const cues = parseSubtitles(vtt);
		if (cues.length === 0) {
			throw new Error('字幕解析结果为空');
		}

		const subtitlePath = normalizePath(
			youtubeSubtitlePath(folder, payload.videoId, payload.lang),
		);
		const notePath = normalizePath(
			youtubeNotePath(folder, payload.title, payload.videoId),
		);

		await writeTextFile(this.app, subtitlePath, vtt);
		await writeTextFile(
			this.app,
			notePath,
			buildYouTubeSessionNote({
				title: payload.title,
				videoId: payload.videoId,
				channel: payload.channel,
				url: payload.url,
				lang: payload.lang,
				subtitlePath,
			}),
		);

		return {
			videoId: payload.videoId,
			title: payload.title,
			notePath,
			subtitlePath,
		};
	}
}

function applyCors(res: ServerResponse): void {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': new TextEncoder().encode(payload).byteLength,
	});
	res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = requestChunk(chunk);
		bytes += buffer.byteLength;
		if (bytes > 10 * 1024 * 1024) {
			throw new Error('字幕数据超过 10 MB');
		}
		chunks.push(buffer);
	}
	const merged = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const raw = new TextDecoder().decode(merged);
	if (!raw.trim()) {
		return null;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error('接收到的同步数据不是有效 JSON');
	}
}

function requestChunk(value: unknown): Uint8Array {
	if (typeof value === 'string') {
		return new TextEncoder().encode(value);
	}
	if (value instanceof Uint8Array) {
		return Uint8Array.from(value);
	}
	throw new Error('请求体编码无效');
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				if (!app.vault.getAbstractFileByPath(current)) {
					throw new Error(`无法创建目录：${current}`);
				}
			}
		}
	}
}

async function writeTextFile(app: App, path: string, content: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return;
	}
	if (existing) {
		throw new Error(`路径被占用：${path}`);
	}
	await app.vault.create(path, content);
}

export async function writeBinaryFile(
	app: App,
	path: string,
	content: ArrayBuffer,
): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modifyBinary(existing, content);
		return;
	}
	if (existing) {
		throw new Error(`路径被占用：${path}`);
	}
	await app.vault.createBinary(path, content);
}

export const BILIBILI_PROXY_PATH = '/glean/bilibili-media';

const BILIBILI_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Guards the proxy against being pointed at arbitrary hosts. */
export function isBilibiliMediaUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		return (
			url.protocol === 'https:' &&
			(host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn'))
		);
	} catch {
		return false;
	}
}

/** The local URL a `<video>` can actually load. */
export function bilibiliProxyUrl(
	port: number,
	token: string,
	mediaUrl: string,
): string {
	const params = new URLSearchParams({ token, url: mediaUrl });
	return `http://127.0.0.1:${port}${BILIBILI_PROXY_PATH}?${params.toString()}`;
}

/** Used by the "save a local copy" action, not by the sync itself. */
export async function downloadBilibiliMedia(
	urls: string[],
): Promise<ArrayBuffer> {
	const errors: string[] = [];
	for (const url of urls) {
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: {
					Referer: 'https://www.bilibili.com/',
					'User-Agent':
						'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
				},
				throw: false,
			});
			if (response.status >= 200 && response.status < 300) {
				return response.arrayBuffer;
			}
			errors.push(`HTTP ${response.status}`);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : '网络错误');
		}
	}
	throw new Error(
		`B 站媒体下载失败（${errors.join('；') || '所有地址均已失效'}）`,
	);
}

export function createReceiverToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function notifyImportSuccess(title: string, notePath: string): void {
	new Notice(`已同步：${title}\n${notePath}`);
}
