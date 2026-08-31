import type { DictionaryLookup } from '../dictionary';

export interface WordLookupContext {
	lookupId: number;
	word: string;
	sentence: string;
	sourceName: string;
	timeLabel: string;
	lookup?: DictionaryLookup | null;
	onDismiss: (lookupId: number) => void;
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

	open(anchor: HTMLElement, context: WordLookupContext): void {
		this.close();

		const doc = anchor.ownerDocument;
		const popover = doc.createElement('div');
		popover.className = 'echo-word-popover';
		popover.setAttribute('role', 'dialog');
		popover.setAttribute('aria-label', `查询 ${context.word}`);
		popover.addEventListener('pointerdown', (event) => event.stopPropagation());

		doc.body.appendChild(popover);
		this.popoverEl = popover;
		this.anchorEl = anchor;
		this.context = context;
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

	update(lookupId: number, lookup: DictionaryLookup | null): void {
		if (!this.context || this.context.lookupId !== lookupId) {
			return;
		}
		this.context.lookup = lookup;
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
