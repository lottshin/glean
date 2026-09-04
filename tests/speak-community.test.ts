import { describe, expect, it } from 'vitest';

import {
	parseFreeDictionaryAudio,
	parseWiktionaryFileUrl,
	parseWiktionaryImageTitles,
	resolveCommunityAudio,
	wiktionaryCandidateFiles,
	type SpeakFetcher,
} from '../src/speak/community';

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

	it('guesses the usual Commons filenames', () => {
		expect(wiktionaryCandidateFiles('Hello')).toContain('File:en-us-hello.ogg');
		expect(wiktionaryCandidateFiles('Hello')).toContain('File:en-uk-hello.ogg');
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
		const hit = await resolveCommunityAudio('free-dictionary', 'Go', 'en-US', fetchJson);
		expect(calls[0]).toContain('api.dictionaryapi.dev/api/v2/entries/en/go');
		expect(hit?.url).toContain('_us_');
	});

	it('returns null for system source', async () => {
		expect(
			await resolveCommunityAudio('system', 'go', 'auto', async () => ({
				status: 200,
				json: {},
			})),
		).toBeNull();
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
		const hit = await resolveCommunityAudio('wiktionary', 'go', 'en-US', fetchJson);
		expect(hit?.source).toBe('wiktionary');
		expect(hit?.url).toContain('En-us-go.ogg');
	});
});
