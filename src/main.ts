import { isAbsolute, join } from 'path';
import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian';
import { DictionaryService, type DictionaryLookup } from './dictionary';
import { DEFAULT_SETTINGS, EchoSettingTab, type EchoSettings } from './settings';
import { MEDIA_EXTENSIONS } from './media/types';
import { LISTEN_VIEW_TYPE, ListenView, type ListenState } from './views/listen';

export default class EchoPlugin extends Plugin {
	settings!: EchoSettings;
	dictionaryReady = false;
	private dictionary: DictionaryService | null = null;
	private dictionaryGeneration = 0;

	async onload() {
		await this.loadSettings();

		this.registerView(LISTEN_VIEW_TYPE, (leaf) => new ListenView(leaf, this));

		void this.reloadDictionary();

		this.addRibbonIcon('headphones', 'Echo 精听', () => {
			void this.activateListenView();
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

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || !MEDIA_EXTENSIONS.has(file.extension.toLowerCase())) {
					return;
				}
				menu.addItem((item) => {
					item.setTitle('Echo: 精听')
						.setIcon('headphones')
						.onClick(() => {
							void this.openVideo(file);
						});
				});
			}),
		);

		this.addSettingTab(new EchoSettingTab(this.app, this));
	}

	onunload() {
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

	async reloadDictionary(): Promise<void> {
		const generation = ++this.dictionaryGeneration;
		const previous = this.dictionary;
		this.dictionary = null;
		this.dictionaryReady = false;
		if (previous) {
			await previous.close();
		}

		try {
			const paths = this.getDictionaryPaths();
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
			: join(vaultPath, this.app.vault.configDir, 'echo', 'dict');
		return {
			dictionary: join(directory, 'echo-dict-v1.tsv'),
			inflections: join(directory, 'echo-inflect-v1.tsv'),
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

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<EchoSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
