import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	captureYouTubeFromHtml,
	pickDefaultTrack,
} from '../extension/src/capture';
import { YouTubeSource, youtubePlayerError } from '../src/media/youtube';
import {
	parseYouTubeSourcePath,
	parseYouTubeVideoId,
	youtubeSourcePath,
} from '../src/youtube/id';
import { snapPlaybackRate } from '../src/youtube/rate';
import {
	buildYouTubeSessionNote,
	sanitizeImportFileName,
	validateImportPayload,
	youtubeNotePath,
	youtubeSubtitlePath,
} from '../src/youtube/session';
import {
	cuesFromTimedText,
	HARD_WORDS,
	healIncompleteCues,
	refineCaptionCues,
	refineWebVtt,
	splitLongCues,
	timedTextToWebVtt,
} from '../src/youtube/vtt';

describe('YouTube identifiers', () => {
	it.each([
		['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://youtu.be/dQw4w9WgXcQ?t=4', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	])('parses %s', (url, expected) => {
		expect(parseYouTubeVideoId(url)).toBe(expected);
	});

	it('rejects foreign and malformed URLs', () => {
		expect(parseYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
		expect(parseYouTubeVideoId('not-video')).toBeNull();
		expect(parseYouTubeSourcePath(youtubeSourcePath('dQw4w9WgXcQ'))).toBe(
			'dQw4w9WgXcQ',
		);
	});
});

describe('YouTube timedtext conversion', () => {
	const payload = {
		events: [
			{
				tStartMs: 1250,
				dDurationMs: 1750,
				segs: [{ utf8: 'Hello ' }, { utf8: 'world.' }],
			},
			{ tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: '' }] },
		],
	};

	it('skips empty rows and emits valid WebVTT', () => {
		const cues = cuesFromTimedText(payload);
		expect(cues).toHaveLength(1);
		expect(cues[0]).toMatchObject({ start: 1.25, end: 3, text: 'Hello world.' });
		expect(timedTextToWebVtt(payload)).toMatch(
			/00:00:01\.250 --> 00:00:03\.000\nNOTE glean-words[^\n]+\nHello world\./,
		);
	});

	it('gives split halves of a timing-less manual line distinct starts', () => {
		// Manual captions put a whole line in one event with no per-word offsets,
		// so every word shares the event start. Splitting must not leave both
		// halves at the same timestamp (the "two 00:00 cues" bug).
		const cues = cuesFromTimedText({
			events: [
				{
					tStartMs: 0,
					dDurationMs: 4000,
					segs: [{ utf8: 'Hey everyone, I am Ingrid and I am 28 years old,' }],
				},
			],
		});
		expect(cues.length).toBeGreaterThanOrEqual(2);
		const starts = cues.map((cue) => cue.start);
		// No two cues may share a start.
		expect(new Set(starts).size).toBe(starts.length);
		// The second half begins after the first, not back at 0.
		expect(cues[1]?.start ?? 0).toBeGreaterThan(0);
	});

	it('drops [Music], splits discourse openers, and reunites mid-clause cuts', () => {
		const asr = {
			events: [
				{ tStartMs: 2720, dDurationMs: 2199, segs: [{ utf8: 'all' }] },
				{
					tStartMs: 6160,
					dDurationMs: 19270,
					segs: [{ utf8: 'right' }, { utf8: ' welcome' }, { utf8: ' to' }],
				},
				{ tStartMs: 8340, dDurationMs: 17090, segs: [{ utf8: '[Music]' }] },
				{ tStartMs: 28960, dDurationMs: 3000, segs: [{ utf8: 'China' }] },
				{
					tStartMs: 32000,
					dDurationMs: 3000,
					segs: [{ utf8: "so yes guys I am here in Shanghai China it's been a long time coming I've been" }],
				},
				{
					tStartMs: 36000,
					dDurationMs: 4000,
					segs: [{ utf8: 'wanting to come here for years and years' }],
				},
			],
		};
		const cues = cuesFromTimedText(asr);
		expect(cues.some((cue) => /\[Music\]/i.test(cue.text))).toBe(false);
		expect(cues[0]?.text.toLowerCase()).toBe('all right');
		expect(cues[1]?.text.toLowerCase()).toContain('welcome to');
		expect(cues[1]?.text.toLowerCase()).toContain('china');
		const long = cues.find((cue) => /wanting to come here/i.test(cue.text));
		expect(long?.text.toLowerCase()).toContain("i've been wanting to come here");
	});

	it('splits oversized cues at clause boundaries', () => {
		const cues = splitLongCues([
			{
				start: 0,
				end: 12,
				text: "so yes guys I am here in Shanghai China it's been a long time coming and I have been wanting to come here for years and years",
			},
		]);
		expect(cues.length).toBeGreaterThanOrEqual(2);
		expect(
			cues.every((cue) => cue.text.split(/\s+/).filter(Boolean).length <= HARD_WORDS),
		).toBe(true);
		expect(cues.map((cue) => cue.text.toLowerCase()).join(' ')).toContain(
			'shanghai china',
		);
		expect(cues.map((cue) => cue.text.toLowerCase()).join(' ')).toContain(
			'wanting to come here',
		);
	});

	it('keeps clause openers together and starts new cues at it\'s / so / we', () => {
		const cues = splitLongCues([
			{
				start: 39,
				end: 60,
				text: "obviously there was a whole big lockdown during Co but now China is back open so as soon as I was able to I booked a trip to come here and it's going to be an awesome couple of weeks here in China we start here in Shanghai then I go to Shian Quin Ming and then Beijing so make sure you get subscribed if you're not already so you don't miss any of that coming up so right now I'm in the people square",
			},
		]);
		const texts = cues.map((cue) => cue.text.toLowerCase());
		expect(texts.some((text) => text.includes('booked a trip to come here'))).toBe(
			true,
		);
		// The clause stays intact. A leading coordinator ("and") is kept so the
		// dictation text still matches the audio — only its clause is a unit.
		expect(
			texts.some((text) => text.includes("it's going to be an awesome couple")),
		).toBe(true);
		expect(texts.some((text) => text.startsWith('we start here'))).toBe(true);
		expect(texts.some((text) => text.startsWith('so make sure'))).toBe(true);
		expect(texts.some((text) => /people square/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bwe$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bso make$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bpeople$/.test(text))).toBe(true);
	});

	it('heals dangling tails like we / so make / people', () => {
		const cues = healIncompleteCues([
			{ start: 46, end: 50, text: 'weeks here in China we' },
			{ start: 50, end: 54, text: 'start here in Shanghai then Beijing so make' },
			{ start: 54, end: 58, text: "sure you get subscribed so right now I'm in the people" },
			{ start: 58, end: 60, text: 'square' },
		]);
		const texts = cues.map((cue) => cue.text.toLowerCase());
		expect(texts.some((text) => text.includes('we start here'))).toBe(true);
		expect(texts.some((text) => text.includes('so make sure'))).toBe(true);
		expect(texts.some((text) => text.includes('people square'))).toBe(true);
		expect(texts.every((text) => !/\bwe$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bmake$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bpeople$/.test(text))).toBe(true);
	});

	it('keeps Chinese New Year / American guy / seen much together and absorbs um', () => {
		const cues = refineCaptionCues([
			{ start: 64, end: 65, text: "it's also Chinese New" },
			{
				start: 65,
				end: 70,
				text: 'Year kind of the the tail end of it Happy Chinese New Year to all that are celebrating',
			},
			{ start: 70, end: 70.5, text: 'um' },
			{
				start: 70.5,
				end: 75,
				text: "guys in this video you know how it goes I'm brand new here I just got here yesterday",
			},
			{ start: 75, end: 75.5, text: "haven't seen" },
			{
				start: 75.5,
				end: 80,
				text: 'much yet so this is going to be my first impressions walking around as an American',
			},
			{ start: 80, end: 85, text: 'guy in Shanghai' },
		]);
		const texts = cues.map((cue) => cue.text.toLowerCase());
		const joined = texts.join(' || ');
		expect(joined).toContain('chinese new year');
		expect(joined).toContain('american guy');
		expect(joined).toContain("haven't seen much");
		expect(texts.every((text) => text !== 'um')).toBe(true);
		expect(texts.every((text) => !/\bchinese new$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bamerican$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bseen$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bthis$/.test(text))).toBe(true);
		expect(texts.every((text) => !/\bum$/.test(text))).toBe(true);
		expect(
			texts.some((text) =>
				/i just got here yesterday haven'?t seen much yet/i.test(text),
			),
		).toBe(true);
		expect(texts.some((text) => text.startsWith('so this is going'))).toBe(true);
		expect(texts.some((text) => text.startsWith('guys') || text.startsWith('um guys'))).toBe(
			true,
		);
	});

	it('keeps "some green onion" and "she\'s going to" glued (screenshot case)', () => {
		const cues = refineCaptionCues([
			{ start: 104, end: 110, text: "and what's going in all of these different vegetables a little cilantro maybe some" },
			{ start: 110, end: 116, text: "green onion and I don't know what that is now she's" },
			{ start: 116, end: 124, text: 'going to fold it up in a second this is like I think hoiston' },
			{ start: 124, end: 130, text: 'sauce or something similar for a little bit' },
		]);
		const texts = cues.map((cue) => cue.text.toLowerCase());
		// The quantifier must not be stranded from its noun.
		expect(texts.every((text) => !/\bsome$/.test(text))).toBe(true);
		expect(texts.join(' || ')).toContain('some green onion');
		// A subject+contraction must not be stranded from its verb phrase.
		expect(texts.every((text) => !/\bshe's$/.test(text))).toBe(true);
		expect(texts.join(' || ')).toMatch(/she's going to/);
		// Unknown/misspelled noun compounds are handled as a noun phrase, not
		// by adding "hoiston" to a phrase exception list.
		expect(texts.every((text) => !/\bhoiston$/.test(text))).toBe(true);
		expect(texts.join(' || ')).toContain('hoiston sauce');
	});

	it('persists ASR word clocks into WebVTT so manual splits can use them', () => {
		const asr = {
			events: [
				{
					tStartMs: 2720,
					dDurationMs: 5000,
					segs: [
						{ utf8: 'all' },
						{ utf8: ' right', tOffsetMs: 800 },
						{ utf8: ' welcome', tOffsetMs: 4591 },
						{ utf8: ' to', tOffsetMs: 5000 },
						{ utf8: ' China', tOffsetMs: 5400 },
					],
				},
			],
		};
		const vtt = timedTextToWebVtt(asr);
		expect(vtt).toMatch(/NOTE\s+glean-segmented/);
		expect(vtt).toMatch(/NOTE\s+glean-words/);
		expect(vtt).toMatch(/NOTE\s+glean-timeline/);
		expect(vtt).toMatch(/7\.311:welcome/);
	});

	it('dates split cues by real word starts, not by char interpolation', () => {
		// "all right" at 2.7s, then music, "welcome to" at ~6s, more music,
		// "China" at ~29s. The old code interpolated "welcome to China" to ~14s
		// (silence). Word timing must place it at the real 6s.
		const asr = {
			events: [
				{ tStartMs: 2720, dDurationMs: 3000, segs: [{ utf8: 'all' }, { utf8: ' right', tOffsetMs: 800 }] },
				{ tStartMs: 6160, dDurationMs: 2000, segs: [{ utf8: 'welcome' }, { utf8: ' to', tOffsetMs: 400 }] },
				{ tStartMs: 8340, dDurationMs: 17000, segs: [{ utf8: '[Music]' }] },
				{ tStartMs: 28960, dDurationMs: 3000, segs: [{ utf8: 'China' }] },
			],
		};
		const cues = cuesFromTimedText(asr);
		const welcome = cues.find((cue) => /welcome to/i.test(cue.text));
		expect(welcome).toBeDefined();
		// Real speech starts near 6s, nowhere near the old interpolated ~14s.
		expect(welcome?.start ?? 0).toBeGreaterThan(5);
		expect(welcome?.start ?? 0).toBeLessThan(9);
	});

	it('pulls a late ASR "China" stamp back onto welcome-to speech', () => {
		// Real video shape: one rolling event ends on "to", next event is only
		// "China" stamped ~22s later. Mid-phrase complement must not sit on silence.
		const asr = {
			events: [
				{
					tStartMs: 2720,
					dDurationMs: 5000,
					segs: [
						{ utf8: 'all ', tOffsetMs: 0 },
						{ utf8: 'right ', tOffsetMs: 3440 },
						{ utf8: 'welcome ', tOffsetMs: 4440 },
						{ utf8: 'to ', tOffsetMs: 4719 },
					],
				},
				{ tStartMs: 28960, dDurationMs: 2000, segs: [{ utf8: 'China ' }] },
				{
					tStartMs: 32000,
					dDurationMs: 2000,
					segs: [
						{ utf8: 'so ', tOffsetMs: 0 },
						{ utf8: 'yes ', tOffsetMs: 559 },
						{ utf8: 'guys', tOffsetMs: 920 },
					],
				},
			],
		};
		const cues = cuesFromTimedText(asr);
		const china = cues.find((cue) => /\bchina\b/i.test(cue.text));
		expect(china).toBeDefined();
		expect(china?.start ?? 99).toBeLessThan(10);
		expect(china?.text.toLowerCase()).toMatch(/welcome to china/);
		const so = cues.find((cue) => /^so yes guys$/i.test(cue.text.trim()));
		expect(so?.start ?? 0).toBeGreaterThan(30);
	});

	it('does not park "welcome to China" in music when word offsets are flat', () => {
		// Regression: discourse-splitting "all right" off a long flat-timed cue
		// used char-ratio interpolation and dated "welcome to China" to ~12s BGM.
		const asr = {
			events: [
				{
					tStartMs: 2720,
					dDurationMs: 29000,
					segs: [
						{ utf8: 'all right welcome to China' },
					],
				},
			],
		};
		const cues = cuesFromTimedText(asr);
		const welcome = cues.find((cue) => /welcome to china/i.test(cue.text));
		expect(welcome).toBeDefined();
		expect(welcome?.start ?? 99).toBeLessThan(6);
		expect(welcome?.start ?? 0).toBeGreaterThanOrEqual(2.5);
	});

	it('cuts at the breath after "so yes guys", not before "guys"', () => {
		// "so yes guys" is one breath group; the pause lands before "I am here".
		const asr = {
			events: [
				{
					tStartMs: 32000,
					dDurationMs: 2000,
					segs: [
						{ utf8: 'so' },
						{ utf8: ' yes', tOffsetMs: 300 },
						{ utf8: ' guys', tOffsetMs: 600 },
					],
				},
				{
					tStartMs: 34000,
					dDurationMs: 3000,
					segs: [
						{ utf8: 'I' },
						{ utf8: ' am', tOffsetMs: 150 },
						{ utf8: ' here', tOffsetMs: 400 },
						{ utf8: ' in', tOffsetMs: 700 },
						{ utf8: ' Shanghai', tOffsetMs: 900 },
						{ utf8: ' China', tOffsetMs: 1300 },
					],
				},
			],
		};
		const cues = cuesFromTimedText(asr);
		const texts = cues.map((cue) => cue.text.toLowerCase());
		expect(texts).toContain('so yes guys');
		expect(texts.some((text) => text.startsWith('i am here'))).toBe(true);
		expect(texts.every((text) => text !== 'so yes')).toBe(true);
		expect(texts.every((text) => !/^guys\b/.test(text))).toBe(true);
	});

	it('splits ">>" speaker turns and drops inline [music]', () => {
		// One event holds several speaker turns marked by ">>" plus an inline
		// [music] tag — the exact shape YouTube ships for a fast dialogue cut.
		const asr = {
			events: [
				{
					tStartMs: 9000,
					dDurationMs: 6000,
					segs: [
						{ utf8: '>>' },
						{ utf8: " What's", tOffsetMs: 150 },
						{ utf8: ' up?', tOffsetMs: 400 },
						{ utf8: ' >>', tOffsetMs: 900 },
						{ utf8: ' You', tOffsetMs: 1100 },
						{ utf8: ' want', tOffsetMs: 1300 },
						{ utf8: ' to', tOffsetMs: 1500 },
						{ utf8: ' do', tOffsetMs: 1650 },
						{ utf8: ' city', tOffsetMs: 1900 },
						{ utf8: ' streets?', tOffsetMs: 2300 },
						{ utf8: ' Come', tOffsetMs: 2900 },
						{ utf8: ' on.', tOffsetMs: 3200 },
						{ utf8: ' >>', tOffsetMs: 3800 },
						{ utf8: ' Yeah,', tOffsetMs: 4000 },
						{ utf8: ' coming', tOffsetMs: 4300 },
						{ utf8: ' down.', tOffsetMs: 4700 },
						{ utf8: ' >>', tOffsetMs: 5200 },
						{ utf8: ' [music]', tOffsetMs: 5400 },
						{ utf8: ' >>', tOffsetMs: 6000 },
					],
				},
			],
		};
		const cues = cuesFromTimedText(asr);
		const texts = cues.map((cue) => cue.text);
		// Turns become separate cues; no ">>" or [music] survives anywhere.
		expect(texts).toContain("What's up?");
		expect(texts.some((text) => text.startsWith('You want to do city streets?'))).toBe(true);
		expect(texts.some((text) => /coming down\.$/.test(text))).toBe(true);
		expect(texts.every((text) => !text.includes('>>'))).toBe(true);
		expect(texts.every((text) => !/music/i.test(text))).toBe(true);
		// The dialogue's first line starts on its real word, ~9s (not BGM time).
		const first = cues.find((cue) => /what's up/i.test(cue.text));
		expect(first?.start ?? 0).toBeGreaterThan(8.9);
		expect(first?.start ?? 0).toBeLessThan(10);
	});

	it('refines an already-saved broken VTT on open/import', () => {
		const broken = `WEBVTT

1
00:00:00.460 --> 00:00:00.500
to come here and it's going to be an awesome couple of weeks here in China we

2
00:00:00.500 --> 00:00:00.540
start here in Shanghai then I go to Shian Quin Ming and then Beijing so make

3
00:00:00.540 --> 00:00:01.000
sure you get subscribed if you're not already so you don't miss any of that coming up so right now I'm in the people

4
00:00:01.000 --> 00:00:01.060
Square it's very Central here in Shanghai
`;
		const refined = refineWebVtt(broken).toLowerCase();
		expect(refined).toContain('we start here');
		expect(refined).toContain('so make sure');
		expect(refined).toMatch(/people\s+square/);
		expect(refined).not.toMatch(/\bchina we\n/);
		expect(refined).not.toMatch(/\bso make\n/);
	});
});

describe('YouTube capture choices', () => {
	it('parses caption tracks from watch-page HTML', () => {
		const html = `
			<script>
			var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Demo","author":"Channel"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en","name":{"simpleText":"English"},"kind":""}]}}};
			</script>
		`;
		const capture = captureYouTubeFromHtml(
			html,
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		);
		expect(capture?.videoId).toBe('dQw4w9WgXcQ');
		expect(capture?.tracks).toHaveLength(1);
		expect(capture?.tracks[0]?.languageCode).toBe('en');
	});

	it('prefers manual English over English ASR and ignores other languages', () => {
		const tracks = [
			{
				baseUrl: 'asr',
				languageCode: 'en',
				name: 'English auto',
				kind: 'asr',
				isAsr: true,
			},
			{
				baseUrl: 'zh',
				languageCode: 'zh-CN',
				name: '中文',
				kind: '',
				isAsr: false,
			},
			{
				baseUrl: 'en',
				languageCode: 'en-US',
				name: 'English',
				kind: '',
				isAsr: false,
			},
		];
		expect(pickDefaultTrack(tracks)?.baseUrl).toBe('en');
		expect(
			pickDefaultTrack([
				{
					baseUrl: 'es',
					languageCode: 'es',
					name: 'Español',
					kind: '',
					isAsr: false,
				},
			]),
		).toBeNull();
	});
});

describe('YouTube session files', () => {
	it('sanitizes paths and writes portable frontmatter', () => {
		expect(sanitizeImportFileName('A/B: C?')).toBe('A B C');
		expect(youtubeSubtitlePath('Glean/YouTube', 'dQw4w9WgXcQ', 'en-US')).toBe(
			'Glean/YouTube/dQw4w9WgXcQ.en-US.vtt',
		);
		expect(youtubeNotePath('Glean/YouTube', 'A/B', 'dQw4w9WgXcQ')).toBe(
			'Glean/YouTube/A B (dQw4w9WgXcQ).md',
		);
		const note = buildYouTubeSessionNote({
			title: 'A video',
			videoId: 'dQw4w9WgXcQ',
			channel: 'Creator',
			url: 'https://youtu.be/dQw4w9WgXcQ',
			lang: 'en',
			subtitlePath: 'Glean/YouTube/dQw4w9WgXcQ.en.vtt',
		});
		expect(note).toContain('glean-kind: youtube');
		expect(note).toContain('glean-video-id: "dQw4w9WgXcQ"');
	});

	it('validates receiver payloads', () => {
		expect(
			validateImportPayload({
				token: 'secret',
				videoId: 'dQw4w9WgXcQ',
				title: 'A video',
				channel: '',
				url: '',
				lang: 'en',
				vtt: 'WEBVTT\n\n',
			}).ok,
		).toBe(true);
		expect(validateImportPayload({}).ok).toBe(false);
		expect(
			validateImportPayload({
				token: 'secret',
				videoId: 'dQw4w9WgXcQ',
				title: 'A video',
				channel: '',
				url: '',
				lang: 'es',
				vtt: 'WEBVTT\n\n',
			}).ok,
		).toBe(false);
	});
});

describe('YouTube playback', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete (globalThis as { window?: unknown }).window;
	});

	it('snaps rates and explains official player errors', () => {
		expect(snapPlaybackRate(1.4, [0.5, 1, 1.5, 2])).toBe(1.5);
		expect(youtubePlayerError(153)).toContain('Error 153');
	});

	it('loads, seeks, plays, polls and detaches a mocked player', async () => {
		let state = 2;
		let time = 0;
		let rate = 1;
		let destroyed = false;
		let events:
			| {
					onReady: () => void;
					onStateChange: (event: { data: number }) => void;
			  }
			| undefined;

		class Player {
			constructor(
				_target: unknown,
				options: {
					events: {
						onReady: () => void;
						onStateChange: (event: { data: number }) => void;
					};
				},
			) {
				events = options.events;
				queueMicrotask(options.events.onReady);
			}
			playVideo() {
				state = 1;
				events?.onStateChange({ data: 1 });
			}
			pauseVideo() {
				state = 2;
				events?.onStateChange({ data: 2 });
			}
			seekTo(seconds: number) {
				time = seconds;
			}
			getCurrentTime() {
				return time;
			}
			getDuration() {
				return 120;
			}
			getPlayerState() {
				return state;
			}
			setPlaybackRate(next: number) {
				rate = next;
			}
			getPlaybackRate() {
				return rate;
			}
			getAvailablePlaybackRates() {
				return [0.5, 1, 1.5, 2];
			}
			getIframe() {
				return { referrerPolicy: '' };
			}
			destroy() {
				destroyed = true;
			}
		}

		const fakeWindow = Object.assign(globalThis, {
			YT: { Player },
			location: { origin: 'app://obsidian.md' },
		});
		(globalThis as { window?: unknown }).window = fakeWindow;
		const container = {
			empty: vi.fn(),
			createDiv: vi.fn(() => ({})),
		};
		const source = new YouTubeSource();
		source.attach(container as unknown as HTMLElement);
		await source.load('dQw4w9WgXcQ', []);
		source.setPlaybackRate(1.4);
		source.seekTo(12.5);
		source.play();
		expect(source.isPlaying()).toBe(true);
		expect(source.getCurrentTime()).toBe(12.5);
		expect(source.getPlaybackRate()).toBe(1.5);
		source.detach();
		expect(destroyed).toBe(true);
	});
});
