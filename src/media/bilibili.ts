import type { Cue, MediaKind, MediaSource } from './types';

export class BilibiliSource implements MediaSource {
	readonly kind: MediaKind = 'bilibili';

	attach(_videoEl: HTMLVideoElement): void {
		throw new Error('BilibiliSource is not implemented yet (planned for v3)');
	}

	detach(): void {}

	async load(_srcUrl: string, _cues: Cue[]): Promise<void> {
		throw new Error('BilibiliSource is not implemented yet (planned for v3)');
	}

	play(): void {
		throw new Error('BilibiliSource is not implemented yet (planned for v3)');
	}

	pause(): void {
		throw new Error('BilibiliSource is not implemented yet (planned for v3)');
	}

	toggle(): void {
		throw new Error('BilibiliSource is not implemented yet (planned for v3)');
	}

	seekTo(_seconds: number): void {
		throw new Error('BilibiliSource is not implemented yet (planned for v3)');
	}

	getCurrentTime(): number {
		return 0;
	}

	getDuration(): number {
		return 0;
	}

	setPlaybackRate(_rate: number): void {}

	getPlaybackRate(): number {
		return 1;
	}

	getCues(): Cue[] {
		return [];
	}

	onTimeUpdate(_cb: (t: number) => void): () => void {
		return () => {};
	}

	onPlay(_cb: () => void): () => void {
		return () => {};
	}

	onPause(_cb: () => void): () => void {
		return () => {};
	}
}
