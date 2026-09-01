import { tokenizeSubtitle } from '../media/subtitle-tokens';
import type { WordStatus } from '../lexicon/note';

const SKIP = new Set([
	'A',
	'BUTTON',
	'CODE',
	'INPUT',
	'KBD',
	'MATH',
	'PRE',
	'SCRIPT',
	'STYLE',
	'SVG',
	'TEXTAREA',
]);

export interface ReadCoverage {
	unique: number;
	known: number;
}

export function sentenceAround(node: Node): string {
	const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th');
	const text = (block?.textContent ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();
	return text;
}

function isEnglishWord(text: string): boolean {
	return /[A-Za-z]/.test(text);
}

/**
 * Wrap English words in a rendered Markdown preview. Code, links and math
 * stay untouched. Returns unique-token coverage against the current lexicon.
 */
export function decorateReadableArticle(
	root: HTMLElement,
	statusOf: (word: string) => WordStatus | null,
	onWord: (el: HTMLElement, word: string) => void,
): ReadCoverage {
	const seen = new Set<string>();
	let known = 0;
	const showText = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
	const walker = root.ownerDocument.createTreeWalker(root, showText);
	const texts: Text[] = [];
	let current = walker.nextNode();
	while (current) {
		if (current.nodeType === Node.TEXT_NODE && current.textContent && shouldWrap(current as Text)) {
			texts.push(current as Text);
		}
		current = walker.nextNode();
	}

	for (const textNode of texts) {
		const raw = textNode.textContent ?? '';
		const tokens = tokenizeSubtitle(raw);
		if (!tokens.some((token) => token.kind === 'word' && isEnglishWord(token.text))) {
			continue;
		}
		const host = textNode.parentElement;
		if (!host) {
			continue;
		}
		const fragment = host.createSpan({ cls: 'glean-read-fragment' });
		fragment.detach();
		for (const token of tokens) {
			if (token.kind !== 'word' || !token.lookup || !isEnglishWord(token.text)) {
				fragment.appendText(token.text);
				continue;
			}
			const key = token.lookup;
			if (!seen.has(key)) {
				seen.add(key);
				const status = statusOf(key);
				if (status === 'known' || status === 'ignored') {
					known += 1;
				}
			}
			const word = fragment.createSpan({
				cls: 'glean-read-word',
				text: token.text,
			});
			word.setAttribute('role', 'button');
			word.dataset.gleanWord = token.lookup;
			const status = statusOf(token.lookup);
			if (status === 'new' || status === 'learning') {
				word.classList.add(`is-${status}`);
			}
			word.addEventListener('click', (event) => {
				// Dragging across a sentence ends on a word; opening the lookup
				// there would fight the selection the reader just made.
				if (hasTextSelection(word)) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				onWord(word, token.lookup ?? token.text);
			});
			fragment.appendChild(word);
		}
		textNode.parentNode?.replaceChild(fragment, textNode);
	}

	return { unique: seen.size, known };
}

function hasTextSelection(el: HTMLElement): boolean {
	const selection = el.ownerDocument.defaultView?.getSelection();
	return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
}

function shouldWrap(node: Text): boolean {
	const parent = node.parentElement;
	if (!parent) {
		return false;
	}
	if (
		parent.closest(
			'.glean-read-word, .glean-read-fragment, .glean-word-note-toolbar, .internal-embed, .cm-scroller, .footnote-ref, .tag',
		)
	) {
		return false;
	}
	let current: HTMLElement | null = parent;
	while (current) {
		if (SKIP.has(current.tagName)) {
			return false;
		}
		current = current.parentElement;
	}
	return true;
}
