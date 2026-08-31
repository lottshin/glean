import {
	App,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
} from 'obsidian';
import type EchoPlugin from './main';

export interface EchoSettings {
	wordsFolder: string;
	lexiconLayoutVersion: number;
	dictionaryPath: string;
	defaultRate: number;
}

export const DEFAULT_SETTINGS: EchoSettings = {
	wordsFolder: 'Echo/Words',
	lexiconLayoutVersion: 1,
	dictionaryPath: '',
	defaultRate: 1,
};

export class EchoSettingTab extends PluginSettingTab {
	plugin: EchoPlugin;

	constructor(app: App, plugin: EchoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: '生词目录',
				desc: '生词笔记存放的 vault 相对路径。修改后不会搬运旧卡片；需要搬运时运行“Echo: 整理生词目录”。',
				control: {
					type: 'text',
					key: 'wordsFolder',
					defaultValue: DEFAULT_SETTINGS.wordsFolder,
					placeholder: DEFAULT_SETTINGS.wordsFolder,
				},
			},
			{
				name: '离线词典目录',
				desc: '配置 Echo 离线词典 TSV 文件所在目录。',
				aliases: ['ECDICT', 'TSV'],
				render: (setting) => {
					setting
						.setDesc(this.dictionaryDescription())
						.addText((text) =>
							text
								.setPlaceholder('留空使用默认目录')
								.setValue(this.plugin.settings.dictionaryPath)
								.onChange(async (value) => {
									this.plugin.settings.dictionaryPath = value.trim();
									await this.plugin.saveSettings();
									await this.plugin.reloadDictionary();
									setting.setDesc(this.dictionaryDescription());
								}),
						);
				},
			},
			{
				name: '默认倍速',
				desc: '打开精听视图时的播放速率。',
				control: {
					type: 'dropdown',
					key: 'defaultRate',
					defaultValue: String(DEFAULT_SETTINGS.defaultRate),
					options: {
						'0.75': '0.75×',
						'1': '1×',
						'1.25': '1.25×',
						'1.5': '1.5×',
					},
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === 'defaultRate') {
			return String(this.plugin.settings.defaultRate);
		}
		return this.plugin.settings[key as keyof EchoSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'wordsFolder') {
			const next =
				(typeof value === 'string' ? value.trim() : '') ||
				DEFAULT_SETTINGS.wordsFolder;
			if (next !== this.plugin.settings.wordsFolder) {
				this.plugin.settings.lexiconLayoutVersion = 1;
			}
			this.plugin.settings.wordsFolder = next;
			await this.plugin.saveSettings();
			this.plugin.scheduleLexiconRebuild();
			await this.plugin.checkLexiconLayout();
			return;
		}
		if (key === 'dictionaryPath') {
			this.plugin.settings.dictionaryPath =
				typeof value === 'string' ? value.trim() : '';
			await this.plugin.saveSettings();
			await this.plugin.reloadDictionary();
			return;
		}
		if (key === 'defaultRate') {
			const rate = Number(value);
			if ([0.75, 1, 1.25, 1.5].includes(rate)) {
				this.plugin.settings.defaultRate = rate;
				await this.plugin.saveSettings();
			}
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('生词目录')
			.setDesc(
				'生词笔记存放的 vault 相对路径。修改后不会搬运旧卡片；需要搬运时运行“Echo: 整理生词目录”。',
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.wordsFolder)
					.setValue(this.plugin.settings.wordsFolder)
					.onChange(async (value) => {
						const next = value.trim() || DEFAULT_SETTINGS.wordsFolder;
						if (next !== this.plugin.settings.wordsFolder) {
							this.plugin.settings.lexiconLayoutVersion = 1;
						}
						this.plugin.settings.wordsFolder = next;
						await this.plugin.saveSettings();
						this.plugin.scheduleLexiconRebuild();
						await this.plugin.checkLexiconLayout();
					}),
			);

		const dictionarySetting = new Setting(containerEl)
			.setName('离线词典目录')
			.setDesc(this.dictionaryDescription())
			.addText((text) =>
				text
					.setPlaceholder('留空使用默认目录')
					.setValue(this.plugin.settings.dictionaryPath)
					.onChange(async (value) => {
						this.plugin.settings.dictionaryPath = value.trim();
						await this.plugin.saveSettings();
						await this.plugin.reloadDictionary();
						dictionarySetting.setDesc(this.dictionaryDescription());
					}),
			);

		new Setting(containerEl)
			.setName('默认倍速')
			.setDesc('打开精听视图时的播放速率。')
			.addDropdown((dropdown) => {
				for (const rate of [0.75, 1, 1.25, 1.5]) {
					dropdown.addOption(String(rate), `${rate}×`);
				}
				dropdown.setValue(String(this.plugin.settings.defaultRate));
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultRate = Number(value);
					await this.plugin.saveSettings();
				});
			});
	}

	private dictionaryDescription(): string {
		return (
			this.plugin.dictionaryError ??
			(this.plugin.dictionaryReady
				? '已加载 Echo 离线词典。留空使用 vault 配置目录下的 echo/dict。'
				: '未找到词典。目录中需要 echo-dict-v1.tsv 和 echo-inflect-v1.tsv。')
		);
	}
}
