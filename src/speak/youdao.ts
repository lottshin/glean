import type { SpeakAccent } from './tts';

export const YOUDAO_TTS_URL = 'https://openapi.youdao.com/ttsapi';

export const YOUDAO_VOICE_US = 'youmeimei';
export const YOUDAO_VOICE_GB = 'youyingying';

export interface YoudaoTtsCredentials {
	appKey: string;
	appSecret: string;
}

export type YoudaoTtsResult =
	| { status: 'ok'; data: ArrayBuffer }
	| { status: 'error'; message: string };

/** Youdao v3 `input` fragment used in the SHA-256 sign string. */
export function youdaoSignInput(q: string): string {
	if (q.length <= 20) {
		return q;
	}
	return `${q.slice(0, 10)}${q.length}${q.slice(-10)}`;
}

export function youdaoVoiceName(accent: SpeakAccent): string {
	return accent === 'en-GB' ? YOUDAO_VOICE_GB : YOUDAO_VOICE_US;
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function buildYoudaoTtsForm(
	text: string,
	accent: SpeakAccent,
	credentials: YoudaoTtsCredentials,
	nowSeconds: number = Math.floor(Date.now() / 1000),
	salt: string = crypto.randomUUID(),
): Promise<URLSearchParams> {
	const q = text.trim();
	const sign = await sha256Hex(
		`${credentials.appKey}${youdaoSignInput(q)}${salt}${nowSeconds}${credentials.appSecret}`,
	);
	const body = new URLSearchParams();
	body.set('q', q);
	body.set('appKey', credentials.appKey);
	body.set('salt', salt);
	body.set('sign', sign);
	body.set('signType', 'v3');
	body.set('curtime', String(nowSeconds));
	body.set('format', 'mp3');
	body.set('voiceName', youdaoVoiceName(accent));
	return body;
}

export function youdaoErrorMessage(errorCode: string): string {
	switch (errorCode) {
		case '108':
			return '有道应用 ID 无效';
		case '110':
			return '这个应用还没绑定语音合成，请在有道控制台给应用添加 TTS';
		case '111':
			return '有道账户欠费或体验金不足';
		case '202':
			return '有道签名错误，请核对应用密钥';
		case '401':
			return '有道拒绝了这次请求（频率或权限）';
		default:
			return `有道朗读失败（${errorCode}）`;
	}
}

export function parseYoudaoTtsResponse(
	contentType: string,
	text: string,
	data: ArrayBuffer,
): YoudaoTtsResult {
	const type = contentType.toLowerCase();
	if (type.includes('audio') && data.byteLength > 0) {
		return { status: 'ok', data };
	}
	let code = '';
	try {
		const payload = JSON.parse(text) as { errorCode?: unknown };
		if (typeof payload.errorCode === 'string' || typeof payload.errorCode === 'number') {
			code = String(payload.errorCode);
		}
	} catch {
		code = '';
	}
	if (!code && data.byteLength > 64) {
		return { status: 'ok', data };
	}
	return {
		status: 'error',
		message: youdaoErrorMessage(code || 'unknown'),
	};
}
