import type { Cue } from './types';

/**
 * Find the cue that contains `time` ([start, end)).
 * Gaps between cues return -1 so the UI does not keep highlighting a finished
 * sentence over music/silence after seeking.
 */
export function cueIndexAt(cues: Cue[], time: number): number {
	if (cues.length === 0 || time < 0) {
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
	if (candidate < 0) {
		return -1;
	}
	const active = cues[candidate];
	if (!active) {
		return -1;
	}
	// Small grace so end-boundary flicker does not clear the active row.
	if (time >= active.end + 0.05) {
		return -1;
	}
	return candidate;
}

export function cueAt(cues: Cue[], time: number): Cue | null {
	const i = cueIndexAt(cues, time);
	return i >= 0 ? (cues[i] ?? null) : null;
}
