/**
 * Snap a requested playback rate to the nearest value YouTube actually allows.
 * When the available list is empty, return the requested rate unchanged.
 */
export function snapPlaybackRate(
	requested: number,
	available: number[],
): number {
	if (!Number.isFinite(requested)) {
		return 1;
	}
	if (available.length === 0) {
		return requested;
	}
	let best = available[0]!;
	let bestDistance = Math.abs(best - requested);
	for (const rate of available) {
		const distance = Math.abs(rate - requested);
		if (
			distance < bestDistance ||
			(distance === bestDistance && rate > best)
		) {
			best = rate;
			bestDistance = distance;
		}
	}
	return best;
}
