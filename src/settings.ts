import { App, PluginSettingTab, Setting } from 'obsidian';
import type EchoPlugin from './main';

export interface EchoSettings {
	wordsFolder: string;
	dictionaryPath: string;
	defaultRate: number;
}

export const DEFAULT_SETTINGS: EchoSettings = {
	wordsFolder: 'Echo/Words',
	dictionaryPath: '',
	defaultRate: 1,
};

export class EchoSettingTab extends PluginSettingTab {
	plugin: EchoPlugin;

	constructor(app: App, plugin: EchoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('生词目录')
			.setDesc('生词笔记存放的 vault 相对路径。v1 暂不写入，先占位。')
			.addText((text) =>
				text
					.setPlaceholder('Echo/words')
					.setValue(this.plugin.settings.wordsFolder)
					.onChange(async (value) => {
						this.plugin.settings.wordsFolder = value.trim() || DEFAULT_SETTINGS.wordsFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('离线词典目录')
			.setDesc(
				this.plugin.dictionaryReady
					? '已加载 Echo 离线词典。留空使用 vault 配置目录下的 .obsidian/echo/dict。'
					: '未找到词典。目录中需要 echo-dict-v1.tsv 和 echo-inflect-v1.tsv。',
			)
			.addText((text) =>
				text
					.setPlaceholder('留空使用默认目录')
					.setValue(this.plugin.settings.dictionaryPath)
					.onChange(async (value) => {
						this.plugin.settings.dictionaryPath = value.trim();
						await this.plugin.saveSettings();
						await this.plugin.reloadDictionary();
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
}
