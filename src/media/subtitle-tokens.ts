import { normalizeLexiconKey } from '../normalize';

export type SubtitleToken = {
	text: string;
	kind: 'word' | 'separator';
	lookup?: string;
};

const WORD = /[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu;

/**
 * Split a subtitle into clickable words while preserving every separator.
 * This renderer is source-agnostic: local, YouTube and Bilibili cues all use it.
 */
export function tokenizeSubtitle(text: string): SubtitleToken[] {
	const tokens: SubtitleToken[] = [];
	let cursor = 0;

	for (const match of text.matchAll(WORD)) {
		const index = match.index;
		const word = match[0];
		if (index > cursor) {
			tokens.push({ text: text.slice(cursor, index), kind: 'separator' });
		}
		tokens.push({
			text: word,
			kind: 'word',
			lookup: normalizeLexiconKey(word),
		});
		cursor = index + word.length;
	}

	if (cursor < text.length) {
		tokens.push({ text: text.slice(cursor), kind: 'separator' });
	}

	return tokens;
}
