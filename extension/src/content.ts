import {
	acceptCaptionRaw,
	captureYouTubeFromHtml,
	captureYouTubePage,
	fetchTrackRaw,
	pickDefaultTrack,
	type CaptionTrack,
	type YouTubeCapture,
} from './capture';

const BUTTON_ID = 'glean-sync-button';
const ICON_CLASS = 'glean-sync-btn__icon';
/** Tooltip when idle; busy/done/error swap in their own text. */
const DEFAULT_TITLE = '同步字幕到 Obsidian Glean';
/** The packaged app icon — icon-only like Immersive Translate. */
const BRAND_ICON_PATH = 'icons/icon-32.png';

const REQUEST_EVENT = 'glean-request-capture';
const RESPONSE_EVENT = 'glean-capture-response';
const REQUEST_TIMEDTEXT = 'glean-request-timedtext';
const RESPONSE_TIMEDTEXT = 'glean-timedtext-response';

let bridgeReady: Promise<void> | null = null;

function ensurePageBridge(): Promise<void> {
	if (document.documentElement.dataset.gleanBridge === 'ready') {
		return Promise.resolve();
	}
	if (bridgeReady) {
		return bridgeReady;
	}
	bridgeReady = new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = chrome.runtime.getURL('page-bridge.js');
		script.addEventListener('load', () => {
			document.documentElement.dataset.gleanBridge = 'ready';
			script.remove();
			resolve();
		});
		script.addEventListener('error', () => {
			bridgeReady = null;
			reject(new Error('page-bridge 加载失败'));
		});
		(document.head ?? document.documentElement).appendChild(script);
	});
	return bridgeReady;
}

function requestBridgeCapture(timeoutMs = 1500): Promise<YouTubeCapture | null> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => {
			document.removeEventListener(RESPONSE_EVENT, onResponse);
			resolve(null);
		}, timeoutMs);
		const onResponse = (event: Event) => {
			if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
				return;
			}
			let detail: { requestId?: unknown; capture?: unknown };
			try {
				detail = JSON.parse(event.detail) as {
					requestId?: unknown;
					capture?: unknown;
				};
			} catch {
				return;
			}
			if (detail.requestId !== requestId) {
				return;
			}
			window.clearTimeout(timer);
			document.removeEventListener(RESPONSE_EVENT, onResponse);
			resolve((detail.capture as YouTubeCapture | null) ?? null);
		};
		document.addEventListener(RESPONSE_EVENT, onResponse);
		document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: requestId }));
	});
}

async function captureFromWatchHtml(): Promise<YouTubeCapture | null> {
	const videoId = new URL(location.href).searchParams.get('v');
	if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
		return null;
	}
	const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
		credentials: 'include',
	});
	if (!response.ok) {
		return null;
	}
	return captureYouTubeFromHtml(await response.text(), location.href);
}

function preferRicherCapture(
	primary: YouTubeCapture | null,
	fallback: YouTubeCapture | null,
): YouTubeCapture | null {
	if (!primary) {
		return fallback;
	}
	if (!fallback) {
		return primary;
	}
	if (fallback.tracks.length > primary.tracks.length) {
		return fallback;
	}
	return primary;
}

async function getCapture(): Promise<YouTubeCapture | null> {
	let fromBridge: YouTubeCapture | null = null;
	try {
		await ensurePageBridge();
		fromBridge = await requestBridgeCapture();
	} catch {
		fromBridge = null;
	}

	if (fromBridge && fromBridge.tracks.length > 0) {
		return fromBridge;
	}

	const fromPage = captureYouTubePage();
	const richer = preferRicherCapture(fromBridge, fromPage);
	if (richer && richer.tracks.length > 0) {
		return richer;
	}

	try {
		const fromHtml = await captureFromWatchHtml();
		return preferRicherCapture(richer, fromHtml);
	} catch {
		return richer;
	}
}

interface SyncSettings {
	port: number;
	token: string;
}

interface SyncRequest {
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

function createBrandIcon(): HTMLImageElement {
	const img = document.createElement('img');
	img.className = ICON_CLASS;
	img.src = chrome.runtime.getURL(BRAND_ICON_PATH);
	img.alt = '';
	img.setAttribute('aria-hidden', 'true');
	img.setAttribute('draggable', 'false');
	return img;
}

/** Icon-only mark — status goes to title + short-lived toast, not a text label. */
function fillButton(button: HTMLButtonElement): void {
	button.replaceChildren(createBrandIcon());
}

function ensureButton(): HTMLButtonElement | null {
	const existing = document.getElementById(BUTTON_ID);
	if (existing instanceof HTMLButtonElement) {
		if (!existing.querySelector(`.${ICON_CLASS}`)) {
			fillButton(existing);
		}
		return existing;
	}

	const host =
		document.querySelector('.ytp-right-controls') ??
		document.querySelector('.ytp-chrome-controls') ??
		document.querySelector('#actions') ??
		document.querySelector('#top-level-buttons-computed');
	if (!(host instanceof HTMLElement)) {
		return null;
	}

	const button = document.createElement('button');
	button.id = BUTTON_ID;
	button.type = 'button';
	button.className = 'glean-sync-btn';
	button.title = DEFAULT_TITLE;
	button.setAttribute('aria-label', DEFAULT_TITLE);
	fillButton(button);
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		void syncCurrentVideo(button);
	});

	host.insertBefore(button, host.firstChild);
	return button;
}

async function readSettings(): Promise<SyncSettings> {
	const stored = await chrome.storage.sync.get({
		port: 17865,
		token: '',
	});
	return {
		port: typeof stored.port === 'number' ? stored.port : Number(stored.port) || 17865,
		token: typeof stored.token === 'string' ? stored.token : '',
	};
}

function chooseTrack(capture: YouTubeCapture, preferredTrackIndex?: number): CaptionTrack | null {
	if (
		preferredTrackIndex !== undefined &&
		Number.isInteger(preferredTrackIndex) &&
		preferredTrackIndex >= 0
	) {
		const selected = capture.tracks[preferredTrackIndex];
		if (selected) {
			return selected;
		}
	}
	return pickDefaultTrack(capture.tracks);
}

function matchingTrack(
	capture: YouTubeCapture,
	wanted: CaptionTrack,
	preferredTrackIndex?: number,
): CaptionTrack | null {
	const byIndex = chooseTrack(capture, preferredTrackIndex);
	if (
		byIndex &&
		byIndex.languageCode === wanted.languageCode &&
		byIndex.isAsr === wanted.isAsr
	) {
		return byIndex;
	}
	return (
		capture.tracks.find(
			(track) =>
				track.languageCode === wanted.languageCode && track.isAsr === wanted.isAsr,
		) ??
		capture.tracks.find((track) => track.languageCode === wanted.languageCode) ??
		null
	);
}

function requestBridgeTimedText(
	track: CaptionTrack,
	videoId: string,
	timeoutMs = 20000,
): Promise<string> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			document.removeEventListener(RESPONSE_TIMEDTEXT, onResponse);
			reject(new Error('页面上下文下载字幕超时'));
		}, timeoutMs);
		const onResponse = (event: Event) => {
			if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
				return;
			}
			let detail: { requestId?: unknown; text?: unknown; error?: unknown };
			try {
				detail = JSON.parse(event.detail) as {
					requestId?: unknown;
					text?: unknown;
					error?: unknown;
				};
			} catch {
				return;
			}
			if (detail.requestId !== requestId) {
				return;
			}
			window.clearTimeout(timer);
			document.removeEventListener(RESPONSE_TIMEDTEXT, onResponse);
			if (typeof detail.text === 'string' && detail.text.trim()) {
				resolve(detail.text);
				return;
			}
			reject(
				new Error(
					typeof detail.error === 'string' ? detail.error : '页面上下文下载字幕失败',
				),
			);
		};
		document.addEventListener(RESPONSE_TIMEDTEXT, onResponse);
		document.dispatchEvent(
			new CustomEvent(REQUEST_TIMEDTEXT, {
				detail: JSON.stringify({ requestId, videoId, track }),
			}),
		);
	});
}

async function segmentCaptionRaw(
	raw: string,
	cacheKey: string,
): Promise<string> {
	const accepted = acceptCaptionRaw(raw);
	if (!accepted) {
		throw new Error('字幕内容无效');
	}
	if (accepted.fmt === 'vtt') {
		return accepted.raw;
	}
	const response = (await chrome.runtime.sendMessage({
		type: 'glean-segment-json3',
		raw: accepted.raw,
		cacheKey,
	})) as { ok?: boolean; vtt?: string; error?: string } | undefined;
	if (chrome.runtime.lastError) {
		throw new Error(chrome.runtime.lastError.message || '分句进程无响应');
	}
	if (!response?.ok || typeof response.vtt !== 'string') {
		throw new Error(response?.error ?? '字幕分句失败');
	}
	return response.vtt;
}

async function downloadTrackRaw(
	track: CaptionTrack,
	preferredTrackIndex?: number,
	videoId?: string,
): Promise<string> {
	if (videoId) {
		try {
			await ensurePageBridge();
			return await requestBridgeTimedText(track, videoId);
		} catch {
			// Fall through to content-script fetch / refresh.
		}
	}

	try {
		const accepted = await fetchTrackRaw(track, fetch, videoId);
		return accepted.raw;
	} catch (firstError) {
		let fresh: YouTubeCapture | null = null;
		try {
			fresh = await captureFromWatchHtml();
		} catch {
			fresh = null;
		}
		const refreshed = fresh ? matchingTrack(fresh, track, preferredTrackIndex) : null;
		if (!refreshed) {
			throw firstError;
		}
		if (videoId || fresh?.videoId) {
			try {
				await ensurePageBridge();
				return await requestBridgeTimedText(
					refreshed,
					fresh?.videoId ?? videoId ?? '',
				);
			} catch {
				// Continue to direct fetch with refreshed URL.
			}
		}
		const accepted = await fetchTrackRaw(
			refreshed,
			fetch,
			fresh?.videoId ?? videoId,
		);
		return accepted.raw;
	}
}

async function syncCurrentVideo(
	button: HTMLButtonElement,
	preferredTrackIndex?: number,
): Promise<{ ok: boolean; error?: string }> {
	const capture = await getCapture();
	if (!capture) {
		setButtonState(button, '无法读取视频信息', 'error');
		return { ok: false, error: '无法读取视频信息' };
	}
	if (capture.tracks.length === 0) {
		setButtonState(button, '无字幕', 'error');
		return { ok: false, error: '该视频没有可用字幕' };
	}

	const settings = await readSettings();
	if (!settings.token.trim()) {
		setButtonState(button, '先在扩展弹窗填 token', 'error');
		return { ok: false, error: '请先在扩展弹窗填写 token' };
	}

	const track = chooseTrack(capture, preferredTrackIndex);
	if (!track) {
		setButtonState(button, '无可用字幕', 'error');
		return { ok: false, error: '没有可用字幕轨道' };
	}

	setButtonState(button, '同步中…', 'busy');
	try {
		setButtonState(button, '下载字幕…', 'busy');
		const raw = await downloadTrackRaw(track, preferredTrackIndex, capture.videoId);
		setButtonState(button, '智能分句中…', 'busy');
		const cacheKey = `${capture.videoId}:${track.languageCode}:${track.isAsr ? 'asr' : 'manual'}`;
		const vtt = await segmentCaptionRaw(raw, cacheKey);
		setButtonState(button, '写入 Obsidian…', 'busy');
		const message: SyncRequest = {
			type: 'glean-sync',
			payload: {
				videoId: capture.videoId,
				title: capture.title,
				channel: capture.channel,
				url: capture.url,
				lang: track.languageCode,
				vtt,
			},
		};
		const response = (await chrome.runtime.sendMessage(message)) as {
			ok: boolean;
			error?: string;
		};
		if (!response?.ok) {
			throw new Error(response?.error ?? '同步失败');
		}
		setButtonState(button, '已同步', 'done');
		window.setTimeout(() => setButtonState(button, DEFAULT_TITLE), 2000);
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : '同步失败';
		setButtonState(button, message, 'error');
		return { ok: false, error: message };
	}
}

const toastTimers = new WeakMap<HTMLButtonElement, number>();

function setButtonState(
	button: HTMLButtonElement,
	text: string,
	state: 'idle' | 'busy' | 'done' | 'error' = 'idle',
): void {
	if (!button.querySelector(`.${ICON_CLASS}`)) {
		fillButton(button);
	}
	const title = state === 'idle' ? DEFAULT_TITLE : text;
	button.title = title;
	button.setAttribute('aria-label', title);
	button.classList.remove('is-busy', 'is-done', 'is-error');
	if (state !== 'idle') {
		button.classList.add(`is-${state}`);
	}
	updateToast(button, state === 'idle' ? '' : text, state);
}

/** Icon-only has no label room — surface status as a short bubble by the mark. */
function updateToast(
	button: HTMLButtonElement,
	text: string,
	state: 'idle' | 'busy' | 'done' | 'error',
): void {
	let toast = button.querySelector<HTMLElement>('.glean-sync-toast');
	if (!text) {
		toast?.classList.remove('is-visible');
		return;
	}
	if (!toast) {
		toast = document.createElement('span');
		toast.className = 'glean-sync-toast';
		button.appendChild(toast);
	}
	toast.textContent = text.length > 36 ? `${text.slice(0, 34)}…` : text;
	toast.classList.remove('is-done', 'is-error');
	if (state === 'done' || state === 'error') {
		toast.classList.add(`is-${state}`);
	}
	toast.classList.add('is-visible');

	const previous = toastTimers.get(button);
	if (previous) {
		window.clearTimeout(previous);
	}
	if (state === 'done' || state === 'error') {
		toastTimers.set(
			button,
			window.setTimeout(() => {
				toast?.classList.remove('is-visible');
			}, state === 'error' ? 4200 : 2000),
		);
	}
}

function boot(): void {
	void ensurePageBridge().catch(() => undefined);
	ensureButton();
	const observer = new MutationObserver(() => {
		ensureButton();
	});
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (!message || typeof message !== 'object') {
			return false;
		}
		const request = message as { type?: unknown; trackIndex?: unknown };
		if (request.type === 'glean-get-capture') {
			void getCapture().then((capture) => sendResponse({ capture }));
			return true;
		}
		if (request.type === 'glean-sync-now') {
			const button = ensureButton();
			if (!button) {
				sendResponse({ ok: false, error: '找不到播放器控件' });
				return false;
			}
			const trackIndex =
				typeof request.trackIndex === 'number' ? request.trackIndex : undefined;
			void syncCurrentVideo(button, trackIndex).then(sendResponse);
			return true;
		}
		return false;
	});
}

boot();
