import { describe, expect, it } from 'vitest';
import {
	captureBilibiliPage,
	parsePageNumber,
	parseParts,
	parseVideoInfo,
	selectPart,
} from '../extension/src/bilibili-capture';

const BV = 'BV1GJ411x7h7';

const viewResponse = {
	code: 0,
	data: {
		bvid: BV,
		aid: 12345,
		title: '英语演讲合集',
		owner: { name: 'UP主甲' },
		pages: [
			{ cid: 1001, page: 1, part: '第一讲' },
			{ cid: 1002, page: 2, part: '第二讲' },
		],
	},
};

const playerResponse = {
	code: 0,
	data: {
		subtitle: {
			subtitles: [
				{ lan: 'en-US', lan_doc: '英语', subtitle_url: '//sub/en.json' },
			],
		},
	},
};

function stubFetch(routes: Record<string, unknown>, status = 200): typeof fetch {
	return (async (input: string) => {
		const key = Object.keys(routes).find((route) => String(input).includes(route));
		if (!key) {
			return { ok: false, status: 404, json: async () => ({}) } as Response;
		}
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => routes[key],
		} as Response;
	}) as unknown as typeof fetch;
}

describe('video info parsing', () => {
	it('reads title, owner and parts', () => {
		const info = parseVideoInfo(viewResponse);
		expect(info?.bvid).toBe(BV);
		expect(info?.aid).toBe(12345);
		expect(info?.owner).toBe('UP主甲');
		expect(info?.parts).toHaveLength(2);
	});

	it('returns null when the response carries no video', () => {
		expect(parseVideoInfo({ code: -404, data: null })).toBeNull();
		expect(parseVideoInfo(null)).toBeNull();
	});

	it('skips parts with no cid', () => {
		const parts = parseParts({ data: { pages: [{ page: 1 }, { cid: 7, page: 2 }] } });
		expect(parts).toEqual([{ cid: 7, page: 2, title: '' }]);
	});
});

describe('part selection', () => {
	it('defaults to part 1 when the url has no p', () => {
		expect(parsePageNumber(`https://www.bilibili.com/video/${BV}`)).toBe(1);
	});

	it('reads the p parameter', () => {
		expect(parsePageNumber(`https://www.bilibili.com/video/${BV}?p=2`)).toBe(2);
	});

	it('ignores a nonsense p', () => {
		expect(parsePageNumber(`https://www.bilibili.com/video/${BV}?p=abc`)).toBe(1);
		expect(parsePageNumber(`https://www.bilibili.com/video/${BV}?p=0`)).toBe(1);
	});

	it('falls back to the first part when p is out of range', () => {
		const parts = parseParts(viewResponse);
		expect(selectPart(parts, 9)?.cid).toBe(1001);
		expect(selectPart([], 1)).toBeNull();
	});
});

describe('capture', () => {
	it('collects ids, title and subtitle tracks', async () => {
		const capture = await captureBilibiliPage(
			`https://www.bilibili.com/video/${BV}`,
			stubFetch({ 'web-interface/view': viewResponse, 'player/v2': playerResponse }),
		);
		expect(capture?.bvid).toBe(BV);
		expect(capture?.cid).toBe(1001);
		expect(capture?.owner).toBe('UP主甲');
		expect(capture?.tracks).toHaveLength(1);
		expect(capture?.tracks[0]?.subtitleUrl).toBe('https://sub/en.json');
	});

	it('picks the cid of the requested part and labels it', async () => {
		const capture = await captureBilibiliPage(
			`https://www.bilibili.com/video/${BV}?p=2`,
			stubFetch({ 'web-interface/view': viewResponse, 'player/v2': playerResponse }),
		);
		expect(capture?.cid).toBe(1002);
		expect(capture?.title).toBe('英语演讲合集 - 第二讲');
		expect(capture?.url).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
	});

	it('reports an empty track list rather than throwing when signed out', async () => {
		const capture = await captureBilibiliPage(
			`https://www.bilibili.com/video/${BV}`,
			stubFetch({
				'web-interface/view': viewResponse,
				'player/v2': { code: 0, data: { subtitle: { subtitles: [] } } },
			}),
		);
		expect(capture?.tracks).toEqual([]);
	});

	it('returns null for a non-bilibili url', async () => {
		expect(
			await captureBilibiliPage('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
		).toBeNull();
	});
});
