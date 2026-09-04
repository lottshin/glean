import { setIcon } from 'obsidian';
import type { GlossItem, PassageGloss } from '../translate/gloss';

export interface PassagePanelHost {
	sourceName: string;
	canTranslate: () => boolean;
	onSaveWord: (item: GlossItem, passage: string) => Promise<void>;
	onSpeakWord: (item: GlossItem) => Promise<void>;
	onTranslate: (passage: string) => Promise<string>;
	onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const PANEL_CLASS = 'glean-passage-panel';
const DOCK_CLASS = 'glean-has-passage-panel';

/**
 * Passage inspector docked beside the article. Reading a passage is a session,
 * not a glance: it stays until dismissed and follows the reader's selection.
 */
export class GleanPassagePanel {
	private dockEl: HTMLElement | null = null;
	private panelEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private host: PassagePanelHost | null = null;
	private removeListeners: (() => void) | null = null;

	private passageId = 0;
	private passage = '';
	private gloss: PassageGloss | null = null;
	private saveStates = new Map<string, SaveState>();
	private translation = '';
	private translateState: 'idle' | 'loading' | 'done' | 'error' = 'idle';
	private translateError = '';

	get isOpen(): boolean {
		return this.panelEl !== null;
	}

	/** False once the host view tore down the DOM the panel was docked into. */
	get isConnected(): boolean {
		return this.panelEl?.isConnected === true;
	}

	isDockedIn(dock: HTMLElement): boolean {
		return this.dockEl === dock;
	}

	open(dock: HTMLElement, host: PassagePanelHost): void {
		if (this.dockEl === dock && this.panelEl) {
			this.host = host;
			return;
		}
		this.close();

		const panel = dock.createDiv({ cls: PANEL_CLASS });
		panel.setAttribute('role', 'complementary');
		panel.setAttribute('aria-label', '整句解析');
		dock.addClass(DOCK_CLASS);

		this.dockEl = dock;
		this.panelEl = panel;
		this.host = host;

		const header = panel.createDiv({ cls: 'glean-passage-header' });
		header.createSpan({ cls: 'glean-passage-kicker', text: '整句解析' });
		header.createSpan({ cls: 'glean-passage-source', text: host.sourceName });
		const dismiss = header.createEl('button', {
			cls: 'glean-passage-close',
			text: '×',
		});
		dismiss.setAttribute('aria-label', '关闭整句解析');
		dismiss.addEventListener('click', () => this.close());

		this.bodyEl = panel.createDiv({ cls: 'glean-passage-body' });
		this.renderBody();

		const doc = dock.ownerDocument;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && this.panelEl) {
				event.preventDefault();
				this.close();
			}
		};
		doc.addEventListener('keydown', onKeyDown, true);
		this.removeListeners = () => doc.removeEventListener('keydown', onKeyDown, true);
	}

	/** A new selection replaces the passage; the translation does not carry over. */
	setPassage(passageId: number, text: string): void {
		if (!this.panelEl) {
			return;
		}
		this.passageId = passageId;
		this.passage = text;
		this.gloss = null;
		this.saveStates.clear();
		this.translation = '';
		this.translateState = 'idle';
		this.translateError = '';
		this.renderBody();
	}

	setGloss(passageId: number, gloss: PassageGloss): void {
		if (this.passageId !== passageId) {
			return;
		}
		this.gloss = gloss;
		this.renderBody();
	}

	close(): void {
		if (!this.panelEl) {
			return;
		}
		this.removeListeners?.();
		this.removeListeners = null;
		this.panelEl.remove();
		this.dockEl?.removeClass(DOCK_CLASS);
		this.panelEl = null;
		this.bodyEl = null;
		this.dockEl = null;
		this.passage = '';
		this.gloss = null;
		this.saveStates.clear();
		const host = this.host;
		this.host = null;
		host?.onClose();
	}

	destroy(): void {
		this.close();
	}

	private renderBody(): void {
		const body = this.bodyEl;
		const host = this.host;
		if (!body || !host) {
			return;
		}
		body.empty();

		if (!this.passage) {
			body.createDiv({
				cls: 'glean-passage-hint',
				text: '选中一句或一段，这里会给出逐词释义。',
			});
			return;
		}

		body.createEl('blockquote', {
			cls: 'glean-passage-quote',
			text: preview(this.passage),
		});
		this.renderTranslation(body, host);
		this.renderGloss(body, host);
	}

	private renderTranslation(body: HTMLElement, host: PassagePanelHost): void {
		const section = body.createDiv({ cls: 'glean-passage-section' });
		section.createDiv({ cls: 'glean-passage-section-title', text: '翻译' });

		if (!host.canTranslate()) {
			section.createDiv({
				cls: 'glean-passage-hint',
				text: '在线翻译未开启。可在 Glean 设置中启用后翻译整句或整段。',
			});
			return;
		}

		if (this.translateState === 'done') {
			section.createDiv({ cls: 'glean-passage-translation', text: this.translation });
			return;
		}

		if (this.translateState === 'error') {
			section.createDiv({ cls: 'glean-passage-hint', text: this.translateError });
		}

		const button = section.createEl('button', {
			cls: 'glean-btn glean-btn-primary glean-passage-translate',
			text:
				this.translateState === 'loading'
					? '正在翻译…'
					: this.translateState === 'error'
						? '重试翻译'
						: '翻译这段',
		});
		button.disabled = this.translateState === 'loading';
		button.addEventListener('click', () => {
			void this.translate(host);
		});
	}

	private renderGloss(body: HTMLElement, host: PassagePanelHost): void {
		const section = body.createDiv({ cls: 'glean-passage-section' });
		section.createDiv({ cls: 'glean-passage-section-title', text: '逐词释义' });

		if (!this.gloss) {
			section.createDiv({ cls: 'glean-passage-hint', text: '正在查询…' });
			return;
		}
		if (this.gloss.items.length === 0) {
			section.createDiv({ cls: 'glean-passage-hint', text: '这段里没有可查的实词。' });
			return;
		}

		const list = section.createDiv({ cls: 'glean-passage-list' });
		for (const item of this.gloss.items) {
			this.renderGlossItem(list, item, host);
		}
		if (this.gloss.truncated > 0) {
			section.createDiv({
				cls: 'glean-passage-hint',
				text: `还有 ${this.gloss.truncated} 个词未显示，选更短的段落可以看全。`,
			});
		}
	}

	private renderGlossItem(
		list: HTMLElement,
		item: GlossItem,
		host: PassagePanelHost,
	): void {
		const row = list.createDiv({ cls: 'glean-passage-item' });
		const head = row.createDiv({ cls: 'glean-passage-item-head' });
		head.createSpan({ cls: 'glean-passage-word', text: item.lemma });
		if (item.surface.toLowerCase() !== item.lemma.toLowerCase()) {
			head.createSpan({ cls: 'glean-passage-surface', text: `← ${item.surface}` });
		}
		if (item.phonetic) {
			head.createSpan({
				cls: 'glean-passage-phonetic',
				text: `/${item.phonetic.replace(/^\/|\/$/g, '')}/`,
			});
		}

		const speak = head.createEl('button', {
			cls: 'glean-passage-speak clickable-icon',
			attr: {
				type: 'button',
				'aria-label': `朗读 ${item.lemma}`,
				title: '朗读',
			},
		});
		setIcon(speak, 'volume-2');
		speak.addEventListener('click', () => {
			void host.onSpeakWord(item);
		});

		const state = this.saveStates.get(item.lemma) ?? 'idle';
		const inLexicon = item.status !== null || state === 'saved';
		const action = head.createEl('button', {
			cls: 'glean-passage-add',
			text: saveLabel(state, inLexicon),
		});
		action.disabled = state === 'saving' || inLexicon;
		action.setAttribute(
			'aria-label',
			inLexicon ? `${item.lemma} 已在生词库` : `加入生词：${item.lemma}`,
		);
		action.addEventListener('click', () => {
			void this.saveWord(item, host);
		});

		if (item.missing) {
			row.createDiv({ cls: 'glean-passage-sense is-missing', text: '离线词典未收录' });
			return;
		}
		const senses = item.senses.slice(0, 2).join('；');
		row.createDiv({
			cls: 'glean-passage-sense',
			text: item.pos ? `${item.pos} ${senses}` : senses,
		});
	}

	private async saveWord(item: GlossItem, host: PassagePanelHost): Promise<void> {
		if ((this.saveStates.get(item.lemma) ?? 'idle') === 'saving') {
			return;
		}
		const passageId = this.passageId;
		const passage = this.passage;
		this.saveStates.set(item.lemma, 'saving');
		this.renderBody();
		try {
			await host.onSaveWord(item, passage);
			if (this.passageId !== passageId) {
				return;
			}
			this.saveStates.set(item.lemma, 'saved');
		} catch {
			if (this.passageId !== passageId) {
				return;
			}
			this.saveStates.set(item.lemma, 'error');
		}
		this.renderBody();
	}

	private async translate(host: PassagePanelHost): Promise<void> {
		if (this.translateState === 'loading') {
			return;
		}
		const passageId = this.passageId;
		const passage = this.passage;
		this.translateState = 'loading';
		this.renderBody();
		try {
			const result = await host.onTranslate(passage);
			if (this.passageId !== passageId) {
				return;
			}
			this.translation = result;
			this.translateState = 'done';
		} catch (error) {
			if (this.passageId !== passageId) {
				return;
			}
			this.translateError = error instanceof Error ? error.message : '翻译失败';
			this.translateState = 'error';
		}
		this.renderBody();
	}
}

function saveLabel(state: SaveState, inLexicon: boolean): string {
	if (state === 'saving') {
		return '…';
	}
	if (inLexicon) {
		return '已入库';
	}
	return state === 'error' ? '重试' : '加入';
}

function preview(text: string): string {
	const compact = text.replace(/\s+/g, ' ').trim();
	return compact.length > 220 ? `${compact.slice(0, 217)}…` : compact;
}
