import type { Cue } from '../media/types';

export interface WordClipWindow {
	start: number;
	end: number;
	/** True when the window came from ASR word clocks, not the whole cue. */
	fromWordClock: boolean;
}

/**
 * Audio window for "hear this word in the video". Prefer the ASR stamp; when
 * the cue lost its word clocks, fall back to the whole sentence so the button
 * still does something useful in listen view.
 */
export function wordClipWindow(
	cue: Cue,
	wordIndex: number,
): WordClipWindow | null {
	const words = cue.words;
	const stamped =
		words &&
		wordIndex >= 0 &&
		wordIndex < words.length &&
		typeof words[wordIndex]?.start === 'number'
			? words[wordIndex]
			: null;

	if (!stamped) {
		if (!(cue.end > cue.start)) {
			return null;
		}
		return { start: cue.start, end: cue.end, fromWordClock: false };
	}

	const next = words?.[wordIndex + 1];
	const start = Math.max(cue.start, stamped.start);
	// Next word's onset is the natural cut; pad short function words a little
	// so "a" / "the" are still audible after seek jitter.
	let end = next ? next.start : cue.end;
	end = Math.max(end, start + 0.35);
	end = Math.min(end, Math.max(cue.end, start + 0.35));
	if (!(end > start)) {
		return null;
	}
	return { start, end, fromWordClock: true };
}
