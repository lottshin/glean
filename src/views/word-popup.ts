export interface WordLookupContext {
	lookupId: number;
	word: string;
	sentence: string;
	sourceName: string;
	timeLabel: string;
	onDismiss: (lookupId: number) => void;
}

/**
 * Non-modal lookup surface anchored to a subtitle word.
 * Dictionary results can replace the placeholder without changing its lifecycle.
 */
export class EchoWordPopover {
	private popoverEl: HTMLElement | null = null;
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

		const kicker = popover.createDiv({ cls: 'echo-word-popover-kicker', text: '词条预览' });
		kicker.setAttribute('aria-hidden', 'true');
		popover.createEl('h2', {
			cls: 'echo-word-popover-title',
			text: context.word,
		});
		popover.createDiv({
			cls: 'echo-word-popover-pending',
			text: '离线词典将在 M2 接入',
		});

		const contextEl = popover.createDiv({ cls: 'echo-word-popover-context' });
		contextEl.createEl('blockquote', { text: context.sentence });
		contextEl.createDiv({
			cls: 'echo-word-popover-source',
			text: `${context.sourceName} · ${context.timeLabel}`,
		});

		doc.body.appendChild(popover);
		this.popoverEl = popover;
		this.context = context;
		this.ownerDocument = doc;
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

	close(): void {
		const context = this.context;
		if (!context && !this.popoverEl) {
			return;
		}
		this.removeListeners?.();
		this.removeListeners = null;
		this.popoverEl?.remove();
		this.popoverEl = null;
		this.context = null;
		this.ownerDocument = null;
		context?.onDismiss(context.lookupId);
	}

	destroy(): void {
		this.close();
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
