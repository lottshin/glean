import {
	ItemView,
	Notice,
	setIcon,
	TFile,
	type WorkspaceLeaf,
} from 'obsidian';
import type { LexiconCard } from '../lexicon/catalog';
import {
	parseAliasList,
	parseWordStatus,
} from '../lexicon/catalog';
import type { WordStatus } from '../lexicon/note';
import type GleanPlugin from '../main';
import { parseBilibiliVideoId, bilibiliSourcePath } from '../bilibili/id';
import { parseYouTubeVideoId, youtubeSourcePath } from '../youtube/id';

export const LEXICON_VIEW_TYPE = 'glean-lexicon';

const PAGE_SIZE = 100;
const STATUSES: WordStatus[] = ['new', 'learning', 'known', 'ignored'];
const STATUS_LABELS: Record<WordStatus, string> = {
	new: '生词',
	learning: '学习中',
	known: '已掌握',
	ignored: '忽略',
};

export type LexiconFilter = 'all' | WordStatus;

export interface LexiconRow {
	card: LexiconCard;
	phonetic: string;
	sources: string[];
	updated: string;
}

export function filterLexiconRows(
	rows: LexiconRow[],
	query: string,
	filter: LexiconFilter,
): LexiconRow[] {
	const needle = query.trim().toLocaleLowerCase('en-US');
	return rows.filter(({ card }) => {
		if (filter !== 'all' && card.status !== filter) {
			return false;
		}
		if (!needle) {
			return true;
		}
		return [card.lemma, ...card.forms].some((value) =>
			value.toLocaleLowerCase('en-US').includes(needle),
		);
	});
}

export class LexiconView extends ItemView {
	private search = '';
	private filter: LexiconFilter = 'all';
	private visible = PAGE_SIZE;
	private listEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private filterEl: HTMLElement | null = null;
	private refreshTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: GleanPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return LEXICON_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Glean 生词库';
	}

	getIcon(): string {
		return 'wheat';
	}

	async onOpen(): Promise<void> {
		this.buildShell();
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (this.related(file.path)) {
					this.queueRender();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (this.related(file.path)) {
					this.queueRender();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.related(file.path) || this.related(oldPath)) {
					this.queueRender();
				}
			}),
		);
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.contentEl.empty();
	}

	refresh(): void {
		this.render();
	}

	private buildShell(): void {
		this.contentEl.empty();
		this.contentEl.addClass('glean-lexicon-view');

		const header = this.contentEl.createDiv({ cls: 'glean-lexicon-header' });
		header.createEl('h2', { text: '生词库' });
		this.summaryEl = header.createDiv({ cls: 'glean-lexicon-summary' });

		const search = this.contentEl.createEl('input', {
			cls: 'glean-lexicon-search',
			attr: {
				type: 'search',
				placeholder: '搜索单词或词形',
				'aria-label': '搜索生词',
				autocomplete: 'off',
				spellcheck: 'false',
			},
		});
		search.addEventListener('input', () => {
			this.search = search.value;
			this.visible = PAGE_SIZE;
			this.render();
		});

		this.filterEl = this.contentEl.createDiv({
			cls: 'glean-lexicon-filters',
			attr: { 'aria-label': '按学习状态筛选' },
		});
		this.listEl = this.contentEl.createDiv({
			cls: 'glean-lexicon-list',
			attr: { 'aria-live': 'polite' },
		});
		this.render();
	}

	private render(): void {
		if (!this.listEl || !this.summaryEl || !this.filterEl) {
			return;
		}
		const rows = this.rows();
		const counts = this.statusCounts(rows);
		const filtered = filterLexiconRows(rows, this.search, this.filter);
		this.summaryEl.setText(`${rows.length} 个词`);
		this.renderFilters(counts, rows.length);
		this.listEl.empty();

		if (filtered.length === 0) {
			const empty = this.listEl.createDiv({ cls: 'glean-lexicon-empty' });
			empty.createDiv({
				cls: 'glean-lexicon-empty-title',
				text: rows.length === 0 ? '还没有生词' : '没有匹配的词',
			});
			empty.createDiv({
				text:
					rows.length === 0
						? '在精听或阅读中点词，然后选择“加入生词”。'
						: '换一个搜索词，或选择“全部”。',
			});
			return;
		}

		for (const row of filtered.slice(0, this.visible)) {
			this.renderRow(row);
		}
		if (filtered.length > this.visible) {
			const more = this.listEl.createEl('button', {
				cls: 'glean-lexicon-more',
				text: `再显示 ${Math.min(PAGE_SIZE, filtered.length - this.visible)} 个`,
			});
			more.addEventListener('click', () => {
				this.visible += PAGE_SIZE;
				this.render();
			});
		}
	}

	private renderFilters(
		counts: Record<WordStatus, number>,
		total: number,
	): void {
		if (!this.filterEl) {
			return;
		}
		this.filterEl.empty();
		const options: Array<[LexiconFilter, string, number]> = [
			['all', '全部', total],
			...STATUSES.map(
				(status): [LexiconFilter, string, number] => [
					status,
					STATUS_LABELS[status],
					counts[status],
				],
			),
		];
		for (const [value, label, count] of options) {
			const button = this.filterEl.createEl('button', {
				cls: 'glean-lexicon-filter',
				text: label,
				attr: {
					type: 'button',
					'aria-label': `${label} ${count} 个`,
					'aria-pressed': String(this.filter === value),
				},
			});
			// A column of zeroes is noise; the label alone still invites a click.
			if (count > 0) {
				button.createSpan({
					cls: 'glean-lexicon-count',
					text: String(count),
				});
			}
			button.toggleClass('is-active', this.filter === value);
			button.addEventListener('click', () => {
				this.filter = value;
				this.visible = PAGE_SIZE;
				this.render();
			});
		}
	}

	private renderRow(row: LexiconRow): void {
		if (!this.listEl) {
			return;
		}
		const { card } = row;
		const item = this.listEl.createDiv({ cls: 'glean-lexicon-item' });
		const main = item.createEl('button', {
			cls: 'glean-lexicon-main',
			attr: {
				type: 'button',
				'aria-label': `打开生词笔记 ${card.lemma}`,
			},
		});
		const wordLine = main.createDiv({ cls: 'glean-lexicon-word-line' });
		wordLine.createSpan({ cls: 'glean-lexicon-lemma', text: card.lemma });
		if (row.phonetic) {
			wordLine.createSpan({
				cls: 'glean-lexicon-phonetic',
				text: `/${row.phonetic}/`,
			});
		}
		const detail = main.createDiv({ cls: 'glean-lexicon-detail' });
		detail.setText(
			card.forms.length > 0 ? card.forms.slice(0, 3).join(' · ') : '打开词卡',
		);
		main.addEventListener('click', () => {
			void this.plugin.openWordNote(card.lemma);
		});

		const controls = item.createDiv({ cls: 'glean-lexicon-controls' });
		const status = controls.createEl('select', {
			cls: `glean-lexicon-status is-${card.status}`,
			attr: { 'aria-label': `${card.lemma} 的学习状态` },
		});
		for (const value of STATUSES) {
			status.createEl('option', {
				value,
				text: STATUS_LABELS[value],
			});
		}
		status.value = card.status;
		status.addEventListener('change', () => {
			status.disabled = true;
			void this.changeStatus(card.lemma, parseWordStatus(status.value));
		});

		const remove = controls.createEl('button', {
			cls: 'glean-lexicon-remove clickable-icon',
			attr: {
				type: 'button',
				'aria-label': `移出生词 ${card.lemma}`,
			},
		});
		setIcon(remove, 'trash-2');
		remove.addEventListener('click', () => {
			void this.remove(card.lemma);
		});

		const source = row.sources[0];
		if (source) {
			const sourceButton = item.createEl('button', {
				cls: 'glean-lexicon-source',
				attr: {
					type: 'button',
					'aria-label': `打开来源 ${source}`,
				},
			});
			const icon = sourceButton.createSpan({ cls: 'glean-lexicon-source-icon' });
			setIcon(icon, 'external-link');
			sourceButton.createSpan({ text: this.sourceLabel(source) });
			sourceButton.addEventListener('click', () => {
				void this.plugin.openLexiconSource(source, card.path);
			});
		}
	}

	private rows(): LexiconRow[] {
		return this.plugin
			.listLexiconCards()
			.map((card) => {
				const file = this.app.vault.getAbstractFileByPath(card.path);
				const frontmatter =
					file instanceof TFile
						? this.app.metadataCache.getFileCache(file)?.frontmatter
						: undefined;
				return {
					card,
					phonetic:
						typeof frontmatter?.phonetic === 'string'
							? frontmatter.phonetic
							: '',
					sources: parseAliasList(frontmatter?.sources).map((source) =>
						this.sourcePath(source),
					),
					updated:
						frontmatter?.updated === undefined
							? ''
							: String(frontmatter.updated),
				};
			})
			.sort(
				(left, right) =>
					right.updated.localeCompare(left.updated) ||
					left.card.lemma.localeCompare(right.card.lemma),
			);
	}

	private statusCounts(rows: LexiconRow[]): Record<WordStatus, number> {
		const counts: Record<WordStatus, number> = {
			new: 0,
			learning: 0,
			known: 0,
			ignored: 0,
		};
		for (const { card } of rows) {
			counts[card.status] += 1;
		}
		return counts;
	}

	private async changeStatus(
		lemma: string,
		status: WordStatus,
	): Promise<void> {
		try {
			if (!(await this.plugin.setWordStatus(lemma, status))) {
				new Notice('找不到对应的生词笔记');
			}
		} catch (error) {
			new Notice(error instanceof Error ? error.message : '更新状态失败');
		}
		this.render();
	}

	private async remove(lemma: string): Promise<void> {
		try {
			if (!(await this.plugin.removeWord(lemma))) {
				new Notice('找不到对应的生词笔记');
				return;
			}
			new Notice(`已将 ${lemma} 移到废纸篓`);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : '移出生词失败');
		}
		this.render();
	}

	private queueRender(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.render();
		}, 80);
	}

	private related(path: string): boolean {
		const folder = this.plugin.settings.wordsFolder.replace(/\/+$/, '');
		return path === folder || path.startsWith(`${folder}/`);
	}

	private sourcePath(value: string): string {
		const trimmed = value.trim();
		const wiki = trimmed.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
		if (wiki?.[1]) {
			return wiki[1].trim();
		}
		const markdown = trimmed.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/);
		const url = markdown?.[1] ?? trimmed;
		const youtubeId = parseYouTubeVideoId(url);
		if (youtubeId) {
			return youtubeSourcePath(youtubeId);
		}
		const bvid = parseBilibiliVideoId(url);
		return bvid ? bilibiliSourcePath(bvid) : trimmed;
	}

	private sourceLabel(path: string): string {
		if (path.startsWith('youtube:')) {
			return `YouTube · ${path.slice('youtube:'.length)}`;
		}
		if (path.startsWith('bilibili:')) {
			return `B 站 · ${path.slice('bilibili:'.length)}`;
		}
		return path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? path;
	}
}
