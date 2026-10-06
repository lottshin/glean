import type { Cue, MediaKind, MediaSource } from './types';
import { snapPlaybackRate } from '../youtube/rate';

interface YouTubePlayer {
	playVideo(): void;
	loadVideoById(options: { videoId: string; startSeconds: number; endSeconds: number }): void;
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

interface YouTubeBridgeMessage {
	source?: unknown;
	type?: unknown;
	state?: unknown;
	time?: unknown;
	duration?: unknown;
	code?: unknown;
}

export type YouTubePlaybackMode = 'direct' | 'bridge';

/** Served from docs/player/ via GitHub Pages; update if the repo slug changes. */
export const YOUTUBE_PLAYER_BRIDGE_URL = 'https://lottshin.github.io/glean/player/';

export function youtubePlayerVars(pageOrigin: string): Record<string, string | number> {
	const vars: Record<string, string | number> = {
		autoplay: 0,
		controls: 1,
		enablejsapi: 1,
		playsinline: 1,
		rel: 0,
		widget_referrer: 'https://obsidian.md',
	};
	vars.origin = /^https?:\/\//i.test(pageOrigin) ? pageOrigin : 'https://obsidian.md';
	return vars;
}

declare global {
	interface Window {
		YT?: YouTubeApi;
		onYouTubeIframeAPIReady?: () => void;
	}
}

let apiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeApi(): Promise<YouTubeApi> {
	if (window.YT?.Player) return Promise.resolve(window.YT);
	if (apiPromise) return apiPromise;
	apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
		const previous = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			previous?.();
			if (window.YT?.Player) resolve(window.YT);
			else reject(new Error('YouTube 播放器 API 加载失败'));
		};
		const existing = document.querySelector<HTMLScriptElement>(
			'script[src="https://www.youtube.com/iframe_api"]',
		);
		if (existing) return;
		const script = document.createElement('script');
		script.src = 'https://www.youtube.com/iframe_api';
		script.async = true;
		script.addEventListener('error', () => {
			apiPromise = null;
			reject(new Error('无法连接 YouTube 播放器 API'));
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
	private readonly mode: YouTubePlaybackMode;
	private container: HTMLElement | null = null;
	private player: YouTubePlayer | null = null;
	private bridgeFrame: HTMLIFrameElement | null = null;
	private bridgeReady = false;
	private bridgePlaying = false;
	private bridgeVideoId = '';
	private bridgeTime = 0;
	private bridgeDuration = 0;
	private bridgeRate = 1;
	private bridgeMessageHandler: ((event: MessageEvent) => void) | null = null;
	private bridgeReadyResolve: (() => void) | null = null;
	private bridgeReadyReject: ((error: Error) => void) | null = null;
	private cues: Cue[] = [];
	private pollTimer: number | null = null;
	private desiredRate = 1;
	private generation = 0;
	private currentVideoId = '';
	private segmentActive = false;
	private segmentEnd = 0;
	private segmentFrame: number | null = null;
	private timeListeners = new Set<(t: number) => void>();
	private playListeners = new Set<() => void>();
	private pauseListeners = new Set<() => void>();
	private segmentEndListeners = new Set<() => void>();
	private errorListeners = new Set<(message: string) => void>();

	constructor(mode: YouTubePlaybackMode = 'direct') {
		this.mode = mode;
	}

	isBridgeMode(): boolean {
		return this.mode === 'bridge';
	}

	attach(container: HTMLElement): void {
		this.detach();
		this.container = container;
		container.empty();
	}

	detach(): void {
		this.generation += 1;
		this.stopSegmentMonitor();
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.player?.destroy();
		this.player = null;
		if (this.bridgeMessageHandler) {
			window.removeEventListener('message', this.bridgeMessageHandler);
			this.bridgeMessageHandler = null;
		}
		this.bridgeReadyReject?.(new Error('YouTube 播放器已关闭'));
		this.bridgeReadyResolve = null;
		this.bridgeReadyReject = null;
		this.bridgeFrame = null;
		this.bridgeReady = false;
		this.bridgePlaying = false;
		this.bridgeVideoId = '';
		this.bridgeTime = 0;
		this.bridgeDuration = 0;
		this.currentVideoId = '';
		this.segmentActive = false;
		this.segmentEnd = 0;
		this.container?.empty();
		this.container = null;
		this.cues = [];
		this.timeListeners.clear();
		this.playListeners.clear();
		this.pauseListeners.clear();
		this.segmentEndListeners.clear();
		this.errorListeners.clear();
	}

	async load(videoId: string, cues: Cue[]): Promise<void> {
		if (!this.container) throw new Error('YouTubeSource is not attached');
		if (!/^[\w-]{11}$/.test(videoId)) throw new Error('YouTube 视频 ID 无效');
		if (this.mode === 'bridge') {
			await this.loadBridge(videoId, cues);
			return;
		}
		const generation = ++this.generation;
		this.currentVideoId = videoId;
		this.segmentActive = false;
		this.segmentEnd = 0;
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
				playerVars: youtubePlayerVars(window.location.origin),
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
						for (const listener of this.errorListeners) listener(message);
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

	private async loadBridge(videoId: string, cues: Cue[]): Promise<void> {
		if (!this.container) throw new Error('YouTubeSource is not attached');
		const generation = ++this.generation;
		this.segmentActive = false;
		this.segmentEnd = 0;
		this.bridgeVideoId = videoId;
		this.bridgeReady = false;
		this.bridgePlaying = false;
		this.bridgeTime = 0;
		this.bridgeDuration = 0;
		this.cues = cues;
		this.container.empty();
		const frame = this.container.createEl('iframe', {
			cls: 'glean-youtube-player-frame',
			attr: {
				title: 'YouTube 播放器',
				allow: 'autoplay; fullscreen; picture-in-picture',
				allowfullscreen: 'true',
				referrerpolicy: 'strict-origin-when-cross-origin',
				src: YOUTUBE_PLAYER_BRIDGE_URL,
			},
		});
		frame.allowFullscreen = true;
		this.bridgeFrame = frame;
		this.bridgeMessageHandler = (event) => this.onBridgeMessage(event, generation);
		window.addEventListener('message', this.bridgeMessageHandler);
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				this.bridgeReadyResolve = null;
				this.bridgeReadyReject = null;
				reject(new Error('移动端 YouTube 播放页加载超时'));
			}, 20_000);
			this.bridgeReadyResolve = () => {
				window.clearTimeout(timeout);
				this.bridgeReadyResolve = null;
				this.bridgeReadyReject = null;
				resolve();
			};
			this.bridgeReadyReject = (error) => {
				window.clearTimeout(timeout);
				this.bridgeReadyResolve = null;
				this.bridgeReadyReject = null;
				reject(error);
			};
		});
		if (generation !== this.generation || !this.bridgeReady) {
			throw new Error('YouTube 播放页已失效');
		}
		this.postBridge({ type: 'load', videoId });
	}

	play(): void {
		if (this.mode === 'bridge') {
			this.postBridge({ type: 'play' });
			return;
		}
		this.player?.playVideo();
	}

	pause(): void {
		if (this.mode === 'bridge') {
			this.postBridge({ type: 'pause' });
			return;
		}
		this.player?.pauseVideo();
	}

	toggle(): void {
		if (this.isPlaying()) this.pause();
		else this.play();
	}

	isPlaying(): boolean {
		return this.mode === 'bridge' ? this.bridgePlaying : this.player?.getPlayerState() === 1;
	}

	seekTo(seconds: number): void {
		this.cancelSegment();
		const target = Math.max(0, seconds);
		if (this.mode === 'bridge') {
			this.postBridge({ type: 'seek', seconds: target });
			return;
		}
		this.player?.seekTo(target, true);
	}

	getCurrentTime(): number {
		return this.mode === 'bridge' ? this.bridgeTime : (this.player?.getCurrentTime() ?? 0);
	}

	getDuration(): number {
		return this.mode === 'bridge' ? this.bridgeDuration : (this.player?.getDuration() ?? 0);
	}

	setPlaybackRate(rate: number): void {
		this.desiredRate = Number.isFinite(rate) ? rate : 1;
		if (this.mode === 'bridge') {
			this.bridgeRate = this.desiredRate;
			this.postBridge({ type: 'rate', rate: this.desiredRate });
			return;
		}
		this.applyPlaybackRate();
	}

	getPlaybackRate(): number {
		return this.mode === 'bridge'
			? this.bridgeRate
			: (this.player?.getPlaybackRate() ?? this.desiredRate);
	}

	getCues(): Cue[] {
		return this.cues;
	}

	playSegment(start: number, end: number): boolean {
		if (!(end > start)) return false;
		this.segmentActive = true;
		this.segmentEnd = end;
		if (this.mode === 'bridge') {
			if (!this.bridgeReady || !this.bridgeVideoId) {
				this.segmentActive = false;
				return false;
			}
			this.postBridge({ type: 'segment', start, end });
			return true;
		}
		if (!this.player || !this.currentVideoId) {
			this.segmentActive = false;
			return false;
		}
		this.player.loadVideoById({
			videoId: this.currentVideoId,
			startSeconds: Math.max(0, start),
			endSeconds: end,
		});
		return true;
	}

	cancelSegment(): void {
		if (!this.segmentActive) return;
		this.segmentActive = false;
		this.segmentEnd = 0;
		this.stopSegmentMonitor();
		if (this.mode === 'bridge') this.postBridge({ type: 'cancel-segment' });
		else this.player?.seekTo(this.player.getCurrentTime(), true);
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

	onSegmentEnd(cb: () => void): () => void {
		this.segmentEndListeners.add(cb);
		return () => this.segmentEndListeners.delete(cb);
	}

	onError(cb: (message: string) => void): () => void {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	private startPolling(): void {
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.pollTimer = window.setInterval(() => {
			const time = this.getCurrentTime();
			for (const listener of this.timeListeners) listener(time);
		}, 250);
	}

	private onStateChange(state: number): void {
		if (state === 0 && this.segmentActive) this.completeSegment();
		else if (state === 1 && this.segmentActive) this.startSegmentMonitor();
		else if (state === 2 && this.segmentActive) this.stopSegmentMonitor();
		const listeners = state === 1 ? this.playListeners : this.pauseListeners;
		if (state === 1 || state === 0 || state === 2 || state === 5) {
			for (const listener of listeners) listener();
		}
	}

	private onBridgeMessage(event: MessageEvent, generation: number): void {
		if (
			generation !== this.generation ||
			event.source !== this.bridgeFrame?.contentWindow ||
			event.origin !== new URL(YOUTUBE_PLAYER_BRIDGE_URL).origin
		) return;
		const data = event.data as YouTubeBridgeMessage;
		if (!data || data.source !== 'glean-youtube-bridge' || typeof data.type !== 'string') return;
		switch (data.type) {
			case 'ready':
				this.bridgeReady = true;
				this.bridgeReadyResolve?.();
				break;
			case 'time':
				if (typeof data.time === 'number' && Number.isFinite(data.time)) this.bridgeTime = data.time;
				if (typeof data.duration === 'number' && Number.isFinite(data.duration)) this.bridgeDuration = data.duration;
				for (const listener of this.timeListeners) listener(this.bridgeTime);
				if (this.segmentActive && this.bridgeTime >= this.segmentEnd) this.completeSegment();
				break;
			case 'state':
				if (data.state === 1) {
					this.bridgePlaying = true;
					for (const listener of this.playListeners) listener();
				} else if (data.state === 0 || data.state === 2) {
					this.bridgePlaying = false;
					if (data.state === 0 && this.segmentActive) this.completeSegment();
					for (const listener of this.pauseListeners) listener();
				}
				break;
			case 'segment-end':
				this.completeSegment();
				break;
			case 'error': {
				const code = typeof data.code === 'number' ? data.code : 0;
				const message = code ? youtubePlayerError(code) : '移动端 YouTube 播放失败';
				for (const listener of this.errorListeners) listener(message);
				this.bridgeReadyReject?.(new Error(message));
				break;
			}
		}
	}

	private postBridge(message: Record<string, unknown>): void {
		if (!this.bridgeFrame?.contentWindow) return;
		this.bridgeFrame.contentWindow.postMessage(
			{ source: 'glean-youtube-host', ...message },
			new URL(YOUTUBE_PLAYER_BRIDGE_URL).origin,
		);
	}

	private startSegmentMonitor(): void {
		if (this.segmentFrame !== null || !this.segmentActive) return;
		const tick = () => {
			this.segmentFrame = null;
			if (!this.segmentActive || !this.player) return;
			if (this.player.getCurrentTime() >= this.segmentEnd) {
				this.player.pauseVideo();
				this.completeSegment();
				return;
			}
			this.segmentFrame = window.requestAnimationFrame(tick);
		};
		this.segmentFrame = window.requestAnimationFrame(tick);
	}

	private stopSegmentMonitor(): void {
		if (this.segmentFrame !== null) {
			window.cancelAnimationFrame(this.segmentFrame);
			this.segmentFrame = null;
		}
	}

	private completeSegment(): void {
		if (!this.segmentActive) return;
		this.segmentActive = false;
		this.segmentEnd = 0;
		this.stopSegmentMonitor();
		for (const listener of this.segmentEndListeners) listener();
	}

	private applyPlaybackRate(): void {
		if (!this.player) return;
		const available = this.player.getAvailablePlaybackRates();
		this.player.setPlaybackRate(snapPlaybackRate(this.desiredRate, available));
	}
}
