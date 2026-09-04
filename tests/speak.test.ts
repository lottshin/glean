import { describe, expect, it } from 'vitest';

import {
	accentLanguage,
	pickEnglishVoice,
	type SpeakVoiceLike,
} from '../src/speak/tts';
import { wordClipWindow } from '../src/speak/word-clip';

describe('pickEnglishVoice', () => {
	const voices: SpeakVoiceLike[] = [
		{ lang: 'zh-CN', name: 'Tingting', localService: true },
		{ lang: 'en-GB', name: 'Daniel', localService: true },
		{ lang: 'en-US', name: 'Samantha', localService: true },
		{ lang: 'en-US', name: 'Google US English', localService: false },
	];

	it('prefers a British voice when asked', () => {
		expect(pickEnglishVoice(voices, 'en-GB')?.name).toBe('Daniel');
	});

	it('prefers an American voice when asked', () => {
		expect(pickEnglishVoice(voices, 'en-US')?.name).toBe('Samantha');
	});

	it('auto-picks a local English voice over a remote one', () => {
		expect(pickEnglishVoice(voices, 'auto')?.localService).toBe(true);
		expect(pickEnglishVoice(voices, 'auto')?.lang.startsWith('en')).toBe(true);
	});

	it('returns null when the engine has no voices at all', () => {
		expect(pickEnglishVoice([], 'auto')).toBeNull();
	});

	it('does not borrow a US voice when British was requested', () => {
		expect(
			pickEnglishVoice(
				[
					{ lang: 'en-US', name: 'Samantha', localService: true },
					{ lang: 'zh-CN', name: 'Tingting', localService: true },
				],
				'en-GB',
			),
		).toBeNull();
	});

	it('does not fall back to a non-English voice for an explicit accent', () => {
		expect(
			pickEnglishVoice([{ lang: 'zh-CN', name: 'Tingting' }], 'en-US'),
		).toBeNull();
	});
});

describe('accentLanguage', () => {
	it('maps the setting onto a BCP 47 tag', () => {
		expect(accentLanguage('en-GB')).toBe('en-GB');
		expect(accentLanguage('en-US')).toBe('en-US');
		expect(accentLanguage('auto')).toBe('en-US');
	});
});

describe('wordClipWindow', () => {
	const cue = {
		index: 0,
		start: 10,
		end: 14,
		text: 'Space plays or pauses',
		words: [
			{ text: 'Space', start: 10.1 },
			{ text: 'plays', start: 10.6 },
			{ text: 'or', start: 11.2 },
			{ text: 'pauses', start: 11.5 },
		],
	};

	it('cuts at the next word onset', () => {
		expect(wordClipWindow(cue, 1)).toEqual({
			start: 10.6,
			end: 11.2,
			fromWordClock: true,
		});
	});

	it('pads a short function word so seek jitter does not mute it', () => {
		const clip = wordClipWindow(cue, 2);
		expect(clip?.fromWordClock).toBe(true);
		expect(clip!.end - clip!.start).toBeGreaterThanOrEqual(0.34);
	});

	it('uses the cue end for the last word', () => {
		expect(wordClipWindow(cue, 3)?.end).toBe(14);
	});

	it('falls back to the whole cue when word clocks are missing', () => {
		expect(
			wordClipWindow({ index: 0, start: 1, end: 3, text: 'hello' }, 0),
		).toEqual({ start: 1, end: 3, fromWordClock: false });
	});

	it('returns null for an empty cue', () => {
		expect(
			wordClipWindow({ index: 0, start: 2, end: 2, text: '' }, 0),
		).toBeNull();
	});
});
