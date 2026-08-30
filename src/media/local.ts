import type { Cue, MediaKind, MediaSource } from './types';

export class LocalFileSource implements MediaSource {
	readonly kind: MediaKind = 'local';

	private videoEl: HTMLVideoElement | null = null;
	private cues: Cue[] = [];
	private timeListeners = new Set<(t: number) => void>();
	private playListeners = new Set<() => void>();
	private pauseListeners = new Set<() => void>();
	private boundTimeUpdate = () => this.emitTime();
	private boundPlay = () => this.emitPlay();
	private boundPause = () => this.emitPause();

	attach(videoEl: HTMLVideoElement): void {
		this.detach();
		this.videoEl = videoEl;
		videoEl.addEventListener('timeupdate', this.boundTimeUpdate);
		videoEl.addEventListener('play', this.boundPlay);
		videoEl.addEventListener('pause', this.boundPause);
		videoEl.addEventListener('seeked', this.boundTimeUpdate);
	}

	detach(): void {
		if (this.videoEl) {
			this.videoEl.removeEventListener('timeupdate', this.boundTimeUpdate);
			this.videoEl.removeEventListener('play', this.boundPlay);
			this.videoEl.removeEventListener('pause', this.boundPause);
			this.videoEl.removeEventListener('seeked', this.boundTimeUpdate);
			this.videoEl.removeAttribute('src');
			this.videoEl.load();
		}
		this.videoEl = null;
		this.cues = [];
		this.timeListeners.clear();
		this.playListeners.clear();
		this.pauseListeners.clear();
	}

	async load(srcUrl: string, cues: Cue[]): Promise<void> {
		if (!this.videoEl) {
			throw new Error('LocalFileSource is not attached');
		}
		this.cues = cues;
		this.videoEl.src = srcUrl;
		this.videoEl.load();
		await waitForCanPlay(this.videoEl);
	}

	play(): void {
		const el = this.videoEl;
		if (!el) {
			return;
		}
		el.muted = false;
		const result = el.play();
		if (result !== undefined) {
			void result.catch(() => {
				// Autoplay may be blocked until a gesture; toolbar/space still retry.
			});
		}
	}

	pause(): void {
		this.videoEl?.pause();
	}

	toggle(): void {
		if (!this.videoEl) {
			return;
		}
		if (this.videoEl.paused) {
			this.play();
		} else {
			this.pause();
		}
	}

	seekTo(seconds: number): void {
		if (!this.videoEl) {
			return;
		}
		this.videoEl.currentTime = Math.max(0, seconds);
	}

	getCurrentTime(): number {
		return this.videoEl?.currentTime ?? 0;
	}

	getDuration(): number {
		const d = this.videoEl?.duration;
		return d !== undefined && Number.isFinite(d) ? d : 0;
	}

	setPlaybackRate(rate: number): void {
		if (this.videoEl) {
			this.videoEl.playbackRate = rate;
		}
	}

	getPlaybackRate(): number {
		return this.videoEl?.playbackRate ?? 1;
	}

	getCues(): Cue[] {
		return this.cues;
	}

	onTimeUpdate(cb: (t: number) => void): () => void {
		this.timeListeners.add(cb);
		return () => this.timeListeners.delete(cb);
	}

	onPlay(cb: () => void): () => void {
		this.playListeners.add(cb);
		return () => this.playListeners.delete(cb);
	}

	onPause(cb: () => void): () => void {
		this.pauseListeners.add(cb);
		return () => this.pauseListeners.delete(cb);
	}

	private emitTime(): void {
		const t = this.getCurrentTime();
		for (const cb of this.timeListeners) {
			cb(t);
		}
	}

	private emitPlay(): void {
		for (const cb of this.playListeners) {
			cb();
		}
	}

	private emitPause(): void {
		for (const cb of this.pauseListeners) {
			cb();
		}
	}
}

function waitForCanPlay(video: HTMLVideoElement): Promise<void> {
	if (video.readyState >= 2) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			cleanup();
			reject(new Error('Timed out loading video'));
		}, 20_000);
		const onReady = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error('Failed to load video'));
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			video.removeEventListener('canplay', onReady);
			video.removeEventListener('error', onError);
		};
		video.addEventListener('canplay', onReady);
		video.addEventListener('error', onError);
	});
}
