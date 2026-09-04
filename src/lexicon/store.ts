import {
	normalizePath,
	Notice,
	parseYaml,
	TFile,
	TFolder,
	type App,
	type Plugin,
} from 'obsidian';
import type { DictionaryLookup } from '../dictionary';
import { normalizeLexiconKey } from '../normalize';
import { LexiconCatalog, parseAliasList, parseWordStatus, type LexiconCard } from './catalog';
import type { ReviewCard } from '../review/queue';
import {
	isDateString,
	parseReviewState,
	type ReviewState,
} from '../review/schedule';
import {
	createGleanUid,
	createWordNote,
	hasGleanFrontmatter,
	type WordContext,
	type WordStatus,
	updateWordNote,
	updateWordReview,
	updateWordStatus,
} from './note';
import {
	isInsideWordsFolder,
	wordNoteLegacyPath,
	wordNotePath,
} from './path';

export type SaveWordResult = 'created' | 'updated' | 'unchanged';

export interface SaveWordInput {
	lookup: DictionaryLookup;
	context: WordContext;
}

export interface LexiconMigrationPlan {
	moves: Array<{ from: string; to: string }>;
	conflicts: Array<{ from: string; to: string }>;
}

export class LexiconStore {
	readonly catalog = new LexiconCatalog();
	private folderPath: string;
	private catalogReady = false;
	private saveLocks = new Map<string, Promise<void>>();
	private duplicateFingerprint = '';

	constructor(
		private readonly app: App,
		private readonly wordsFolder: () => string,
	) {
		this.folderPath = this.normalizedFolder();
	}

	observe(plugin: Plugin): void {
		plugin.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.refreshFile(file);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
					this.catalog.removePath(file.path);
				} else if (file instanceof TFolder) {
					this.rebuild();
				}
			}),
		);
		plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) {
					this.catalog.rename(oldPath, file.path);
					this.refreshFile(file);
				} else if (file instanceof TFolder) {
					this.rebuild();
				}
			}),
		);
		const onResolved = () => {
			if (!this.catalogReady) {
				this.catalogReady = true;
				this.rebuild();
			}
		};
		plugin.registerEvent(this.app.metadataCache.on('resolved', onResolved));
		// Hot reload can attach after the one-shot `resolved` event. Build an
		// immediate best-effort catalog, then replace it when metadata resolves.
		this.rebuild();
	}

	rebuild(): void {
		this.folderPath = this.normalizedFolder();
		const cards: LexiconCard[] = [];
		const root = this.app.vault.getAbstractFileByPath(this.folderPath);
		if (!(root instanceof TFolder)) {
			this.catalog.replaceAll(cards);
			return;
		}
		for (const file of this.markdownFiles(root)) {
			const card = this.cardFromFile(file);
			if (card) {
				cards.push(card);
			}
		}
		cards.sort((left, right) => left.path.localeCompare(right.path));
		this.reportDuplicateLemmas(cards);
		this.catalog.replaceAll(cards);
	}

	find(word: string): LexiconCard | null {
		return this.catalog.get(word);
	}

	list(): LexiconCard[] {
		return this.catalog.list();
	}

	isWordNote(file: TFile): boolean {
		return this.cardFromFile(file) !== null;
	}

	async remove(word: string): Promise<boolean> {
		const file = await this.locate(word);
		if (!file) {
			return false;
		}
		return this.removeFile(file);
	}

	async removeFile(file: TFile): Promise<boolean> {
		if (!this.isWordNote(file)) {
			return false;
		}
		await this.app.fileManager.trashFile(file);
		this.catalog.removePath(file.path);
		return true;
	}

	/**
	 * Resolve every card's schedule. Cards written before reviews existed have
	 * no `due`, so they fall back to their capture date and drain oldest-first
	 * instead of all landing on today with no order.
	 */
	reviewCards(today: string): ReviewCard[] {
		const cards: ReviewCard[] = [];
		for (const card of this.catalog.list()) {
			const file = this.app.vault.getAbstractFileByPath(card.path);
			if (!(file instanceof TFile)) {
				continue;
			}
			const frontmatter =
				this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			const fallbackDue = isDateString(frontmatter.created)
				? frontmatter.created
				: today;
			cards.push({
				path: card.path,
				lemma: card.lemma,
				forms: card.forms,
				status: card.status,
				review: parseReviewState(frontmatter, fallbackDue),
			});
		}
		return cards;
	}

	async readNote(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? this.app.vault.read(file) : null;
	}

	async recordReview(
		card: ReviewCard,
		review: ReviewState,
		status?: WordStatus,
	): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(card.path);
		if (!(file instanceof TFile) || !this.isWordNote(file)) {
			return false;
		}
		const date = new Date().toISOString().slice(0, 10);
		await this.app.vault.process(file, (content) =>
			updateWordReview(content, review, { status, date }),
		);
		if (status) {
			this.catalog.upsert({
				path: card.path,
				lemma: card.lemma,
				forms: card.forms,
				status,
			});
		}
		return true;
	}

	async setStatus(word: string, status: WordStatus): Promise<boolean> {
		const file = await this.locate(word);
		if (!file || !this.isWordNote(file)) {
			return false;
		}
		await this.app.vault.process(file, (content) =>
			updateWordStatus(content, status),
		);
		const card = this.catalog.get(word);
		if (card) {
			this.catalog.upsert({ ...card, status });
		} else {
			this.refreshFile(file);
		}
		return true;
	}

	async save(input: SaveWordInput): Promise<SaveWordResult> {
		const key = normalizeLexiconKey(input.lookup.lemma);
		const previous = this.saveLocks.get(key) ?? Promise.resolve();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => gate);
		this.saveLocks.set(key, tail);
		await previous.catch(() => undefined);
		try {
			return await this.saveUnlocked(input);
		} finally {
			release();
			if (this.saveLocks.get(key) === tail) {
				this.saveLocks.delete(key);
			}
		}
	}

	private async saveUnlocked(input: SaveWordInput): Promise<SaveWordResult> {
		const folder = this.folder();
		const lemma = input.lookup.lemma;
		const canonical = wordNotePath(folder, lemma);
		const existing = await this.locate(lemma);
		const date = new Date().toISOString().slice(0, 10);
		const uid = createGleanUid();

		if (!existing) {
			await this.ensureFolder(canonical.slice(0, canonical.lastIndexOf('/')));
			const created = await this.app.vault.create(
				canonical,
				createWordNote({ ...input, date, uid }),
			);
			this.updateCatalogFromSave(created, input);
			return 'created';
		}

		const original = await this.app.vault.read(existing);
		const cachedGlean =
			this.app.metadataCache.getFileCache(existing)?.frontmatter?.glean === true;
		if (!cachedGlean && !hasGleanFrontmatter(original)) {
			throw new Error(`已有同名笔记且不是 Glean 生词：${existing.path}`);
		}

		const preview = this.updateContent(original, input, date, uid);
		if (!preview.changed) {
			return 'unchanged';
		}
		await this.app.vault.process(existing, (current) =>
			this.updateContent(current, input, date, uid).content,
		);
		this.updateCatalogFromSave(existing, input);
		return 'updated';
	}

	private async locate(lemma: string): Promise<TFile | null> {
		const folder = this.folder();
		const indexed = this.catalog.get(lemma)?.path;
		const candidates = [
			indexed,
			wordNotePath(folder, lemma),
			wordNoteLegacyPath(folder, lemma),
		];
		for (const path of candidates) {
			if (!path) {
				continue;
			}
			const found = this.app.vault.getAbstractFileByPath(path);
			if (found instanceof TFile) {
				return found;
			}
		}
		return null;
	}

	async planLayoutMigration(): Promise<LexiconMigrationPlan> {
		const folder = this.folder();
		const root = this.app.vault.getAbstractFileByPath(folder);
		if (!(root instanceof TFolder)) {
			return { moves: [], conflicts: [] };
		}
		const plan: LexiconMigrationPlan = { moves: [], conflicts: [] };
		for (const file of this.markdownFiles(root)) {
			const card = this.cardFromFile(file);
			if (!card) {
				continue;
			}
			const dest = wordNotePath(folder, card.lemma);
			if (file.path === dest) {
				continue;
			}
			const move = { from: file.path, to: dest };
			if (this.app.vault.getAbstractFileByPath(dest)) {
				plan.conflicts.push(move);
			} else {
				plan.moves.push(move);
			}
		}
		return plan;
	}

	async executeLayoutMigration(plan: LexiconMigrationPlan): Promise<string> {
		const moved: string[] = [];
		const failed: Array<{ from: string; to: string }> = [];
		for (const move of plan.moves) {
			const file = this.app.vault.getAbstractFileByPath(move.from);
			if (!(file instanceof TFile) || this.app.vault.getAbstractFileByPath(move.to)) {
				failed.push(move);
				continue;
			}
			try {
				await this.ensureFolder(move.to.slice(0, move.to.lastIndexOf('/')));
				await this.app.fileManager.renameFile(file, move.to);
				moved.push(`${move.from} → ${move.to}`);
			} catch {
				failed.push(move);
			}
		}
		this.rebuild();
		return this.writeMigrationReport(moved, [...plan.conflicts, ...failed]);
	}

	private refreshFile(file: TFile): void {
		if (!isInsideWordsFolder(file.path, this.folder())) {
			this.catalog.removePath(file.path);
			return;
		}
		const card = this.cardFromFile(file);
		if (card) {
			this.catalog.upsert(card);
		} else {
			this.catalog.removePath(file.path);
		}
	}

	private updateCatalogFromSave(file: TFile, input: SaveWordInput): void {
		const current = this.catalog.get(input.lookup.lemma);
		const forms = new Set(current?.forms ?? []);
		if (
			input.lookup.surface.toLocaleLowerCase('en-US') !==
			input.lookup.lemma.toLocaleLowerCase('en-US')
		) {
			forms.add(input.lookup.surface);
		}
		this.catalog.upsert({
			path: file.path,
			lemma: input.lookup.lemma,
			forms: [...forms],
			status: current?.status ?? 'new',
		});
	}

	private reportDuplicateLemmas(cards: LexiconCard[]): void {
		const firstPath = new Map<string, string>();
		const duplicates: string[] = [];
		for (const card of cards) {
			const key = normalizeLexiconKey(card.lemma);
			const first = firstPath.get(key);
			if (first && first !== card.path) {
				duplicates.push(`${card.lemma}: ${first} / ${card.path}`);
			} else {
				firstPath.set(key, card.path);
			}
		}
		const fingerprint = duplicates.join('\n');
		if (fingerprint && fingerprint !== this.duplicateFingerprint) {
			new Notice(`发现重复生词卡，请合并后再操作：${duplicates[0]}`);
		}
		this.duplicateFingerprint = fingerprint;
	}

	private cardFromFile(file: TFile): LexiconCard | null {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter?.glean !== true) {
			return null;
		}
		const forms = [
			...parseAliasList(frontmatter.forms),
			...parseAliasList(frontmatter.aliases),
		];
		return {
			path: file.path,
			lemma: typeof frontmatter.lemma === 'string' ? frontmatter.lemma : file.basename,
			status: parseWordStatus(frontmatter.status),
			forms,
		};
	}

	private folder(): string {
		return this.folderPath;
	}

	private normalizedFolder(): string {
		return normalizePath(this.wordsFolder().trim() || 'Glean/Words');
	}

	private updateContent(
		content: string,
		input: SaveWordInput,
		date: string,
		uid: string,
	): { content: string; changed: boolean } {
		const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		if (!match?.[1]) {
			throw new Error('生词笔记缺少有效的 frontmatter');
		}
		const parsed: unknown = parseYaml(match[1]);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('生词笔记的 frontmatter 无效');
		}
		return updateWordNote(content, parsed as Record<string, unknown>, {
			...input,
			date,
			uid,
		});
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch {
					if (!this.app.vault.getAbstractFileByPath(current)) {
						throw new Error(`无法创建生词目录：${current}`);
					}
				}
			}
		}
	}

	private markdownFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		const visit = (current: TFolder) => {
			for (const child of current.children) {
				if (child instanceof TFolder) {
					visit(child);
				} else if (child instanceof TFile && child.extension === 'md') {
					files.push(child);
				}
			}
		};
		visit(folder);
		return files;
	}

	private async writeMigrationReport(
		moved: string[],
		conflicts: Array<{ from: string; to: string }>,
	): Promise<string> {
		await this.ensureFolder(this.folder());
		const path = normalizePath(`${this.folder()}/_migration-report.md`);
		const lines = [
			'# Glean 生词目录整理报告',
			'',
			`生成时间：${new Date().toISOString()}`,
			'',
			`已移动：${moved.length}`,
			`未移动：${conflicts.length}`,
			'',
			'## 已移动',
			'',
			...(moved.length > 0 ? moved.map((line) => `- ${line}`) : ['- 无']),
			'',
			'## 冲突或失败',
			'',
			...(conflicts.length > 0
				? conflicts.map(({ from, to }) => `- ${from} → ${to}`)
				: ['- 无']),
			'',
		];
		const content = lines.join('\n');
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
		return path;
	}
}
