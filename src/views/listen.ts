import { ItemView, Notice, TFile, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
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
import { formatTimestamp, parseSubtitles } from '../media/srt';
import { findSiblingSubtitle } from '../media/subtitles';
import { tokenizeSubtitle } from '../media/subtitle-tokens';
import {
	AUDIO_EXTENSIONS,
	MEDIA_EXTENSIONS,
	PLAYBACK_RATES,
	type Cue,
} from '../media/types';
import { GleanWordPopover } from './word-popup';

export const LISTEN_VIEW_TYPE = 'glean-listen';

export type GleanViewMode = 'listen' | 'dictation';

export interface ListenState {
	videoPath: string;
	subtitlePath: string | null;
	seekTo?: number;
	mode?: GleanViewMode;
}

type DictCellView = DictCell & { span: HTMLElement };

/**
 * Glean listen view.
 * Default mode is intensive listening (current sentence + cue list).
 * Dictation is an explicit mode switch, not a permanent second panel.
 */
export class ListenView extends ItemView {
	plugin: GleanPlugin;
	private source = new LocalFileSource();
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
	private sentenceMode = false;
	/** True only after the playhead has entered the target sentence (avoids seek race). */
	private sentenceArmed = false;
	private sentenceStart = 0;
	private sentenceEnd = 0;
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
		return this.currentVideo ? `Glean · ${this.currentVideo.basename}` : 'Glean 精听';
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
			text: '打开 vault 里的视频或音频。字幕放同目录同名 .srt / .vtt。',
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

		this.videoEl = stage.createEl('video', { cls: 'glean-video' });
		this.videoEl.controls = true;
		this.videoEl.preload = 'metadata';
		this.videoEl.muted = false;
		this.videoEl.volume = 1;
		this.videoEl.addEventListener('loadedmetadata', () => this.syncMediaChrome());

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
		cuesWrap.createDiv({ cls: 'glean-cues-label', text: '字幕' });
		this.cueListEl = cuesWrap.createDiv({ cls: 'glean-cues' });
		this.renderEmptyCues(
			'还没有字幕',
			'打开媒体后，同目录同名的 .srt / .vtt 会自动挂上。',
		);

		this.source.attach(this.videoEl);
		this.source.setPlaybackRate(this.plugin.settings.defaultRate);
		this.unsubs.push(
			this.source.onTimeUpdate((t) => this.onTick(t)),
			this.source.onPlay(() => this.syncPlayButton()),
			this.source.onPause(() => this.syncPlayButton()),
		);

		this.syncModeChrome();
		this.syncMediaChrome();
		this.contentEl.focus({ preventScroll: true });
	}

	private openMediaPicker(): void {
		new MediaSuggestModal(this.app, (file) => {
			void this.plugin.openVideo(file);
		}).open();
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
		const has = !!this.currentVideo;
		root.toggleClass('has-media', has);
		const isAudio =
			!!this.currentVideo && AUDIO_EXTENSIONS.has(this.currentVideo.extension.toLowerCase());
		root.toggleClass('is-audio', isAudio);

		let isPortrait = false;
		if (this.videoEl && this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0) {
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
		if (!this.videoEl) {
			return;
		}

		this.closeWordLookup();
		this.sentenceMode = false;
		this.sentenceArmed = false;
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
			this.currentVideo = null;
			this.currentSubtitle = null;
			this.syncMediaChrome();
			this.setStatus('媒体无法播放。试试 mp4 / webm / mp3 / m4a。');
			return;
		}

		if (this.videoEl) {
			this.videoEl.muted = false;
			this.videoEl.volume = 1;
		}

		if (this.playerPaneEl) {
			this.playerPaneEl.removeClass('is-resized');
		}

		this.currentVideo = video;
		this.currentSubtitle = subtitle;
		this.cues = cues;
		this.activeIndex = -1;
		this.sentenceMode = false;
		this.sentenceArmed = false;
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
		this.renderCueTokens(textEl, cue, 'glean-word');
	}

	/**
	 * Words stay clickable in every mode as long as the real sentence is on
	 * screen; a masked sentence is rendered as plain text.
	 */
	private renderCueTokens(host: HTMLElement, cue: Cue, cls: string): void {
		host.empty();
		const shown = this.displayCueText(cue);
		if (shown !== cue.text) {
			host.setText(shown);
			return;
		}

		let wordIndex = 0;
		for (const token of tokenizeSubtitle(cue.text)) {
			if (token.kind === 'separator' || !token.lookup) {
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
		this.wordPopover.open(anchor, {
			lookupId,
			word,
			sentence: cue.text,
			sourceName: this.currentVideo?.name ?? '当前媒体',
			timeLabel: formatTimestamp(cue.start),
			inLexicon: initialCard !== null,
			status: initialCard?.status,
			onDismiss: (closedLookupId) => this.clearSelectedWord(closedLookupId),
			onSave: async (lookup) => {
				if (!this.currentVideo) {
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
							sourcePath: this.currentVideo.path,
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
				if (t >= this.sentenceStart - 0.05 && t < this.sentenceEnd - 0.05) {
					this.sentenceArmed = true;
				}
			} else if (t >= this.sentenceEnd - 0.05) {
				this.sentenceMode = false;
				this.sentenceArmed = false;
				this.source.pause();
				if (this.mode === 'dictation') {
					this.focusDictInput();
				}
			}
			return;
		}

		// Dictation always stops at the active sentence end (even if continuous play slipped in).
		if (this.mode === 'dictation' && this.activeIndex >= 0) {
			const cue = this.cues[this.activeIndex];
			if (cue && t >= cue.end - 0.05 && this.videoEl && !this.videoEl.paused) {
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

		const hideHint = this.hidden ? '原句已隐藏 · H 显示' : '原句可见 · H 隐藏';
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
				const hideHint = this.hidden ? '原句已隐藏 · H 显示' : '原句可见 · H 隐藏';
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

	private focusDictInput(): void {
		if (this.mode !== 'dictation') {
			return;
		}
		window.setTimeout(() => {
			this.inputEl?.focus({ preventScroll: true });
		}, 0);
	}

	private clearAdvanceTimer(): void {
		if (this.advanceTimer !== null) {
			window.clearTimeout(this.advanceTimer);
			this.advanceTimer = null;
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
		this.clearAdvanceTimer();
		this.sentenceMode = true;
		this.sentenceArmed = false;
		this.sentenceStart = cue.start;
		this.sentenceEnd = cue.end;
		this.source.seekTo(cue.start);
		this.source.play();
		this.setActive(cue.index);
	}

	private togglePlayback(): void {
		if (this.mode === 'dictation') {
			if (this.videoEl && !this.videoEl.paused) {
				this.sentenceMode = false;
				this.sentenceArmed = false;
				this.source.pause();
				this.focusDictInput();
				return;
			}
			this.replayCurrent();
			return;
		}
		this.sentenceMode = false;
		this.sentenceArmed = false;
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
		this.clearAdvanceTimer();
		this.clearLookupOpenTimer();
		this.wordPopover.destroy();
		for (const u of this.unsubs) {
			u();
		}
		this.unsubs = [];
		this.source.detach();
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
		this.modeListenBtn = null;
		this.modeDictBtn = null;
		this.playerPaneEl = null;
		this.audioTitleEl = null;
		this.audioSubEl = null;
		this.dictCells = [];
	}

	getState(): Record<string, unknown> {
		if (!this.currentVideo) {
			return { mode: this.mode };
		}
		return {
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
		if (typeof s.videoPath === 'string') {
			await this.openMedia({
				videoPath: s.videoPath,
				subtitlePath: typeof s.subtitlePath === 'string' ? s.subtitlePath : null,
				seekTo: typeof s.seekTo === 'number' ? s.seekTo : undefined,
				mode: s.mode,
			});
		}
	}
}
