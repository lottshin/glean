import { stopSpeech } from './tts';

let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;

export function stopCommunityAudio(): void {
	if (currentAudio) {
		currentAudio.pause();
		currentAudio.src = '';
		currentAudio = null;
	}
	if (currentObjectUrl) {
		URL.revokeObjectURL(currentObjectUrl);
		currentObjectUrl = null;
	}
}

/** Stop both community clips and system TTS. */
export function stopAllSpeech(): void {
	stopCommunityAudio();
	stopSpeech();
}

/**
 * Play a remote pronunciation. Prefer a blob so Obsidian does not depend on
 * media-element CORS for every CDN the community APIs point at.
 */
export async function playAudioBuffer(
	data: ArrayBuffer,
	mimeType = 'audio/mpeg',
): Promise<void> {
	stopAllSpeech();
	const blob = new Blob([data], { type: mimeType });
	const objectUrl = URL.createObjectURL(blob);
	currentObjectUrl = objectUrl;
	const audio = new Audio(objectUrl);
	currentAudio = audio;
	await new Promise<void>((resolve, reject) => {
		audio.onended = () => {
			if (currentAudio === audio) {
				currentAudio = null;
			}
			if (currentObjectUrl === objectUrl) {
				URL.revokeObjectURL(objectUrl);
				currentObjectUrl = null;
			}
			resolve();
		};
		audio.onerror = () => {
			if (currentAudio === audio) {
				currentAudio = null;
			}
			if (currentObjectUrl === objectUrl) {
				URL.revokeObjectURL(objectUrl);
				currentObjectUrl = null;
			}
			reject(new Error('音频播放失败'));
		};
		void audio.play().catch((error) => {
			reject(error instanceof Error ? error : new Error('音频播放失败'));
		});
	});
}

export function guessAudioMime(url: string): string {
	const lower = url.toLowerCase();
	if (lower.includes('.ogg') || lower.includes('.oga')) {
		return 'audio/ogg';
	}
	if (lower.includes('.wav')) {
		return 'audio/wav';
	}
	if (lower.includes('.flac')) {
		return 'audio/flac';
	}
	return 'audio/mpeg';
}
