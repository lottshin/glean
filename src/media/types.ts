export interface Cue {
	index: number;
	start: number;
	end: number;
	text: string;
}

export type MediaKind = 'local' | 'youtube' | 'bilibili';

export interface MediaSource {
	readonly kind: MediaKind;
	attach(videoEl: HTMLVideoElement): void;
	detach(): void;
	load(srcUrl: string, cues: Cue[]): Promise<void>;
	play(): void;
	pause(): void;
	toggle(): void;
	seekTo(seconds: number): void;
	getCurrentTime(): number;
	getDuration(): number;
	setPlaybackRate(rate: number): void;
	getPlaybackRate(): number;
	getCues(): Cue[];
	onTimeUpdate(cb: (t: number) => void): () => void;
	onPlay(cb: () => void): () => void;
	onPause(cb: () => void): () => void;
}

export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v']);
export const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus']);
export const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt']);

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5];
