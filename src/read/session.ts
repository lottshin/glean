import { MarkdownView, Notice, TFile } from 'obsidian';
import { normalizeDictionaryKey } from '../dictionary';
import type { WordStatus } from '../lexicon/note';
import type GleanPlugin from '../main';
import { glossPassage } from '../translate/gloss';
import { GleanWordPopover } from '../views/word-popup';
import { decorateReadableArticle, sentenceAround } from './decorate';
import {
	readingMetrics,
	shouldHintWord,
} from './metrics';
import { GleanPassagePanel } from './passage-panel';

const ACTION_CLASS = 'glean-read-action';
const BAR_CLASS = 'glean-read-bar';
const HOST_CLASS = 'glean-read-host';

export const READ_ICON = 'wheat';

interface ReadingSelection {
	text: string;
	file: TFile;
	doc: Document;
	dock: HTMLElement;
}

/**
 * Opt-in reading mode for ordinary Markdown notes.
 * Sections only wrap words; chrome and coverage live on the view once.
 */
export class ReadingMode {
	private enabled = new Set<string>();
	private popover = new GleanWordPopover();
	private passagePanel = new GleanPassagePanel();
	private lookupSequence = 0;
	private passageSequence = 0;
	private coverageTimers = new Map<string, number>();
	private coverageGenerations = new Map<string, number>();
	/** Paths mid-transition into preview, exempt from the source-mode guard. */
	private switching = new Set<string>();
	private passageDirty = false;
	private passageText = '';
	private selectionTimer: number | null = null;
	private removeSelectionWatch: (() => void) | null = null;
	private syncing = false;

	constructor(private readonly plugin: GleanPlugin) {}

	observe(): void {
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', () => this.syncChrome()),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => this.syncChrome()),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => this.syncChrome()),
		);
		this.plugin.registerEvent(
			this.plugin.app.metadataCache.on('changed', (file) => {
				const folder = this.plugin.settings.wordsFolder.replace(/\/+$/, '');
				if (file.path === folder || file.path.startsWith(`${folder}/`)) {
					this.refreshEnabledViews();
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile) || !this.enabled.delete(oldPath)) {
					return;
				}
				this.enabled.add(file.path);
				this.syncChrome();
				this.rerender(file);
			}),
		);
		this.plugin.app.workspace.onLayoutReady(() => this.syncChrome());
		this.plugin.registerMarkdownPostProcessor((element, context) => {
			this.decorateSection(element, context.sourcePath);
		});
	}

	isEnabled(path: string): boolean {
		return this.enabled.has(path);
	}

	refresh(): void {
		this.refreshEnabledViews();
	}

	canEnable(file: TFile | null): file is TFile {
		return (
			!!file &&
			file.extension.toLowerCase() === 'md' &&
			!this.plugin.isWordNote(file)
		);
	}

	async toggle(file: TFile | null): Promise<void> {
		if (!this.canEnable(file)) {
			new Notice('当前笔记不能进入 Glean 阅读');
			return;
		}
		if (this.enabled.has(file.path)) {
			this.enabled.delete(file.path);
			this.popover.close();
			this.passagePanel.close();
		} else {
			this.enabled.add(file.path);
			// Switching into preview fires layout events while the view still
			// reports source mode; the guard below must not read that as an exit.
			this.switching.add(file.path);
			try {
				await this.openPreview(file);
			} finally {
				this.switching.delete(file.path);
			}
		}
		this.syncChrome();
		this.rerender(file);
	}

	private decorateSection(element: HTMLElement, sourcePath: string): void {
		if (!this.enabled.has(sourcePath)) {
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile) || this.plugin.isWordNote(file)) {
			return;
		}
		if (element.classList.contains(BAR_CLASS) || element.closest(`.${BAR_CLASS}`)) {
			return;
		}

		decorateReadableArticle(
			element,
			(word) => this.statusOf(word),
			(el, word) => this.openLookup(el, word, file),
		);
		this.scheduleCoverage(sourcePath);
	}

	private statusOf(word: string): WordStatus | null {
		return this.plugin.findLexiconCard(word)?.status ?? null;
	}

	private openLookup(anchor: HTMLElement, word: string, file: TFile): void {
		const lookupId = ++this.lookupSequence;
		const sentence = sentenceAround(anchor);
		const initialCard = this.plugin.findLexiconCard(word);
		this.popover.open(anchor, {
			lookupId,
			word,
			sentence,
			sourceName: file.basename,
			timeLabel: '阅读',
			inLexicon: initialCard !== null,
			status: initialCard?.status,
			onDismiss: () => undefined,
			onSave: async (lookup) => {
				const resolved = lookup ?? {
					surface: word,
					lemma: normalizeDictionaryKey(word),
					match: 'missing' as const,
					entry: null,
				};
				try {
					const result = await this.plugin.saveWord({
						lookup: resolved,
						context: {
							sentence,
							sourcePath: file.path,
							timeLabel: '阅读',
						},
					});
					this.popover.close();
					this.rerender(file);
					return result;
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
					this.popover.close();
					this.rerender(file);
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
						return false;
					}
					this.popover.close();
					this.rerender(file);
					return true;
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
				this.popover.update(lookupId, lookup, card !== null, card?.status);
			})
			.catch(() => this.popover.update(lookupId, null));
	}

	/** The panel is a session: openable from a selection, closable on demand. */
	canExplainSelection(): boolean {
		return this.passagePanel.isOpen || this.currentSelection() !== null;
	}

	explainSelection(): void {
		if (this.passagePanel.isOpen) {
			this.passagePanel.close();
			return;
		}
		const selection = this.currentSelection();
		if (!selection) {
			new Notice('请先在 Glean 阅读里选中句子或段落');
			return;
		}
		this.popover.close();
		this.openPassagePanel(selection);
		this.syncChrome();
	}

	private openPassagePanel(selection: ReadingSelection): void {
		const { file, dock } = selection;
		this.passagePanel.open(dock, {
			sourceName: file.basename,
			canTranslate: () => this.plugin.settings.translateEnabled,
			onSaveWord: async (item, passage) => {
				try {
					const lookup = (await this.plugin.lookupWord(item.surface)) ?? {
						surface: item.surface,
						lemma: item.lemma,
						match: 'missing' as const,
						entry: null,
					};
					await this.plugin.saveWord({
						lookup,
						context: {
							sentence: passage,
							sourcePath: file.path,
							timeLabel: '阅读',
						},
					});
					// Re-rendering now would rebuild the article under the
					// reader; highlights catch up when the session ends.
					this.passageDirty = true;
				} catch (error) {
					new Notice(error instanceof Error ? error.message : '生词保存失败');
					throw error;
				}
			},
			onTranslate: (passage) => this.plugin.translatePassage(passage),
			onClose: () => this.onPassagePanelClosed(file),
		});
		this.watchSelection(selection.doc);
		this.setPassage(selection.text);
	}

	private onPassagePanelClosed(file: TFile): void {
		this.unwatchSelection();
		this.syncChrome();
		if (this.passageDirty) {
			this.passageDirty = false;
			this.rerender(file);
		}
	}

	private setPassage(text: string): void {
		const passageId = ++this.passageSequence;
		this.passagePanel.setPassage(passageId, text);
		void glossPassage(
			text,
			(word) => this.plugin.lookupWord(word),
			(word) => this.statusOf(word),
		)
			.then((gloss) => this.passagePanel.setGloss(passageId, gloss))
			.catch(() =>
				this.passagePanel.setGloss(passageId, { items: [], truncated: 0 }),
			);
	}

	/**
	 * While the panel is open, selecting the next sentence swaps its contents.
	 * Collapsed selections are ignored so clicking a word keeps the passage.
	 */
	private watchSelection(doc: Document): void {
		this.unwatchSelection();
		const onSelectionChange = () => {
			if (this.selectionTimer !== null) {
				window.clearTimeout(this.selectionTimer);
			}
			this.selectionTimer = window.setTimeout(() => {
				this.selectionTimer = null;
				const selection = this.currentSelection();
				if (
					selection &&
					this.passagePanel.isDockedIn(selection.dock) &&
					selection.text !== this.passageText
				) {
					this.passageText = selection.text;
					this.setPassage(selection.text);
				}
			}, 200);
		};
		doc.addEventListener('selectionchange', onSelectionChange);
		this.removeSelectionWatch = () => {
			doc.removeEventListener('selectionchange', onSelectionChange);
		};
	}

	private unwatchSelection(): void {
		if (this.selectionTimer !== null) {
			window.clearTimeout(this.selectionTimer);
			this.selectionTimer = null;
		}
		this.removeSelectionWatch?.();
		this.removeSelectionWatch = null;
		this.passageText = '';
	}

	private currentSelection(): ReadingSelection | null {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			const file = view instanceof MarkdownView ? view.file : null;
			if (!(view instanceof MarkdownView) || !file || !this.enabled.has(file.path)) {
				continue;
			}
			const host = this.previewHost(view);
			const dock = this.passageDock(view);
			const doc = view.containerEl.ownerDocument;
			const selection = doc.defaultView?.getSelection();
			if (
				!host ||
				!dock ||
				!selection ||
				selection.rangeCount === 0 ||
				selection.isCollapsed
			) {
				continue;
			}
			const range = selection.getRangeAt(0);
			if (!host.contains(range.commonAncestorContainer)) {
				continue;
			}
			const text = selection.toString().replace(/\s+/g, ' ').trim();
			if (!text) {
				continue;
			}
			return { text, file, doc, dock };
		}
		return null;
	}

	/** Flex parent of the preview: docking here shrinks the article, not covers it. */
	private passageDock(view: MarkdownView): HTMLElement | null {
		return (
			view.containerEl.querySelector<HTMLElement>('.markdown-reading-view') ??
			this.previewHost(view)?.parentElement ??
			null
		);
	}

	private async openPreview(file: TFile): Promise<void> {
		const { workspace } = this.plugin.app;
		let view = workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== file.path) {
			const leaf = workspace.getLeaf(false);
			await leaf.openFile(file);
			view = leaf.view instanceof MarkdownView ? leaf.view : null;
		}
		if (!view) {
			return;
		}
		const state = view.getState();
		if (state.mode !== 'preview') {
			await view.setState({ ...state, mode: 'preview' }, { history: false });
		}
	}

	private rerender(file: TFile): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				view.previewMode?.rerender(true);
			}
		}
		this.scheduleCoverage(file.path);
	}

	private syncChrome(): void {
		// Closing the panel syncs chrome again to relabel the toolbar button.
		if (this.syncing) {
			return;
		}
		this.syncing = true;
		try {
			this.syncChromeOnce();
		} finally {
			this.syncing = false;
		}
	}

	private syncChromeOnce(): void {
		if (this.passagePanel.isOpen && !this.passagePanel.isConnected) {
			this.passagePanel.close();
		}
		const views: MarkdownView[] = [];
		// A note can sit in several panes at once; reading mode should survive
		// as long as any one of them still renders the preview.
		const previewed = new Map<string, boolean>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			views.push(view);
			const path = view.file?.path;
			if (path) {
				previewed.set(path, (previewed.get(path) ?? false) || view.getMode() === 'preview');
			}
		}

		for (const path of [...this.enabled]) {
			if (this.switching.has(path) || previewed.get(path) !== false) {
				continue;
			}
			this.enabled.delete(path);
			this.passagePanel.close();
		}

		for (const view of views) {
			this.syncHeaderAction(view);
			this.syncViewBar(view);
		}
	}

	private syncHeaderAction(view: MarkdownView): void {
		view.containerEl
			.querySelectorAll(`.view-actions .${ACTION_CLASS}`)
			.forEach((node) => node.remove());
		const file = view.file;
		if (!this.canEnable(file)) {
			return;
		}
		const on = this.enabled.has(file.path);
		// The wheat mark means "Glean acts here". On a note the only Glean
		// action is reading, so the brand icon needs no second glyph. It also
		// keeps clear of `book-open`, which Obsidian's own preview toggle owns.
		const button = view.addAction(READ_ICON, on ? '退出 Glean 阅读' : 'Glean 阅读', () => {
			void this.toggle(file);
		});
		button.addClass(ACTION_CLASS);
		button.toggleClass('is-active', on);
	}

	private syncViewBar(view: MarkdownView): void {
		const file = view.file;
		const host = this.previewHost(view);
		if (!host) {
			return;
		}
		host.querySelectorAll(`.${BAR_CLASS}`).forEach((node) => node.remove());
		host.toggleClass(HOST_CLASS, !!(file && this.enabled.has(file.path)));
		if (!file || !this.enabled.has(file.path)) {
			return;
		}
		const bar = host.createDiv({ cls: BAR_CLASS });
		host.prepend(bar);
		bar.createDiv({
			cls: 'glean-read-bar-label',
			text: 'Glean 阅读 · 统计中…',
		});
		const explain = bar.createEl('button', {
			cls: 'glean-btn glean-read-bar-explain',
			text: this.passagePanel.isOpen ? '收起解析' : '解析选区',
		});
		// Buttons steal focus on mousedown, which would clear the selection
		// the reader just made before the click handler can read it.
		explain.addEventListener('mousedown', (event) => event.preventDefault());
		explain.addEventListener('click', (event) => {
			event.preventDefault();
			this.explainSelection();
		});
		const exit = bar.createEl('button', {
			cls: 'glean-btn glean-read-bar-exit',
			text: '退出',
		});
		exit.addEventListener('mousedown', (event) => event.preventDefault());
		exit.addEventListener('click', (event) => {
			event.preventDefault();
			void this.toggle(file);
		});
		this.scheduleCoverage(file.path);
	}

	private previewHost(view: MarkdownView): HTMLElement | null {
		return (
			view.containerEl.querySelector<HTMLElement>('.markdown-preview-view') ??
			view.contentEl.querySelector<HTMLElement>('.markdown-preview-view')
		);
	}

	private scheduleCoverage(path: string): void {
		const previous = this.coverageTimers.get(path);
		if (previous !== undefined) {
			window.clearTimeout(previous);
		}
		const timer = window.setTimeout(() => {
			this.coverageTimers.delete(path);
			void this.refreshCoverage(path);
		}, 60);
		this.coverageTimers.set(path, timer);
	}

	private async refreshCoverage(path: string): Promise<void> {
		if (!this.enabled.has(path)) {
			return;
		}
		const generation = (this.coverageGenerations.get(path) ?? 0) + 1;
		this.coverageGenerations.set(path, generation);
		const targets: {
			label: HTMLElement;
			words: HTMLElement[];
			counts: Map<string, number>;
		}[] = [];
		const allWords = new Set<string>();

		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== path) {
				continue;
			}
			const host = this.previewHost(view);
			const label = host?.querySelector(`.${BAR_CLASS} .glean-read-bar-label`);
			if (!(label instanceof HTMLElement) || !host) {
				continue;
			}
			const words = Array.from(
				host.querySelectorAll<HTMLElement>('[data-glean-word]'),
			);
			const counts = new Map<string, number>();
			for (const el of words) {
				const word = el.dataset.gleanWord;
				if (!word) {
					continue;
				}
				counts.set(word, (counts.get(word) ?? 0) + 1);
				allWords.add(word);
			}
			targets.push({ label, words, counts });
		}
		if (targets.length === 0) {
			return;
		}

		const lookups = new Map(
			await Promise.all(
				[...allWords].map(async (word) => [
					word,
					await this.plugin.lookupWord(word),
				] as const),
			),
		);
		if (
			this.coverageGenerations.get(path) !== generation ||
			!this.enabled.has(path)
		) {
			return;
		}

		for (const { label, words, counts } of targets) {
			if (!label.isConnected) {
				continue;
			}
			if (counts.size === 0) {
				label.setText('Glean 阅读 · 暂无可统计词');
				continue;
			}
			const metrics = readingMetrics(counts, lookups, (word) => this.statusOf(word));
			label.setText(
				`Glean 阅读 · 常用 3000 词覆盖 ${metrics.commonPercent}% · 本文生词 ${metrics.savedWords}`,
			);
			for (const el of words) {
				const word = el.dataset.gleanWord;
				if (!word) {
					continue;
				}
				el.toggleClass(
					'is-frequency-hint',
					shouldHintWord(
						lookups.get(word) ?? null,
						this.statusOf(word),
						this.plugin.settings.readingHintRank,
					),
				);
			}
		}
	}

	private refreshEnabledViews(): void {
		for (const path of this.enabled) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				this.rerender(file);
			}
		}
	}

	destroy(): void {
		this.popover.destroy();
		this.passagePanel.destroy();
		for (const timer of this.coverageTimers.values()) {
			window.clearTimeout(timer);
		}
		this.coverageTimers.clear();
		this.coverageGenerations.clear();
		this.enabled.clear();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			view.containerEl
				.querySelectorAll(`.${BAR_CLASS}, .view-actions .${ACTION_CLASS}`)
				.forEach((node) => node.remove());
			view.containerEl.removeClass(HOST_CLASS);
			view.previewMode?.rerender(true);
		}
	}
}
