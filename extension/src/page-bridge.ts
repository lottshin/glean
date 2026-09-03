import {
	captureYouTubePage,
	acceptCaptionRaw,
	prepareTimedTextUrl,
	type CaptionTrack,
} from './capture';

const REQUEST_CAPTURE = 'glean-request-capture';
const RESPONSE_CAPTURE = 'glean-capture-response';
const REQUEST_TIMEDTEXT = 'glean-request-timedtext';
const RESPONSE_TIMEDTEXT = 'glean-timedtext-response';
const INSTALLED_KEY = '__gleanPageBridgeInstalled';
const CACHE_KEY = '__gleanTimedTextCache';

interface TimedTextCacheEntry {
	videoId: string;
	languageCode: string;
	text: string;
	url: string;
}

const pageWindow = window as unknown as Record<string, unknown>;

function getCache(): TimedTextCacheEntry[] {
	const existing = pageWindow[CACHE_KEY];
	if (Array.isArray(existing)) {
		return existing as TimedTextCacheEntry[];
	}
	const cache: TimedTextCacheEntry[] = [];
	pageWindow[CACHE_KEY] = cache;
	return cache;
}

function rememberTimedText(url: string, text: string): void {
	if (!text.trim()) {
		return;
	}
	try {
		const parsed = new URL(url, location.href);
		if (!parsed.pathname.includes('timedtext')) {
			return;
		}
		const videoId =
			parsed.searchParams.get('v') ||
			new URL(location.href).searchParams.get('v') ||
			'';
		// Auto-translated responses use tlang; prefer that over source lang.
		const languageCode =
			parsed.searchParams.get('tlang') ||
			parsed.searchParams.get('lang') ||
			'';
		if (!videoId || !languageCode) {
			return;
		}
		const cache = getCache();
		const next: TimedTextCacheEntry = {
			videoId,
			languageCode,
			text,
			url: parsed.toString(),
		};
		const index = cache.findIndex(
			(entry) =>
				entry.videoId === videoId &&
				entry.languageCode.toLowerCase() === languageCode.toLowerCase(),
		);
		if (index >= 0) {
			cache[index] = next;
		} else {
			cache.push(next);
		}
		if (cache.length > 12) {
			cache.shift();
		}
	} catch {
		// Ignore malformed URLs.
	}
}

function findCachedTimedText(videoId: string, languageCode: string): string | null {
	const wanted = languageCode.trim().toLowerCase();
	if (!wanted) {
		return null;
	}
	const cache = getCache();
	const exact = cache.find((entry) => {
		if (entry.videoId !== videoId || !entry.text.trim()) {
			return false;
		}
		const cachedLang = entry.languageCode.trim().toLowerCase();
		return (
			cachedLang === wanted ||
			cachedLang.startsWith(`${wanted}-`) ||
			wanted.startsWith(`${cachedLang}-`)
		);
	});
	return exact?.text ?? null;
}

function findPoToken(): string | null {
	for (const entry of performance.getEntriesByType('resource')) {
		try {
			const url = new URL(entry.name);
			if (!url.pathname.includes('timedtext')) {
				continue;
			}
			const pot = url.searchParams.get('pot');
			if (pot) {
				return pot;
			}
		} catch {
			// Keep scanning.
		}
	}

	for (const entry of getCache()) {
		try {
			const pot = new URL(entry.url).searchParams.get('pot');
			if (pot) {
				return pot;
			}
		} catch {
			// Keep scanning.
		}
	}

	return null;
}

function installNetworkHooks(): void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await originalFetch(input, init);
		try {
			const url =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes('timedtext')) {
				const clone = response.clone();
				void clone.text().then((text) => rememberTimedText(url, text));
			}
		} catch {
			// Never break page networking.
		}
		return response;
	};

	const originalOpen = XMLHttpRequest.prototype.open;
	const originalSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (
		method: string,
		url: string | URL,
		async?: boolean,
		username?: string | null,
		password?: string | null,
	) {
		(this as XMLHttpRequest & { __gleanUrl?: string }).__gleanUrl = String(url);
		return originalOpen.call(this, method, url, async ?? true, username, password);
	};
	XMLHttpRequest.prototype.send = function (
		body?: Document | XMLHttpRequestBodyInit | null,
	) {
		this.addEventListener('load', () => {
			const url = (this as XMLHttpRequest & { __gleanUrl?: string }).__gleanUrl;
			if (url?.includes('timedtext') && typeof this.responseText === 'string') {
				rememberTimedText(url, this.responseText);
			}
		});
		return originalSend.call(this, body);
	};
}

async function ensureCaptionsWarm(): Promise<void> {
	const button = document.querySelector('.ytp-subtitles-button');
	if (!(button instanceof HTMLElement)) {
		return;
	}
	const pressed = button.getAttribute('aria-pressed') === 'true';
	if (!pressed) {
		button.click();
		await new Promise((resolve) => window.setTimeout(resolve, 1200));
		return;
	}
	// Already on: briefly toggle to force a fresh timedtext request with pot.
	button.click();
	await new Promise((resolve) => window.setTimeout(resolve, 250));
	button.click();
	await new Promise((resolve) => window.setTimeout(resolve, 1200));
}

function looksLikeChinese(text: string): boolean {
	const sample = text.slice(0, 2000);
	const cjk = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
	const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
	return cjk >= 20 && cjk > latin;
}

function cacheMatchesTrack(raw: string, languageCode: string): boolean {
	const lang = languageCode.toLowerCase();
	if (lang.startsWith('zh')) {
		return true;
	}
	if (lang.startsWith('en') && looksLikeChinese(raw)) {
		return false;
	}
	return true;
}

async function fetchTimedTextInPage(
	track: CaptionTrack,
	videoId: string,
): Promise<string> {
	// Return RAW json3/vtt only — full NLP segmentation runs once in the
	// extension service worker so the YouTube tab stays responsive.
	const tryAccept = (raw: string): string | null => {
		if (!cacheMatchesTrack(raw, track.languageCode)) {
			return null;
		}
		return acceptCaptionRaw(raw)?.raw ?? null;
	};

	const cached = findCachedTimedText(videoId, track.languageCode);
	if (cached) {
		const accepted = tryAccept(cached);
		if (accepted) {
			return accepted;
		}
	}

	await ensureCaptionsWarm();
	const warmed = findCachedTimedText(videoId, track.languageCode);
	if (warmed) {
		const accepted = tryAccept(warmed);
		if (accepted) {
			return accepted;
		}
	}

	const pot = findPoToken();
	const errors: string[] = [];
	for (const fmt of ['json3', 'vtt'] as const) {
		const url = prepareTimedTextUrl(track.baseUrl, {
			fmt,
			pot,
			client: 'WEB',
		});
		try {
			const response = await fetch(url, {
				credentials: 'include',
				headers: { Accept: '*/*' },
			});
			if (!response.ok) {
				errors.push(`${fmt}: HTTP ${response.status}`);
				continue;
			}
			const text = await response.text();
			rememberTimedText(url, text);
			if (!text.trim()) {
				errors.push(`${fmt}: 空响应`);
				continue;
			}
			if (!cacheMatchesTrack(text, track.languageCode)) {
				errors.push(`${fmt}: 语言与所选轨道不符`);
				continue;
			}
			const accepted = acceptCaptionRaw(text);
			if (accepted && (accepted.fmt === fmt || accepted.fmt === 'json3')) {
				return accepted.raw;
			}
			if (accepted) {
				return accepted.raw;
			}
			errors.push(`${fmt}: 无法解析`);
		} catch (error) {
			errors.push(
				`${fmt}: ${error instanceof Error ? error.message : '网络错误'}`,
			);
		}
	}

	throw new Error(
		errors.join('；') ||
			'字幕下载失败。请先把播放器字幕切到目标语言，等字幕出现后再同步。',
	);
}

if (!pageWindow[INSTALLED_KEY]) {
	pageWindow[INSTALLED_KEY] = true;
	installNetworkHooks();

	document.addEventListener(REQUEST_CAPTURE, (event) => {
		const requestId =
			event instanceof CustomEvent && typeof event.detail === 'string'
				? event.detail
				: '';
		if (!requestId) {
			return;
		}
		document.dispatchEvent(
			new CustomEvent(RESPONSE_CAPTURE, {
				detail: JSON.stringify({
					requestId,
					capture: captureYouTubePage(),
				}),
			}),
		);
	});

	document.addEventListener(REQUEST_TIMEDTEXT, (event) => {
		if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
			return;
		}
		let detail: {
			requestId?: unknown;
			videoId?: unknown;
			track?: CaptionTrack;
		};
		try {
			detail = JSON.parse(event.detail) as {
				requestId?: unknown;
				videoId?: unknown;
				track?: CaptionTrack;
			};
		} catch {
			return;
		}
		const requestId = typeof detail.requestId === 'string' ? detail.requestId : '';
		const videoId = typeof detail.videoId === 'string' ? detail.videoId : '';
		const track = detail.track;
		if (!requestId || !videoId || !track?.baseUrl) {
			return;
		}
		void fetchTimedTextInPage(track, videoId)
			.then((text) => {
				document.dispatchEvent(
					new CustomEvent(RESPONSE_TIMEDTEXT, {
						detail: JSON.stringify({ requestId, text }),
					}),
				);
			})
			.catch((error: unknown) => {
				document.dispatchEvent(
					new CustomEvent(RESPONSE_TIMEDTEXT, {
						detail: JSON.stringify({
							requestId,
							error: error instanceof Error ? error.message : '字幕下载失败',
						}),
					}),
				);
			});
	});
}
