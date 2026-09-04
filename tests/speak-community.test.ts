import { afterEach, describe, expect, it } from 'vitest';

import {
	clearCommunityAudioCache,
	parseFreeDictionaryAudio,
	parseWiktionaryFileUrl,
	parseWiktionaryImageTitles,
	resolveCommunityAudio,
	wiktionaryCandidateFiles,
	type SpeakFetcher,
} from '../src/speak/community';

afterEach(() => {
	clearCommunityAudioCache();
});

describe('free dictionary parsing', () => {
	const payload = [
		{
			word: 'hello',
			phonetics: [
				{ text: 'həˈləʊ', audio: '' },
				{
					text: 'həˈləʊ',
					audio: '//ssl.gstatic.com/dictionary/static/sounds/20200429/hello--_gb_1.mp3',
				},
				{
					text: 'hɛˈloʊ',
					audio: 'https://ssl.gstatic.com/dictionary/static/sounds/20200429/hello--_us_1.mp3',
				},
			],
		},
	];

	it('prefers a British clip when asked', () => {
		const hit = parseFreeDictionaryAudio(payload, 'en-GB');
		expect(hit?.accentHint).toBe('en-GB');
		expect(hit?.url).toContain('_gb_');
		expect(hit?.url.startsWith('https:')).toBe(true);
	});

	it('prefers an American clip when asked', () => {
		const hit = parseFreeDictionaryAudio(payload, 'en-US');
		expect(hit?.url).toContain('_us_');
	});

	it('refuses the wrong accent instead of making 美/英 identical', () => {
		const onlyUs = [
			{
				word: 'color',
				phonetics: [
					{
						audio: 'https://example.test/color--_us_1.mp3',
					},
				],
			},
		];
		expect(parseFreeDictionaryAudio(onlyUs, 'en-GB')).toBeNull();
		expect(parseFreeDictionaryAudio(onlyUs, 'en-US')?.url).toContain('_us_');
	});

	it('returns null when every phonetic is silent', () => {
		expect(
			parseFreeDictionaryAudio([{ word: 'x', phonetics: [{ audio: '' }] }], 'auto'),
		).toBeNull();
	});
});

describe('wiktionary parsing', () => {
	it('keeps English pronunciation files and drops unrelated media', () => {
		const titles = parseWiktionaryImageTitles({
			query: {
				pages: {
					'1': {
						images: [
							{ title: 'File:en-us-bracket.ogg' },
							{ title: 'File:Bracket.svg' },
							{ title: 'File:En-uk-bracket.ogg' },
							{ title: 'File:cat.jpg' },
						],
					},
				},
			},
		});
		expect(titles).toEqual(['File:en-us-bracket.ogg', 'File:En-uk-bracket.ogg']);
	});

	it('reads the direct file URL from imageinfo', () => {
		expect(
			parseWiktionaryFileUrl({
				query: {
					pages: {
						'1': {
							imageinfo: [
								{
									url: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/En-us-bracket.ogg',
								},
							],
						},
					},
				},
			}),
		).toContain('En-us-bracket.ogg');
	});

	it('guesses the usual Commons filenames for the requested accent only', () => {
		expect(wiktionaryCandidateFiles('Hello', 'en-US')).toContain('File:en-us-hello.ogg');
		expect(wiktionaryCandidateFiles('Hello', 'en-US').join(' ')).not.toMatch(/uk|gb/i);
		expect(wiktionaryCandidateFiles('Hello', 'en-GB')).toContain('File:en-uk-hello.ogg');
		expect(wiktionaryCandidateFiles('Hello', 'en-GB').join(' ')).not.toMatch(/-us-/i);
	});
});

describe('resolveCommunityAudio', () => {
	it('routes free-dictionary through the public entries endpoint', async () => {
		const calls: string[] = [];
		const fetchJson: SpeakFetcher = async (url) => {
			calls.push(url);
			return {
				status: 200,
				json: [
					{
						word: 'go',
						phonetics: [
							{
								audio: 'https://example.test/go--_us_1.mp3',
							},
						],
					},
				],
			};
		};
		const lookup = await resolveCommunityAudio(
			'free-dictionary',
			'Go',
			'en-US',
			fetchJson,
		);
		expect(calls[0]).toContain('api.dictionaryapi.dev/api/v2/entries/en/go');
		expect(lookup.status).toBe('hit');
		if (lookup.status === 'hit') {
			expect(lookup.hit.url).toContain('_us_');
		}
	});

	it('returns miss for system source', async () => {
		expect(
			await resolveCommunityAudio('system', 'go', 'auto', async () => ({
				status: 200,
				json: {},
			})),
		).toEqual({ status: 'miss' });
	});

	it('uses a direct Commons hit before scanning the page', async () => {
		const fetchJson: SpeakFetcher = async (url) => {
			if (url.includes('prop=imageinfo')) {
				return {
					status: 200,
					json: {
						query: {
							pages: {
								'1': {
									title: 'File:En-us-go.ogg',
									imageinfo: [
										{
											url: 'https://upload.wikimedia.org/wikipedia/commons/x/En-us-go.ogg',
										},
									],
								},
							},
						},
					},
				};
			}
			throw new Error(`unexpected ${url}`);
		};
		const lookup = await resolveCommunityAudio('wiktionary', 'go', 'en-US', fetchJson);
		expect(lookup.status).toBe('hit');
		if (lookup.status === 'hit') {
			expect(lookup.hit.url).toContain('En-us-go.ogg');
		}
	});

	it('treats 429 as rate-limited instead of throwing', async () => {
		const lookup = await resolveCommunityAudio(
			'wiktionary',
			'go',
			'en-US',
			async () => ({ status: 429, json: null }),
		);
		expect(lookup).toEqual({ status: 'rate-limited', source: 'Wiktionary' });
	});

	it('reuses a cached hit without another network call', async () => {
		let calls = 0;
		const fetchJson: SpeakFetcher = async () => {
			calls += 1;
			return {
				status: 200,
				json: [
					{
						word: 'go',
						phonetics: [{ audio: 'https://example.test/go--_us_1.mp3' }],
					},
				],
			};
		};
		await resolveCommunityAudio('free-dictionary', 'go', 'en-US', fetchJson);
		await resolveCommunityAudio('free-dictionary', 'go', 'en-US', fetchJson);
		expect(calls).toBe(1);
	});

	it('skips the network during a rate-limit cooldown', async () => {
		let calls = 0;
		const fetchJson: SpeakFetcher = async () => {
			calls += 1;
			return { status: 429, json: null };
		};
		const now = 1_000_000;
		await resolveCommunityAudio('wiktionary', 'go', 'en-US', fetchJson, now);
		await resolveCommunityAudio('wiktionary', 'go', 'en-US', fetchJson, now + 1_000);
		expect(calls).toBe(1);
	});
});
