import { describe, expect, it, vi } from 'vitest';
import { ListenView } from '../src/views/listen';
import type { BilibiliStream, ListenState } from '../src/views/listen';

/** A view carrying just enough identity to answer "is this my media?". */
function viewHolding(media: {
	video?: { path: string };
	youtube?: { videoId: string; title: string };
	bilibili?: BilibiliStream;
}) {
	const view = Object.create(ListenView.prototype) as Record<string, unknown>;
	view.currentVideo = media.video ?? null;
	view.currentYouTube = media.youtube ?? null;
	view.currentBilibili = media.bilibili ?? null;
	return view as unknown as {
		holdsMedia(state: ListenState): boolean;
		isVacant(): boolean;
	};
}

const stream: BilibiliStream = {
	bvid: 'BV1xD8q6ZEDR',
	page: 1,
	title: '万亿美元悖论',
	mediaUrl: 'https://x.bilivideo.com/v.mp4?deadline=1788433957',
	mediaSize: 7725547,
	expiresAt: 1788433957,
	notePath: 'Glean/Bilibili/note.md',
};

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

	it('recognises the Bilibili note it already holds', () => {
		const view = viewHolding({ bilibili: stream });
		const state: ListenState = {
			kind: 'bilibili',
			bvid: stream.bvid,
			mediaUrl: stream.mediaUrl,
			notePath: stream.notePath,
		};
		expect(view.holdsMedia(state)).toBe(true);
		expect(view.holdsMedia({ ...state, notePath: 'Glean/Bilibili/two.md' })).toBe(
			false,
		);
	});

	// The kinds must not answer for each other, or opening a video could evict
	// an unrelated session.
	it('does not match across media kinds', () => {
		const local = viewHolding({ video: { path: 'Media/hello.mp4' } });
		expect(local.holdsMedia({ kind: 'youtube', videoId: 'abc123', subtitlePath: '' })).toBe(
			false,
		);
		const remote = viewHolding({ youtube: { videoId: 'abc123', title: 'x' } });
		expect(remote.holdsMedia({ videoPath: 'Media/hello.mp4', subtitlePath: null })).toBe(false);
		expect(
			remote.holdsMedia({
				kind: 'bilibili',
				bvid: stream.bvid,
				mediaUrl: stream.mediaUrl,
				notePath: stream.notePath,
			}),
		).toBe(false);
	});

	it('reports an untouched tab as free to fill', () => {
		expect(viewHolding({}).isVacant()).toBe(true);
		expect(viewHolding({ video: { path: 'Media/hello.mp4' } }).isVacant()).toBe(false);
		expect(viewHolding({ bilibili: stream }).isVacant()).toBe(false);
	});
});

/**
 * A Bilibili id used to ride in `videoId`, which `openMedia` reads as "this is
 * YouTube" — the note then failed with "YouTube 视频 ID 无效".
 */
describe('routing a state to its player', () => {
	function routerView() {
		const view = Object.create(ListenView.prototype) as Record<string, unknown>;
		view.openBilibiliMedia = vi.fn(async () => undefined);
		view.openYouTubeMedia = vi.fn(async () => undefined);
		view.setStatus = vi.fn();
		view.app = { vault: { getAbstractFileByPath: () => null } };
		return view as unknown as {
			openMedia(state: ListenState): Promise<void>;
			openBilibiliMedia: ReturnType<typeof vi.fn>;
			openYouTubeMedia: ReturnType<typeof vi.fn>;
			setStatus: ReturnType<typeof vi.fn>;
		};
	}

	it('sends a Bilibili state to the Bilibili player', async () => {
		const view = routerView();
		await view.openMedia({
			kind: 'bilibili',
			bvid: stream.bvid,
			mediaUrl: stream.mediaUrl,
			notePath: stream.notePath,
			subtitlePath: 'sub.vtt',
		});
		expect(view.openBilibiliMedia).toHaveBeenCalledOnce();
		expect(view.openYouTubeMedia).not.toHaveBeenCalled();
	});

	it('sends a YouTube state to the YouTube player', async () => {
		const view = routerView();
		await view.openMedia({ kind: 'youtube', videoId: 'abc123' });
		expect(view.openYouTubeMedia).toHaveBeenCalledOnce();
		expect(view.openBilibiliMedia).not.toHaveBeenCalled();
	});

	it('explains a Bilibili state that lost its link', async () => {
		const view = routerView();
		await view.openMedia({ kind: 'bilibili', bvid: stream.bvid });
		expect(view.openBilibiliMedia).not.toHaveBeenCalled();
		expect(view.setStatus).toHaveBeenCalledWith('缺少 B 站播放地址');
	});
});

describe('sentence loop state', () => {
	it('restarts the active sentence when the loop stop is reached', () => {
		const view = Object.create(ListenView.prototype) as Record<string, unknown>;
		const source = {
			getPlaybackRate: () => 1,
			getCurrentTime: () => 4,
			seekTo: vi.fn(),
			play: vi.fn(),
			pause: vi.fn(),
		};
		view.sentenceMode = true;
		view.sentenceLoop = true;
		view.sentenceStart = 2;
		view.sentenceEnd = 4;
		view.sentenceArmed = true;
		view.source = source;
		view.sentenceStopTimer = null;
		view.clearSentenceStop = vi.fn();
		view.scheduleSentenceStop = vi.fn();

		(view.finishSentence as () => void)();

		expect(source.seekTo).toHaveBeenCalledWith(2);
		expect(source.play).toHaveBeenCalledOnce();
		expect(view.sentenceMode).toBe(true);
	});

	it('does not enable a loop without loaded subtitles', () => {
		const view = Object.create(ListenView.prototype) as Record<string, unknown>;
		view.cues = [];
		view.sentenceLoop = false;
		view.setStatus = vi.fn();
		view.syncSentenceLoopButton = vi.fn();

		(view.toggleSentenceLoop as () => void)();

		expect(view.sentenceLoop).toBe(false);
		expect(view.setStatus).toHaveBeenCalledWith('打开带字幕的媒体后才能循环句子');
	});
});
