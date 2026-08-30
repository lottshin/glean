import { Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, EchoSettingTab, type EchoSettings } from './settings';
import { MEDIA_EXTENSIONS } from './media/types';
import { LISTEN_VIEW_TYPE, ListenView, type ListenState } from './views/listen';

export default class EchoPlugin extends Plugin {
	settings!: EchoSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(LISTEN_VIEW_TYPE, (leaf) => new ListenView(leaf, this));

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

	onunload() {}

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
