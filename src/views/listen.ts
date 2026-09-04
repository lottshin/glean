import {
	ItemView,
	Notice,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	type ViewStateResult,
} from 'obsidian';
import { normalizeDictionaryKey } from '../dictionary';
import type GleanPlugin from '../main';
import { cueIndexAt } from '../media/cues';
import {
	buildDictCells,
	isComplete,
	nextDisplayIndex,
	normalizeChar,
	type DictCell,
} from '../media/dictation';
import { LocalFileSource } from '../media/local';
import { MediaSuggestModal } from '../media/picker';
import {
	explainSplitCueFailure,
	mergeCueWithNext,
	splitCueBeforeWord,
} from '../media/cue-edit';
import {
	formatTimestamp,
	isGleanEditedSubtitles,
	parseSubtitles,
	serializeSubtitles,
} from '../media/srt';
import { findSiblingSubtitle } from '../media/subtitles';
import { tokenizeSubtitle } from '../media/subtitle-tokens';
import {
	AUDIO_EXTENSIONS,
	MEDIA_EXTENSIONS,
	PLAYBACK_RATES,
	type Cue,
	type MediaKind,
	type MediaSource,
} from '../media/types';
import { YouTubeSource } from '../media/youtube';
import { bilibiliSourcePath } from '../bilibili/id';
import { bilibiliMediaPath, formatMediaSize } from '../bilibili/session';
import {
	bilibiliProxyUrl,
	downloadBilibiliMedia,
	writeBinaryFile,
} from '../import/receiver';
import { youtubeSourcePath } from '../youtube/id';
import { isGleanSegmentedSubtitles, refineCaptionCues } from '../youtube/vtt';
import { GleanWordPopover } from './word-popup';
export const LISTEN_VIEW_TYPE = 'glean-listen';

export type GleanViewMode = 'listen' | 'dictation';

export interface ListenState {
	kind?: MediaKind;
	videoPath?: string;
	videoId?: string;
	title?: string;
	subtitlePath?: string | null;
	seekTo?: number;
	mode?: GleanViewMode;
	/**
	 * Bilibili streams from a signed CDN link rather than a vault file. Its id
	 * stays in `bvid` because a truthy `videoId` means "this is YouTube".
	 */
	bvid?: string;
	mediaUrl?: string;
	mediaSize?: number;
	mediaExpiresAt?: number | null;
	page?: number;
	notePath?: string;
}

export interface BilibiliStream {
	bvid: string;
	page: number;
	title: string;
	mediaUrl: string;
	mediaSize: number;
	expiresAt: number | null;
	notePath: string;
}

function isStreamExpired(expiresAt: number | null): boolean {
	return expiresAt !== null && expiresAt * 1000 <= Date.now();
}

type DictCellView = DictCell & { span: HTMLElement };

function withCueIndexes(
	cues: Array<{
		start: number;
		end: number;
		text: string;
		words?: Cue['words'];
	}>,
): Cue[] {
	return cues.map((cue, index) => ({
		index,
		start: cue.start,
		end: cue.end,
		text: cue.text,
		words: cue.words,
	}));
}

/** Apply the latest clause heal/split when opening an already-saved VTT. */
function refineListenCues(cues: Cue[]): Cue[] {
	return withCueIndexes(refineCaptionCues(cues));
}

/** Manual edits and already-segmented syncs must not re-run NLP on open. */
function cuesFromSubtitleBody(raw: string): Cue[] {
	const parsed = parseSubtitles(raw);
	if (isGleanEditedSubtitles(raw) || isGleanSegmentedSubtitles(raw)) {
		return parsed;
	}
	return refineListenCues(parsed);
}

/**
 * Glean listen view.
 * Default mode is intensive listening (current sentence + cue list).
 * Dictation is an explicit mode switch, not a permanent second panel.
 */
export class ListenView extends ItemView {
	plugin: GleanPlugin;
	private source: MediaSource = new LocalFileSource();
	private mediaHostEl: HTMLElement | null = null;
	private videoEl: HTMLVideoElement | null = null;
	private cueListEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private playBtn: HTMLButtonElement | null = null;
	private modeListenBtn: HTMLButtonElement | null = null;
	private modeDictBtn: HTMLButtonElement | null = null;
	private hideBtn: HTMLButtonElement | null = null;
	private timeEl: HTMLElement | null = null;
	private cueEls: HTMLElement[] = [];
	private cues: Cue[] = [];
	private activeIndex = -1;
	private unsubs: Array<() => void> = [];
	private currentVideo: TFile | null = null;
	private currentSubtitle: TFile | null = null;
	private currentYouTube: { videoId: string; title: string } | null = null;
	private currentBilibili: BilibiliStream | null = null;
	/**
	 * Kept when a stream fails to load so "save a local copy" stays reachable —
	 * downloading is the way out when streaming is what broke.
	 */
	private bilibiliFallback: BilibiliStream | null = null;
	private sentenceMode = false;
	/** True only after the playhead has entered the target sentence (avoids seek race). */
	private sentenceArmed = false;
	private sentenceStart = 0;
	private sentenceEnd = 0;
	private sentenceStopTimer: number | null = null;
	private pendingSeek: number | null = null;
	private mode: GleanViewMode = 'listen';
	/** In dictation mode: whether the original sentence is hidden. */
	private hidden = true;
	private selectedWord: {
		cueIndex: number;
		wordIndex: number;
		lookupId: number;
	} | null = null;
	private lookupSequence = 0;
	private lookupOpenTimer: number | null = null;
	private wordPopover = new GleanWordPopover();
	private speakClipTimer: number | null = null;
	private focusEl: HTMLElement | null = null;
	private focusTextEl: HTMLElement | null = null;
	private focusMetaEl: HTMLElement | null = null;
	private dictPanelEl: HTMLElement | null = null;
	private dictEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private dictHintEl: HTMLElement | null = null;
	private dictCells: DictCellView[] = [];
	private dictNorm = '';
	private dictMatched = 0;
	private dictWrong = false;
	private dictRevealed = false;
	private advanceTimer: number | null = null;
	private saveLocalBtn: HTMLButtonElement | null = null;
	private playerPaneEl: HTMLElement | null = null;
	private audioTitleEl: HTMLElement | null = null;
	private audioSubEl: HTMLElement | null = null;
	private splitDragging = false;

	constructor(leaf: WorkspaceLeaf, plugin: GleanPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return LISTEN_VIEW_TYPE;
	}

	getDisplayText(): string {
		const title =
			this.currentVideo?.basename ??
			this.currentYouTube?.title ??
			this.currentBilibili?.title;
		return title ? `Glean · ${title}` : 'Glean 精听';
	}

	getIcon(): string {
		return 'headphones';
	}

	/** No media loaded yet, so this tab can take any without losing anything. */
	isVacant(): boolean {
		return !this.currentVideo && !this.currentYouTube && !this.currentBilibili;
	}

	/** Whether this tab already holds the media a request is asking for. */
	holdsMedia(state: ListenState): boolean {
		if (state.kind === 'youtube' || state.videoId) {
			return !!state.videoId && this.currentYouTube?.videoId === state.videoId;
		}
		if (state.kind === 'bilibili') {
			return (
				!!state.notePath && this.currentBilibili?.notePath === state.notePath
			);
		}
		return !!state.videoPath && this.currentVideo?.path === state.videoPath;
	}

	/** Stop playback without touching the rest of the view's state. */
	pausePlayback(): void {
		this.exitSentenceMode();
		this.source.pause();
	}

	async onOpen(): Promise<void> {
		this.renderShell();
		this.registerDomEvent(this.containerEl, 'keydown', (evt) => this.onKey(evt), true);
	}

	async onClose(): Promise<void> {
		this.teardown();
	}

	async openMedia(state: ListenState): Promise<void> {
		if (state.kind === 'bilibili') {
			if (!state.mediaUrl) {
				this.setStatus('缺少 B 站播放地址');
				return;
			}
			await this.openBilibiliMedia(state);
			return;
		}
		if (state.kind === 'youtube' || state.videoId) {
			if (!state.videoId) {
				this.setStatus('缺少 YouTube 视频 ID');
				return;
			}
			await this.openYouTubeMedia(state);
			return;
		}
		if (!state.videoPath) {
			this.setStatus('请选择媒体文件');
			return;
		}
		const video = this.app.vault.getAbstractFileByPath(state.videoPath);
		if (!(video instanceof TFile) || !MEDIA_EXTENSIONS.has(video.extension.toLowerCase())) {
			this.setStatus(`找不到媒体：${state.videoPath}`);
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
		if (state.mode === 'listen' || state.mode === 'dictation') {
			this.mode = state.mode;
		}
		await this.loadFiles(video, subtitleFile);
	}

	private renderShell(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('glean-listen');
		root.tabIndex = 0;

		const toolbar = root.createDiv({ cls: 'glean-toolbar' });

		const transport = toolbar.createDiv({ cls: 'glean-toolbar-group' });
		this.playBtn = transport.createEl('button', { text: '播放', cls: 'glean-btn glean-btn-primary' });
		this.playBtn.addEventListener('click', () => this.togglePlayback());

		const replayBtn = transport.createEl('button', {
			text: '重听',
			cls: 'glean-btn',
			attr: { title: '重听本句 (R)' },
		});
		replayBtn.addEventListener('click', () => this.replayCurrent());

		const prevBtn = transport.createEl('button', {
			text: '上一句',
			cls: 'glean-btn',
			attr: { title: '[' },
		});
		prevBtn.addEventListener('click', () => this.jumpBy(-1));

		const nextBtn = transport.createEl('button', {
			text: '下一句',
			cls: 'glean-btn',
			attr: { title: ']' },
		});
		nextBtn.addEventListener('click', () => this.jumpBy(1));

		const modes = toolbar.createDiv({ cls: 'glean-toolbar-group glean-mode-group' });
		this.modeListenBtn = modes.createEl('button', {
			text: '精听',
			cls: 'glean-btn',
			attr: { title: '精听模式：看字幕、点句重听（默认）' },
		});
		this.modeListenBtn.addEventListener('click', () => this.setMode('listen'));
		this.modeDictBtn = modes.createEl('button', {
			text: '听写',
			cls: 'glean-btn',
			attr: { title: '听写模式：隐藏原句并实时匹配' },
		});
		this.modeDictBtn.addEventListener('click', () => this.setMode('dictation'));

		const opts = toolbar.createDiv({ cls: 'glean-toolbar-group' });
		const openBtn = opts.createEl('button', {
			text: '打开',
			cls: 'glean-btn',
			attr: { title: '打开视频或音频' },
		});
		openBtn.addEventListener('click', () => this.openMediaPicker());

		this.hideBtn = opts.createEl('button', {
			cls: 'glean-btn',
			attr: { title: '显示 / 隐藏原句 (H)·仅听写模式' },
		});
		this.hideBtn.addEventListener('click', () => this.toggleHidden());

		this.saveLocalBtn = opts.createEl('button', {
			text: '存本地',
			cls: 'glean-btn is-hidden-ctrl',
			attr: { title: '把 B 站画面存进 vault，直链过期后仍可复习' },
		});
		this.saveLocalBtn.addEventListener('click', () => {
			void this.saveBilibiliCopy();
		});

		const rateSelect = opts.createEl('select', { cls: 'glean-rate', attr: { title: '倍速' } });
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

		const meta = toolbar.createDiv({ cls: 'glean-toolbar-meta' });
		this.timeEl = meta.createSpan({ cls: 'glean-time', text: '00:00 / 00:00' });
		this.statusEl = meta.createSpan({ cls: 'glean-status', text: '打开媒体开始精听' });

		const body = root.createDiv({ cls: 'glean-body' });

		this.playerPaneEl = body.createDiv({ cls: 'glean-player-pane' });
		const stage = this.playerPaneEl.createDiv({ cls: 'glean-player-stage' });

		const empty = stage.createDiv({ cls: 'glean-player-empty' });
		empty.createDiv({ cls: 'glean-player-empty-title', text: '还没有媒体' });
		empty.createDiv({
			cls: 'glean-player-empty-detail',
			text: '打开 vault 里的视频或音频；字幕放同目录同名 .srt / .vtt。YouTube / B 站用浏览器里的 Glean Capture 同步英文字幕（设置里有说明）。',
		});
		const emptyOpen = empty.createEl('button', {
			text: '打开媒体',
			cls: 'glean-btn glean-btn-primary',
		});
		emptyOpen.addEventListener('click', () => this.openMediaPicker());

		const audioCard = stage.createDiv({ cls: 'glean-audio-card' });
		audioCard.createDiv({ cls: 'glean-audio-icon', text: '♪' });
		const audioMeta = audioCard.createDiv({ cls: 'glean-audio-meta' });
		this.audioTitleEl = audioMeta.createDiv({ cls: 'glean-audio-title', text: '' });
		this.audioSubEl = audioMeta.createDiv({ cls: 'glean-audio-sub', text: '音频精听' });

		this.mediaHostEl = stage.createDiv({ cls: 'glean-media-host' });

		const veil = stage.createDiv({ cls: 'glean-video-veil' });
		veil.createDiv({ cls: 'glean-video-veil-title', text: '听写中' });
		veil.createDiv({
			cls: 'glean-video-veil-detail',
			text: '画面已遮挡，避免视频内烧录字幕泄题。声音照常，用上方按钮控制播放。',
		});

		const splitter = body.createDiv({
			cls: 'glean-splitter',
			attr: { title: '拖动调整播放器高度' },
		});
		this.bindSplitter(splitter);

		const side = body.createDiv({ cls: 'glean-side' });

		this.focusEl = side.createDiv({ cls: 'glean-focus' });
		this.focusMetaEl = this.focusEl.createDiv({ cls: 'glean-focus-meta', text: '当前句' });
		this.focusTextEl = this.focusEl.createDiv({
			cls: 'glean-focus-text',
			text: '播放或点一句开始精听。',
		});

		this.dictPanelEl = side.createDiv({ cls: 'glean-dict-panel' });
		const dictHead = this.dictPanelEl.createDiv({ cls: 'glean-dict-head' });
		dictHead.createSpan({ cls: 'glean-dict-kicker', text: '听写' });
		this.dictHintEl = dictHead.createDiv({
			cls: 'glean-dict-hint',
			text: '隐藏原句，敲下听到的内容。',
		});
		this.dictEl = this.dictPanelEl.createDiv({ cls: 'glean-dict-cells' });
		this.inputEl = this.dictPanelEl.createEl('input', {
			cls: 'glean-dict-input',
			attr: {
				type: 'text',
				placeholder: '敲下听到的内容，这里会留下你的输入…',
				autocomplete: 'off',
				autocapitalize: 'off',
				spellcheck: 'false',
			},
		});
		this.inputEl.addEventListener('input', () => this.onDictInput());
		this.inputEl.addEventListener('keydown', (evt) => this.onDictKey(evt));

		const cuesWrap = side.createDiv({ cls: 'glean-cues-wrap' });
		const cuesHead = cuesWrap.createDiv({ cls: 'glean-cues-head' });
		cuesHead.createDiv({ cls: 'glean-cues-label', text: '字幕' });
		cuesHead.createDiv({
			cls: 'glean-cue-edit-hint',
			text: '词间 \u21B5\uFE0E 断句 · 行首 \u232B\uFE0E 并入上一行',
		});
		this.cueListEl = cuesWrap.createDiv({ cls: 'glean-cues' });
		this.renderEmptyCues(
			'还没有字幕',
			'打开媒体后，同目录同名的 .srt / .vtt 会自动挂上。',
		);

		this.bindSource(this.source);

		this.syncModeChrome();
		this.syncMediaChrome();
		this.contentEl.focus({ preventScroll: true });
	}

	private openMediaPicker(): void {
		new MediaSuggestModal(this.app, (file) => {
			void this.plugin.openVideo(file);
		}).open();
	}

	private bindSource(source: MediaSource): void {
		for (const unsubscribe of this.unsubs) {
			unsubscribe();
		}
		this.unsubs = [];
		this.source.detach();
		this.source = source;
		if (!this.mediaHostEl) {
			return;
		}
		this.source.attach(this.mediaHostEl);
		this.videoEl = this.mediaHostEl.querySelector('video');
		this.videoEl?.addEventListener('loadedmetadata', () => this.syncMediaChrome());
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);
		this.unsubs.push(
			this.source.onTimeUpdate((time) => this.onTick(time)),
			// A booked stop is only valid while the clock is running: hold it
			// across a pause, then re-book against the time we resume from.
			this.source.onPlay(() => {
				this.syncPlayButton();
				if (this.sentenceArmed) {
					this.scheduleSentenceStop();
				}
			}),
			this.source.onPause(() => {
				this.syncPlayButton();
				this.clearSentenceStop();
			}),
			this.source.onError((message) => this.setStatus(message)),
		);
	}

	private ensureSource(kind: 'local' | 'youtube'): void {
		if (this.source.kind === kind) {
			return;
		}
		this.bindSource(kind === 'youtube' ? new YouTubeSource() : new LocalFileSource());
	}

	private setMode(mode: GleanViewMode): void {
		if (this.mode === mode) {
			return;
		}
		this.closeWordLookup();
		this.mode = mode;
		if (mode === 'dictation') {
			this.hidden = true;
			this.dictRevealed = false;
		}
		this.syncModeChrome();
		this.refreshFocus();
		this.refreshCueTexts();
		if (mode === 'dictation') {
			this.loadDictationForActive();
			this.focusDictInput();
		} else {
			this.clearAdvanceTimer();
			this.contentEl.focus({ preventScroll: true });
		}
		this.app.workspace.requestSaveLayout();
	}

	private syncModeChrome(): void {
		const root = this.contentEl;
		root.toggleClass('is-dictation', this.mode === 'dictation');
		root.toggleClass('is-listen-mode', this.mode === 'listen');
		this.modeListenBtn?.toggleClass('is-active-mode', this.mode === 'listen');
		this.modeDictBtn?.toggleClass('is-active-mode', this.mode === 'dictation');
		if (this.hideBtn) {
			this.hideBtn.toggleClass('is-hidden-ctrl', this.mode !== 'dictation');
			this.syncHideButton();
		}
	}

	private bindSplitter(splitter: HTMLElement): void {
		const onMove = (evt: MouseEvent) => {
			if (!this.splitDragging || !this.playerPaneEl) {
				return;
			}
			const body = this.contentEl.querySelector('.glean-body');
			if (!(body instanceof HTMLElement)) {
				return;
			}
			const rect = body.getBoundingClientRect();
			if (rect.height <= 0) {
				return;
			}
			const px = evt.clientY - rect.top;
			const clamped = Math.min(rect.height * 0.7, Math.max(100, px));
			this.playerPaneEl.addClass('is-resized');
			this.playerPaneEl.setCssProps({
				'--glean-player-height': `${clamped}px`,
			});
		};
		const onUp = () => {
			if (!this.splitDragging) {
				return;
			}
			this.splitDragging = false;
			this.contentEl.removeClass('is-resizing');
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
		splitter.addEventListener('mousedown', (evt) => {
			evt.preventDefault();
			this.splitDragging = true;
			this.contentEl.addClass('is-resizing');
			window.addEventListener('mousemove', onMove);
			window.addEventListener('mouseup', onUp);
		});
	}

	private renderEmptyCues(title: string, detail: string): void {
		if (!this.cueListEl) {
			return;
		}
		this.cueListEl.empty();
		const empty = this.cueListEl.createDiv({ cls: 'glean-empty' });
		empty.createDiv({ cls: 'glean-empty-title', text: title });
		empty.createDiv({ cls: 'glean-empty-detail', text: detail });
	}

	private syncMediaChrome(): void {
		const root = this.contentEl;
		const has =
			!!this.currentVideo || !!this.currentYouTube || !!this.currentBilibili;
		root.toggleClass('has-media', has);
		root.toggleClass('is-youtube', this.currentYouTube !== null);
		root.toggleClass('is-bilibili', this.currentBilibili !== null);
		this.saveLocalBtn?.toggleClass(
			'is-hidden-ctrl',
			this.currentBilibili === null && this.bilibiliFallback === null,
		);
		const isAudio =
			!!this.currentVideo && AUDIO_EXTENSIONS.has(this.currentVideo.extension.toLowerCase());
		root.toggleClass('is-audio', isAudio);

		let isPortrait = false;
		if (
			this.videoEl instanceof HTMLVideoElement &&
			this.videoEl.videoWidth > 0 &&
			this.videoEl.videoHeight > 0
		) {
			isPortrait = this.videoEl.videoHeight > this.videoEl.videoWidth;
		}
		root.toggleClass('is-portrait', isPortrait && !isAudio);

		if (this.audioTitleEl) {
			this.audioTitleEl.setText(this.currentVideo?.name ?? '');
		}
		if (this.audioSubEl) {
			this.audioSubEl.setText(
				isAudio ? `${this.currentVideo?.extension.toUpperCase() ?? ''} · 音频` : '',
			);
		}
	}

	private async loadFiles(video: TFile, subtitle: TFile | null): Promise<void> {
		if (!this.mediaHostEl) {
			return;
		}
		this.ensureSource('local');

		this.closeWordLookup();
		this.exitSentenceMode();
		this.source.pause();
		this.setStatus('正在加载…');

		const srcUrl = this.app.vault.getResourcePath(video);

		let cues: Cue[] = [];
		if (subtitle) {
			const raw = await this.app.vault.read(subtitle);
			cues = cuesFromSubtitleBody(raw);
		}

		try {
			await this.source.load(srcUrl, cues);
		} catch {
			this.currentVideo = null;
			this.currentYouTube = null;
			this.currentBilibili = null;
			this.currentSubtitle = null;
			this.syncMediaChrome();
			this.setStatus('媒体无法播放。试试 mp4 / webm / mp3 / m4a。');
			return;
		}

		if (this.playerPaneEl) {
			this.playerPaneEl.removeClass('is-resized');
		}

		this.currentVideo = video;
		this.currentYouTube = null;
		this.currentBilibili = null;
		this.bilibiliFallback = null;
		this.currentSubtitle = subtitle;
		this.cues = cues;
		this.activeIndex = -1;
		this.exitSentenceMode();
		this.clearAdvanceTimer();
		this.syncMediaChrome();
		this.syncModeChrome();
		this.renderCues();
		this.refreshFocus();
		if (this.mode === 'dictation') {
			this.loadDictationForActive();
		}
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);

		if (this.pendingSeek !== null) {
			this.source.seekTo(this.pendingSeek);
			this.pendingSeek = null;
		}

		const subLabel = subtitle ? subtitle.name : '无字幕';
		this.setStatus(`${video.name} · ${subLabel} · ${cues.length} 句`);
		this.updateTime(this.source.getCurrentTime());
		this.app.workspace.requestSaveLayout();
		this.contentEl.focus({ preventScroll: true });
	}

	private async openYouTubeMedia(state: ListenState): Promise<void> {
		if (!this.mediaHostEl || !state.videoId) {
			return;
		}
		let subtitle: TFile | null = null;
		if (state.subtitlePath) {
			const found = this.app.vault.getAbstractFileByPath(state.subtitlePath);
			if (found instanceof TFile) {
				subtitle = found;
			}
		}
		if (!subtitle) {
			this.setStatus('找不到 YouTube 字幕文件');
			return;
		}

		const cues = cuesFromSubtitleBody(await this.app.vault.read(subtitle));
		if (cues.length === 0) {
			this.setStatus('YouTube 字幕为空或格式无效');
			return;
		}

		this.closeWordLookup();
		this.exitSentenceMode();
		this.ensureSource('youtube');
		this.source.pause();
		this.setStatus('正在连接 YouTube…');
		if (state.seekTo !== undefined) {
			this.pendingSeek = state.seekTo;
		}
		if (state.mode === 'listen' || state.mode === 'dictation') {
			this.mode = state.mode;
		}

		try {
			await this.source.load(state.videoId, cues);
		} catch (error) {
			this.currentVideo = null;
			this.currentYouTube = null;
			this.currentBilibili = null;
			this.currentSubtitle = null;
			this.syncMediaChrome();
			this.setStatus(error instanceof Error ? error.message : 'YouTube 播放失败');
			return;
		}

		this.currentVideo = null;
		this.currentBilibili = null;
		this.bilibiliFallback = null;
		this.currentYouTube = {
			videoId: state.videoId,
			title: state.title?.trim() || state.videoId,
		};
		this.currentSubtitle = subtitle;
		this.cues = cues;
		this.activeIndex = -1;
		this.clearAdvanceTimer();
		this.syncMediaChrome();
		this.syncModeChrome();
		this.renderCues();
		this.refreshFocus();
		if (this.mode === 'dictation') {
			this.loadDictationForActive();
		}
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);
		if (this.pendingSeek !== null) {
			this.source.seekTo(this.pendingSeek);
			this.pendingSeek = null;
		}
		this.setStatus(
			`${this.currentYouTube.title} · ${subtitle.name} · ${cues.length} 句`,
		);
		this.updateTime(this.source.getCurrentTime());
		this.app.workspace.requestSaveLayout();
		this.contentEl.focus({ preventScroll: true });
	}

	/**
	 * Streams the muxed MP4 straight from B 站 CDN. The link is signed and dies
	 * after roughly two hours, so a load failure most likely means it expired
	 * rather than that the video is gone.
	 */
	private async openBilibiliMedia(state: ListenState): Promise<void> {
		if (!this.mediaHostEl || !state.mediaUrl) {
			return;
		}
		let subtitle: TFile | null = null;
		if (state.subtitlePath) {
			const found = this.app.vault.getAbstractFileByPath(state.subtitlePath);
			if (found instanceof TFile) {
				subtitle = found;
			}
		}
		if (!subtitle) {
			this.setStatus('找不到 B 站字幕文件');
			return;
		}

		const cues = cuesFromSubtitleBody(await this.app.vault.read(subtitle));
		if (cues.length === 0) {
			this.setStatus('B 站字幕为空或格式无效');
			return;
		}

		this.closeWordLookup();
		this.exitSentenceMode();
		this.ensureSource('local');
		this.source.pause();
		this.setStatus('正在连接 B 站…');
		if (state.seekTo !== undefined) {
			this.pendingSeek = state.seekTo;
		}
		if (state.mode === 'listen' || state.mode === 'dictation') {
			this.mode = state.mode;
		}

		const stream: BilibiliStream = {
			bvid: state.bvid ?? '',
			page: state.page ?? 1,
			title: state.title?.trim() || state.bvid || 'B 站视频',
			mediaUrl: state.mediaUrl,
			mediaSize: state.mediaSize ?? 0,
			expiresAt: state.mediaExpiresAt ?? null,
			notePath: state.notePath ?? '',
		};

		// The CDN rejects any request a browser can make, so the picture has to
		// come through the plugin's local server.
		if (!this.plugin.isYouTubeReceiverRunning()) {
			this.currentBilibili = null;
			this.bilibiliFallback = stream;
			this.syncMediaChrome();
			this.setStatus(
				'B 站在线播放需要采集接收端在运行，请到设置里打开，或点「存本地」下载。',
			);
			return;
		}
		const playbackUrl = bilibiliProxyUrl(
			this.plugin.settings.youtubeReceiverPort,
			this.plugin.settings.youtubeReceiverToken,
			stream.mediaUrl,
		);

		try {
			await this.source.load(playbackUrl, cues);
		} catch {
			this.currentVideo = null;
			this.currentYouTube = null;
			this.currentBilibili = null;
			this.currentSubtitle = null;
			this.bilibiliFallback = stream;
			this.syncMediaChrome();
			this.setStatus(
				isStreamExpired(stream.expiresAt)
					? 'B 站直链已过期。回到该视频页面再点一次麦穗即可续上。'
					: 'B 站画面加载失败。可以点「存本地」下载，或回视频页面重新同步。',
			);
			return;
		}

		this.currentVideo = null;
		this.currentYouTube = null;
		this.currentBilibili = stream;
		this.bilibiliFallback = null;
		this.currentSubtitle = subtitle;
		this.cues = cues;
		this.activeIndex = -1;
		this.clearAdvanceTimer();
		this.syncMediaChrome();
		this.syncModeChrome();
		this.renderCues();
		this.refreshFocus();
		if (this.mode === 'dictation') {
			this.loadDictationForActive();
		}
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);
		if (this.pendingSeek !== null) {
			this.source.seekTo(this.pendingSeek);
			this.pendingSeek = null;
		}
		this.setStatus(
			`${stream.title} · 在线 · ${subtitle.name} · ${cues.length} 句`,
		);
		this.updateTime(this.source.getCurrentTime());
		this.app.workspace.requestSaveLayout();
		this.contentEl.focus({ preventScroll: true });
	}

	/**
	 * Pulls the streamed MP4 into the vault and records it on the note, so the
	 * session survives the CDN link expiring.
	 */
	private async saveBilibiliCopy(): Promise<void> {
		const stream = this.currentBilibili ?? this.bilibiliFallback;
		if (!stream) {
			return;
		}
		const folder = normalizePath(
			this.plugin.settings.bilibiliFolder.trim() || 'Glean/Bilibili',
		);
		const target = normalizePath(
			bilibiliMediaPath(folder, stream.bvid, stream.page),
		);
		const resume = this.source.getCurrentTime();
		const subtitlePath = this.currentSubtitle?.path ?? null;

		if (!(this.app.vault.getAbstractFileByPath(target) instanceof TFile)) {
			if (isStreamExpired(stream.expiresAt)) {
				new Notice('B 站直链已过期，先回视频页面重新同步一次');
				return;
			}
			const button = this.saveLocalBtn;
			button?.setAttr('disabled', 'true');
			new Notice(`正在下载 ${formatMediaSize(stream.mediaSize)}…`);
			try {
				const bytes = await downloadBilibiliMedia([stream.mediaUrl]);
				await writeBinaryFile(this.app, target, bytes);
			} catch (error) {
				new Notice(
					error instanceof Error ? error.message : 'B 站画面下载失败',
				);
				return;
			} finally {
				button?.removeAttribute('disabled');
			}
			const note = this.app.vault.getAbstractFileByPath(stream.notePath);
			if (note instanceof TFile) {
				await this.app.fileManager.processFrontMatter(
					note,
					(frontmatter: Record<string, unknown>) => {
						frontmatter.media = target;
					},
				);
			}
			new Notice('已存为本地副本');
		}

		await this.openMedia({
			kind: 'local',
			videoPath: target,
			subtitlePath,
			seekTo: resume,
			mode: this.mode,
		});
	}

	private renderCues(): void {
		if (!this.cueListEl) {
			return;
		}
		this.cueListEl.empty();
		this.cueEls = [];

		if (this.cues.length === 0) {
			this.renderEmptyCues('没有字幕', '把同名的 .srt 或 .vtt 放到媒体旁边再打开。');
			this.refreshFocus();
			return;
		}

		for (const cue of this.cues) {
			const row = this.cueListEl.createDiv({ cls: 'glean-cue' });
			row.createSpan({ cls: 'glean-cue-time', text: formatTimestamp(cue.start) });
			const textEl = row.createSpan({ cls: 'glean-cue-text' });
			this.renderCueText(textEl, cue);
			row.addEventListener('click', () => {
				this.playSentence(cue);
			});
			this.cueEls.push(row);
		}
	}

	private renderCueText(textEl: HTMLElement, cue: Cue): void {
		this.renderCueTokens(textEl, cue, 'glean-word', true);
	}

	/** A clickable gap between two words: click to split the cue here. */
	private appendCutSlot(
		host: HTMLElement,
		cueIndex: number,
		wordIndex: number,
		gap: string,
	): void {
		const slot = host.createSpan({
			cls: 'glean-cut-slot',
			text: gap.length > 0 ? gap : ' ',
			attr: { role: 'button', 'aria-label': '在此断句', title: '在此断句' },
		});
		slot.addEventListener('click', (evt) => {
			evt.stopPropagation();
			void this.splitCueBefore(cueIndex, wordIndex);
		});
	}

	/** A line-start affordance: click to merge this cue into the previous one. */
	private appendMergeSlot(host: HTMLElement, cueIndex: number): void {
		const slot = host.createSpan({
			cls: 'glean-merge-slot',
			attr: { role: 'button', 'aria-label': '并入上一行', title: '并入上一行' },
		});
		slot.addEventListener('click', (evt) => {
			evt.stopPropagation();
			void this.mergeCueWithPrevious(cueIndex);
		});
	}

	/**
	 * Words stay clickable in every mode as long as the real sentence is on
	 * screen; a masked sentence is rendered as plain text.
	 */
	private renderCueTokens(
		host: HTMLElement,
		cue: Cue,
		cls: string,
		editable = false,
	): void {
		host.empty();
		const shown = this.displayCueText(cue);
		if (shown !== cue.text) {
			host.setText(shown);
			return;
		}

		const tokens = [...tokenizeSubtitle(cue.text)];
		const totalWords = tokens.filter(
			(token) => token.kind !== 'separator' && token.lookup,
		).length;
		if (editable && cue.index > 0) {
			this.appendMergeSlot(host, cue.index);
		}

		let wordIndex = 0;
		for (const token of tokens) {
			if (token.kind === 'separator') {
				if (editable && wordIndex > 0 && wordIndex < totalWords) {
					this.appendCutSlot(host, cue.index, wordIndex, token.text);
				} else {
					host.appendText(token.text);
				}
				continue;
			}
			if (!token.lookup) {
				host.appendText(token.text);
				continue;
			}
			const index = wordIndex++;
			// A span, not a button: themes restyle buttons with their own
			// background and shadow, which would tint every single word.
			const word = host.createSpan({
				cls,
				text: token.text,
				attr: {
					role: 'button',
					tabindex: '-1',
					'aria-label': `查词：${token.lookup}`,
					'data-glean-cue-index': String(cue.index),
					'data-glean-word-index': String(index),
				},
			});
			if (
				this.selectedWord?.cueIndex === cue.index &&
				this.selectedWord.wordIndex === index
			) {
				word.addClass('is-selected');
			}
			let pointerStart: { x: number; y: number } | null = null;
			word.addEventListener('pointerdown', (evt) => {
				pointerStart = { x: evt.clientX, y: evt.clientY };
			});
			word.addEventListener('click', (evt) => {
				evt.stopPropagation();
				if (evt.detail > 1) {
					this.clearLookupOpenTimer();
					return;
				}
				const moved =
					pointerStart !== null &&
					Math.hypot(evt.clientX - pointerStart.x, evt.clientY - pointerStart.y) > 4;
				const selection = word.ownerDocument.getSelection();
				if (moved || selection?.toString()) {
					return;
				}
				this.clearLookupOpenTimer();
				this.lookupOpenTimer = window.setTimeout(() => {
					this.lookupOpenTimer = null;
					if (word.isConnected) {
						this.openWordLookup(
							word,
							token.lookup ?? token.text,
							cue,
							index,
						);
					}
				}, 180);
			});
			word.addEventListener('dblclick', (evt) => {
				evt.stopPropagation();
				this.clearLookupOpenTimer();
			});
		}
	}

	private openWordLookup(
		anchor: HTMLElement,
		word: string,
		cue: Cue,
		wordIndex: number,
	): void {
		this.clearAdvanceTimer();
		this.inputEl?.blur();
		const previous = this.selectedWord;
		const lookupId = ++this.lookupSequence;
		this.selectedWord = { cueIndex: cue.index, wordIndex, lookupId };
		this.paintWordSelection(previous, this.selectedWord);
		const initialCard = this.plugin.findLexiconCard(word);
		const sourceName =
			this.currentVideo?.name ??
			this.currentYouTube?.title ??
			this.currentBilibili?.title ??
			'当前媒体';
		const sourcePath = this.currentVideo
			? this.currentVideo.path
			: this.currentYouTube
				? youtubeSourcePath(this.currentYouTube.videoId)
				: this.currentBilibili
					? bilibiliSourcePath(this.currentBilibili.bvid)
					: null;
		this.wordPopover.open(anchor, {
			lookupId,
			word,
			sentence: cue.text,
			sourceName,
			timeLabel: formatTimestamp(cue.start),
			inLexicon: initialCard !== null,
			status: initialCard?.status,
			onDismiss: (closedLookupId) => this.clearSelectedWord(closedLookupId),
			onSpeak: async (lookup, accent) => {
				const surface =
					lookup?.lemma ??
					lookup?.surface ??
					word;
				return this.speakLookup(cue, wordIndex, surface, accent);
			},
			onSave: async (lookup) => {
				if (!sourcePath) {
					throw new Error('没有来源媒体');
				}
				const resolved = lookup ?? {
					surface: word,
					lemma: normalizeDictionaryKey(word),
					match: 'missing' as const,
					entry: null,
				};
				try {
					return await this.plugin.saveWord({
						lookup: resolved,
						context: {
							sentence: cue.text,
							sourcePath,
							sourceName,
							time: cue.start,
							timeLabel: formatTimestamp(cue.start),
						},
					});
				} catch (error) {
					new Notice(error instanceof Error ? error.message : '生词保存失败');
					throw error;
				}
			},
			onRemove: async (lookup) => {
				const lemma = lookup?.lemma ?? normalizeDictionaryKey(word);
				try {
					const removed = await this.plugin.removeWord(lemma);
					if (!removed) {
						throw new Error('找不到对应的生词笔记');
					}
					new Notice(`已将 ${lemma} 移到废纸篓`);
					return true;
				} catch (error) {
					new Notice(error instanceof Error ? error.message : '移出生词失败');
					throw error;
				}
			},
			onOpenNote: async (lookup) => {
				const lemma = lookup?.lemma ?? normalizeDictionaryKey(word);
				const opened = await this.plugin.openWordNote(lemma);
				if (!opened) {
					new Notice('找不到对应的生词笔记');
				}
				return opened;
			},
			onStatus: async (lookup, status) => {
				const lemma = lookup?.lemma ?? normalizeDictionaryKey(word);
				try {
					const updated = await this.plugin.setWordStatus(lemma, status);
					if (!updated) {
						new Notice('找不到对应的生词笔记');
					}
					return updated;
				} catch (error) {
					new Notice(error instanceof Error ? error.message : '更新生词状态失败');
					throw error;
				}
			},
		});
		void this.plugin
			.lookupWord(word)
			.then((lookup) => {
				const key = lookup?.lemma ?? word;
				const card = this.plugin.findLexiconCard(key);
				this.wordPopover.update(
					lookupId,
					lookup,
					card !== null,
					card?.status,
				);
			})
			.catch(() => this.wordPopover.update(lookupId, null));
	}

	/** The highlight only lives as long as the lookup it belongs to. */
	private clearSelectedWord(lookupId: number): void {
		if (!this.selectedWord || this.selectedWord.lookupId !== lookupId) {
			return;
		}
		const previous = this.selectedWord;
		this.selectedWord = null;
		this.paintWordSelection(previous, null);
		if (this.mode === 'dictation') {
			this.focusDictInput();
		}
	}

	private paintWordSelection(
		previous: { cueIndex: number; wordIndex: number } | null,
		next: { cueIndex: number; wordIndex: number } | null,
	): void {
		if (previous) {
			for (const el of this.wordElements(previous.cueIndex, previous.wordIndex)) {
				el.removeClass('is-selected');
			}
		}
		if (next) {
			for (const el of this.wordElements(next.cueIndex, next.wordIndex)) {
				el.addClass('is-selected');
			}
		}
	}

	private wordElements(cueIndex: number, wordIndex: number): HTMLElement[] {
		return Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(
				`[data-glean-cue-index="${cueIndex}"][data-glean-word-index="${wordIndex}"]`,
			),
		);
	}

	private closeWordLookup(): void {
		this.clearLookupOpenTimer();
		this.wordPopover.close();
		const selected = this.selectedWord;
		if (selected) {
			this.clearSelectedWord(selected.lookupId);
		}
	}

	private clearLookupOpenTimer(): void {
		if (this.lookupOpenTimer !== null) {
			window.clearTimeout(this.lookupOpenTimer);
			this.lookupOpenTimer = null;
		}
	}

	private displayCueText(cue: Cue): string {
		if (this.mode !== 'dictation') {
			return cue.text;
		}
		if (!this.hidden || this.dictRevealed) {
			return cue.text;
		}
		if (cue.index === this.activeIndex && this.dictMatched > 0) {
			return this.partialCueText(cue);
		}
		return '·····';
	}

	private partialCueText(cue: Cue): string {
		const { cells } = buildDictCells(cue.text);
		const cursor = nextDisplayIndex(cells, this.dictMatched);
		let out = '';
		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i];
			if (!cell) {
				continue;
			}
			if (cell.normIndex === null) {
				out += this.dictMatched > 0 && i < cursor ? cell.ch : (/\s/.test(cell.ch) ? cell.ch : '·');
			} else if (cell.normIndex < this.dictMatched) {
				out += cell.ch;
			} else {
				out += '·';
			}
		}
		return out;
	}

	private refreshCueTexts(): void {
		for (let i = 0; i < this.cues.length; i++) {
			const cue = this.cues[i];
			const row = this.cueEls[i];
			if (!cue || !row) {
				continue;
			}
			const textEl = row.querySelector('.glean-cue-text');
			if (textEl instanceof HTMLElement) {
				this.renderCueText(textEl, cue);
			}
		}
	}

	private refreshFocus(): void {
		const cue = this.cues[this.activeIndex];
		if (this.focusMetaEl) {
			if (!cue) {
				this.focusMetaEl.setText('当前句');
			} else {
				this.focusMetaEl.setText(
					`当前句 · ${formatTimestamp(cue.start)} · ${this.activeIndex + 1}/${this.cues.length}`,
				);
			}
		}
		if (!this.focusTextEl) {
			return;
		}
		// Dictation mode: only the dict cells + input show the sentence (avoid triple display).
		if (this.mode === 'dictation') {
			this.focusTextEl.setText('');
			return;
		}
		if (!cue) {
			this.focusTextEl.setText('播放或点一句开始精听。下一里程碑：点词查义与入库。');
			return;
		}
		this.renderCueTokens(this.focusTextEl, cue, 'glean-word glean-focus-word');
	}

	private onTick(t: number): void {
		this.updateTime(t);
		if (this.sentenceMode) {
			if (!this.sentenceArmed) {
				if (t >= this.sentenceStart - 0.05 && t < this.sentenceEnd) {
					this.sentenceArmed = true;
				} else {
					// Still waiting for the seek to land; the clock is not ours yet.
					return;
				}
			}
			this.scheduleSentenceStop();
			return;
		}

		// Dictation always stops at the active sentence end (even if continuous play slipped in).
		if (this.mode === 'dictation' && this.activeIndex >= 0) {
			const cue = this.cues[this.activeIndex];
			if (cue && t >= cue.end - 0.05 && this.source.isPlaying()) {
				this.source.pause();
				this.focusDictInput();
				return;
			}
		}

		const next = cueIndexAt(this.cues, t);
		if (next !== this.activeIndex) {
			this.setActive(next);
		}
	}

	private setActive(index: number): void {
		if (index !== this.activeIndex) {
			this.closeWordLookup();
		}
		if (this.activeIndex >= 0) {
			this.cueEls[this.activeIndex]?.removeClass('is-active');
		}
		this.activeIndex = index;
		const el = index >= 0 ? this.cueEls[index] : undefined;
		if (el) {
			el.addClass('is-active');
			el.scrollIntoView({ block: 'nearest' });
		}
		this.refreshFocus();
		if (this.mode === 'dictation') {
			this.loadDictationForActive();
		} else {
			this.refreshCueTexts();
		}
	}

	private loadDictationForActive(): void {
		this.clearAdvanceTimer();
		this.dictMatched = 0;
		this.dictWrong = false;
		this.dictRevealed = false;
		this.dictCells = [];
		this.dictNorm = '';

		if (this.inputEl) {
			this.inputEl.value = '';
		}
		if (!this.dictEl || !this.dictHintEl) {
			this.refreshFocus();
			this.refreshCueTexts();
			return;
		}
		this.dictEl.empty();

		const cue = this.cues[this.activeIndex];
		if (!cue) {
			this.dictHintEl.setText('点一句或按 R，然后开始敲。');
			this.dictHintEl.removeClass('is-done');
			this.refreshFocus();
			this.refreshCueTexts();
			return;
		}

		const hideHint = this.dictHideHint();
		this.dictHintEl.setText(
			`${formatTimestamp(cue.start)} · ${this.activeIndex + 1}/${this.cues.length} · ${hideHint}`,
		);
		this.dictHintEl.removeClass('is-done');

		const built = buildDictCells(cue.text);
		this.dictNorm = built.norm;
		for (const cell of built.cells) {
			const span = this.dictEl.createSpan({ cls: 'glean-dict-cell' });
			span.setText(this.cellDisplay(cell, 'pending'));
			this.dictCells.push({ ...cell, span });
		}
		this.paintDictCells();
		this.refreshFocus();
		this.refreshCueTexts();
	}

	private cellDisplay(
		cell: DictCell,
		state: 'pending' | 'matched' | 'current' | 'wrong' | 'revealed',
	): string {
		if (state === 'matched' || state === 'revealed' || !this.hidden) {
			return cell.ch === ' ' ? '·' : cell.ch;
		}
		if (state === 'current' || state === 'wrong') {
			return '_';
		}
		return '·';
	}

	private paintDictCells(): void {
		const cursor = nextDisplayIndex(this.dictCells, this.dictMatched);
		const done = isComplete(this.dictMatched, this.dictNorm.length);

		for (let i = 0; i < this.dictCells.length; i++) {
			const cell = this.dictCells[i];
			if (!cell) {
				continue;
			}
			cell.span.className = 'glean-dict-cell';
			let state: 'pending' | 'matched' | 'current' | 'wrong' | 'revealed' = 'pending';

			if (this.dictRevealed || !this.hidden) {
				state = this.dictRevealed ? 'revealed' : 'matched';
				if (cell.normIndex !== null && cell.normIndex < this.dictMatched) {
					cell.span.addClass('is-matched');
				} else if (!this.hidden) {
					cell.span.addClass('is-visible');
				} else {
					cell.span.addClass('is-revealed');
				}
			} else if (cell.normIndex === null) {
				if (i < cursor || done) {
					state = 'matched';
					cell.span.addClass('is-matched');
				} else {
					cell.span.addClass('is-pending');
				}
			} else if (cell.normIndex < this.dictMatched) {
				state = 'matched';
				cell.span.addClass('is-matched');
			} else if (cell.normIndex === this.dictMatched && !done) {
				state = this.dictWrong ? 'wrong' : 'current';
				cell.span.addClass(this.dictWrong ? 'is-wrong' : 'is-current');
			} else {
				cell.span.addClass('is-pending');
			}

			cell.span.setText(this.cellDisplay(cell, state));
		}

		if (this.dictHintEl && done && this.dictNorm.length > 0) {
			this.dictHintEl.setText('匹配完成');
			this.dictHintEl.addClass('is-done');
		}
		this.refreshFocus();
	}

	private onDictInput(): void {
		if (this.mode !== 'dictation') {
			return;
		}
		if (!this.inputEl || this.activeIndex < 0 || this.dictNorm.length === 0) {
			return;
		}
		if (this.dictRevealed) {
			return;
		}

		const typed = this.inputEl.value;
		let matched = 0;
		let wrong = false;
		let keepUntil = typed.length;

		for (let i = 0; i < typed.length; i++) {
			const raw = typed[i];
			if (raw === undefined || !/[A-Za-z0-9]/.test(raw)) {
				continue;
			}
			const expected = this.dictNorm[matched];
			if (expected === undefined) {
				keepUntil = i;
				break;
			}
			if (normalizeChar(raw) === expected) {
				matched += 1;
				wrong = false;
			} else {
				wrong = true;
				keepUntil = i + 1;
				break;
			}
		}

		if (keepUntil < typed.length) {
			this.inputEl.value = typed.slice(0, keepUntil);
		}

		this.dictMatched = matched;
		this.dictWrong = wrong;
		this.paintDictCells();
		this.refreshCueTexts();

		if (!wrong && isComplete(this.dictMatched, this.dictNorm.length)) {
			this.onDictComplete();
		}
	}

	private onDictComplete(): void {
		this.paintDictCells();
		this.refreshCueTexts();
		this.clearAdvanceTimer();
		this.advanceTimer = window.setTimeout(() => {
			this.advanceTimer = null;
			if (this.activeIndex < this.cues.length - 1) {
				this.jumpBy(1);
			}
		}, 900);
	}

	private onDictKey(evt: KeyboardEvent): void {
		if (evt.key === 'Enter') {
			evt.preventDefault();
			this.replayCurrent();
			return;
		}
		if (evt.key === 'Escape') {
			evt.preventDefault();
			this.inputEl?.blur();
			this.contentEl.focus({ preventScroll: true });
			return;
		}
		if (evt.key === 'Backspace' && this.dictWrong) {
			this.dictWrong = false;
			this.paintDictCells();
		}
	}

	private toggleHidden(): void {
		if (this.mode !== 'dictation') {
			return;
		}
		this.closeWordLookup();
		this.hidden = !this.hidden;
		this.dictRevealed = !this.hidden;
		this.syncHideButton();
		this.paintDictCells();
		this.refreshCueTexts();
		if (this.dictHintEl && this.activeIndex >= 0) {
			const cue = this.cues[this.activeIndex];
			if (isComplete(this.dictMatched, this.dictNorm.length)) {
				this.dictHintEl.setText('匹配完成');
				this.dictHintEl.addClass('is-done');
			} else if (cue) {
				const hideHint = this.dictHideHint();
				this.dictHintEl.setText(
					`${formatTimestamp(cue.start)} · ${this.activeIndex + 1}/${this.cues.length} · ${hideHint}`,
				);
				this.dictHintEl.removeClass('is-done');
			}
		}
		this.focusDictInput();
	}

	private syncHideButton(): void {
		this.hideBtn?.setText(this.hidden ? '显示原句' : '隐藏原句');
	}

	/**
	 * Status line for dictation. Both callers read from here so the wording
	 * cannot drift apart from the behaviour again.
	 */
	private dictHideHint(): string {
		return this.hidden ? '原句已隐藏 · H 显示' : '原句可见 · H 隐藏';
	}

	private focusDictInput(): void {
		if (this.mode !== 'dictation') {
			return;
		}
		window.setTimeout(() => {
			this.inputEl?.focus({ preventScroll: true });
		}, 0);
	}

	/** Leave single-sentence playback, dropping any pause we had booked. */
	private exitSentenceMode(): void {
		this.sentenceMode = false;
		this.sentenceArmed = false;
		this.clearSentenceStop();
	}

	private clearSentenceStop(): void {
		if (this.sentenceStopTimer !== null) {
			window.clearTimeout(this.sentenceStopTimer);
			this.sentenceStopTimer = null;
		}
	}

	/**
	 * Book the pause for the moment the sentence ends, instead of waiting to be
	 * told we passed it. The time signal only arrives every 250ms on YouTube, so
	 * stopping on a tick overruns the end by up to that much — long enough to
	 * play the first word of the next sentence.
	 *
	 * Called again on every tick: seeking, buffering and rate changes all move
	 * the target, and re-booking from a fresh clock keeps drift from adding up.
	 */
	private scheduleSentenceStop(remainingOverride?: number): void {
		this.clearSentenceStop();
		if (!this.sentenceMode) {
			return;
		}
		const rate = this.source.getPlaybackRate() || 1;
		const remaining =
			remainingOverride ?? (this.sentenceEnd - this.source.getCurrentTime()) / rate;
		if (remaining <= 0) {
			this.finishSentence();
			return;
		}
		this.sentenceStopTimer = window.setTimeout(() => {
			this.sentenceStopTimer = null;
			this.finishSentence();
		}, remaining * 1000);
	}

	private finishSentence(): void {
		if (!this.sentenceMode) {
			return;
		}
		// A seek that had to buffer leaves the clock behind the booking. Cutting
		// the sentence short here would be worse than the overrun we are fixing,
		// so re-book against where playback actually is.
		const rate = this.source.getPlaybackRate() || 1;
		const remaining = (this.sentenceEnd - this.source.getCurrentTime()) / rate;
		if (remaining > 0.05) {
			this.scheduleSentenceStop(remaining);
			return;
		}
		this.exitSentenceMode();
		this.source.pause();
		if (this.mode === 'dictation') {
			this.focusDictInput();
		}
	}

	private clearAdvanceTimer(): void {
		if (this.advanceTimer !== null) {
			window.clearTimeout(this.advanceTimer);
			this.advanceTimer = null;
		}
	}

	private clearSpeakClipTimer(): void {
		if (this.speakClipTimer !== null) {
			window.clearTimeout(this.speakClipTimer);
			this.speakClipTimer = null;
		}
	}

	/**
	 * 美/英 ask for a specific accent. Do not hijack them with the video clip —
	 * that made both buttons play the same original take.
	 */
	private async speakLookup(
		_cue: Cue,
		_wordIndex: number,
		text: string,
		accent: 'en-US' | 'en-GB' = 'en-US',
	): Promise<boolean> {
		await this.plugin.speakWord(text, accent);
		return true;
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
		this.clearAdvanceTimer();
		this.clearSpeakClipTimer();
		this.sentenceMode = true;
		this.sentenceArmed = false;
		this.sentenceStart = cue.start;
		this.sentenceEnd = cue.end;
		this.source.seekTo(cue.start);
		this.source.play();
		this.setActive(cue.index);
		// Book from the seek target rather than the clock: until the seek lands,
		// getCurrentTime() still reports where we came from. Ticks correct this
		// once playback is really inside the sentence.
		const rate = this.source.getPlaybackRate() || 1;
		this.scheduleSentenceStop((cue.end - cue.start) / rate);
	}

	private splitCueBefore(index: number, wordIndex: number): Promise<void> {
		// Always time the cut from ASR word clocks (hydrate from file timeline first
		// if this cue lost its per-cue NOTE glean-words).
		const next = splitCueBeforeWord(this.cues, index, wordIndex);
		if (next) {
			return this.applyCueEdit(next, '已拆成两句', '这里断不开', index);
		}
		const reason = explainSplitCueFailure(this.cues, index, wordIndex);
		if (reason === 'missing-word-clocks') {
			new Notice('这句缺少词级时间，重新同步后断句会对齐真实出声点');
			return Promise.resolve();
		}
		return this.applyCueEdit(null, '已拆成两句', '这里断不开', index);
	}

	private mergeCueWithPrevious(index: number): Promise<void> {
		return this.applyCueEdit(
			mergeCueWithNext(this.cues, index - 1),
			'已并入上一句',
			'没有上一句可并',
			Math.max(0, index - 1),
		);
	}

	private async applyCueEdit(
		next: Cue[] | null,
		ok: string,
		emptyHint: string,
		focusIndex: number = this.activeIndex,
	): Promise<void> {
		if (focusIndex < 0) {
			new Notice('先点一句字幕再编辑');
			return;
		}
		if (!next) {
			new Notice(emptyHint);
			return;
		}
		this.cues = next;
		this.closeWordLookup();
		this.renderCues();
		const keep = Math.min(Math.max(0, focusIndex), this.cues.length - 1);
		const cue = this.cues[keep];
		if (cue) {
			this.setActive(keep);
		}
		await this.persistEditedCues();
		new Notice(ok);
	}

	private async persistEditedCues(): Promise<void> {
		const file = this.currentSubtitle;
		if (!file) {
			new Notice('没有字幕文件，只改了当前这一次');
			return;
		}
		const format = file.extension.toLowerCase() === 'srt' ? 'srt' : 'vtt';
		const body = serializeSubtitles(this.cues, format);
		await this.app.vault.modify(file, body);
		const label =
			this.currentVideo?.name ??
			this.currentYouTube?.title ??
			this.currentBilibili?.title ??
			file.name;
		this.setStatus(`${label} · ${file.name} · ${this.cues.length} 句`);
	}

	private togglePlayback(): void {
		if (this.mode === 'dictation') {
			if (this.source.isPlaying()) {
				this.exitSentenceMode();
				this.source.pause();
				this.focusDictInput();
				return;
			}
			this.replayCurrent();
			return;
		}
		this.exitSentenceMode();
		this.source.toggle();
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
			this.togglePlayback();
			return;
		}
		if (key === 'r' || key === 'R') {
			evt.preventDefault();
			this.replayCurrent();
			return;
		}
		if (key === 'd' || key === 'D') {
			evt.preventDefault();
			this.setMode(this.mode === 'dictation' ? 'listen' : 'dictation');
			return;
		}
		if (key === 'h' || key === 'H') {
			if (this.mode === 'dictation') {
				evt.preventDefault();
				this.toggleHidden();
			}
			return;
		}
		if (key === 'Enter' && this.wordPopover.saveCurrent()) {
			evt.preventDefault();
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
		const select = this.contentEl.querySelector('.glean-rate');
		if (select instanceof HTMLSelectElement) {
			select.value = String(next);
		}
	}

	private syncPlayButton(): void {
		if (!this.playBtn) {
			return;
		}
		this.playBtn.setText(this.source.isPlaying() ? '暂停' : '播放');
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
		this.clearAdvanceTimer();
		this.clearSpeakClipTimer();
		this.clearSentenceStop();
		this.clearLookupOpenTimer();
		this.plugin.stopSpeaking();
		this.wordPopover.destroy();
		for (const u of this.unsubs) {
			u();
		}
		this.unsubs = [];
		this.source.detach();
		this.mediaHostEl = null;
		this.videoEl = null;
		this.cueListEl = null;
		this.cueEls = [];
		this.focusEl = null;
		this.focusTextEl = null;
		this.focusMetaEl = null;
		this.dictPanelEl = null;
		this.dictEl = null;
		this.inputEl = null;
		this.dictHintEl = null;
		this.hideBtn = null;
		this.saveLocalBtn = null;
		this.modeListenBtn = null;
		this.modeDictBtn = null;
		this.playerPaneEl = null;
		this.audioTitleEl = null;
		this.audioSubEl = null;
		this.dictCells = [];
	}

	getState(): Record<string, unknown> {
		if (this.currentYouTube) {
			return {
				kind: 'youtube',
				videoId: this.currentYouTube.videoId,
				title: this.currentYouTube.title,
				subtitlePath: this.currentSubtitle?.path ?? null,
				seekTo: this.source.getCurrentTime(),
				mode: this.mode,
			};
		}
		if (this.currentBilibili) {
			return {
				kind: 'bilibili',
				bvid: this.currentBilibili.bvid,
				page: this.currentBilibili.page,
				title: this.currentBilibili.title,
				mediaUrl: this.currentBilibili.mediaUrl,
				mediaSize: this.currentBilibili.mediaSize,
				mediaExpiresAt: this.currentBilibili.expiresAt,
				notePath: this.currentBilibili.notePath,
				subtitlePath: this.currentSubtitle?.path ?? null,
				seekTo: this.source.getCurrentTime(),
				mode: this.mode,
			};
		}
		if (!this.currentVideo) {
			return { mode: this.mode };
		}
		return {
			kind: 'local',
			videoPath: this.currentVideo.path,
			subtitlePath: this.currentSubtitle?.path ?? null,
			seekTo: this.source.getCurrentTime(),
			mode: this.mode,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		if (!state || typeof state !== 'object') {
			return;
		}
		const s = state as Partial<ListenState>;
		if (s.mode === 'listen' || s.mode === 'dictation') {
			this.mode = s.mode;
			this.syncModeChrome();
		}
		if (s.kind === 'youtube' && typeof s.videoId === 'string') {
			await this.openMedia({
				kind: 'youtube',
				videoId: s.videoId,
				title: typeof s.title === 'string' ? s.title : undefined,
				subtitlePath: typeof s.subtitlePath === 'string' ? s.subtitlePath : null,
				seekTo: typeof s.seekTo === 'number' ? s.seekTo : undefined,
				mode: s.mode,
			});
		} else if (s.kind === 'bilibili' && typeof s.mediaUrl === 'string') {
			// A restored layout can be hours old, so the signed link may be dead;
			// re-resolve from the note instead of replaying a stale URL.
			const fresh =
				typeof s.notePath === 'string'
					? this.plugin.bilibiliStateFromNotePath(s.notePath)
					: null;
			await this.openMedia({
				...(fresh ?? {
					kind: 'bilibili',
					bvid: typeof s.bvid === 'string' ? s.bvid : undefined,
					page: typeof s.page === 'number' ? s.page : 1,
					title: typeof s.title === 'string' ? s.title : undefined,
					mediaUrl: s.mediaUrl,
					mediaSize: typeof s.mediaSize === 'number' ? s.mediaSize : 0,
					mediaExpiresAt:
						typeof s.mediaExpiresAt === 'number' ? s.mediaExpiresAt : null,
					notePath: typeof s.notePath === 'string' ? s.notePath : '',
					subtitlePath:
						typeof s.subtitlePath === 'string' ? s.subtitlePath : null,
				}),
				seekTo: typeof s.seekTo === 'number' ? s.seekTo : undefined,
				mode: s.mode,
			});
		} else if (typeof s.videoPath === 'string') {
			await this.openMedia({
				kind: 'local',
				videoPath: s.videoPath,
				subtitlePath: typeof s.subtitlePath === 'string' ? s.subtitlePath : null,
				seekTo: typeof s.seekTo === 'number' ? s.seekTo : undefined,
				mode: s.mode,
			});
		}
	}
}
