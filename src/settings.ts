import { App, PluginSettingTab, Setting } from 'obsidian';
import type EchoPlugin from './main';

export interface EchoSettings {
	wordsFolder: string;
	defaultRate: number;
}

export const DEFAULT_SETTINGS: EchoSettings = {
	wordsFolder: 'Echo/Words',
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
