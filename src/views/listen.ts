import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type EchoPlugin from '../main';
import { cueIndexAt } from '../media/cues';
import { LocalFileSource } from '../media/local';
import { formatTimestamp, parseSubtitles } from '../media/srt';
import { findSiblingSubtitle } from '../media/subtitles';
import { PLAYBACK_RATES, VIDEO_EXTENSIONS, type Cue } from '../media/types';

export const LISTEN_VIEW_TYPE = 'echo-listen';

export interface ListenState {
	videoPath: string;
	subtitlePath: string | null;
	seekTo?: number;
}

export class ListenView extends ItemView {
	plugin: EchoPlugin;
	private source = new LocalFileSource();
	private videoEl: HTMLVideoElement | null = null;
	private cueListEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private playBtn: HTMLButtonElement | null = null;
	private timeEl: HTMLElement | null = null;
	private cueEls: HTMLElement[] = [];
	private cues: Cue[] = [];
	private activeIndex = -1;
	private unsubs: Array<() => void> = [];
	private currentVideo: TFile | null = null;
	private currentSubtitle: TFile | null = null;
	private sentenceMode = false;
	private sentenceEnd = 0;
	private pendingSeek: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: EchoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return LISTEN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.currentVideo ? `Echo · ${this.currentVideo.basename}` : 'Echo 精听';
	}

	getIcon(): string {
		return 'headphones';
	}

	async onOpen(): Promise<void> {
		this.renderShell();
		this.registerDomEvent(this.containerEl, 'keydown', (evt) => this.onKey(evt), true);
	}

	async onClose(): Promise<void> {
		this.teardown();
	}

	async openMedia(state: ListenState): Promise<void> {
		const video = this.app.vault.getAbstractFileByPath(state.videoPath);
		if (!(video instanceof TFile) || !VIDEO_EXTENSIONS.has(video.extension.toLowerCase())) {
			this.setStatus(`找不到视频：${state.videoPath}`);
			return;
		}

		const subtitlePath = state.subtitlePath ?? findSiblingSubtitle(this.app, video);
		let subtitleFile: TFile | null = null;
		if (subtitlePath) {
			const found = this.app.vault.getAbstractFileByPath(subtitlePath);
			if (found instanceof TFile) {
				subtitleFile = found;
			}
		}

		if (state.seekTo !== undefined) {
			this.pendingSeek = state.seekTo;
		}
		await this.loadFiles(video, subtitleFile);
	}

	private renderShell(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('echo-listen');
		root.tabIndex = 0;

		const toolbar = root.createDiv({ cls: 'echo-toolbar' });
		this.playBtn = toolbar.createEl('button', { text: '播放', cls: 'echo-btn' });
		this.playBtn.addEventListener('click', () => {
			this.sentenceMode = false;
			this.source.toggle();
		});

		const replayBtn = toolbar.createEl('button', { text: '重听本句', cls: 'echo-btn' });
		replayBtn.addEventListener('click', () => this.replayCurrent());

		const prevBtn = toolbar.createEl('button', { text: '上一句', cls: 'echo-btn' });
		prevBtn.addEventListener('click', () => this.jumpBy(-1));

		const nextBtn = toolbar.createEl('button', { text: '下一句', cls: 'echo-btn' });
		nextBtn.addEventListener('click', () => this.jumpBy(1));

		const rateSelect = toolbar.createEl('select', { cls: 'echo-rate' });
		for (const rate of PLAYBACK_RATES) {
			rateSelect.createEl('option', {
				text: `${rate}×`,
				value: String(rate),
			});
		}
		rateSelect.value = String(this.plugin.settings.defaultRate);
		rateSelect.addEventListener('change', () => {
			this.source.setPlaybackRate(Number(rateSelect.value));
		});

		this.timeEl = toolbar.createSpan({ cls: 'echo-time', text: '00:00 / 00:00' });
		this.statusEl = toolbar.createSpan({ cls: 'echo-status', text: '打开一个视频开始精听' });

		const body = root.createDiv({ cls: 'echo-body' });
		const playerPane = body.createDiv({ cls: 'echo-player-pane' });
		this.videoEl = playerPane.createEl('video', { cls: 'echo-video' });
		this.videoEl.controls = true;
		this.videoEl.preload = 'metadata';

		this.cueListEl = body.createDiv({ cls: 'echo-cues' });
		this.cueListEl.createDiv({
			cls: 'echo-empty',
			text: '在文件管理器右键视频 → Echo: 精听，或用命令面板。字幕请放在同目录、同名的 .srt / .vtt。',
		});

		this.source.attach(this.videoEl);
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);
		this.unsubs.push(
			this.source.onTimeUpdate((t) => this.onTick(t)),
			this.source.onPlay(() => this.syncPlayButton()),
			this.source.onPause(() => this.syncPlayButton()),
		);

		this.contentEl.focus({ preventScroll: true });
	}

	private async loadFiles(video: TFile, subtitle: TFile | null): Promise<void> {
		if (!this.videoEl) {
			return;
		}

		this.sentenceMode = false;
		this.source.pause();
		this.setStatus('正在加载…');

		const srcUrl = this.app.vault.getResourcePath(video);

		let cues: Cue[] = [];
		if (subtitle) {
			const raw = await this.app.vault.read(subtitle);
			cues = parseSubtitles(raw);
		}

		try {
			await this.source.load(srcUrl, cues);
		} catch {
			this.setStatus('视频无法播放。试试 mp4 / webm。');
			return;
		}

		this.currentVideo = video;
		this.currentSubtitle = subtitle;
		this.cues = cues;
		this.activeIndex = -1;
		this.sentenceMode = false;
		this.renderCues();
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);

		if (this.pendingSeek !== null) {
			this.source.seekTo(this.pendingSeek);
			this.pendingSeek = null;
		}

		const subLabel = subtitle ? subtitle.name : '无字幕';
		this.setStatus(`${video.name} · ${subLabel} · ${cues.length} 句`);
		this.updateTime(this.source.getCurrentTime());
		this.contentEl.focus({ preventScroll: true });
	}

	private renderCues(): void {
		if (!this.cueListEl) {
			return;
		}
		this.cueListEl.empty();
		this.cueEls = [];

		if (this.cues.length === 0) {
			this.cueListEl.createDiv({
				cls: 'echo-empty',
				text: '没有字幕。把同名的 .srt 或 .vtt 放到视频旁边再打开。',
			});
			return;
		}

		for (const cue of this.cues) {
			const row = this.cueListEl.createDiv({ cls: 'echo-cue' });
			row.createSpan({ cls: 'echo-cue-time', text: formatTimestamp(cue.start) });
			row.createSpan({ cls: 'echo-cue-text', text: cue.text });
			row.addEventListener('click', () => {
				this.playSentence(cue);
			});
			this.cueEls.push(row);
		}
	}

	private onTick(t: number): void {
		this.updateTime(t);
		if (this.sentenceMode && t >= this.sentenceEnd - 0.05) {
			this.sentenceMode = false;
			this.source.pause();
		}
		const next = cueIndexAt(this.cues, t);
		if (next !== this.activeIndex) {
			this.setActive(next);
		}
	}

	private setActive(index: number): void {
		if (this.activeIndex >= 0) {
			this.cueEls[this.activeIndex]?.removeClass('is-active');
		}
		this.activeIndex = index;
		const el = index >= 0 ? this.cueEls[index] : undefined;
		if (el) {
			el.addClass('is-active');
			el.scrollIntoView({ block: 'nearest' });
		}
	}

	private replayCurrent(): void {
		const cue = this.cues[this.activeIndex] ?? this.cues[0];
		if (!cue) {
			return;
		}
		this.playSentence(cue);
	}

	private jumpBy(delta: number): void {
		if (this.cues.length === 0) {
			return;
		}
		let index = this.activeIndex;
		if (index < 0) {
			index = 0;
		} else {
			index = Math.min(this.cues.length - 1, Math.max(0, index + delta));
		}
		const cue = this.cues[index];
		if (!cue) {
			return;
		}
		this.playSentence(cue);
	}

	private playSentence(cue: Cue): void {
		this.sentenceMode = true;
		this.sentenceEnd = cue.end;
		this.source.seekTo(cue.start);
		this.source.play();
		this.setActive(cue.index);
	}

	private onKey(evt: KeyboardEvent): void {
		if (
			evt.target instanceof HTMLInputElement ||
			evt.target instanceof HTMLTextAreaElement ||
			evt.target instanceof HTMLSelectElement
		) {
			return;
		}
		const key = evt.key;
		if (key === ' ' || key === 'Spacebar') {
			evt.preventDefault();
			this.sentenceMode = false;
			this.source.toggle();
			return;
		}
		if (key === 'r' || key === 'R') {
			evt.preventDefault();
			this.replayCurrent();
			return;
		}
		if (key === '[') {
			evt.preventDefault();
			this.jumpBy(-1);
			return;
		}
		if (key === ']') {
			evt.preventDefault();
			this.jumpBy(1);
			return;
		}
		if (key === '-') {
			evt.preventDefault();
			this.nudgeRate(-1);
			return;
		}
		if (key === '=' || key === '+') {
			evt.preventDefault();
			this.nudgeRate(1);
		}
	}

	private nudgeRate(dir: number): void {
		const current = this.source.getPlaybackRate();
		const i = PLAYBACK_RATES.findIndex((rate) => rate === current);
		const nextIndex = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir));
		const next = PLAYBACK_RATES[nextIndex];
		if (next === undefined) {
			return;
		}
		this.source.setPlaybackRate(next);
		const select = this.contentEl.querySelector('.echo-rate');
		if (select instanceof HTMLSelectElement) {
			select.value = String(next);
		}
	}

	private syncPlayButton(): void {
		if (!this.playBtn || !this.videoEl) {
			return;
		}
		this.playBtn.setText(this.videoEl.paused ? '播放' : '暂停');
	}

	private updateTime(t: number): void {
		if (!this.timeEl) {
			return;
		}
		this.timeEl.setText(`${formatTimestamp(t)} / ${formatTimestamp(this.source.getDuration())}`);
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	private teardown(): void {
		for (const u of this.unsubs) {
			u();
		}
		this.unsubs = [];
		this.source.detach();
		this.videoEl = null;
		this.cueListEl = null;
		this.cueEls = [];
	}

	getState(): Record<string, unknown> {
		if (!this.currentVideo) {
			return {};
		}
		return {
			videoPath: this.currentVideo.path,
			subtitlePath: this.currentSubtitle?.path ?? null,
			seekTo: this.source.getCurrentTime(),
		};
	}

	async setState(state: unknown): Promise<void> {
		if (!state || typeof state !== 'object') {
			return;
		}
		const s = state as Partial<ListenState>;
		if (typeof s.videoPath === 'string') {
			await this.openMedia({
				videoPath: s.videoPath,
				subtitlePath: typeof s.subtitlePath === 'string' ? s.subtitlePath : null,
				seekTo: typeof s.seekTo === 'number' ? s.seekTo : undefined,
			});
		}
	}
}
