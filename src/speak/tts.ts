/**
 * System speech for a single English word. No network, no audio pack — the
 * machine's installed voices are the whole source.
 */

export type SpeakAccent = 'auto' | 'en-US' | 'en-GB';

export interface SpeakVoiceLike {
	lang: string;
	name: string;
	localService?: boolean;
	default?: boolean;
}

/** Prefer a local English voice matching the accent; fall back gracefully. */
export function pickEnglishVoice<T extends SpeakVoiceLike>(
	voices: readonly T[],
	accent: SpeakAccent,
): T | null {
	if (voices.length === 0) {
		return null;
	}
	const english = voices.filter((voice) => /^en(?:[-_]|$)/i.test(voice.lang));
	const pool = english.length > 0 ? english : voices;

	const prefer = (predicate: (voice: T) => boolean): T | null =>
		pool.find(predicate) ?? null;

	if (accent === 'en-GB') {
		return (
			prefer((voice) => /^en-GB/i.test(voice.lang)) ??
			prefer((voice) => /british|uk english|daniel|serena|martha/i.test(voice.name)) ??
			prefer((voice) => voice.localService !== false) ??
			pool[0] ??
			null
		);
	}
	if (accent === 'en-US') {
		return (
			prefer((voice) => /^en-US/i.test(voice.lang)) ??
			prefer((voice) => /american|us english|samantha|alex|victoria/i.test(voice.name)) ??
			prefer((voice) => voice.localService !== false) ??
			pool[0] ??
			null
		);
	}
	// auto: local English first, then whatever the system marked default.
	return (
		prefer((voice) => voice.localService !== false && /^en(?:[-_]|$)/i.test(voice.lang)) ??
		prefer((voice) => voice.default === true && /^en(?:[-_]|$)/i.test(voice.lang)) ??
		prefer((voice) => /^en(?:[-_]|$)/i.test(voice.lang)) ??
		prefer((voice) => voice.localService !== false) ??
		pool[0] ??
		null
	);
}

export function accentLanguage(accent: SpeakAccent): string {
	return accent === 'en-GB' ? 'en-GB' : 'en-US';
}

export function canUseSpeechSynthesis(
	speech: SpeechSynthesis | undefined = window.speechSynthesis,
): boolean {
	return Boolean(speech && typeof speech.speak === 'function');
}

export function stopSpeech(
	speech: SpeechSynthesis | undefined = window.speechSynthesis,
): void {
	speech?.cancel();
}

/**
 * Speak one word/phrase. Resolves when utterance ends or is cancelled.
 * Rejects only when the API itself is missing.
 */
export async function speakWithTts(
	text: string,
	accent: SpeakAccent = 'auto',
	speech: SpeechSynthesis | undefined = window.speechSynthesis,
): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) {
		return;
	}
	if (!canUseSpeechSynthesis(speech) || !speech) {
		throw new Error('这台设备不支持系统朗读');
	}

	speech.cancel();

	const voices = await loadVoices(speech);
	const utter = new SpeechSynthesisUtterance(trimmed);
	utter.lang = accentLanguage(accent);
	utter.rate = 0.95;
	const voice = pickEnglishVoice(voices, accent);
	if (voice) {
		utter.voice = voice;
		if (!utter.lang.startsWith('en')) {
			utter.lang = voice.lang;
		}
	}

	await new Promise<void>((resolve, reject) => {
		utter.onend = () => resolve();
		utter.onerror = (event) => {
			// Cancelled mid-utterance is not a failure worth a Notice.
			if (event.error === 'canceled' || event.error === 'interrupted') {
				resolve();
				return;
			}
			reject(new Error('朗读失败'));
		};
		speech.speak(utter);
	});
}

function loadVoices(speech: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
	const existing = speech.getVoices();
	if (existing.length > 0) {
		return Promise.resolve(existing);
	}
	return new Promise((resolve) => {
		const finish = () => {
			speech.removeEventListener('voiceschanged', finish);
			resolve(speech.getVoices());
		};
		speech.addEventListener('voiceschanged', finish);
		// Some engines never fire the event; don't hang the button.
		window.setTimeout(finish, 300);
	});
}
