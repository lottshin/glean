import type { Cue } from './types';
import { wordClocksAdvanceAt } from './word-timeline';

const MIN_SPAN = 0.25;

function reindex(cues: Cue[]): Cue[] {
	return cues.map((cue, index) => ({ ...cue, index }));
}

function joinCueText(left: string, right: string): string {
	const a = left.trim();
	const b = right.trim();
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) {
		return `${a} ${b}`;
	}
	return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}

function wordSpans(text: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	const word = /[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu;
	for (const match of text.matchAll(word)) {
		spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

function concatWords(
	left: Cue['words'],
	right: Cue['words'],
): Cue['words'] {
	return left && right ? [...left, ...right] : undefined;
}

/**
 * Cut time from ASR word clocks only. Returns null when clocks are missing or
 * flat — callers must NOT invent times with char-ratio or padding.
 */
function midFromWordClocks(cue: Cue, at: number): number | null {
	const words = cue.words;
	if (!words || words.length !== wordSpans(cue.text).length) {
		return null;
	}
	if (!wordClocksAdvanceAt(words, cue.text, at)) {
		return null;
	}
	const leftStart = words[0]?.start ?? cue.start;
	const boundary = words[at]?.start;
	if (typeof boundary === 'number' && boundary > leftStart + 0.05) {
		return Math.min(cue.end - MIN_SPAN, Math.max(cue.start + MIN_SPAN, boundary));
	}
	const advanced = words.slice(at).find((word) => word.start > leftStart + 0.05);
	if (!advanced) {
		return null;
	}
	return Math.min(cue.end - MIN_SPAN, Math.max(cue.start + MIN_SPAN, advanced.start));
}

export type SplitCueFailure = 'too-short' | 'missing-word-clocks';

/**
 * Why a manual split cannot be timed. Used for precise user-facing notices.
 */
export function explainSplitCueFailure(
	cues: Cue[],
	index: number,
	wordIndex: number,
): SplitCueFailure | null {
	const cue = cues[index];
	if (!cue) {
		return 'too-short';
	}
	const spans = wordSpans(cue.text);
	if (spans.length < 2) {
		return 'too-short';
	}
	const at = Math.min(Math.max(1, wordIndex), spans.length - 1);
	if (midFromWordClocks(cue, at) === null) {
		return 'missing-word-clocks';
	}
	return null;
}

/** Merge cue `index` with the following cue. */
export function mergeCueWithNext(cues: Cue[], index: number): Cue[] | null {
	const left = cues[index];
	const right = cues[index + 1];
	if (!left || !right) {
		return null;
	}
	const merged: Cue = {
		index,
		start: left.start,
		end: Math.max(left.end, right.end),
		text: joinCueText(left.text, right.text),
		words: concatWords(left.words, right.words),
	};
	return reindex([...cues.slice(0, index), merged, ...cues.slice(index + 2)]);
}

/**
 * Split cue `index` before word `wordIndex` (0-based among clickable words).
 *
 * Universal timing rule: the right half starts at that word's real ASR time.
 * No char-ratio, no 1s pad — those invent wrong stamps (e.g. welcome → 12s).
 * Without usable word clocks, returns null (caller should tell user to re-sync).
 */
export function splitCueBeforeWord(
	cues: Cue[],
	index: number,
	wordIndex: number,
): Cue[] | null {
	const cue = cues[index];
	if (!cue) {
		return null;
	}
	const spans = wordSpans(cue.text);
	if (spans.length < 2) {
		return null;
	}
	const at = Math.min(Math.max(1, wordIndex), spans.length - 1);
	const cut = spans[at]?.start;
	if (cut === undefined || cut <= 0) {
		return null;
	}
	const first = cue.text.slice(0, cut).trim();
	const second = cue.text.slice(cut).trim();
	if (!first || !second) {
		return null;
	}
	const mid = midFromWordClocks(cue, at);
	if (mid === null) {
		return null;
	}
	const leftCount = wordSpans(first).length;
	const leftWords = cue.words?.slice(0, leftCount);
	const rightWords = cue.words?.slice(at);
	const left: Cue = {
		index,
		start: cue.start,
		end: Math.max(cue.start + MIN_SPAN, mid),
		text: first,
		words: leftWords && leftWords.length === leftCount ? leftWords : undefined,
	};
	const right: Cue = {
		index: index + 1,
		start: Math.min(mid, cue.end - MIN_SPAN),
		end: cue.end,
		text: second,
		words:
			rightWords && rightWords.length === wordSpans(second).length
				? rightWords
				: undefined,
	};
	if (!(left.end > left.start) || !(right.end > right.start)) {
		return null;
	}
	return reindex([...cues.slice(0, index), left, right, ...cues.slice(index + 1)]);
}

/** Split a long cue at the middle word when the user has not selected one. */
export function splitCueAtMidpoint(cues: Cue[], index: number): Cue[] | null {
	const cue = cues[index];
	if (!cue) {
		return null;
	}
	const n = wordSpans(cue.text).length;
	if (n < 2) {
		return null;
	}
	return splitCueBeforeWord(cues, index, Math.floor(n / 2));
}

export function nudgeCueEdge(
	cues: Cue[],
	index: number,
	edge: 'start' | 'end',
	delta: number,
): Cue[] | null {
	const cue = cues[index];
	if (!cue) {
		return null;
	}
	let start = cue.start;
	let end = cue.end;
	if (edge === 'start') {
		start = Math.max(0, start + delta);
		start = Math.min(start, end - MIN_SPAN);
	} else {
		end = Math.max(start + MIN_SPAN, end + delta);
	}
	if (start === cue.start && end === cue.end) {
		return null;
	}
	const next = cues.slice();
	next[index] = { ...cue, start, end };
	return next;
}
