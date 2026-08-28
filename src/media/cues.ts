import type { Cue } from './types';

/**
 * Find the cue that contains `time`. If the playhead sits in a gap,
 * return the most recent cue that already started.
 */
export function cueIndexAt(cues: Cue[], time: number): number {
	if (cues.length === 0) {
		return -1;
	}
	let lo = 0;
	let hi = cues.length - 1;
	let candidate = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const cue = cues[mid];
		if (cue === undefined) {
			break;
		}
		if (cue.start <= time) {
			candidate = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return candidate;
}

export function cueAt(cues: Cue[], time: number): Cue | null {
	const i = cueIndexAt(cues, time);
	return i >= 0 ? (cues[i] ?? null) : null;
}
