import type { Cue } from './types';

export type TimelineWord = { text: string; start: number };

/** Full-video ASR word clock list, written once near the top of synced VTT. */
export const GLEAN_TIMELINE_PREFIX = 'NOTE glean-timeline';

function normToken(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9'+-]+/gi, '');
}

export function formatGleanTimelineNote(words: TimelineWord[]): string {
	const body = words
		.map((word) => `${word.start.toFixed(3)}:${word.text.replace(/[\s:]+/g, '_')}`)
		.join(' ');
	return `${GLEAN_TIMELINE_PREFIX} ${body}`;
}

export function parseGleanTimelineNote(line: string): TimelineWord[] | null {
	const match = line.trim().match(/^NOTE\s+glean-timeline\s+(.+)$/i);
	if (!match?.[1]) {
		return null;
	}
	const words: TimelineWord[] = [];
	for (const token of match[1].trim().split(/\s+/)) {
		const sep = token.indexOf(':');
		if (sep <= 0) {
			continue;
		}
		const start = Number(token.slice(0, sep));
		const text = token.slice(sep + 1).replace(/_/g, ' ');
		if (!Number.isFinite(start) || !text) {
			continue;
		}
		words.push({ text, start });
	}
	return words.length > 0 ? words : null;
}

/** Extract the first glean-timeline note from a VTT/SRT body. */
export function extractGleanTimeline(input: string): TimelineWord[] | null {
	for (const line of input.split(/\r?\n/)) {
		const parsed = parseGleanTimelineNote(line);
		if (parsed) {
			return parsed;
		}
	}
	return null;
}

function cueTokens(text: string): string[] {
	const word = /[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu;
	return [...text.matchAll(word)].map((match) => match[0]);
}

/**
 * Align cue text to the video-wide ASR timeline and recover per-word starts.
 * Used when a cue lost its NOTE glean-words (old edits) but the file still
 * carries NOTE glean-timeline from sync.
 */
export function alignWordsFromTimeline(
	text: string,
	cueStart: number,
	timeline: TimelineWord[],
): TimelineWord[] | null {
	const tokens = cueTokens(text);
	if (tokens.length === 0 || timeline.length < tokens.length) {
		return null;
	}
	const want = tokens.map(normToken);
	let best: TimelineWord[] | null = null;
	let bestDelta = Infinity;
	const limit = timeline.length - tokens.length;
	for (let i = 0; i <= limit; i += 1) {
		let ok = true;
		for (let j = 0; j < tokens.length; j += 1) {
			if (normToken(timeline[i + j]?.text ?? '') !== want[j]) {
				ok = false;
				break;
			}
		}
		if (!ok) {
			continue;
		}
		const slice = timeline.slice(i, i + tokens.length);
		const delta = Math.abs((slice[0]?.start ?? 0) - cueStart);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = slice.map((word, index) => ({
				text: tokens[index] ?? word.text,
				start: word.start,
			}));
		}
	}
	if (!best || bestDelta > 8) {
		return null;
	}
	return best;
}

/** Fill missing cue.words from a video-wide timeline when possible. */
export function hydrateCueWordsFromTimeline(
	cues: Cue[],
	timeline: TimelineWord[] | null,
): Cue[] {
	if (!timeline || timeline.length === 0) {
		return cues;
	}
	return cues.map((cue) => {
		const tokenCount = cueTokens(cue.text).length;
		if (cue.words && cue.words.length === tokenCount) {
			return cue;
		}
		const aligned = alignWordsFromTimeline(cue.text, cue.start, timeline);
		if (!aligned) {
			return cue;
		}
		return { ...cue, words: aligned };
	});
}

export function timelineFromCues(
	cues: Array<{ words?: TimelineWord[] }>,
): TimelineWord[] {
	const out: TimelineWord[] = [];
	for (const cue of cues) {
		if (!cue.words) {
			continue;
		}
		for (const word of cue.words) {
			out.push({ text: word.text, start: word.start });
		}
	}
	return out;
}

/** True when the cut word has a real ASR start after the opener. */
export function wordClocksAdvanceAt(
	words: TimelineWord[] | undefined,
	text: string,
	at: number,
): boolean {
	if (!words || words.length !== cueTokens(text).length) {
		return false;
	}
	const leftStart = words[0]?.start;
	const boundary = words[at]?.start;
	if (typeof leftStart !== 'number' || typeof boundary !== 'number') {
		return false;
	}
	if (boundary > leftStart + 0.05) {
		return true;
	}
	return words.slice(at).some((word) => word.start > leftStart + 0.05);
}
