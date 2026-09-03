import { describe, expect, it } from 'vitest';

import { cuesFromTimedText, timedTextToWebVtt } from '../src/youtube/vtt';

/** Rolling-ASR style payload roughly matching a mid-length YouTube talk. */
function buildPayload(nEvents: number) {
	const vocab =
		'so yes guys I am here in Shanghai today and we are going to walk around the city because people say it is amazing but honestly you have to see it for yourself right now the weather is nice welcome to China all right let us go over there and grab some food first'.split(
			' ',
		);
	const events = [];
	let t = 1000;
	for (let i = 0; i < nEvents; i += 1) {
		const wordsPerEvent = 1 + (i % 3);
		const segs = [];
		for (let w = 0; w < wordsPerEvent; w += 1) {
			segs.push({
				utf8: `${vocab[(i * 3 + w) % vocab.length] ?? 'the'} `,
				tOffsetMs: w * 180,
			});
		}
		events.push({ tStartMs: t, dDurationMs: 600, segs });
		t += 650;
	}
	return { events };
}

describe('segmentation speed', () => {
	it(
		'segments 1500 events in under 8s after cache/fast-path work',
		() => {
			const payload = buildPayload(1500);
			const start = performance.now();
			const cues = cuesFromTimedText(payload);
			const ms = performance.now() - start;
			const vtt = timedTextToWebVtt(payload);
			// eslint-disable-next-line no-console
			console.log(
				`1500 events -> ${cues.length} cues in ${ms.toFixed(0)}ms; segmented=${/glean-segmented/i.test(vtt)}`,
			);
			expect(cues.length).toBeGreaterThan(50);
			expect(ms).toBeLessThan(8000);
			expect(vtt).toMatch(/NOTE\s+glean-segmented/i);
		},
		30000,
	);
});
