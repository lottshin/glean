import { pickDefaultTrack, type CaptionTrack, type YouTubeCapture } from './capture';
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

let activePlatform: 'youtube' | 'bilibili' | null = null;

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
	const isBilibili = /bilibili\.com\/video\//.test(tab.url);
	const isYouTube = /youtube\.com|youtu\.be/.test(tab.url);
	if (!isBilibili && !isYouTube) {
		activePlatform = null;
		fillLanguages([]);
		setStatus('请先打开一个 YouTube 或 B 站视频页');
		return;
	}
	activePlatform = isBilibili ? 'bilibili' : 'youtube';
	try {
		const response = (await chrome.tabs.sendMessage(tab.id, {
			type: isBilibili
				? 'glean-get-capture-bilibili'
				: 'glean-get-capture',
		})) as { capture: YouTubeCapture | BilibiliCapture | null };
		const capture = response?.capture ?? null;
		if (!capture) {
			fillLanguages([]);
			setStatus('无法读取该页字幕信息，稍等页面加载后再试', 'error');
			return;
		}
		if (isBilibili) {
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
			const preferred = pickDefaultTrack(youtube.tracks);
			const ordered = preferred
				? [preferred, ...youtube.tracks.filter((track) => track !== preferred)]
				: youtube.tracks;
			fillLanguages(
				ordered.map((track: CaptionTrack) => ({
					index: youtube.tracks.indexOf(track),
					label: track.name,
					automatic: track.isAsr,
				})),
			);
		}
		setStatus(
			isBilibili
				? usableEnglishTracks((capture as BilibiliCapture).tracks).length > 0
					? `已识别：${capture.title}`
					: bilibiliRefusal(capture as BilibiliCapture)
				: capture.tracks.length > 0
				? `已识别：${capture.title}`
				: '该视频没有可下载的字幕轨道',
			langSelect.options.length > 0 && !langSelect.disabled ? 'ok' : 'error',
		);
	} catch {
		fillLanguages([]);
		setStatus('内容脚本未就绪，请刷新视频页面', 'error');
	}
}

async function syncNow(): Promise<void> {
	await saveSettings();
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		setStatus('没有活动标签页', 'error');
		return;
	}
	setStatus('正在同步…');
	try {
		const response = (await chrome.tabs.sendMessage(tab.id, {
			type:
				activePlatform === 'bilibili'
					? 'glean-sync-bilibili-now'
					: 'glean-sync-now',
			trackIndex: langSelect.value ? Number(langSelect.value) : undefined,
		})) as { ok: boolean; error?: string };
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
