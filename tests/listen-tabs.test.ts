import { describe, expect, it } from 'vitest';
import { ListenView } from '../src/views/listen';
import type { ListenState } from '../src/views/listen';

/** A view carrying just enough identity to answer "is this my media?". */
function viewHolding(media: {
	video?: { path: string };
	youtube?: { videoId: string; title: string };
}) {
	const view = Object.create(ListenView.prototype) as Record<string, unknown>;
	view.currentVideo = media.video ?? null;
	view.currentYouTube = media.youtube ?? null;
	return view as unknown as {
		holdsMedia(state: ListenState): boolean;
		isVacant(): boolean;
	};
}

describe('choosing which listening tab to reuse', () => {
	it('recognises the local file it already holds', () => {
		const view = viewHolding({ video: { path: 'Media/hello.mp4' } });
		expect(view.holdsMedia({ videoPath: 'Media/hello.mp4', subtitlePath: null })).toBe(true);
		expect(view.holdsMedia({ videoPath: 'Media/other.mp4', subtitlePath: null })).toBe(false);
	});

	it('recognises the YouTube video it already holds', () => {
		const view = viewHolding({ youtube: { videoId: 'abc123', title: 'x' } });
		const state: ListenState = {
			kind: 'youtube',
			videoId: 'abc123',
			subtitlePath: 'Subs/abc123.vtt',
		};
		expect(view.holdsMedia(state)).toBe(true);
		expect(view.holdsMedia({ ...state, videoId: 'zzz999' })).toBe(false);
	});

	// The two kinds must not answer for each other, or opening a video could
	// evict an unrelated YouTube session.
	it('does not match across media kinds', () => {
		const local = viewHolding({ video: { path: 'Media/hello.mp4' } });
		expect(local.holdsMedia({ kind: 'youtube', videoId: 'abc123', subtitlePath: '' })).toBe(
			false,
		);
		const remote = viewHolding({ youtube: { videoId: 'abc123', title: 'x' } });
		expect(remote.holdsMedia({ videoPath: 'Media/hello.mp4', subtitlePath: null })).toBe(false);
	});

	it('reports an untouched tab as free to fill', () => {
		expect(viewHolding({}).isVacant()).toBe(true);
		expect(viewHolding({ video: { path: 'Media/hello.mp4' } }).isVacant()).toBe(false);
	});
});
