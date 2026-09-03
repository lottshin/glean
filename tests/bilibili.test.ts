import { describe, expect, it } from 'vitest';
import {
	bilibiliSourcePath,
	bilibiliWatchUrl,
	isBilibiliVideoId,
	parseBilibiliSourcePath,
	parseBilibiliVideoId,
} from '../src/bilibili/id';
import {
	bilibiliSubtitleToWebVtt,
	bilibiliSyncRefusalMessage,
	cuesFromBilibiliSubtitle,
	isEnglishLanguage,
	normalizeSubtitleUrl,
	parseSubtitleTracks,
	pickDefaultTrack,
	translatedEnglishTracks,
	usableEnglishTracks,
} from '../src/bilibili/subtitle';

const BV = 'BV1GJ411x7h7';

describe('bilibili video id', () => {
	it('accepts a bare BV id', () => {
		expect(parseBilibiliVideoId(BV)).toBe(BV);
		expect(isBilibiliVideoId(BV)).toBe(true);
	});

	it('rejects ids containing base58-excluded glyphs', () => {
		expect(isBilibiliVideoId('BV1GJ411x7hO')).toBe(false);
		expect(isBilibiliVideoId('BV1GJ411x7hl')).toBe(false);
		expect(isBilibiliVideoId('BV1GJ411x7h')).toBe(false);
	});

	it('pulls the id out of watch urls', () => {
		expect(parseBilibiliVideoId(`https://www.bilibili.com/video/${BV}`)).toBe(BV);
		expect(parseBilibiliVideoId(`https://www.bilibili.com/video/${BV}/?p=2`)).toBe(BV);
		expect(parseBilibiliVideoId(`https://m.bilibili.com/video/${BV}`)).toBe(BV);
		expect(parseBilibiliVideoId(`www.bilibili.com/video/${BV}`)).toBe(BV);
	});

	it('reads the bvid query parameter', () => {
		expect(
			parseBilibiliVideoId(`https://www.bilibili.com/list/watchlater?bvid=${BV}`),
		).toBe(BV);
	});

	it('returns null for other hosts and for opaque short links', () => {
		expect(parseBilibiliVideoId(`https://youtube.com/watch?v=dQw4w9WgXcQ`)).toBeNull();
		expect(parseBilibiliVideoId('https://b23.tv/aBcDeFg')).toBeNull();
		expect(parseBilibiliVideoId('')).toBeNull();
	});

	it('round-trips the source path', () => {
		expect(parseBilibiliSourcePath(bilibiliSourcePath(BV))).toBe(BV);
		expect(parseBilibiliSourcePath(`youtube:${BV}`)).toBeNull();
	});

	it('only adds p= for later parts', () => {
		expect(bilibiliWatchUrl(BV)).toBe(`https://www.bilibili.com/video/${BV}`);
		expect(bilibiliWatchUrl(BV, 1)).toBe(`https://www.bilibili.com/video/${BV}`);
		expect(bilibiliWatchUrl(BV, 3)).toBe(`https://www.bilibili.com/video/${BV}?p=3`);
	});
});

describe('subtitle track list', () => {
	const playerResponse = {
		code: 0,
		data: {
			subtitle: {
				subtitles: [
					{
						lan: 'ai-zh',
						lan_doc: '中文（自动生成）',
						subtitle_url: '//aisubtitle.hdslb.com/zh.json',
					},
					{
						lan: 'en-US',
						lan_doc: '英语',
						subtitle_url: '//aisubtitle.hdslb.com/en.json',
					},
				],
			},
		},
	};

	it('adds the missing scheme to protocol-relative urls', () => {
		expect(normalizeSubtitleUrl('//aisubtitle.hdslb.com/a.json')).toBe(
			'https://aisubtitle.hdslb.com/a.json',
		);
		expect(normalizeSubtitleUrl('https://example.com/a.json')).toBe(
			'https://example.com/a.json',
		);
	});

	it('parses tracks and flags machine-generated ones', () => {
		const tracks = parseSubtitleTracks(playerResponse);
		expect(tracks).toHaveLength(2);
		expect(tracks[0]?.isAi).toBe(true);
		expect(tracks[0]?.subtitleUrl).toBe('https://aisubtitle.hdslb.com/zh.json');
		expect(tracks[1]?.isAi).toBe(false);
	});

	it('returns an empty list when the video has no subtitles', () => {
		expect(parseSubtitleTracks({ data: { subtitle: { subtitles: [] } } })).toEqual([]);
		expect(parseSubtitleTracks({ data: {} })).toEqual([]);
		expect(parseSubtitleTracks(null)).toEqual([]);
	});

	it('skips entries with no usable url', () => {
		const tracks = parseSubtitleTracks({
			data: { subtitle: { subtitles: [{ lan: 'en', subtitle_url: '' }] } },
		});
		expect(tracks).toEqual([]);
	});

	it('prefers a human English track', () => {
		expect(pickDefaultTrack(parseSubtitleTracks(playerResponse))?.lan).toBe('en-US');
	});

	it('falls back to AI English over human Chinese', () => {
		const tracks = parseSubtitleTracks({
			data: {
				subtitle: {
					subtitles: [
						{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//x/zh.json' },
						{ lan: 'ai-en', lan_doc: '英语（自动）', subtitle_url: '//x/en.json' },
					],
				},
			},
		});
		expect(pickDefaultTrack(tracks)?.lan).toBe('ai-en');
	});

	// Shape taken from BV1rRut6rEGS, a Chinese vlog Bilibili auto-translated
	// into five languages. Its English track reads fluently but the audio is
	// Chinese, so syncing it would produce captions nobody can listen along to.
	const chineseVlog = parseSubtitleTracks({
		data: {
			subtitle: {
				subtitles: [
					{ lan: 'ai-zh', lan_doc: '中文', ai_type: 0, ai_status: 2, subtitle_url: '//x/zh.json' },
					{ lan: 'ai-en', lan_doc: 'English', ai_type: 1, ai_status: 2, subtitle_url: '//x/en.json' },
					{ lan: 'ai-ja', lan_doc: '日本語', ai_type: 1, ai_status: 2, subtitle_url: '//x/ja.json' },
				],
			},
		},
	});

	it('marks ai_type 1 tracks as translations', () => {
		expect(chineseVlog.map((track) => track.isTranslation)).toEqual([
			false,
			true,
			true,
		]);
	});

	it('offers no English track when the only English one is translated', () => {
		expect(usableEnglishTracks(chineseVlog)).toEqual([]);
		expect(translatedEnglishTracks(chineseVlog).map((t) => t.lan)).toEqual([
			'ai-en',
		]);
	});

	it('names Chinese audio when English is translated from it', () => {
		expect(bilibiliSyncRefusalMessage(chineseVlog)).toBe(
			'原声是中文，英文字幕是机翻的，跟读音对不上',
		);
	});

	it('does not claim Chinese audio when a real English track exists', () => {
		const tedEd = parseSubtitleTracks({
			data: {
				subtitle: {
					subtitles: [
						{ lan: 'zh', lan_doc: '中文', ai_type: 0, subtitle_url: '//x/zh.json' },
						{ lan: 'en', lan_doc: 'English', ai_type: 0, subtitle_url: '//x/en.json' },
						{ lan: 'ai-zh', lan_doc: '中文', ai_type: 1, subtitle_url: '//x/aizh.json' },
					],
				},
			},
		});
		expect(bilibiliSyncRefusalMessage(tedEd)).toBe('');
	});

	/**
	 * Bilibili attaches its default Chinese track with ai_type 0 even to
	 * English-dubbed uploads, so that flag cannot stand in for the spoken
	 * language. Sampled English material (English Conversation, 西游记 English
	 * dub, The Simpsons) all carried a lone ai-zh/0 track.
	 */
	it('keeps a human English track alongside Bilibili default Chinese one', () => {
		const englishDub = parseSubtitleTracks({
			data: {
				subtitle: {
					subtitles: [
						{ lan: 'ai-zh', lan_doc: '中文', ai_type: 0, subtitle_url: '//x/zh.json' },
						{ lan: 'en-US', lan_doc: '英语', subtitle_url: '//x/en.json' },
					],
				},
			},
		});
		expect(usableEnglishTracks(englishDub).map((t) => t.lan)).toEqual(['en-US']);
	});

	it('never defaults to a translated track', () => {
		expect(pickDefaultTrack(chineseVlog)?.lan).toBe('ai-zh');
	});

	it('keeps AI English that is not a translation', () => {
		const englishTalk = parseSubtitleTracks({
			data: {
				subtitle: {
					subtitles: [
						{ lan: 'ai-en', lan_doc: 'English', ai_type: 0, subtitle_url: '//x/en.json' },
						{ lan: 'ai-zh', lan_doc: '中文', ai_type: 1, subtitle_url: '//x/zh.json' },
					],
				},
			},
		});
		expect(usableEnglishTracks(englishTalk).map((t) => t.lan)).toEqual(['ai-en']);
	});

	it('keeps human English tracks, which carry no ai_type to judge by', () => {
		const human = parseSubtitleTracks({
			data: {
				subtitle: {
					subtitles: [
						{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//x/zh.json' },
						{ lan: 'en-US', lan_doc: '英语', subtitle_url: '//x/en.json' },
					],
				},
			},
		});
		expect(usableEnglishTracks(human).map((t) => t.lan)).toEqual(['en-US']);
	});

	it('recognises English language codes with and without the ai prefix', () => {
		expect(['en', 'en-US', 'ai-en', 'EN_GB'].map(isEnglishLanguage)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(['zh-CN', 'ai-zh', 'eng-x', 'es'].map(isEnglishLanguage)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});

	it('returns null for an empty track list', () => {
		expect(pickDefaultTrack([])).toBeNull();
	});
});

describe('subtitle body conversion', () => {
	const payload = {
		body: [
			{ from: 1.5, to: 3.25, content: 'Hello there' },
			{ from: 3.25, to: 6, content: 'general Kenobi' },
		],
	};

	it('keeps the original cue boundaries', () => {
		const cues = cuesFromBilibiliSubtitle(payload);
		expect(cues).toEqual([
			{ start: 1.5, end: 3.25, text: 'Hello there' },
			{ start: 3.25, end: 6, text: 'general Kenobi' },
		]);
	});

	it('drops malformed and zero-length entries', () => {
		const cues = cuesFromBilibiliSubtitle({
			body: [
				{ from: 0, to: 1, content: '  ' },
				{ from: 2, to: 2, content: 'zero length' },
				{ from: 5, to: 4, content: 'reversed' },
				{ from: 1, content: 'missing end' },
				{ from: 7, to: 8, content: 'kept' },
			],
		});
		expect(cues).toEqual([{ start: 7, end: 8, text: 'kept' }]);
	});

	it('sorts cues that arrive out of order', () => {
		const cues = cuesFromBilibiliSubtitle({
			body: [
				{ from: 9, to: 10, content: 'second' },
				{ from: 1, to: 2, content: 'first' },
			],
		});
		expect(cues.map((cue) => cue.text)).toEqual(['first', 'second']);
	});

	it('emits VTT with the original timings', () => {
		const vtt = bilibiliSubtitleToWebVtt(payload);
		expect(vtt.startsWith('WEBVTT')).toBe(true);
		expect(vtt).toContain('NOTE glean-segmented');
		expect(vtt).toContain('00:00:01.500 --> 00:00:03.250');
		expect(vtt).toContain('Hello there');
		expect(vtt).toContain('general Kenobi');
	});

	it('returns an empty string when there is nothing to convert', () => {
		expect(bilibiliSubtitleToWebVtt({ body: [] })).toBe('');
		expect(bilibiliSubtitleToWebVtt({})).toBe('');
	});

	it('leaves Chinese cues untouched by default', () => {
		const vtt = bilibiliSubtitleToWebVtt({
			body: [{ from: 0, to: 2, content: '大家好今天我们来讲一个故事' }],
		});
		expect(vtt).toContain('大家好今天我们来讲一个故事');
	});
});
