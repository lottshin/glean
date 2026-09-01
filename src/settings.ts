import {
	App,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	type SettingDefinitionItem,
} from 'obsidian';
import type GleanPlugin from './main';
import {
	DEFAULT_READING_HINT_RANK,
	type ReadingHintRank,
} from './read/metrics';
import {
	DEFAULT_OPENAI_ENDPOINT,
	type TranslationProvider,
} from './translate/provider';

export interface GleanSettings {
	wordsFolder: string;
	lexiconLayoutVersion: number;
	dictionaryPath: string;
	defaultRate: number;
	readingHintRank: ReadingHintRank;
	translateEnabled: boolean;
	translateProvider: TranslationProvider;
	translateApiKey: string;
	translateEndpoint: string;
	translateModel: string;
	translateTarget: string;
}

export const DEFAULT_SETTINGS: GleanSettings = {
	wordsFolder: 'Glean/Words',
	lexiconLayoutVersion: 1,
	dictionaryPath: '',
	defaultRate: 1,
	readingHintRank: DEFAULT_READING_HINT_RANK,
	translateEnabled: false,
	translateProvider: 'openai',
	translateApiKey: '',
	translateEndpoint: '',
	translateModel: 'gpt-4o-mini',
	translateTarget: '简体中文',
};

export class GleanSettingTab extends PluginSettingTab {
	plugin: GleanPlugin;

	constructor(app: App, plugin: GleanPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: '生词目录',
				desc: '生词笔记存放的 vault 相对路径。修改后不会搬运旧卡片；需要搬运时运行“Glean: 整理生词目录”。',
				control: {
					type: 'text',
					key: 'wordsFolder',
					defaultValue: DEFAULT_SETTINGS.wordsFolder,
					placeholder: DEFAULT_SETTINGS.wordsFolder,
				},
			},
			{
				name: '离线词典目录',
				desc: '配置 Glean 离线词典 TSV 文件所在目录。',
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
			{
				name: '阅读词汇提示',
				desc: '按词频给较难词加轻量虚线，只改变阅读界面，不会自动加入生词库。',
				control: {
					type: 'dropdown',
					key: 'readingHintRank',
					defaultValue: String(DEFAULT_SETTINGS.readingHintRank),
					options: {
						'3000': '较多（常用 3000 词以外）',
						'5000': '适中（常用 5000 词以外）',
						'8000': '较少（常用 8000 词以外）',
						'0': '关闭',
					},
				},
			},
			{
				type: 'group',
				heading: '在线整句翻译',
				items: [
					{
						name: '启用在线翻译',
						desc: '关闭时整句解析只用本地词典，选区内容不会离开这台设备。',
						control: {
							type: 'toggle',
							key: 'translateEnabled',
							defaultValue: false,
						},
					},
					{
						name: '服务商',
						desc: 'OpenAI 兼容接口可指向任意兼容服务。',
						visible: () => this.plugin.settings.translateEnabled,
						control: {
							type: 'dropdown',
							key: 'translateProvider',
							defaultValue: DEFAULT_SETTINGS.translateProvider,
							options: {
								openai: 'OpenAI 兼容',
								deepl: 'DeepL',
							},
						},
					},
					{
						name: 'API key',
						desc: '以明文保存在插件数据中，请勿在共享 vault 里填写。',
						visible: () => this.plugin.settings.translateEnabled,
						control: {
							type: 'text',
							key: 'translateApiKey',
							defaultValue: '',
							placeholder: 'sk-… 或 DeepL key',
						},
					},
					{
						name: '接口地址',
						desc: `留空时 OpenAI 兼容使用 ${DEFAULT_OPENAI_ENDPOINT}，DeepL 按 key 自动选择官方地址。`,
						visible: () => this.plugin.settings.translateEnabled,
						control: {
							type: 'text',
							key: 'translateEndpoint',
							defaultValue: '',
							placeholder: '留空使用默认地址',
						},
					},
					{
						name: '模型',
						desc: '仅 OpenAI 兼容接口使用。',
						visible: () =>
							this.plugin.settings.translateEnabled &&
							this.plugin.settings.translateProvider === 'openai',
						control: {
							type: 'text',
							key: 'translateModel',
							defaultValue: DEFAULT_SETTINGS.translateModel,
							placeholder: DEFAULT_SETTINGS.translateModel,
						},
					},
					{
						name: '目标语言',
						visible: () => this.plugin.settings.translateEnabled,
						control: {
							type: 'text',
							key: 'translateTarget',
							defaultValue: DEFAULT_SETTINGS.translateTarget,
							placeholder: DEFAULT_SETTINGS.translateTarget,
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === 'defaultRate' || key === 'readingHintRank') {
			return String(this.plugin.settings[key]);
		}
		return this.plugin.settings[key as keyof GleanSettings];
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
			return;
		}
		if (key === 'readingHintRank') {
			const rank = Number(value);
			if ([0, 3000, 5000, 8000].includes(rank)) {
				this.plugin.settings.readingHintRank = rank as ReadingHintRank;
				await this.plugin.saveSettings();
				this.plugin.refreshReadingViews();
			}
			return;
		}
		if (key === 'translateEnabled') {
			this.plugin.settings.translateEnabled = value === true;
			await this.plugin.saveSettings();
			this.revealDependentSettings();
			return;
		}
		if (key === 'translateProvider') {
			this.plugin.settings.translateProvider =
				value === 'deepl' ? 'deepl' : 'openai';
			await this.plugin.saveSettings();
			this.revealDependentSettings();
			return;
		}
		if (
			key === 'translateApiKey' ||
			key === 'translateEndpoint' ||
			key === 'translateModel' ||
			key === 'translateTarget'
		) {
			const next = typeof value === 'string' ? value.trim() : '';
			this.plugin.settings[key] =
				next || (key === 'translateApiKey' || key === 'translateEndpoint'
					? ''
					: DEFAULT_SETTINGS[key]);
			await this.plugin.saveSettings();
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('生词目录')
			.setDesc(
				'生词笔记存放的 vault 相对路径。修改后不会搬运旧卡片；需要搬运时运行“Glean: 整理生词目录”。',
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

		new Setting(containerEl)
			.setName('阅读词汇提示')
			.setDesc('按词频给较难词加轻量虚线，只改变阅读界面，不会自动加入生词库。')
			.addDropdown((dropdown) => {
				dropdown.addOption('3000', '较多（常用 3000 词以外）');
				dropdown.addOption('5000', '适中（常用 5000 词以外）');
				dropdown.addOption('8000', '较少（常用 8000 词以外）');
				dropdown.addOption('0', '关闭');
				dropdown.setValue(String(this.plugin.settings.readingHintRank));
				dropdown.onChange(async (value) => {
					this.plugin.settings.readingHintRank = Number(value) as ReadingHintRank;
					await this.plugin.saveSettings();
					this.plugin.refreshReadingViews();
				});
			});

		new Setting(containerEl).setName('在线整句翻译').setHeading();

		new Setting(containerEl)
			.setName('启用在线翻译')
			.setDesc('关闭时整句解析只用本地词典，选区内容不会离开这台设备。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.translateEnabled)
					.onChange(async (value) => {
						this.plugin.settings.translateEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (!this.plugin.settings.translateEnabled) {
			return;
		}

		new Setting(containerEl)
			.setName('服务商')
			.setDesc('OpenAI 兼容接口可指向任意兼容服务。')
			.addDropdown((dropdown) => {
				dropdown.addOption('openai', 'OpenAI 兼容');
				dropdown.addOption('deepl', 'DeepL');
				dropdown.setValue(this.plugin.settings.translateProvider);
				dropdown.onChange(async (value) => {
					this.plugin.settings.translateProvider =
						value === 'deepl' ? 'deepl' : 'openai';
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('API key')
			.setDesc('以明文保存在插件数据中，请勿在共享 vault 里填写。')
			.addText((text) =>
				text
					.setPlaceholder('sk-… 或 DeepL key')
					.setValue(this.plugin.settings.translateApiKey)
					.onChange(async (value) => {
						this.plugin.settings.translateApiKey = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('接口地址')
			.setDesc(
				`留空时 OpenAI 兼容使用 ${DEFAULT_OPENAI_ENDPOINT}，DeepL 按 key 自动选择官方地址。`,
			)
			.addText((text) =>
				text
					.setPlaceholder('留空使用默认地址')
					.setValue(this.plugin.settings.translateEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.translateEndpoint = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		if (this.plugin.settings.translateProvider === 'openai') {
			new Setting(containerEl)
				.setName('模型')
				.setDesc('仅 OpenAI 兼容接口使用。')
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.translateModel)
						.setValue(this.plugin.settings.translateModel)
						.onChange(async (value) => {
							this.plugin.settings.translateModel =
								value.trim() || DEFAULT_SETTINGS.translateModel;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('目标语言')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.translateTarget)
					.setValue(this.plugin.settings.translateTarget)
					.onChange(async (value) => {
						this.plugin.settings.translateTarget =
							value.trim() || DEFAULT_SETTINGS.translateTarget;
						await this.plugin.saveSettings();
					}),
			);
	}

	/**
	 * Only the declarative renderer evaluates `visible`, and that renderer
	 * only exists from 1.13.0. Older builds fall back to display().
	 */
	private revealDependentSettings(): void {
		if (requireApiVersion('1.13.0')) {
			this.refreshDomState();
		}
	}

	private dictionaryDescription(): string {
		return (
			this.plugin.dictionaryError ??
			(this.plugin.dictionaryReady
				? '已加载 Glean 离线词典。留空使用 vault 配置目录下的 glean/dict。'
				: '未找到词典。目录中需要 glean-dict-v1.tsv 和 glean-inflect-v1.tsv。')
		);
	}
}
