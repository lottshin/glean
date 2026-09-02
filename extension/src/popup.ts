import { pickDefaultTrack, type CaptionTrack, type YouTubeCapture } from './capture';

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

function fillLanguages(tracks: CaptionTrack[]): void {
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
	for (const [index, track] of tracks.entries()) {
		const option = document.createElement('option');
		option.value = String(index);
		option.textContent = `${track.name}${track.isAsr ? '（自动）' : ''}`;
		langSelect.append(option);
	}
	const preferred = pickDefaultTrack(tracks);
	const preferredIndex = preferred ? tracks.indexOf(preferred) : 0;
	langSelect.value = String(preferredIndex >= 0 ? preferredIndex : 0);
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
	if (!tab?.id || !tab.url || !/youtube\.com|youtu\.be/.test(tab.url)) {
		fillLanguages([]);
		setStatus('请先打开一个 YouTube 视频页');
		return;
	}
	try {
		const response = (await chrome.tabs.sendMessage(tab.id, {
			type: 'glean-get-capture',
		})) as { capture: YouTubeCapture | null };
		const capture = response?.capture ?? null;
		if (!capture) {
			fillLanguages([]);
			setStatus('无法读取该页字幕信息，稍等页面加载后再试', 'error');
			return;
		}
		fillLanguages(capture.tracks);
		setStatus(
			capture.tracks.length > 0
				? `已识别：${capture.title}`
				: '该视频没有可下载的字幕轨道',
			capture.tracks.length > 0 ? 'ok' : 'error',
		);
	} catch {
		fillLanguages([]);
		setStatus('内容脚本未就绪，请刷新 YouTube 页面', 'error');
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
			type: 'glean-sync-now',
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
