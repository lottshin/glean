import {
	captureBilibiliPage,
	type BilibiliCapture,
} from './bilibili-capture';
import type { BilibiliAudioTrack } from '../../src/bilibili/playurl';
import type { BilibiliSubtitleTrack } from '../../src/bilibili/subtitle';

const BUTTON_ID = 'glean-sync-button';
const DEFAULT_TITLE = '同步英文字幕和音频到 Obsidian Glean';
const BRAND_ICON_PATH = 'icons/icon-32.png';
const REQUEST_AUDIO = 'glean-request-bilibili-audio';
const RESPONSE_AUDIO = 'glean-bilibili-audio-response';

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
			reject(new Error('页面桥接脚本加载失败'));
		});
		(document.head ?? document.documentElement).appendChild(script);
	});
	return bridgeReady;
}

function requestAudioTrack(timeoutMs = 3000): Promise<BilibiliAudioTrack> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			document.removeEventListener(RESPONSE_AUDIO, onResponse);
			reject(new Error('读取 B 站音频轨超时'));
		}, timeoutMs);
		const onResponse = (event: Event) => {
			if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
				return;
			}
			let detail: {
				requestId?: unknown;
				track?: BilibiliAudioTrack;
				error?: unknown;
			};
			try {
				detail = JSON.parse(event.detail) as typeof detail;
			} catch {
				return;
			}
			if (detail.requestId !== requestId) {
				return;
			}
			window.clearTimeout(timer);
			document.removeEventListener(RESPONSE_AUDIO, onResponse);
			if (detail.track?.urls?.length) {
				resolve(detail.track);
				return;
			}
			reject(
				new Error(
					typeof detail.error === 'string'
						? detail.error
						: '没有可用的 B 站音频轨',
				),
			);
		};
		document.addEventListener(RESPONSE_AUDIO, onResponse);
		document.dispatchEvent(new CustomEvent(REQUEST_AUDIO, { detail: requestId }));
	});
}

function isEnglishTrack(track: BilibiliSubtitleTrack): boolean {
	return /^(?:ai-)?en(?:[-_]|$)/i.test(track.lan);
}

function englishTracks(capture: BilibiliCapture): BilibiliSubtitleTrack[] {
	return capture.tracks.filter(isEnglishTrack);
}

async function getCapture(): Promise<BilibiliCapture | null> {
	let latest: BilibiliCapture | null = null;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		latest = await captureBilibiliPage(location.href);
		if (!latest || latest.tracks.length > 0) {
			return latest;
		}
		await new Promise((resolve) => window.setTimeout(resolve, 500));
	}
	return latest;
}

function createIcon(): HTMLImageElement {
	const image = document.createElement('img');
	image.className = 'glean-sync-btn__icon';
	image.src = chrome.runtime.getURL(BRAND_ICON_PATH);
	image.alt = '';
	image.setAttribute('aria-hidden', 'true');
	image.setAttribute('draggable', 'false');
	return image;
}

function ensureButton(): HTMLButtonElement | null {
	const existing = document.getElementById(BUTTON_ID);
	if (existing instanceof HTMLButtonElement) {
		return existing;
	}
	const host =
		document.querySelector('.bpx-player-control-bottom-right') ??
		document.querySelector('.bpx-player-control-wrap');
	if (!(host instanceof HTMLElement)) {
		return null;
	}
	const button = document.createElement('button');
	button.id = BUTTON_ID;
	button.type = 'button';
	button.className = 'glean-sync-btn';
	button.title = DEFAULT_TITLE;
	button.setAttribute('aria-label', DEFAULT_TITLE);
	button.append(createIcon());
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		void syncCurrentVideo(button);
	});
	host.insertBefore(button, host.firstChild);
	return button;
}

function setButtonState(
	button: HTMLButtonElement,
	text: string,
	state: 'idle' | 'busy' | 'done' | 'error' = 'idle',
): void {
	button.title = state === 'idle' ? DEFAULT_TITLE : text;
	button.setAttribute('aria-label', button.title);
	button.classList.remove('is-busy', 'is-done', 'is-error');
	if (state !== 'idle') {
		button.classList.add(`is-${state}`);
	}
	let toast = button.querySelector<HTMLElement>('.glean-sync-toast');
	if (!toast) {
		toast = document.createElement('span');
		toast.className = 'glean-sync-toast';
		button.append(toast);
	}
	toast.textContent = text;
	toast.classList.toggle('is-visible', state !== 'idle');
	toast.classList.toggle('is-error', state === 'error');
	toast.classList.toggle('is-done', state === 'done');
	if (state === 'done' || state === 'error') {
		window.setTimeout(() => toast?.classList.remove('is-visible'), 4000);
	}
}

async function syncCurrentVideo(
	button: HTMLButtonElement,
	preferredTrackIndex?: number,
): Promise<{ ok: boolean; error?: string }> {
	setButtonState(button, '读取字幕…', 'busy');
	try {
		const capture = await getCapture();
		if (!capture) {
			throw new Error('无法读取 B 站视频信息');
		}
		const available = englishTracks(capture);
		const selected =
			preferredTrackIndex !== undefined
				? capture.tracks[preferredTrackIndex]
				: available[0];
		const track = selected && isEnglishTrack(selected) ? selected : available[0];
		if (!track) {
			throw new Error('该视频没有英文字幕轨；自动生成英文字幕将在下一步支持');
		}

		const vttResult = (await chrome.runtime.sendMessage({
			type: 'glean-bilibili-vtt',
			track,
		})) as { ok?: boolean; vtt?: string; error?: string };
		if (!vttResult?.ok || !vttResult.vtt) {
			throw new Error(vttResult?.error ?? 'B 站字幕转换失败');
		}

		setButtonState(button, '读取音频轨…', 'busy');
		await ensurePageBridge();
		const audio = await requestAudioTrack();

		setButtonState(button, '下载到 Obsidian…', 'busy');
		const response = (await chrome.runtime.sendMessage({
			type: 'glean-sync-bilibili',
			payload: {
				bvid: capture.bvid,
				page: capture.page,
				cid: capture.cid,
				title: capture.title,
				owner: capture.owner,
				url: capture.url,
				lang: track.lan,
				vtt: vttResult.vtt,
				audioUrls: audio.urls,
			},
		})) as { ok?: boolean; error?: string };
		if (!response?.ok) {
			throw new Error(response?.error ?? '同步失败');
		}
		setButtonState(button, '已同步', 'done');
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : '同步失败';
		setButtonState(button, message, 'error');
		return { ok: false, error: message };
	}
}

function boot(): void {
	void ensurePageBridge().catch(() => undefined);
	ensureButton();
	new MutationObserver(() => ensureButton()).observe(document.documentElement, {
		childList: true,
		subtree: true,
	});
	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (!message || typeof message !== 'object') {
			return false;
		}
		const request = message as { type?: unknown; trackIndex?: unknown };
		if (request.type === 'glean-get-capture-bilibili') {
			void getCapture().then((capture) => sendResponse({ capture }));
			return true;
		}
		if (request.type === 'glean-sync-bilibili-now') {
			const button = ensureButton();
			if (!button) {
				sendResponse({ ok: false, error: '找不到 B 站播放器控件' });
				return false;
			}
			void syncCurrentVideo(
				button,
				typeof request.trackIndex === 'number'
					? request.trackIndex
					: undefined,
			).then(sendResponse);
			return true;
		}
		return false;
	});
}

boot();
