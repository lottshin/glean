import {
	Menu,
	Notice,
	normalizePath,
	Platform,
	Plugin,
	TFile,
	requestUrl,
	type WorkspaceLeaf,
} from 'obsidian';
import { bundledDictionary } from 'glean:dictionary-package';
import { DictionaryService, type DictionaryLookup } from './dictionary';
import { installBundledDictionary } from './dictionary/install';
import {
	createReceiverToken,
	notifyImportSuccess,
	YouTubeImportReceiver,
} from './import/receiver';
import type { LexiconCard } from './lexicon/catalog';
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
import { clearMediaChrome, registerMediaChrome } from './media/media-chrome';
import { MEDIA_EXTENSIONS } from './media/types';
import { LISTEN_VIEW_TYPE, ListenView, type ListenState } from './views/listen';
import { READ_ICON, ReadingMode } from './read/session';
import {
	TranslationError,
	listOpenAiModels,
	translateText,
	type TranslationRequest,
	type TranslationResponse,
} from './translate/provider';
import {
	LEXICON_VIEW_TYPE,
	LexiconView,
} from './views/lexicon';
import { REVIEW_VIEW_TYPE, ReviewView } from './views/review';
import type { ReviewCard } from './review/queue';
import type { ReviewState } from './review/schedule';
import { parseBilibiliSourcePath } from './bilibili/id';
import {
	COMMUNITY_USER_AGENT,
	forgetCommunityAudioCache,
	resolveAccentPhonetics,
	resolveCommunityAudio,
	type AccentPhonetics,
	type SpeakFetcher,
	type SpeakSource,
} from './speak/community';
import {
	guessAudioMime,
	playAudioBuffer,
	stopAllSpeech,
} from './speak/player';
import { speakWithTts, type SpeakAccent } from './speak/tts';
import {
	YOUDAO_TTS_URL,
	buildYoudaoTtsForm,
	parseYoudaoTtsResponse,
} from './speak/youdao';
import { parseYouTubeSourcePath } from './youtube/id';
import type { BilibiliSession } from './bilibili/session';

export default class GleanPlugin extends Plugin {
	settings!: GleanSettings;
	dictionaryReady = false;
	dictionaryError: string | null = null;
	dictionaryInstalling = false;
	readonly hasBundledDictionary = bundledDictionary !== null;
	private dictionary: DictionaryService | null = null;
	private dictionaryGeneration = 0;
	private bundledInstallAttempted = false;
	private lexicon!: LexiconStore;
	private lexiconRebuildTimer: number | null = null;
	private reading!: ReadingMode;
	private layoutNoticeShown = false;
	private youtubeReceiver: YouTubeImportReceiver | null = null;
	private lastYouTubeImport: {
		videoId: string;
		title: string;
		notePath: string;
		subtitlePath: string;
	} | null = null;
	private lastBilibiliImport: { title: string; notePath: string } | null = null;

	async onload() {
		await this.loadSettings();
		if (!this.settings.youtubeReceiverToken) {
			this.settings.youtubeReceiverToken = createReceiverToken();
			await this.saveSettings();
		}
		this.lexicon = new LexiconStore(this.app, () => this.settings.wordsFolder);
		this.lexicon.observe(this);
		this.reading = new ReadingMode(this);
		this.reading.observe();

		this.registerView(LISTEN_VIEW_TYPE, (leaf) => new ListenView(leaf, this));
		this.registerView(LEXICON_VIEW_TYPE, (leaf) => new LexiconView(leaf, this));
		this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewView(leaf, this));

		void this.reloadDictionary();
		void this.refreshYouTubeReceiver();

		// Ribbon stays a hub menu. Context-aware entry (YouTube → listen,
		// article → read) belongs on the note header wheat, not here.
		this.addRibbonIcon('wheat', 'Glean', (event) => {
			const file = this.app.workspace.getActiveFile();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle('生词库')
					.setIcon('library')
					.onClick(() => {
						void this.activateLexiconView();
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle('复习生词')
					.setIcon('graduation-cap')
					.onClick(() => {
						void this.activateReviewView();
					}),
			);
			menu.addSeparator();
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
					.setTitle('阅读当前笔记')
					.setIcon(READ_ICON)
					.setDisabled(!this.reading.canEnable(file))
					.onClick(() => {
						void this.reading.toggle(file);
					}),
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle('浏览器扩展…')
					.setIcon('puzzle')
					.onClick(() => this.openSettingTab()),
			);
			menu.showAtMouseEvent(event);
		});

		this.addCommand({
			id: 'open-lexicon',
			name: '打开生词库',
			callback: () => {
				void this.activateLexiconView();
			},
		});

		this.addCommand({
			id: 'review-words',
			name: '复习生词',
			callback: () => {
				void this.activateReviewView();
			},
		});

		this.addCommand({
			id: 'open-listen',
			name: '打开精听视图',
			callback: () => {
				void this.activateListenView();
			},
		});

		this.addCommand({
			id: 'open-last-youtube-import',
			name: '打开刚同步的 YouTube 视频',
			checkCallback: (checking) => {
				if (!this.lastYouTubeImport) {
					return false;
				}
				if (!checking) {
					void this.openYouTube(
						this.lastYouTubeImport.videoId,
						this.lastYouTubeImport.subtitlePath,
						this.lastYouTubeImport.title,
					);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'listen-current-youtube-note',
			name: '精听当前 YouTube 笔记',
			checkCallback: (checking) => {
				const session = this.youtubeSessionFromFile(
					this.app.workspace.getActiveFile(),
				);
				if (!session) {
					return false;
				}
				if (!checking) {
					void this.openYouTube(
						session.videoId,
						session.subtitlePath,
						session.title,
					);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'listen-current-bilibili-note',
			name: '精听当前 B 站笔记',
			checkCallback: (checking) => {
				const session = this.bilibiliSessionFromFile(
					this.app.workspace.getActiveFile(),
				);
				if (!session) {
					return false;
				}
				if (!checking) {
					void this.openBilibili(session);
				}
				return true;
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
					const youtube = this.getYouTubeSession(file);
					const bilibili = this.getBilibiliSession(file);
					if (youtube) {
						menu.addItem((item) => {
							item.setTitle('Glean: 精听')
								.setIcon('headphones')
								.onClick(() => {
									void this.openYouTube(
										youtube.videoId,
										youtube.subtitlePath,
										youtube.title,
									);
								});
						});
					} else if (bilibili) {
						menu.addItem((item) => {
							item.setTitle('Glean: 精听')
								.setIcon('headphones')
								.onClick(() => {
									void this.openBilibili(bilibili);
								});
						});
					} else {
						menu.addItem((item) => {
							item.setTitle('Glean: 阅读')
								.setIcon(READ_ICON)
								.onClick(() => {
									void this.reading.toggle(file);
								});
						});
					}
				}
			}),
		);

		this.registerObsidianProtocolHandler('glean', (parameters) => {
			void this.openGleanLink(parameters);
		});

		registerWordNoteChrome(this);
		registerMediaChrome(this);

		// Moving to another listening tab silences the one left behind. Leaving
		// for a note does not: that is a glance, not a switch of material.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (!leaf || !(leaf.view instanceof ListenView)) {
					return;
				}
				for (const other of this.app.workspace.getLeavesOfType(LISTEN_VIEW_TYPE)) {
					if (other !== leaf && other.view instanceof ListenView) {
						other.view.pausePlayback();
					}
				}
			}),
		);

		this.addSettingTab(new GleanSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			void this.checkLexiconLayout();
			void this.maybeHintBrowserExtensions();
		});
	}

	onunload() {
		clearMediaChrome(this);
		this.reading?.destroy();
		void this.youtubeReceiver?.stop();
		this.youtubeReceiver = null;
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

	/**
	 * Pronounce a lemma/surface. `accent` comes from the card's 美/英 buttons;
	 * omitting it falls back to the settings default.
	 */
	async speakWord(
		text: string,
		accent: SpeakAccent = 'en-US',
	): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		try {
			if (this.settings.speakSource === 'youdao') {
				const played = await this.speakYoudaoWord(trimmed, accent);
				if (played) {
					return;
				}
			} else if (this.settings.speakSource !== 'system') {
				const played = await this.speakCommunityWord(trimmed, accent);
				if (played) {
					return;
				}
			}
			await speakWithTts(trimmed, accent);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : '朗读失败');
		}
	}

	/** Best-effort US/UK IPA from Free Dictionary; null when offline/miss. */
	async lookupAccentPhonetics(word: string): Promise<AccentPhonetics | null> {
		const trimmed = word.trim();
		if (!trimmed) {
			return null;
		}
		try {
			const lookup = await resolveAccentPhonetics(
				trimmed,
				this.communityFetcher(),
			);
			return lookup.status === 'hit' ? lookup.phonetics : null;
		} catch {
			return null;
		}
	}

	private communityFetcher(): SpeakFetcher {
		return async (url) => {
			const response = await requestUrl({
				url,
				throw: false,
				headers: {
					'User-Agent': COMMUNITY_USER_AGENT,
				},
			});
			let json: unknown = null;
			try {
				json = response.json;
			} catch {
				json = null;
			}
			return { status: response.status, json };
		};
	}

	private async speakYoudaoWord(
		text: string,
		accent: SpeakAccent,
	): Promise<boolean> {
		const appKey = this.settings.youdaoAppKey.trim();
		const appSecret = this.settings.youdaoAppSecret.trim();
		if (!appKey || !appSecret) {
			new Notice('请先在设置里填写有道应用 ID 和密钥');
			return false;
		}
		const body = await buildYoudaoTtsForm(text, accent, { appKey, appSecret });
		const response = await requestUrl({
			url: YOUDAO_TTS_URL,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: body.toString(),
			throw: false,
		});
		if (response.status === 429 || response.status === 503) {
			new Notice('有道暂时限流，已改用系统朗读');
			return false;
		}
		const contentType =
			response.headers['content-type'] ??
			response.headers['Content-Type'] ??
			'';
		const parsed = parseYoudaoTtsResponse(
			contentType,
			response.text,
			response.arrayBuffer,
		);
		if (parsed.status !== 'ok') {
			new Notice(`${parsed.message}，已改用系统朗读`);
			return false;
		}
		await playAudioBuffer(parsed.data, 'audio/mpeg');
		return true;
	}

	private async speakCommunityWord(
		text: string,
		accent: SpeakAccent,
	): Promise<boolean> {
		// Free Dictionary's Google CDN audio is often dead; try Wiktionary next.
		const chain: SpeakSource[] =
			this.settings.speakSource === 'free-dictionary'
				? ['free-dictionary', 'wiktionary']
				: [this.settings.speakSource];

		let rateLimitedSource: string | null = null;
		for (const source of chain) {
			if (source === 'system') {
				continue;
			}
			const lookup = await resolveCommunityAudio(
				source,
				text,
				accent,
				this.communityFetcher(),
			);
			if (lookup.status === 'rate-limited') {
				rateLimitedSource = lookup.source;
				continue;
			}
			if (lookup.status !== 'hit') {
				continue;
			}
			const audio = await requestUrl({
				url: lookup.hit.url,
				throw: false,
				headers: {
					'User-Agent': COMMUNITY_USER_AGENT,
				},
			});
			if (audio.status === 429 || audio.status === 503) {
				rateLimitedSource = lookup.hit.source;
				continue;
			}
			if (audio.status < 200 || audio.status >= 300) {
				forgetCommunityAudioCache(source, text, accent);
				continue;
			}
			await playAudioBuffer(audio.arrayBuffer, guessAudioMime(lookup.hit.url));
			return true;
		}
		if (rateLimitedSource) {
			new Notice(`${rateLimitedSource} 暂时限流，已改用系统朗读`);
		}
		return false;
	}

	stopSpeaking(): void {
		stopAllSpeech();
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
			this.translationConfig(),
			text,
			this.translationTransport(),
		);
	}

	async listTranslationModels(): Promise<string[]> {
		return listOpenAiModels(this.translationConfig(), this.translationTransport());
	}

	async refreshYouTubeReceiver(): Promise<void> {
		if (!Platform.isDesktopApp || !this.settings.youtubeReceiverEnabled) {
			await this.youtubeReceiver?.stop();
			this.youtubeReceiver = null;
			return;
		}
		const options = {
			port: this.settings.youtubeReceiverPort,
			token: this.settings.youtubeReceiverToken,
			folder: this.settings.youtubeFolder,
			bilibiliFolder: this.settings.bilibiliFolder,
			onImported: (result: {
				videoId: string;
				title: string;
				notePath: string;
				subtitlePath: string;
			}) => {
				this.lastYouTubeImport = result;
				notifyImportSuccess(result.title, result.notePath);
			},
			onBilibiliImported: (result: { title: string; notePath: string }) => {
				this.lastBilibiliImport = {
					title: result.title,
					notePath: result.notePath,
				};
				notifyImportSuccess(result.title, result.notePath);
			},
		};
		try {
			if (this.youtubeReceiver) {
				await this.youtubeReceiver.restart(options);
			} else {
				this.youtubeReceiver = new YouTubeImportReceiver(this.app, options);
				await this.youtubeReceiver.start();
			}
		} catch (error) {
			this.youtubeReceiver = null;
			new Notice(
				error instanceof Error
					? `浏览器采集接收端启动失败：${error.message}`
					: '浏览器采集接收端启动失败',
			);
		}
	}

	isYouTubeReceiverRunning(): boolean {
		return this.youtubeReceiver?.running === true;
	}

	private translationConfig() {
		return {
			enabled: this.settings.translateEnabled,
			provider: this.settings.translateProvider,
			apiKey: this.settings.translateApiKey,
			endpoint: this.settings.translateEndpoint,
			model: this.settings.translateModel,
			targetLang: this.settings.translateTarget,
		};
	}

	private translationTransport() {
		return async (request: TranslationRequest): Promise<TranslationResponse> => {
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
		};
	}

	async removeWord(word: string): Promise<boolean> {
		return this.lexicon.remove(word);
	}

	listLexiconCards(): LexiconCard[] {
		return this.lexicon.list();
	}

	reviewCards(today: string): ReviewCard[] {
		return this.lexicon.reviewCards(today);
	}

	async readWordNote(path: string): Promise<string | null> {
		return this.lexicon.readNote(path);
	}

	async recordReview(
		card: ReviewCard,
		review: ReviewState,
		status?: WordStatus,
	): Promise<boolean> {
		return this.lexicon.recordReview(card, review, status);
	}

	async openWordNotePath(path: string): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return false;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
		return true;
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

	async openLexiconSource(sourcePath: string, originPath: string): Promise<boolean> {
		const youtubeId = parseYouTubeSourcePath(sourcePath);
		if (youtubeId) {
			const session = this.findYouTubeSession(youtubeId);
			if (!session) {
				new Notice(`找不到 YouTube 会话：${youtubeId}`);
				return false;
			}
			await this.openYouTube(
				session.videoId,
				session.subtitlePath,
				session.title,
			);
			return true;
		}
		const bvid = parseBilibiliSourcePath(sourcePath);
		if (bvid) {
			const session = this.findBilibiliSession(bvid);
			if (!session) {
				new Notice(`找不到 B 站会话：${bvid}`);
				return false;
			}
			await this.openBilibili(session);
			return true;
		}
		const exact = this.app.vault.getAbstractFileByPath(sourcePath);
		const file =
			exact instanceof TFile
				? exact
				: this.app.metadataCache.getFirstLinkpathDest(sourcePath, originPath);
		if (!(file instanceof TFile)) {
			new Notice(`找不到来源：${sourcePath}`);
			return false;
		}
		if (MEDIA_EXTENSIONS.has(file.extension.toLowerCase())) {
			await this.openVideo(file);
			return true;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
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

	async reloadDictionary(allowBundledInstall = true): Promise<void> {
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
			const dictionary = paths.external
				? await DictionaryService.open(paths.dictionary, paths.inflections)
				: DictionaryService.fromText(
						await this.app.vault.adapter.read(paths.dictionary),
						await this.app.vault.adapter.read(paths.inflections),
					);
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
				if (
					allowBundledInstall &&
					!this.bundledInstallAttempted &&
					!this.settings.dictionaryPath.trim() &&
					bundledDictionary
				) {
					this.bundledInstallAttempted = true;
					await this.installDictionary(true);
					return;
				}
				if (paths) {
					this.dictionaryError =
						`词典加载失败：${paths.directory}。请确认两个 TSV 文件完整且可读。`;
					if (
						previousError !== this.dictionaryError &&
						Boolean(this.settings.dictionaryPath.trim())
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

	async installDictionary(automatic = false): Promise<boolean> {
		if (!bundledDictionary || this.dictionaryInstalling) {
			return false;
		}
		const paths = this.getDictionaryPaths();
		if (!paths) {
			this.dictionaryError = '当前 vault 不支持安装本地词典。';
			return false;
		}
		this.dictionaryInstalling = true;
		this.dictionaryError = null;
		const notice = new Notice(
			automatic ? 'Glean 正在准备离线词典…' : '正在安装 Glean 离线词典…',
			0,
		);
		try {
			if (paths.external) {
				await installBundledDictionary(paths.directory, bundledDictionary);
			} else {
				await installBundledDictionary(
					{
						adapter: this.app.vault.adapter,
						directory: paths.directory,
					},
					bundledDictionary,
				);
			}
			await this.reloadDictionary(false);
			if (!this.dictionaryReady) {
				throw new Error(this.dictionaryError ?? '词典加载失败');
			}
			notice.setMessage('Glean 离线词典已安装');
			window.setTimeout(() => notice.hide(), 2500);
			return true;
		} catch (error) {
			this.dictionaryError =
				error instanceof Error ? error.message : '离线词典安装失败';
			notice.setMessage(this.dictionaryError);
			window.setTimeout(() => notice.hide(), 5000);
			return false;
		} finally {
			this.dictionaryInstalling = false;
		}
	}

	private getDictionaryPaths(): {
		dictionary: string;
		inflections: string;
		directory: string;
		external: boolean;
	} | null {
		const configured = this.settings.dictionaryPath.trim();
		const isExternalPath =
			configured.startsWith('/') || /^[A-Za-z]:[\\/]/.test(configured);
		if (!Platform.isDesktopApp && isExternalPath) {
			return null;
		}
		const relativeDirectory = normalizePath(
			configured || `${this.app.vault.configDir}/glean/dict`,
		);
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
		};
		const basePath =
			Platform.isDesktopApp && typeof adapter.getBasePath === 'function'
				? adapter.getBasePath()
				: null;
		const external = Platform.isDesktopApp && (isExternalPath || basePath !== null);
		const directory = isExternalPath
			? configured.replace(/[\\/]+$/, '')
			: basePath
				? `${basePath.replace(/[\\/]+$/, '')}/${relativeDirectory}`
				: relativeDirectory;
		const separator = external && directory.includes('\\') ? '\\' : '/';
		return {
			directory,
			external,
			dictionary: `${directory}${separator}glean-dict-v1.tsv`,
			inflections: `${directory}${separator}glean-inflect-v1.tsv`,
		};
	}

	async activateListenView(state?: ListenState): Promise<ListenView | null> {
		const resolved = state ?? this.listenStateFromContext();
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(LISTEN_VIEW_TYPE);
		const listenViewOf = (leaf: WorkspaceLeaf): ListenView | null =>
			leaf.view instanceof ListenView ? leaf.view : null;
		// Each piece of media gets its own tab, so jumping back from a word card
		// lands in the tab holding that video instead of evicting whatever the
		// user is currently studying. An untouched tab is fair game to fill.
		let leaf =
			(resolved
				? leaves.find((candidate) => listenViewOf(candidate)?.holdsMedia(resolved))
				: leaves[0]) ??
			leaves.find((candidate) => listenViewOf(candidate)?.isVacant()) ??
			null;
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
		}
		// Two sentences playing at once is never what was wanted.
		for (const other of leaves) {
			if (other !== leaf) {
				listenViewOf(other)?.pausePlayback();
			}
		}
		await leaf.setViewState({
			type: LISTEN_VIEW_TYPE,
			active: true,
			state: (resolved ?? {}) as Record<string, unknown>,
		});
		workspace.revealLeaf(leaf);
		workspace.setActiveLeaf(leaf, { focus: true });

		const view = leaf.view;
		if (!(view instanceof ListenView)) {
			return null;
		}
		if (resolved) {
			await view.openMedia(resolved);
		}
		return view;
	}

	/** Prefer the active session note, then the latest import, then local media. */
	private listenStateFromContext(): ListenState | undefined {
		const session = this.youtubeSessionFromFile(this.app.workspace.getActiveFile());
		if (session) {
			return {
				kind: 'youtube',
				videoId: session.videoId,
				title: session.title,
				subtitlePath: session.subtitlePath,
			};
		}
		const bilibili = this.bilibiliSessionFromFile(
			this.app.workspace.getActiveFile(),
		);
		if (bilibili) {
			return this.bilibiliListenState(bilibili);
		}
		if (this.lastYouTubeImport) {
			return {
				kind: 'youtube',
				videoId: this.lastYouTubeImport.videoId,
				title: this.lastYouTubeImport.title,
				subtitlePath: this.lastYouTubeImport.subtitlePath,
			};
		}
		if (this.lastBilibiliImport) {
			const state = this.bilibiliStateFromNotePath(
				this.lastBilibiliImport.notePath,
			);
			if (state) {
				return state;
			}
		}
		const file = this.app.workspace.getActiveFile();
		if (file && MEDIA_EXTENSIONS.has(file.extension.toLowerCase())) {
			return {
				videoPath: file.path,
				subtitlePath: null,
			};
		}
		return undefined;
	}

	async activateLexiconView(): Promise<LexiconView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(LEXICON_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab');
			await leaf.setViewState({
				type: LEXICON_VIEW_TYPE,
				active: true,
			});
		}
		// setActiveLeaf alone leaves a collapsed sidebar collapsed, so the view
		// would exist without ever becoming visible.
		if (leaf.getRoot() === workspace.rightSplit) {
			workspace.rightSplit.expand();
		}
		workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (!(view instanceof LexiconView)) {
			return null;
		}
		view.refresh();
		return view;
	}

	/**
	 * Reviews open as a main-area tab, not a sidebar: typing practice needs the
	 * width, and the sidebar is already the library's home.
	 */
	async activateReviewView(): Promise<ReviewView | null> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0] ?? workspace.getLeaf('tab');
		await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
		workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (!(view instanceof ReviewView)) {
			return null;
		}
		view.refresh();
		return view;
	}

	async openVideo(
		file: TFile,
		seekTo?: number,
		subtitlePath: string | null = null,
	): Promise<void> {
		const view = await this.activateListenView({
			videoPath: file.path,
			subtitlePath,
			seekTo,
		});
		if (!view) {
			new Notice('无法打开精听视图');
			return;
		}
		this.app.workspace.requestSaveLayout();
	}

	async openBilibili(session: BilibiliSession, seekTo?: number): Promise<void> {
		const view = await this.activateListenView({
			...this.bilibiliListenState(session),
			seekTo,
		});
		if (!view) {
			new Notice('无法打开 B 站精听视图');
			return;
		}
		this.app.workspace.requestSaveLayout();
	}

	async openYouTube(
		videoId: string,
		subtitlePath: string,
		title: string,
		seekTo?: number,
	): Promise<void> {
		const view = await this.activateListenView({
			kind: 'youtube',
			videoId,
			title,
			subtitlePath,
			seekTo,
		});
		if (!view) {
			new Notice('无法打开 YouTube 精听视图');
			return;
		}
		this.app.workspace.requestSaveLayout();
	}

	getYouTubeSession(file: TFile | null): {
		videoId: string;
		title: string;
		subtitlePath: string;
	} | null {
		return this.youtubeSessionFromFile(file);
	}

	getBilibiliSession(file: TFile | null): BilibiliSession | null {
		return this.bilibiliSessionFromFile(file);
	}

	private youtubeSessionFromFile(file: TFile | null): {
		videoId: string;
		title: string;
		subtitlePath: string;
	} | null {
		if (!file) {
			return null;
		}
		const rawFrontmatter: unknown =
			this.app.metadataCache.getFileCache(file)?.frontmatter;
		const frontmatter =
			rawFrontmatter &&
			typeof rawFrontmatter === 'object' &&
			!Array.isArray(rawFrontmatter)
				? (rawFrontmatter as Record<string, unknown>)
				: undefined;
		const videoId = frontmatter?.['glean-video-id'];
		const subtitlePath = frontmatter?.subtitle;
		if (
			frontmatter?.['glean-kind'] !== 'youtube' ||
			typeof videoId !== 'string' ||
			typeof subtitlePath !== 'string'
		) {
			return null;
		}
		return {
			videoId,
			subtitlePath,
			title:
				typeof frontmatter.title === 'string'
					? frontmatter.title
					: file.basename,
		};
	}

	private bilibiliSessionFromFile(file: TFile | null): BilibiliSession | null {
		if (!file) {
			return null;
		}
		const rawFrontmatter: unknown =
			this.app.metadataCache.getFileCache(file)?.frontmatter;
		const frontmatter =
			rawFrontmatter &&
			typeof rawFrontmatter === 'object' &&
			!Array.isArray(rawFrontmatter)
				? (rawFrontmatter as Record<string, unknown>)
				: undefined;
		const bvid = frontmatter?.['glean-video-id'];
		const subtitlePath = frontmatter?.subtitle;
		if (
			frontmatter?.['glean-kind'] !== 'bilibili' ||
			typeof bvid !== 'string' ||
			typeof subtitlePath !== 'string'
		) {
			return null;
		}
		// `audio` is what pre-streaming imports wrote; treat it as a local copy so
		// notes captured before this change keep playing.
		const localPath =
			typeof frontmatter.media === 'string'
				? frontmatter.media
				: typeof frontmatter.audio === 'string'
					? frontmatter.audio
					: null;
		const mediaUrl =
			typeof frontmatter['media-url'] === 'string'
				? frontmatter['media-url']
				: '';
		if (!mediaUrl && !localPath) {
			return null;
		}
		return {
			bvid,
			page: typeof frontmatter['glean-page'] === 'number'
				? frontmatter['glean-page']
				: 1,
			subtitlePath,
			mediaUrl,
			mediaSize:
				typeof frontmatter['media-size'] === 'number'
					? frontmatter['media-size']
					: 0,
			mediaExpiresAt:
				typeof frontmatter['media-expires'] === 'number'
					? frontmatter['media-expires']
					: null,
			localPath,
			notePath: file.path,
			title:
				typeof frontmatter.title === 'string'
					? frontmatter.title
					: file.basename,
		};
	}

	/** A saved local copy wins over the signed link, which expires. */
	private bilibiliListenState(session: BilibiliSession): ListenState {
		if (session.localPath) {
			const local = this.app.vault.getAbstractFileByPath(session.localPath);
			if (local instanceof TFile) {
				return {
					kind: 'local',
					videoPath: local.path,
					subtitlePath: session.subtitlePath,
					title: session.title,
				};
			}
		}
		return {
			kind: 'bilibili',
			bvid: session.bvid,
			page: session.page,
			title: session.title,
			mediaUrl: session.mediaUrl,
			mediaSize: session.mediaSize,
			mediaExpiresAt: session.mediaExpiresAt,
			notePath: session.notePath,
			subtitlePath: session.subtitlePath,
		};
	}

	/** Used when restoring a layout, where the saved link may already be dead. */
	bilibiliStateFromNotePath(notePath: string): ListenState | null {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) {
			return null;
		}
		const session = this.bilibiliSessionFromFile(note);
		return session ? this.bilibiliListenState(session) : null;
	}

	private findYouTubeSession(videoId: string): {
		videoId: string;
		title: string;
		subtitlePath: string;
	} | null {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const session = this.youtubeSessionFromFile(file);
			if (session?.videoId === videoId) {
				return session;
			}
		}
		return null;
	}

	private findBilibiliSession(bvid: string): BilibiliSession | null {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const session = this.bilibiliSessionFromFile(file);
			if (session?.bvid === bvid) {
				return session;
			}
		}
		return null;
	}

	private async openGleanLink(parameters: Record<string, string>): Promise<void> {
		const target = parseGleanProtocol(parameters);
		if (!target) {
			new Notice('Glean 回跳链接无效');
			return;
		}
		if (target.kind === 'youtube' && target.videoId) {
			const session = this.findYouTubeSession(target.videoId);
			if (!session) {
				new Notice(`找不到 YouTube 会话：${target.videoId}`);
				return;
			}
			await this.openYouTube(
				session.videoId,
				session.subtitlePath,
				session.title,
				target.time,
			);
			return;
		}
		if (target.kind === 'bilibili' && target.bvid) {
			const session = this.findBilibiliSession(target.bvid);
			if (!session) {
				new Notice(`找不到 B 站会话：${target.bvid}`);
				return;
			}
			await this.openBilibili(session, target.time);
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

	/** Settings UI is not in the public Plugin API; this is the documented internal hook. */
	openSettingTab(): void {
		const setting = (
			this.app as unknown as {
				setting: { open: () => void; openTabById: (id: string) => void };
			}
		).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private async maybeHintBrowserExtensions(): Promise<void> {
		if (this.settings.browserExtensionsHintShown) {
			return;
		}
		this.settings.browserExtensionsHintShown = true;
		await this.saveSettings();
		new Notice(
			'网页文章用官方 Obsidian Web Clipper；YouTube / B 站视频用 Glean Capture。说明在 设置 → Glean。',
			10_000,
		);
	}
}
