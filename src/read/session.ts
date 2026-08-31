import { MarkdownView, Notice, TFile } from 'obsidian';
import { normalizeDictionaryKey } from '../dictionary';
import type { WordStatus } from '../lexicon/note';
import type EchoPlugin from '../main';
import { EchoWordPopover } from '../views/word-popup';
import { decorateReadableArticle, sentenceAround } from './decorate';

const ACTION_CLASS = 'echo-read-action';
const BAR_CLASS = 'echo-read-bar';
const HOST_CLASS = 'echo-read-host';

/**
 * Opt-in reading mode for ordinary Markdown notes.
 * Sections only wrap words; chrome and coverage live on the view once.
 */
export class ReadingMode {
	private enabled = new Set<string>();
	private popover = new EchoWordPopover();
	private lookupSequence = 0;
	private coverageTimers = new Map<string, number>();

	constructor(private readonly plugin: EchoPlugin) {}

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

	canEnable(file: TFile | null): file is TFile {
		return (
			!!file &&
			file.extension.toLowerCase() === 'md' &&
			!this.plugin.isWordNote(file)
		);
	}

	async toggle(file: TFile | null): Promise<void> {
		if (!this.canEnable(file)) {
			new Notice('当前笔记不能进入 Echo 阅读');
			return;
		}
		if (this.enabled.has(file.path)) {
			this.enabled.delete(file.path);
			this.popover.close();
		} else {
			this.enabled.add(file.path);
			await this.openPreview(file);
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
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			if (
				view.file &&
				this.enabled.has(view.file.path) &&
				view.getMode() !== 'preview'
			) {
				this.enabled.delete(view.file.path);
			}
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
		const button = view.addAction('book-open', on ? '退出 Echo 阅读' : 'Echo 阅读', () => {
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
			cls: 'echo-read-bar-label',
			text: 'Echo 阅读 · 统计中…',
		});
		const exit = bar.createEl('button', {
			cls: 'echo-btn echo-read-bar-exit',
			text: '退出',
		});
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
			this.refreshCoverage(path);
		}, 60);
		this.coverageTimers.set(path, timer);
	}

	private refreshCoverage(path: string): void {
		if (!this.enabled.has(path)) {
			return;
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== path) {
				continue;
			}
			const host = this.previewHost(view);
			const label = host?.querySelector(`.${BAR_CLASS} .echo-read-bar-label`);
			if (!(label instanceof HTMLElement) || !host) {
				continue;
			}
			const stats = this.coverageFrom(host);
			label.setText(
				stats.unique === 0
					? 'Echo 阅读 · 暂无可统计词'
					: `Echo 阅读 · 认识 ${stats.percent}% · ${stats.known}/${stats.unique}`,
			);
		}
	}

	private coverageFrom(host: HTMLElement): {
		unique: number;
		known: number;
		percent: number;
	} {
		const seen = new Set<string>();
		let known = 0;
		for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-echo-word]'))) {
			const word = el.dataset.echoWord;
			if (!word || seen.has(word)) {
				continue;
			}
			seen.add(word);
			const status = this.statusOf(word);
			if (status === 'known' || status === 'ignored') {
				known += 1;
			}
		}
		const unique = seen.size;
		return {
			unique,
			known,
			percent: unique === 0 ? 0 : Math.round((100 * known) / unique),
		};
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
		for (const timer of this.coverageTimers.values()) {
			window.clearTimeout(timer);
		}
		this.coverageTimers.clear();
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
