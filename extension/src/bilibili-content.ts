import {
	captureBilibiliPage,
	type BilibiliCapture,
} from './bilibili-capture';
import type { BilibiliMediaTrack } from '../../src/bilibili/playurl';
import {
	bilibiliSyncRefusalMessage,
	isEnglishLanguage,
	usableEnglishTracks,
	type BilibiliSubtitleTrack,
} from '../../src/bilibili/subtitle';
import { sendBackground } from './runtime';

const BUTTON_ID = 'glean-sync-button';
const DEFAULT_TITLE = '同步英文字幕到 Obsidian Glean';
const BRAND_ICON_PATH = 'icons/icon-32.png';
const REQUEST_MEDIA = 'glean-request-bilibili-media';
const RESPONSE_MEDIA = 'glean-bilibili-media-response';
const QUALITY_LABELS: Record<number, string> = {
	16: '360P',
	32: '480P',
	64: '720P',
	80: '1080P',
};

let bridgeReady: Promise<void> | null = null;

function ensurePageBridge(): Promise<void> {
	if (document.documentElement.dataset.gleanBridge === 'ready') {
		return Promise.resolve();
	}
	if (bridgeReady) {
		return bridgeReady;
	}
	bridgeReady = new Promise((resolve, reject) => {
		let url: string;
		try {
			url = chrome.runtime.getURL('page-bridge.js');
		} catch {
			bridgeReady = null;
			reject(new Error('扩展已重载，请刷新这个视频页'));
			return;
		}
		const script = document.createElement('script');
		script.src = url;
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

function requestMediaTrack(
	bvid: string,
	cid: number,
	timeoutMs = 8000,
): Promise<BilibiliMediaTrack> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			document.removeEventListener(RESPONSE_MEDIA, onResponse);
			reject(new Error('读取 B 站播放地址超时'));
		}, timeoutMs);
		const onResponse = (event: Event) => {
			if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
				return;
			}
			let detail: {
				requestId?: unknown;
				track?: BilibiliMediaTrack;
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
			document.removeEventListener(RESPONSE_MEDIA, onResponse);
			if (detail.track?.urls?.length) {
				resolve(detail.track);
				return;
			}
			reject(
				new Error(
					typeof detail.error === 'string'
						? detail.error
						: '没有可用的 B 站播放地址',
				),
			);
		};
		document.addEventListener(RESPONSE_MEDIA, onResponse);
		document.dispatchEvent(
			new CustomEvent(REQUEST_MEDIA, {
				detail: JSON.stringify({ requestId, bvid, cid, qn: 64 }),
			}),
		);
	});
}

function isEnglishTrack(track: BilibiliSubtitleTrack): boolean {
	return isEnglishLanguage(track.lan) && !track.isTranslation;
}

function englishTracks(capture: BilibiliCapture): BilibiliSubtitleTrack[] {
	return usableEnglishTracks(capture.tracks);
}

/** Explains a refusal in terms of what the video actually is. */
function noEnglishReason(capture: BilibiliCapture): string {
	const message = bilibiliSyncRefusalMessage(capture.tracks);
	return message || '该视频没有英文字幕轨；自动生成英文字幕将在下一步支持';
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
	image.className = 'glean-sync-btn__mark';
	image.src = chrome.runtime.getURL(BRAND_ICON_PATH);
	image.alt = '';
	image.setAttribute('aria-hidden', 'true');
	image.setAttribute('draggable', 'false');
	return image;
}

function appendControlIcon(button: HTMLButtonElement): void {
	const icon = document.createElement('div');
	icon.className = 'bpx-player-ctrl-btn-icon glean-sync-btn__control-icon';
	icon.append(createIcon());
	button.append(icon);
}

function normalizeControlIcon(button: HTMLButtonElement): void {
	if (button.querySelector('.glean-sync-btn__control-icon')) {
		return;
	}
	const legacy = button.querySelector<HTMLImageElement>('.glean-sync-btn__mark, img');
	button.replaceChildren();
	if (legacy) {
		legacy.className = 'glean-sync-btn__mark';
		const icon = document.createElement('div');
		icon.className = 'bpx-player-ctrl-btn-icon glean-sync-btn__control-icon';
		icon.append(legacy);
		button.append(icon);
	} else {
		appendControlIcon(button);
	}
}

/**
 * Sit just left of Bilibili's own controls, which is where other extensions
 * (Immersive Translate) put their buttons too.
 *
 * Anchoring on the first native control rather than `firstChild` keeps the spot
 * stable: otherwise whichever extension loads last wins the front of the row,
 * and Bilibili's "1080P 高清 / 选集 / 倍速 / 字幕" group gets split apart.
 */
function nativeControlAnchor(host: HTMLElement): Element | null {
	for (const child of Array.from(host.children)) {
		if (
			child.id !== BUTTON_ID &&
			child.classList.contains('bpx-player-ctrl-btn')
		) {
			return child;
		}
	}
	return null;
}

function visibleControlHost(): HTMLElement | null {
	const hosts = Array.from(
		document.querySelectorAll('.bpx-player-control-bottom-right'),
	).filter((element): element is HTMLElement => {
		if (!(element instanceof HTMLElement)) {
			return false;
		}
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return (
			style.display !== 'none' &&
			style.visibility !== 'hidden' &&
			rect.width > 0 &&
			rect.height > 0
		);
	});
	return hosts.sort((left, right) => {
		const leftRect = left.getBoundingClientRect();
		const rightRect = right.getBoundingClientRect();
		return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
	})[0] ?? null;
}

function controlHost(): HTMLElement | null {
	const bottomRight = visibleControlHost();
	if (bottomRight) {
		return bottomRight;
	}
	const wrap = document.querySelector('.bpx-player-control-wrap');
	return wrap instanceof HTMLElement ? wrap : null;
}

function ensureButton(): HTMLButtonElement | null {
	const existing = document.getElementById(BUTTON_ID);
	if (existing instanceof HTMLButtonElement) {
		existing.classList.add('bpx-player-ctrl-btn');
		normalizeControlIcon(existing);
		existing.style.removeProperty('height');
		existing.style.removeProperty('margin-top');
		// The player builds its control row asynchronously. If the first pass
		// used the outer wrap as a fallback, move the button into the real right
		// control row once Bilibili has mounted it so the scoped sizing rules apply.
		const rightControls = visibleControlHost();
		if (
			rightControls &&
			(existing.parentElement !== rightControls ||
				existing.nextElementSibling !== nativeControlAnchor(rightControls))
		) {
			rightControls.insertBefore(existing, nativeControlAnchor(rightControls));
		}
		return existing;
	}
	const host = controlHost();
	if (!(host instanceof HTMLElement)) {
		return null;
	}
	const button = document.createElement('button');
	button.id = BUTTON_ID;
	button.type = 'button';
	// Reuse Bilibili's own control-item class so its responsive player CSS owns
	// height and alignment in normal, web-fullscreen and fullscreen modes.
	button.className = 'bpx-player-ctrl-btn glean-sync-btn';
	button.title = DEFAULT_TITLE;
	button.setAttribute('aria-label', DEFAULT_TITLE);
	appendControlIcon(button);
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		void syncCurrentVideo(button);
	});
	// insertBefore(node, null) appends, which is the right fallback if the
	// control row ever ships without a recognisable native button.
	host.insertBefore(button, nativeControlAnchor(host));
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
			throw new Error(noEnglishReason(capture));
		}

		const vttResult = await sendBackground<{
			ok?: boolean;
			vtt?: string;
			error?: string;
		}>({
			type: 'glean-bilibili-vtt',
			track,
		});
		if (!vttResult?.ok || !vttResult.vtt) {
			throw new Error(vttResult?.error ?? 'B 站字幕转换失败');
		}

		setButtonState(button, '读取播放地址…', 'busy');
		await ensurePageBridge();
		const media = await requestMediaTrack(capture.bvid, capture.cid);

		setButtonState(button, '写入 Obsidian…', 'busy');
		const response = await sendBackground<{
			ok?: boolean;
			error?: string;
		}>({
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
				mediaUrls: media.urls,
				mediaSize: media.size,
				mediaQuality: QUALITY_LABELS[media.quality] ?? '',
				mediaExpiresAt: media.expiresAt,
			},
		});
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
