import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseSubtitles, parseTimestamp } from '../src/media/srt';
import { cueIndexAt } from '../src/media/cues';
import type { Cue } from '../src/media/types';
import { siblingSubtitlePaths } from '../src/media/paths';

const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:02,500
Hello world.

2
00:00:02,500 --> 00:00:05,000
This is a <i>test</i>.

3
00:00:06,000 --> 00:00:08,000
Third line.
`;

const SAMPLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:01.000
First

NOTE this is a comment

00:00:01.500 --> 00:00:02.000
Second
`;

describe('parseTimestamp', () => {
	it('parses srt commas and optional hours', () => {
		expect(parseTimestamp('00:00:01,500')).toBe(1.5);
		expect(parseTimestamp('1:02:03,040')).toBe(3723.04);
	});

	it('parses vtt dots', () => {
		expect(parseTimestamp('00:00:01.250')).toBe(1.25);
	});
});

describe('parseSubtitles', () => {
	it('parses srt and strips markup', () => {
		const cues = parseSubtitles(SAMPLE_SRT);
		expect(cues).toHaveLength(3);
		expect(cues[0]).toMatchObject({ index: 0, start: 0, end: 2.5, text: 'Hello world.' });
		expect(cues[1]?.text).toBe('This is a test.');
		expect(cues[2]?.start).toBe(6);
	});

	it('parses webvtt and skips NOTE', () => {
		const cues = parseSubtitles(SAMPLE_VTT);
		expect(cues.map((c) => c.text)).toEqual(['First', 'Second']);
		expect(cues[1]?.start).toBe(1.5);
	});

	it('returns empty for blank input', () => {
		expect(parseSubtitles('')).toEqual([]);
		expect(parseSubtitles('WEBVTT\n\n')).toEqual([]);
	});

	it('skips malformed blocks and strips ASS tags', () => {
		const cues = parseSubtitles(`1
not-a-timestamp
oops

2
00:00:01,000 --> 00:00:02,000
{\\an8}Hello

3
00:00:03,000 --> 00:00:02,000
backwards
`);
		expect(cues).toHaveLength(1);
		expect(cues[0]?.text).toBe('Hello');
	});
});

describe('formatTimestamp', () => {
	it('omits hours when zero', () => {
		expect(formatTimestamp(65)).toBe('01:05');
		expect(formatTimestamp(3723)).toBe('01:02:03');
	});
});

describe('cueIndexAt', () => {
	const cues: Cue[] = [
		{ index: 0, start: 0, end: 2, text: 'a' },
		{ index: 1, start: 2, end: 4, text: 'b' },
		{ index: 2, start: 6, end: 8, text: 'c' },
	];

	it('finds containing cue and holds through gaps', () => {
		expect(cueIndexAt(cues, 0.5)).toBe(0);
		expect(cueIndexAt(cues, 2)).toBe(1);
		expect(cueIndexAt(cues, 5)).toBe(1);
		expect(cueIndexAt(cues, 7)).toBe(2);
	});

	it('returns -1 before the first cue', () => {
		expect(cueIndexAt([], 1)).toBe(-1);
		expect(cueIndexAt(cues, -1)).toBe(-1);
	});
});

describe('siblingSubtitlePaths', () => {
	it('prefixes the folder and prefers same-stem srt', () => {
		expect(siblingSubtitlePaths('Media', 'talk')[0]).toBe('Media/talk.srt');
		expect(siblingSubtitlePaths('', 'talk')).toContain('talk.en.srt');
		expect(siblingSubtitlePaths('/', 'talk')[1]).toBe('talk.vtt');
	});
});
