export interface YouTubeImportPayload {
	token: string;
	videoId: string;
	title: string;
	channel: string;
	url: string;
	lang: string;
	vtt: string;
}

export interface YouTubeImportResult {
	ok: true;
	videoId: string;
	title: string;
	notePath: string;
	subtitlePath: string;
}

export interface YouTubeImportError {
	ok: false;
	error: string;
}

export type YouTubeImportResponse = YouTubeImportResult | YouTubeImportError;

export function sanitizeImportFileName(input: string): string {
	const cleaned = input
		.replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.slice(0, 80) || 'untitled';
}

export function youtubeSubtitlePath(
	folder: string,
	videoId: string,
	lang: string,
): string {
	const safeLang = lang.replace(/[^\w-]+/g, '_') || 'und';
	return `${folder.replace(/\/+$/, '')}/${videoId}.${safeLang}.vtt`;
}

export function youtubeNotePath(folder: string, title: string, videoId: string): string {
	const base = sanitizeImportFileName(title);
	return `${folder.replace(/\/+$/, '')}/${base} (${videoId}).md`;
}

export function buildYouTubeSessionNote(input: {
	title: string;
	videoId: string;
	channel: string;
	url: string;
	lang: string;
	subtitlePath: string;
}): string {
	const lines = [
		'---',
		'glean-kind: youtube',
		`glean-video-id: ${JSON.stringify(input.videoId)}`,
		`title: ${JSON.stringify(input.title)}`,
		`channel: ${JSON.stringify(input.channel)}`,
		`url: ${JSON.stringify(input.url)}`,
		`lang: ${JSON.stringify(input.lang)}`,
		`subtitle: ${JSON.stringify(input.subtitlePath)}`,
		'---',
		'',
		`# ${input.title}`,
		'',
		`- 频道：${input.channel || '未知'}`,
		`- 链接：${input.url}`,
		`- 字幕：[[${input.subtitlePath}]]`,
		'',
		'打开此笔记后，点右上角麦穗即可进入精听；英文文章笔记点麦穗则进入阅读。',
		'也可以运行命令「Glean: 精听当前 YouTube 笔记」。',
		'',
	];
	return lines.join('\n');
}

export function validateImportPayload(
	body: unknown,
): { ok: true; payload: YouTubeImportPayload } | { ok: false; error: string } {
	if (!body || typeof body !== 'object') {
		return { ok: false, error: '请求体无效' };
	}
	const record = body as Record<string, unknown>;
	const token = typeof record.token === 'string' ? record.token.trim() : '';
	const videoId = typeof record.videoId === 'string' ? record.videoId.trim() : '';
	const title = typeof record.title === 'string' ? record.title.trim() : '';
	const channel = typeof record.channel === 'string' ? record.channel.trim() : '';
	const url = typeof record.url === 'string' ? record.url.trim() : '';
	const lang = typeof record.lang === 'string' ? record.lang.trim() : '';
	const vtt = typeof record.vtt === 'string' ? record.vtt : '';

	if (!token) {
		return { ok: false, error: '缺少 token' };
	}
	if (!/^[\w-]{11}$/.test(videoId)) {
		return { ok: false, error: 'videoId 无效' };
	}
	if (!title) {
		return { ok: false, error: '缺少标题' };
	}
	if (!lang) {
		return { ok: false, error: '缺少字幕语言' };
	}
	if (!vtt.trim()) {
		return { ok: false, error: '缺少字幕内容' };
	}
	return {
		ok: true,
		payload: {
			token,
			videoId,
			title,
			channel,
			url: url || `https://www.youtube.com/watch?v=${videoId}`,
			lang,
			vtt,
		},
	};
}
