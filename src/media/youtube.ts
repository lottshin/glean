import type { Cue, MediaKind, MediaSource } from './types';
import { snapPlaybackRate } from '../youtube/rate';

interface YouTubePlayer {
	playVideo(): void;
	pauseVideo(): void;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	getCurrentTime(): number;
	getDuration(): number;
	getPlayerState(): number;
	setPlaybackRate(rate: number): void;
	getPlaybackRate(): number;
	getAvailablePlaybackRates(): number[];
	getIframe(): HTMLIFrameElement;
	destroy(): void;
}

interface YouTubeApi {
	Player: new (
		element: HTMLElement,
		options: {
			host?: string;
			videoId: string;
			playerVars: Record<string, string | number>;
			events: {
				onReady: () => void;
				onStateChange: (event: { data: number }) => void;
				onPlaybackRateChange: () => void;
				onError: (event: { data: number }) => void;
			};
		},
	) => YouTubePlayer;
}

declare global {
	interface Window {
		YT?: YouTubeApi;
		onYouTubeIframeAPIReady?: () => void;
	}
}

let apiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeApi(): Promise<YouTubeApi> {
	if (window.YT?.Player) {
		return Promise.resolve(window.YT);
	}
	if (apiPromise) {
		return apiPromise;
	}
	apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
		const previous = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			previous?.();
			if (window.YT?.Player) {
				resolve(window.YT);
			} else {
				reject(new Error('YouTube Player API 加载失败'));
			}
		};
		const existing = document.querySelector<HTMLScriptElement>(
			'script[src="https://www.youtube.com/iframe_api"]',
		);
		if (existing) {
			return;
		}
		const script = document.createElement('script');
		script.src = 'https://www.youtube.com/iframe_api';
		script.async = true;
		script.addEventListener('error', () => {
			apiPromise = null;
			reject(new Error('无法连接 YouTube Player API'));
		});
		document.head.appendChild(script);
	});
	return apiPromise;
}

export function youtubePlayerError(code: number): string {
	switch (code) {
		case 2:
			return 'YouTube 视频 ID 无效';
		case 5:
			return '当前设备无法播放这个 YouTube 视频';
		case 100:
			return 'YouTube 视频不存在、已删除或设为私密';
		case 101:
		case 150:
			return '视频作者禁止在 YouTube 之外嵌入播放';
		case 153:
			return '当前 Obsidian 环境无法向 YouTube 提供嵌入来源信息（Error 153）';
		default:
			return `YouTube 播放失败（Error ${code}）`;
	}
}

export class YouTubeSource implements MediaSource {
	readonly kind: MediaKind = 'youtube';
	private container: HTMLElement | null = null;
	private player: YouTubePlayer | null = null;
	private cues: Cue[] = [];
	private pollTimer: number | null = null;
	private desiredRate = 1;
	private generation = 0;
	private timeListeners = new Set<(t: number) => void>();
	private playListeners = new Set<() => void>();
	private pauseListeners = new Set<() => void>();
	private errorListeners = new Set<(message: string) => void>();

	attach(container: HTMLElement): void {
		this.detach();
		this.container = container;
		container.empty();
	}

	detach(): void {
		this.generation += 1;
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.player?.destroy();
		this.player = null;
		this.container?.empty();
		this.container = null;
		this.cues = [];
		this.timeListeners.clear();
		this.playListeners.clear();
		this.pauseListeners.clear();
		this.errorListeners.clear();
	}

	async load(videoId: string, cues: Cue[]): Promise<void> {
		if (!this.container) {
			throw new Error('YouTubeSource is not attached');
		}
		if (!/^[\w-]{11}$/.test(videoId)) {
			throw new Error('YouTube 视频 ID 无效');
		}
		const generation = ++this.generation;
		this.player?.destroy();
		this.player = null;
		this.container.empty();
		const target = this.container.createDiv({ cls: 'glean-youtube-player' });
		const api = await loadYouTubeApi();
		this.cues = cues;

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timeout = window.setTimeout(() => {
				if (!settled) {
					settled = true;
					player.destroy();
					reject(new Error('YouTube 播放器加载超时'));
				}
			}, 20_000);
			const player = new api.Player(target, {
				host: 'https://www.youtube-nocookie.com',
				videoId,
				playerVars: {
					autoplay: 0,
					controls: 1,
					enablejsapi: 1,
					playsinline: 1,
					rel: 0,
					origin: window.location.origin,
				},
				events: {
					onReady: () => {
						if (generation !== this.generation) {
							player.destroy();
							return;
						}
						this.player = player;
						player.getIframe().referrerPolicy = 'strict-origin-when-cross-origin';
						this.applyPlaybackRate();
						this.startPolling();
						if (!settled) {
							settled = true;
							window.clearTimeout(timeout);
							resolve();
						}
					},
					onStateChange: ({ data }) => this.onStateChange(data),
					onPlaybackRateChange: () => undefined,
					onError: ({ data }) => {
						const message = youtubePlayerError(data);
						for (const listener of this.errorListeners) {
							listener(message);
						}
						if (!settled) {
							settled = true;
							window.clearTimeout(timeout);
							player.destroy();
							reject(new Error(message));
						}
					},
				},
			});
		});
	}

	play(): void {
		this.player?.playVideo();
	}

	pause(): void {
		this.player?.pauseVideo();
	}

	toggle(): void {
		if (this.isPlaying()) {
			this.pause();
		} else {
			this.play();
		}
	}

	isPlaying(): boolean {
		return this.player?.getPlayerState() === 1;
	}

	seekTo(seconds: number): void {
		this.player?.seekTo(Math.max(0, seconds), true);
	}

	getCurrentTime(): number {
		return this.player?.getCurrentTime() ?? 0;
	}

	getDuration(): number {
		return this.player?.getDuration() ?? 0;
	}

	setPlaybackRate(rate: number): void {
		this.desiredRate = Number.isFinite(rate) ? rate : 1;
		this.applyPlaybackRate();
	}

	getPlaybackRate(): number {
		return this.player?.getPlaybackRate() ?? this.desiredRate;
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

	onError(cb: (message: string) => void): () => void {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	private startPolling(): void {
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
		}
		this.pollTimer = window.setInterval(() => {
			const time = this.getCurrentTime();
			for (const listener of this.timeListeners) {
				listener(time);
			}
		}, 250);
	}

	private onStateChange(state: number): void {
		const listeners = state === 1 ? this.playListeners : this.pauseListeners;
		if (state === 1 || state === 0 || state === 2 || state === 5) {
			for (const listener of listeners) {
				listener();
			}
		}
	}

	private applyPlaybackRate(): void {
		if (!this.player) {
			return;
		}
		const available = this.player.getAvailablePlaybackRates();
		this.player.setPlaybackRate(snapPlaybackRate(this.desiredRate, available));
	}
}
