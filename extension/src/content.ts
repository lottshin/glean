import {
	captureYouTubeFromHtml,
	captureYouTubePage,
	fetchTrackVtt,
	pickDefaultTrack,
	type CaptionTrack,
	type YouTubeCapture,
} from './capture';

const BUTTON_ID = 'glean-sync-button';
const LABEL_CLASS = 'glean-sync-btn__label';
const DEFAULT_LABEL = 'Glean';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Lucide `wheat` (ISC) — the same mark the Obsidian plugin uses for its ribbon
 * icon, inlined so the button carries the brand without a network request.
 */
const WHEAT_PATHS = [
	'M2 22 16 8',
	'M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
	'M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
	'M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
	'M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z',
	'M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z',
	'M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z',
	'M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z',
];

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

function createWheatIcon(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'glean-sync-btn__icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	for (const d of WHEAT_PATHS) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

/** Icon on the left, status text on the right: only the text ever changes. */
function fillButton(button: HTMLButtonElement): void {
	const pill = document.createElement('span');
	pill.className = 'glean-sync-btn__pill';
	pill.appendChild(createWheatIcon());
	const label = document.createElement('span');
	label.className = LABEL_CLASS;
	label.textContent = DEFAULT_LABEL;
	pill.appendChild(label);
	button.replaceChildren(pill);
}

function ensureButton(): HTMLButtonElement | null {
	const existing = document.getElementById(BUTTON_ID);
	if (existing instanceof HTMLButtonElement) {
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
	button.title = '同步字幕到 Obsidian Glean';
	button.setAttribute('aria-label', '同步字幕到 Obsidian Glean');
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
	timeoutMs = 8000,
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

async function downloadTrackVtt(
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
		return await fetchTrackVtt(track, fetch, videoId);
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
		return await fetchTrackVtt(refreshed, fetch, fresh?.videoId ?? videoId);
	}
}

async function syncCurrentVideo(
	button: HTMLButtonElement,
	preferredTrackIndex?: number,
): Promise<{ ok: boolean; error?: string }> {
	const capture = await getCapture();
	if (!capture) {
		setButtonState(button, '无法读取视频信息', true);
		return { ok: false, error: '无法读取视频信息' };
	}
	if (capture.tracks.length === 0) {
		setButtonState(button, '无字幕', true);
		return { ok: false, error: '该视频没有可用字幕' };
	}

	const settings = await readSettings();
	if (!settings.token.trim()) {
		setButtonState(button, '先在扩展弹窗填 token', true);
		return { ok: false, error: '请先在扩展弹窗填写 token' };
	}

	const track = chooseTrack(capture, preferredTrackIndex);
	if (!track) {
		setButtonState(button, '无可用字幕', true);
		return { ok: false, error: '没有可用字幕轨道' };
	}

	setButtonState(button, '同步中…');
	try {
		const vtt = await downloadTrackVtt(track, preferredTrackIndex, capture.videoId);
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
		setButtonState(button, '已同步');
		window.setTimeout(() => setButtonState(button, DEFAULT_LABEL), 2000);
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : '同步失败';
		setButtonState(
			button,
			message,
			true,
		);
		return { ok: false, error: message };
	}
}

function setButtonState(button: HTMLButtonElement, text: string, isError = false): void {
	let label = button.querySelector<HTMLElement>(`.${LABEL_CLASS}`);
	if (!label) {
		fillButton(button);
		label = button.querySelector<HTMLElement>(`.${LABEL_CLASS}`);
	}
	const shown = text.length > 18 ? `${text.slice(0, 16)}…` : text;
	if (label) {
		label.textContent = shown;
	} else {
		button.textContent = shown;
	}
	button.classList.toggle('is-error', isError);
	button.title = text;
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
