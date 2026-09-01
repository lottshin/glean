import { existsSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { FileSystemAdapter, Menu, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { DictionaryService, type DictionaryLookup } from './dictionary';
import { LexiconMigrationModal } from './lexicon/migration-modal';
import { registerWordNoteChrome } from './lexicon/note-chrome';
import type { WordStatus } from './lexicon/note';
import { parseGleanProtocol } from './lexicon/protocol';
import {
	LexiconStore,
	type SaveWordInput,
	type SaveWordResult,
} from './lexicon/store';
import { DEFAULT_SETTINGS, GleanSettingTab, type GleanSettings } from './settings';
import { MEDIA_EXTENSIONS } from './media/types';
import { LISTEN_VIEW_TYPE, ListenView, type ListenState } from './views/listen';
import { READ_ICON, ReadingMode } from './read/session';
import { TranslationError, translateText } from './translate/provider';

export default class GleanPlugin extends Plugin {
	settings!: GleanSettings;
	dictionaryReady = false;
	dictionaryError: string | null = null;
	private dictionary: DictionaryService | null = null;
	private dictionaryGeneration = 0;
	private lexicon!: LexiconStore;
	private lexiconRebuildTimer: number | null = null;
	private reading!: ReadingMode;
	private layoutNoticeShown = false;

	async onload() {
		await this.loadSettings();
		this.lexicon = new LexiconStore(this.app, () => this.settings.wordsFolder);
		this.lexicon.observe(this);
		this.reading = new ReadingMode(this);
		this.reading.observe();

		this.registerView(LISTEN_VIEW_TYPE, (leaf) => new ListenView(leaf, this));

		void this.reloadDictionary();

		// One plugin, one ribbon slot. Listening and reading are co-equal, so
		// the icon opens a menu instead of privileging either one.
		this.addRibbonIcon('wheat', 'Glean', (event) => {
			const file = this.app.workspace.getActiveFile();
			const reading = this.reading.canEnable(file) && this.reading.isEnabled(file.path);
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle('精听')
					.setIcon('headphones')
					.onClick(() => {
						void this.activateListenView();
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle(reading ? '退出阅读' : '阅读当前笔记')
					.setIcon(READ_ICON)
					.setDisabled(!this.reading.canEnable(file))
					.onClick(() => {
						void this.reading.toggle(file);
					}),
			);
			menu.showAtMouseEvent(event);
		});

		this.addCommand({
			id: 'open-listen',
			name: '打开精听视图',
			callback: () => {
				void this.activateListenView();
			},
		});

		this.addCommand({
			id: 'listen-current-file',
			name: '精听当前文件',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !MEDIA_EXTENSIONS.has(file.extension.toLowerCase())) {
					return false;
				}
				if (!checking) {
					void this.openVideo(file);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'tidy-words',
			name: '整理生词目录',
			callback: async () => {
				const plan = await this.lexicon.planLayoutMigration();
				if (plan.moves.length === 0 && plan.conflicts.length === 0) {
					new Notice('生词目录已经整理完毕');
					return;
				}
				new LexiconMigrationModal(this.app, plan, async () => {
					const reportPath = await this.lexicon.executeLayoutMigration(plan);
					this.settings.lexiconLayoutVersion = 2;
					await this.saveSettings();
					new Notice(`生词目录整理完成，报告：${reportPath}`);
				}).open();
			},
		});

		this.addCommand({
			id: 'read-current-note',
			name: '阅读当前笔记',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.reading.canEnable(file)) {
					return false;
				}
				if (!checking) {
					void this.reading.toggle(file);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'explain-selection',
			name: '解析选中句子或段落',
			checkCallback: (checking) => {
				if (!this.reading.canExplainSelection()) {
					return false;
				}
				if (!checking) {
					this.reading.explainSelection();
				}
				return true;
			},
		});

		this.addCommand({
			id: 'remove-word',
			name: '移出生词',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.lexicon.isWordNote(file)) {
					return false;
				}
				if (!checking) {
					void this.removeWordFile(file);
				}
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) {
					return;
				}
				if (MEDIA_EXTENSIONS.has(file.extension.toLowerCase())) {
					menu.addItem((item) => {
						item.setTitle('Glean: 精听')
							.setIcon('headphones')
							.onClick(() => {
								void this.openVideo(file);
							});
					});
				}
				if (this.lexicon.isWordNote(file)) {
					menu.addItem((item) => {
						item.setTitle('Glean: 移出生词')
							.setIcon('trash')
							.onClick(() => {
								void this.removeWordFile(file);
							});
					});
				} else if (file.extension.toLowerCase() === 'md') {
					menu.addItem((item) => {
						item.setTitle('Glean: 阅读')
							.setIcon(READ_ICON)
							.onClick(() => {
								void this.reading.toggle(file);
							});
					});
				}
			}),
		);

		this.registerObsidianProtocolHandler('glean', (parameters) => {
			void this.openGleanLink(parameters);
		});

		registerWordNoteChrome(this);

		this.addSettingTab(new GleanSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			void this.checkLexiconLayout();
		});
	}

	onunload() {
		this.reading?.destroy();
		if (this.lexiconRebuildTimer !== null) {
			window.clearTimeout(this.lexiconRebuildTimer);
			this.lexiconRebuildTimer = null;
		}
		this.dictionaryGeneration += 1;
		const dictionary = this.dictionary;
		this.dictionary = null;
		this.dictionaryReady = false;
		if (dictionary) {
			void dictionary.close();
		}
	}

	async lookupWord(word: string): Promise<DictionaryLookup | null> {
		return this.dictionary?.lookup(word) ?? null;
	}

	refreshReadingViews(): void {
		this.reading.refresh();
	}

	async saveWord(input: SaveWordInput): Promise<SaveWordResult> {
		return this.lexicon.save(input);
	}

	/**
	 * Only reached from an explicit user action, and only when translation is
	 * enabled in settings. Nothing leaves the vault otherwise.
	 */
	async translatePassage(text: string): Promise<string> {
		return translateText(
			{
				enabled: this.settings.translateEnabled,
				provider: this.settings.translateProvider,
				apiKey: this.settings.translateApiKey,
				endpoint: this.settings.translateEndpoint,
				model: this.settings.translateModel,
				targetLang: this.settings.translateTarget,
			},
			text,
			async (request) => {
				try {
					const response = await requestUrl({
						url: request.url,
						method: request.method,
						headers: request.headers,
						body: request.body,
						throw: false,
					});
					return { status: response.status, text: response.text };
				} catch {
					throw new TranslationError(`无法连接翻译服务：${request.url}`);
				}
			},
		);
	}

	async removeWord(word: string): Promise<boolean> {
		return this.lexicon.remove(word);
	}

	async setWordStatus(word: string, status: WordStatus): Promise<boolean> {
		return this.lexicon.setStatus(word, status);
	}

	async removeWordFile(file: TFile): Promise<boolean> {
		try {
			const removed = await this.lexicon.removeFile(file);
			if (!removed) {
				new Notice('这不是 Glean 生词笔记');
				return false;
			}
			new Notice(`已将 ${file.basename} 移到废纸篓`);
			return true;
		} catch (error) {
			new Notice(error instanceof Error ? error.message : '移出生词失败');
			return false;
		}
	}

	async openWordNote(word: string): Promise<boolean> {
		const card = this.lexicon.find(word);
		if (!card) {
			return false;
		}
		const file = this.app.vault.getAbstractFileByPath(card.path);
		if (!(file instanceof TFile)) {
			return false;
		}
		await this.app.workspace.getLeaf(false).openFile(file);
		return true;
	}

	findLexiconCard(word: string) {
		return this.lexicon.find(word);
	}

	isWordNote(file: TFile): boolean {
		return this.lexicon.isWordNote(file);
	}

	scheduleLexiconRebuild(): void {
		this.layoutNoticeShown = false;
		if (this.lexiconRebuildTimer !== null) {
			window.clearTimeout(this.lexiconRebuildTimer);
		}
		this.lexiconRebuildTimer = window.setTimeout(() => {
			this.lexiconRebuildTimer = null;
			this.lexicon.rebuild();
		}, 300);
	}

	async checkLexiconLayout(): Promise<void> {
		if (this.settings.lexiconLayoutVersion >= 2 || this.layoutNoticeShown) {
			return;
		}
		const plan = await this.lexicon.planLayoutMigration();
		if (plan.moves.length === 0 && plan.conflicts.length === 0) {
			return;
		}
		this.layoutNoticeShown = true;
		new Notice('发现旧版生词目录，请运行“Glean: 整理生词目录”完成整理。');
	}

	async reloadDictionary(): Promise<void> {
		const generation = ++this.dictionaryGeneration;
		const previousError = this.dictionaryError;
		const previous = this.dictionary;
		this.dictionary = null;
		this.dictionaryReady = false;
		this.dictionaryError = null;
		if (previous) {
			await previous.close();
		}

		const paths = this.getDictionaryPaths();
		try {
			if (!paths) {
				return;
			}
			const dictionary = await DictionaryService.open(paths.dictionary, paths.inflections);
			if (generation !== this.dictionaryGeneration) {
				await dictionary.close();
				return;
			}
			this.dictionary = dictionary;
			this.dictionaryReady = true;
		} catch {
			if (generation === this.dictionaryGeneration) {
				this.dictionary = null;
				this.dictionaryReady = false;
				if (paths) {
					const directory = dirname(paths.dictionary);
					this.dictionaryError =
						`词典加载失败：${directory}。请确认两个 TSV 文件完整且可读。`;
					if (
						previousError !== this.dictionaryError &&
						(Boolean(this.settings.dictionaryPath.trim()) ||
							existsSync(directory))
					) {
						new Notice(this.dictionaryError);
					}
				}
			}
		} finally {
			if (generation === this.dictionaryGeneration) {
				this.refreshReadingViews();
			}
		}
	}

	private getDictionaryPaths(): { dictionary: string; inflections: string } | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return null;
		}
		const vaultPath = adapter.getBasePath();
		const configured = this.settings.dictionaryPath.trim();
		const directory = configured
			? isAbsolute(configured)
				? configured
				: join(vaultPath, configured)
			: join(vaultPath, this.app.vault.configDir, 'glean', 'dict');
		return {
			dictionary: join(directory, 'glean-dict-v1.tsv'),
			inflections: join(directory, 'glean-inflect-v1.tsv'),
		};
	}

	async activateListenView(state?: ListenState): Promise<ListenView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(LISTEN_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
		}
		await leaf.setViewState({
			type: LISTEN_VIEW_TYPE,
			active: true,
			state: (state ?? {}) as Record<string, unknown>,
		});
		workspace.setActiveLeaf(leaf, { focus: true });

		const view = leaf.view;
		if (!(view instanceof ListenView)) {
			return null;
		}
		if (state) {
			await view.openMedia(state);
		}
		return view;
	}

	async openVideo(file: TFile, seekTo?: number): Promise<void> {
		const view = await this.activateListenView({
			videoPath: file.path,
			subtitlePath: null,
			seekTo,
		});
		if (!view) {
			new Notice('无法打开精听视图');
			return;
		}
		this.app.workspace.requestSaveLayout();
	}

	private async openGleanLink(parameters: Record<string, string>): Promise<void> {
		const target = parseGleanProtocol(parameters);
		if (!target) {
			new Notice('Glean 回跳链接无效');
			return;
		}
		const file = this.resolveGleanSource(target.sourcePath);
		if (!file) {
			const oldName = target.sourcePath.split('/').at(-1);
			const sameName = oldName
				? this.app.vault
						.getFiles()
						.filter(
							(candidate) =>
								candidate.name === oldName &&
								MEDIA_EXTENSIONS.has(candidate.extension.toLowerCase()),
						)
				: [];
			new Notice(
				sameName.length > 1
					? `找到多个同名媒体，请手动打开：${oldName}`
					: `找不到来源媒体：${target.sourcePath}`,
			);
			return;
		}
		await this.openVideo(file, target.time);
	}

	private resolveGleanSource(sourcePath: string): TFile | null {
		const isMedia = (file: TFile | null): file is TFile =>
			file instanceof TFile && MEDIA_EXTENSIONS.has(file.extension.toLowerCase());
		const exact = this.app.vault.getAbstractFileByPath(sourcePath);
		const exactFile = exact instanceof TFile ? exact : null;
		if (isMedia(exactFile)) {
			return exactFile;
		}

		const active = this.app.workspace.getActiveFile();
		const origin = active?.path ?? '';
		const resolved = this.app.metadataCache.getFirstLinkpathDest(sourcePath, origin);
		if (isMedia(resolved)) {
			return resolved;
		}

		// Obsidian updates the readable wikilink when media is renamed, but it
		// cannot rewrite the custom protocol URL. Recover from links on the
		// active Glean card only when the original folder identifies one source.
		const activeIsGlean =
			active &&
			this.app.metadataCache.getFileCache(active)?.frontmatter?.glean === true;
		const links = activeIsGlean
			? (this.app.metadataCache.getFileCache(active)?.links ?? [])
			: [];
		const candidates = Array.from(
			new Set(
				links
					.map((link) =>
						this.app.metadataCache.getFirstLinkpathDest(link.link, origin),
					)
					.filter(isMedia),
			),
		);
		const oldFolder = sourcePath.includes('/')
			? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
			: '';
		const sameFolder = candidates.filter(
			(candidate) => candidate.parent?.path === oldFolder,
		);
		if (sameFolder.length === 1) {
			return sameFolder[0] ?? null;
		}

		const oldName = sourcePath.split('/').at(-1);
		const basenameMatches = this.app.vault
			.getFiles()
			.filter((candidate) => candidate.name === oldName && isMedia(candidate));
		return basenameMatches.length === 1 ? (basenameMatches[0] ?? null) : null;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<GleanSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
