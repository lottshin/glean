import {
	pickDefaultTrack,
	usableEnglishTracks as youtubeEnglishTracks,
	type CaptionTrack,
	type YouTubeCapture,
} from './capture';
import type { BilibiliCapture } from './bilibili-capture';
import {
	bilibiliSyncRefusalMessage,
	pickDefaultTrack as pickDefaultBilibiliTrack,
	usableEnglishTracks,
	type BilibiliSubtitleTrack,
} from '../../src/bilibili/subtitle';

const portInput = document.getElementById('port') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const langSelect = document.getElementById('lang') as HTMLSelectElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const syncBtn = document.getElementById('sync') as HTMLButtonElement;

function setStatus(text: string, kind: 'plain' | 'ok' | 'error' = 'plain'): void {
	statusEl.textContent = text;
	statusEl.classList.toggle('is-ok', kind === 'ok');
	statusEl.classList.toggle('is-error', kind === 'error');
}

type PopupTrack = {
	index: number;
	label: string;
	automatic: boolean;
};

type VideoPlatform = 'youtube' | 'bilibili';

function platformFromUrl(url: string): VideoPlatform | null {
	if (/bilibili\.com\/video\//.test(url)) {
		return 'bilibili';
	}
	return /youtube\.com|youtu\.be/.test(url) ? 'youtube' : null;
}

function hasNoMessageReceiver(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /receiving end does not exist|could not establish connection/i.test(message);
}

async function injectContentScript(
	tabId: number,
	platform: VideoPlatform,
): Promise<void> {
	// An extension reload leaves the old DOM button behind, but its listener
	// belongs to a dead extension context. Remove it before booting the new one.
	await chrome.scripting.executeScript({
		target: { tabId },
		func: () => document.getElementById('glean-sync-button')?.remove(),
	});
	await chrome.scripting.insertCSS({
		target: { tabId },
		files: ['content.css'],
	});
	await chrome.scripting.executeScript({
		target: { tabId },
		files: [platform === 'bilibili' ? 'bilibili-content.js' : 'content.js'],
	});
}

async function sendToVideoTab<T>(
	tabId: number,
	platform: VideoPlatform,
	message: unknown,
): Promise<T> {
	try {
		return (await chrome.tabs.sendMessage(tabId, message)) as T;
	} catch (error) {
		if (!hasNoMessageReceiver(error)) {
			throw error;
		}
		await injectContentScript(tabId, platform);
		return (await chrome.tabs.sendMessage(tabId, message)) as T;
	}
}

/** Names the real obstacle: no English at all, or English that is a translation. */
function bilibiliRefusal(capture: BilibiliCapture): string {
	const message = bilibiliSyncRefusalMessage(capture.tracks);
	return message || '该视频没有英文字幕轨；自动生成将在后续支持';
}

function fillLanguages(tracks: PopupTrack[]): void {
	langSelect.innerHTML = '';
	if (tracks.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = '无字幕';
		langSelect.append(option);
		langSelect.disabled = true;
		return;
	}
	langSelect.disabled = false;
	for (const track of tracks) {
		const option = document.createElement('option');
		option.value = String(track.index);
		option.textContent = `${track.label}${track.automatic ? '（自动）' : ''}`;
		langSelect.append(option);
	}
	langSelect.value = String(tracks[0]?.index ?? 0);
}

async function loadSettings(): Promise<void> {
	const stored = await chrome.storage.sync.get({
		port: 17865,
		token: '',
	});
	portInput.value = String(
		typeof stored.port === 'number' || typeof stored.port === 'string'
			? stored.port
			: 17865,
	);
	tokenInput.value = typeof stored.token === 'string' ? stored.token : '';
}

async function saveSettings(): Promise<void> {
	const port = Number(portInput.value) || 17865;
	const token = tokenInput.value.trim();
	await chrome.storage.sync.set({ port, token });
	setStatus('设置已保存', 'ok');
}

async function refreshCapture(): Promise<void> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id || !tab.url) {
		fillLanguages([]);
		setStatus('请先打开一个 YouTube 或 B 站视频页');
		return;
	}
	const platform = platformFromUrl(tab.url);
	if (!platform) {
		fillLanguages([]);
		setStatus('请先打开一个 YouTube 或 B 站视频页');
		return;
	}
	try {
		const response = await sendToVideoTab<{
			capture: YouTubeCapture | BilibiliCapture | null;
		}>(tab.id, platform, {
			type: platform === 'bilibili'
				? 'glean-get-capture-bilibili'
				: 'glean-get-capture',
		});
		const capture = response?.capture ?? null;
		if (!capture) {
			fillLanguages([]);
			setStatus('无法读取该页字幕信息，稍等页面加载后再试', 'error');
			return;
		}
		if (platform === 'bilibili') {
			const biliCapture = capture as BilibiliCapture;
			const english = usableEnglishTracks(biliCapture.tracks);
			const preferred = pickDefaultBilibiliTrack(english);
			const ordered = preferred
				? [preferred, ...english.filter((track) => track !== preferred)]
				: english;
			fillLanguages(
				ordered.map((track: BilibiliSubtitleTrack) => ({
					index: biliCapture.tracks.indexOf(track),
					label: track.lanDoc,
					automatic: track.isAi,
				})),
			);
		} else {
			const youtube = capture as YouTubeCapture;
			const english = youtubeEnglishTracks(youtube.tracks);
			const preferred = pickDefaultTrack(english);
			const ordered = preferred
				? [preferred, ...english.filter((track) => track !== preferred)]
				: english;
			fillLanguages(
				ordered.map((track: CaptionTrack) => ({
					index: youtube.tracks.indexOf(track),
					label: track.name,
					automatic: track.isAsr,
				})),
			);
		}
		setStatus(
			platform === 'bilibili'
				? usableEnglishTracks((capture as BilibiliCapture).tracks).length > 0
					? `已识别：${capture.title}`
					: bilibiliRefusal(capture as BilibiliCapture)
				: youtubeEnglishTracks((capture as YouTubeCapture).tracks).length > 0
				? `已识别：${capture.title}`
				: (capture as YouTubeCapture).tracks.length > 0
					? '该视频只有非英文字幕，Glean 只导入英文'
					: '该视频没有可下载的字幕轨道',
			langSelect.options.length > 0 && !langSelect.disabled ? 'ok' : 'error',
		);
	} catch (error) {
		fillLanguages([]);
		setStatus(
			error instanceof Error ? error.message : '无法连接视频页面',
			'error',
		);
	}
}

async function syncNow(): Promise<void> {
	await saveSettings();
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id || !tab.url) {
		setStatus('没有活动标签页', 'error');
		return;
	}
	const platform = platformFromUrl(tab.url);
	if (!platform) {
		setStatus('请先打开一个 YouTube 或 B 站视频页', 'error');
		return;
	}
	setStatus('正在同步…');
	try {
		const response = await sendToVideoTab<{ ok: boolean; error?: string }>(
			tab.id,
			platform,
			{
				type:
					platform === 'bilibili'
						? 'glean-sync-bilibili-now'
						: 'glean-sync-now',
				trackIndex: langSelect.value ? Number(langSelect.value) : undefined,
			},
		);
		if (!response?.ok) {
			throw new Error(response?.error ?? '同步失败');
		}
		setStatus('已发送到 Obsidian', 'ok');
	} catch (error) {
		setStatus(error instanceof Error ? error.message : '同步失败', 'error');
	}
}

saveBtn.addEventListener('click', () => {
	void saveSettings();
});
syncBtn.addEventListener('click', () => {
	void syncNow();
});

void loadSettings().then(() => refreshCapture());
