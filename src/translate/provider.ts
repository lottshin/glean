export type TranslationProvider = 'deepl' | 'openai';

export interface TranslationConfig {
	enabled: boolean;
	provider: TranslationProvider;
	apiKey: string;
	endpoint: string;
	model: string;
	targetLang: string;
}

export interface TranslationRequest {
	url: string;
	method: 'POST';
	headers: Record<string, string>;
	body: string;
}

export interface TranslationResponse {
	status: number;
	text: string;
}

/** Injected so the pure request/response logic stays testable off Obsidian. */
export type TranslationTransport = (
	request: TranslationRequest,
) => Promise<TranslationResponse>;

/** A whole chapter would blow past provider limits and cost real money. */
export const MAX_TRANSLATION_CHARS = 4000;

export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';

/** An unreachable host can hang forever, leaving the panel stuck on "翻译中". */
export const TRANSLATION_TIMEOUT_MS = 30_000;

export class TranslationError extends Error {}

export function buildRequest(
	config: TranslationConfig,
	text: string,
): TranslationRequest {
	if (config.provider === 'deepl') {
		return {
			url: deeplUrl(config.endpoint, config.apiKey),
			method: 'POST',
			headers: {
				Authorization: `DeepL-Auth-Key ${config.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				text: [text],
				target_lang: deeplTarget(config.targetLang),
			}),
		};
	}

	const base = (config.endpoint.trim() || DEFAULT_OPENAI_ENDPOINT).replace(/\/+$/, '');
	return {
		url: `${base}/chat/completions`,
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: config.model,
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						`Translate the user's text into ${config.targetLang}. ` +
						'Reply with the translation only, no notes and no quotes.',
				},
				{ role: 'user', content: text },
			],
		}),
	};
}

export function parseResponse(
	provider: TranslationProvider,
	response: TranslationResponse,
): string {
	if (response.status < 200 || response.status >= 300) {
		throw new TranslationError(
			`翻译服务返回 ${response.status}：${briefError(response.text)}`,
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(response.text);
	} catch {
		throw new TranslationError('翻译服务返回了无法解析的内容');
	}

	const translated =
		provider === 'deepl' ? deeplText(payload) : openaiText(payload);
	if (!translated) {
		throw new TranslationError('翻译服务没有返回译文');
	}
	return translated.trim();
}

export async function translateText(
	config: TranslationConfig,
	text: string,
	transport: TranslationTransport,
	timeoutMs?: number,
): Promise<string> {
	if (!config.enabled) {
		throw new TranslationError('在线翻译未开启，请在 Glean 设置中启用');
	}
	if (!config.apiKey.trim()) {
		throw new TranslationError('缺少 API key，请在 Glean 设置中填写');
	}
	const trimmed = text.trim();
	if (!trimmed) {
		throw new TranslationError('没有可翻译的内容');
	}
	if (trimmed.length > MAX_TRANSLATION_CHARS) {
		throw new TranslationError(
			`选区超过 ${MAX_TRANSLATION_CHARS} 字，请分段翻译`,
		);
	}
	return parseResponse(
		config.provider,
		await withTimeout(
			transport(buildRequest(config, trimmed)),
			timeoutMs ?? TRANSLATION_TIMEOUT_MS,
		),
	);
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new TranslationError('翻译服务无响应，请检查网络或接口地址')),
			ms,
		);
	});
	return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function deeplUrl(endpoint: string, apiKey: string): string {
	const configured = endpoint.trim().replace(/\/+$/, '');
	if (configured) {
		return `${configured}/translate`;
	}
	// DeepL routes free keys to a separate host; the suffix is the only signal.
	return apiKey.trim().endsWith(':fx')
		? 'https://api-free.deepl.com/v2/translate'
		: 'https://api.deepl.com/v2/translate';
}

/**
 * DeepL takes language codes, but the setting holds a human-readable name so
 * the OpenAI prompt reads naturally. Map the common names, pass codes through.
 */
const DEEPL_LANGUAGES = new Map([
	['中文', 'ZH'],
	['简体中文', 'ZH'],
	['中文（简体）', 'ZH'],
	['CHINESE', 'ZH'],
	['ZH-CN', 'ZH'],
	['ZH-HANS', 'ZH'],
	['繁体中文', 'ZH-HANT'],
	['中文（繁體）', 'ZH-HANT'],
	['英文', 'EN'],
	['英语', 'EN'],
	['ENGLISH', 'EN'],
	['日文', 'JA'],
	['日语', 'JA'],
	['JAPANESE', 'JA'],
]);

function deeplTarget(targetLang: string): string {
	const value = targetLang.trim().toUpperCase();
	if (!value) {
		return 'ZH';
	}
	return DEEPL_LANGUAGES.get(value) ?? value;
}

function firstItem(payload: unknown, key: string): unknown {
	if (!isRecord(payload)) {
		return null;
	}
	const list: unknown = payload[key];
	return Array.isArray(list) ? (list as unknown[])[0] : null;
}

function deeplText(payload: unknown): string {
	const first = firstItem(payload, 'translations');
	return isRecord(first) && typeof first.text === 'string' ? first.text : '';
}

function openaiText(payload: unknown): string {
	const first = firstItem(payload, 'choices');
	if (!isRecord(first) || !isRecord(first.message)) {
		return '';
	}
	return typeof first.message.content === 'string' ? first.message.content : '';
}

function briefError(text: string): string {
	const compact = text.replace(/\s+/g, ' ').trim();
	if (!compact) {
		return '无返回内容';
	}
	return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
