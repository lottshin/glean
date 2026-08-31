import type { DictionaryLookup } from '../dictionary';
import type { WordStatus } from '../lexicon/note';
import type { SaveWordResult } from '../lexicon/store';

export interface WordLookupContext {
	lookupId: number;
	word: string;
	sentence: string;
	sourceName: string;
	timeLabel: string;
	lookup?: DictionaryLookup | null;
	inLexicon?: boolean;
	status?: WordStatus;
	onDismiss: (lookupId: number) => void;
	onSave: (lookup: DictionaryLookup | null) => Promise<SaveWordResult>;
	onRemove: (lookup: DictionaryLookup | null) => Promise<boolean>;
	onOpenNote: (lookup: DictionaryLookup | null) => Promise<boolean>;
	onStatus: (
		lookup: DictionaryLookup | null,
		status: WordStatus,
	) => Promise<boolean>;
}

/**
 * Non-modal lookup surface anchored to a subtitle word.
 * Dictionary results can replace the placeholder without changing its lifecycle.
 */
export class EchoWordPopover {
	private popoverEl: HTMLElement | null = null;
	private anchorEl: HTMLElement | null = null;
	private context: WordLookupContext | null = null;
	private ownerDocument: Document | null = null;
	private removeListeners: (() => void) | null = null;
	private saveState: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
	private removeState: 'idle' | 'removing' | 'error' = 'idle';

	open(anchor: HTMLElement, context: WordLookupContext): void {
		this.close();

		const doc = anchor.ownerDocument;
		const popover = doc.body.createDiv({ cls: 'echo-word-popover' });
		popover.setAttribute('role', 'dialog');
		popover.setAttribute('aria-label', `查询 ${context.word}`);
		popover.addEventListener('pointerdown', (event) => event.stopPropagation());

		this.popoverEl = popover;
		this.anchorEl = anchor;
		this.context = context;
		this.saveState = 'idle';
		this.removeState = 'idle';
		this.ownerDocument = doc;
		this.render();
		this.position(anchor);

		const onOutsidePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target && !popover.contains(target as Node) && target !== anchor) {
				this.close();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				this.close();
			}
		};
		const onViewportChange = () => this.close();
		const win = doc.defaultView;
		doc.addEventListener('pointerdown', onOutsidePointerDown, true);
		doc.addEventListener('keydown', onKeyDown, true);
		doc.addEventListener('scroll', onViewportChange, true);
		win?.addEventListener('resize', onViewportChange);
		this.removeListeners = () => {
			doc.removeEventListener('pointerdown', onOutsidePointerDown, true);
			doc.removeEventListener('keydown', onKeyDown, true);
			doc.removeEventListener('scroll', onViewportChange, true);
			win?.removeEventListener('resize', onViewportChange);
		};
	}

	update(
		lookupId: number,
		lookup: DictionaryLookup | null,
		inLexicon?: boolean,
		status?: WordStatus,
	): void {
		if (!this.context || this.context.lookupId !== lookupId) {
			return;
		}
		this.context.lookup = lookup;
		if (inLexicon !== undefined) {
			this.context.inLexicon = inLexicon;
		}
		if (status !== undefined) {
			this.context.status = status;
		}
		this.render();
		if (this.anchorEl?.isConnected) {
			this.position(this.anchorEl);
		}
	}

	close(): void {
		const context = this.context;
		if (!context && !this.popoverEl) {
			return;
		}
		this.removeListeners?.();
		this.removeListeners = null;
		this.popoverEl?.remove();
		this.popoverEl = null;
		this.anchorEl = null;
		this.context = null;
		this.ownerDocument = null;
		context?.onDismiss(context.lookupId);
	}

	destroy(): void {
		this.close();
	}

	saveCurrent(): boolean {
		if (!this.context) {
			return false;
		}
		void this.save();
		return true;
	}

	private render(): void {
		const popover = this.popoverEl;
		const context = this.context;
		if (!popover || !context) {
			return;
		}
		popover.empty();
		const kicker = popover.createDiv({
			cls: 'echo-word-popover-kicker',
			text: context.lookup?.match === 'inflection' ? '词形还原' : '词条',
		});
		kicker.setAttribute('aria-hidden', 'true');
		const title = popover.createDiv({ cls: 'echo-word-popover-heading' });
		title.createEl('h2', {
			cls: 'echo-word-popover-title',
			text: context.word,
		});
		if (context.lookup?.entry && context.lookup.match !== 'direct') {
			title.createSpan({
				cls: 'echo-word-popover-lemma',
				text: `→ ${context.lookup.entry.word}`,
			});
		}

		if (context.lookup === undefined) {
			popover.createDiv({ cls: 'echo-word-popover-pending', text: '正在查询…' });
		} else if (context.lookup === null) {
			popover.createDiv({
				cls: 'echo-word-popover-pending',
				text: '未安装离线词典，请在 Echo 设置中选择词典目录。',
			});
		} else if (!context.lookup.entry) {
			popover.createDiv({
				cls: 'echo-word-popover-pending',
				text: '离线词典未收录这个词。',
			});
		} else {
			const entry = context.lookup.entry;
			if (entry.phonetic) {
				popover.createDiv({
					cls: 'echo-word-popover-phonetic',
					text: `/${entry.phonetic.replace(/^\/|\/$/g, '')}/`,
				});
			}
			if (entry.pos) {
				popover.createDiv({ cls: 'echo-word-popover-pos', text: entry.pos });
			}
			const senses = popover.createDiv({ cls: 'echo-word-popover-senses' });
			for (const translation of entry.translations) {
				senses.createDiv({ cls: 'echo-word-popover-sense', text: translation });
			}
			if (entry.translations.length === 0 && entry.definition) {
				senses.createDiv({ cls: 'echo-word-popover-sense', text: entry.definition });
			}
		}

		const contextEl = popover.createDiv({ cls: 'echo-word-popover-context' });
		contextEl.createEl('blockquote', { text: context.sentence });
		contextEl.createDiv({
			cls: 'echo-word-popover-source',
			text: `${context.sourceName} · ${context.timeLabel}`,
		});

		const actions = popover.createDiv({ cls: 'echo-word-popover-actions' });
		const inLexicon = Boolean(context.inLexicon) || this.saveState === 'saved';
		if (inLexicon) {
			const statusRow = actions.createDiv({ cls: 'echo-word-popover-status' });
			statusRow.createSpan({ text: '状态' });
			const statusSelect = statusRow.createEl('select');
			const statusOptions: Array<[WordStatus, string]> = [
				['new', '生词'],
				['learning', '学习中'],
				['known', '已掌握'],
				['ignored', '忽略'],
			];
			for (const [value, label] of statusOptions) {
				statusSelect.createEl('option', { value, text: label });
			}
			statusSelect.value = context.status ?? 'new';
			statusSelect.disabled =
				this.removeState === 'removing' || this.saveState === 'saving';
			statusSelect.addEventListener('change', () => {
				void this.setStatus(statusSelect.value as WordStatus);
			});
			const secondary = actions.createDiv({ cls: 'echo-word-popover-secondary' });
			const openButton = secondary.createEl('button', {
				cls: 'echo-btn echo-word-popover-open',
				text: '打开笔记',
			});
			openButton.disabled = this.removeState === 'removing' || this.saveState === 'saving';
			openButton.addEventListener('click', () => {
				void this.openNote();
			});
			const removeButton = secondary.createEl('button', {
				cls: 'echo-btn echo-word-popover-remove',
				text:
					this.removeState === 'removing'
						? '正在移出…'
						: this.removeState === 'error'
							? '移出失败，重试'
							: '移出生词',
			});
			removeButton.disabled = this.removeState === 'removing' || this.saveState === 'saving';
			removeButton.addEventListener('click', () => {
				void this.remove();
			});
		}
		const saveButton = actions.createEl('button', {
			cls: 'echo-btn echo-btn-primary echo-word-popover-save',
			text:
				this.saveState === 'saving'
					? '正在保存…'
					: this.saveState === 'saved'
						? '已加入生词'
						: this.saveState === 'error'
							? '保存失败，重试'
							: context.inLexicon
								? '追加语境'
								: '加入生词',
		});
		saveButton.disabled = this.saveState === 'saving' || this.saveState === 'saved';
		saveButton.addEventListener('click', () => {
			void this.save();
		});
	}

	private async openNote(): Promise<void> {
		const context = this.context;
		if (!context) {
			return;
		}
		try {
			const opened = await context.onOpenNote(context.lookup ?? null);
			if (opened) {
				this.close();
			}
		} catch {
			// Leave the popover open; the host surfaces a notice.
		}
	}

	private async remove(): Promise<void> {
		const context = this.context;
		if (!context || this.removeState === 'removing' || this.saveState === 'saving') {
			return;
		}
		this.removeState = 'removing';
		this.render();
		try {
			const removed = await context.onRemove(context.lookup ?? null);
			if (this.context?.lookupId !== context.lookupId) {
				return;
			}
			if (!removed) {
				throw new Error('生词笔记不存在');
			}
			this.context.inLexicon = false;
			this.saveState = 'idle';
			this.removeState = 'idle';
		} catch {
			if (this.context?.lookupId !== context.lookupId) {
				return;
			}
			this.removeState = 'error';
		}
		this.render();
		if (this.anchorEl?.isConnected) {
			this.position(this.anchorEl);
		}
	}

	private async setStatus(status: WordStatus): Promise<void> {
		const context = this.context;
		if (!context) {
			return;
		}
		try {
			const updated = await context.onStatus(context.lookup ?? null, status);
			if (this.context?.lookupId === context.lookupId && updated) {
				this.context.status = status;
				this.render();
			}
		} catch {
			// Keep the current status; the host surfaces a notice.
			this.render();
		}
	}

	private async save(): Promise<void> {
		const context = this.context;
		if (!context || this.saveState === 'saving' || this.saveState === 'saved') {
			return;
		}
		this.saveState = 'saving';
		this.render();
		const wasInLexicon = Boolean(context.inLexicon);
		try {
			await context.onSave(context.lookup ?? null);
			if (this.context?.lookupId !== context.lookupId) {
				return;
			}
			this.saveState = wasInLexicon ? 'idle' : 'saved';
			this.context.inLexicon = true;
			this.context.status ??= 'new';
			this.removeState = 'idle';
		} catch {
			if (this.context?.lookupId !== context.lookupId) {
				return;
			}
			this.saveState = 'error';
		}
		this.render();
		if (this.anchorEl?.isConnected) {
			this.position(this.anchorEl);
		}
	}

	private position(anchor: HTMLElement): void {
		const popover = this.popoverEl;
		const doc = this.ownerDocument;
		if (!popover || !doc) {
			return;
		}

		const gap = 8;
		const edge = 10;
		const anchorRect = anchor.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		const viewportWidth = doc.documentElement.clientWidth;
		const viewportHeight = doc.documentElement.clientHeight;
		const left = Math.max(
			edge,
			Math.min(viewportWidth - popoverRect.width - edge, anchorRect.left),
		);
		const hasRoomBelow = anchorRect.bottom + gap + popoverRect.height <= viewportHeight - edge;
		const top = hasRoomBelow
			? anchorRect.bottom + gap
			: Math.max(edge, anchorRect.top - popoverRect.height - gap);

		popover.style.setProperty('left', `${left}px`);
		popover.style.setProperty('top', `${top}px`);
	}
}
