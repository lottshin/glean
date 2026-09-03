import { describe, expect, it } from 'vitest';
import {
	bilibiliMediaPath,
	bilibiliNotePath,
	bilibiliSubtitlePath,
	buildBilibiliSessionNote,
	formatMediaSize,
	validateBilibiliImportPayload,
} from '../src/bilibili/session';

const base = {
	token: 'secret',
	bvid: 'BV1GJ411x7h7',
	page: 1,
	cid: 123456,
	title: 'English Podcast',
	owner: 'Teacher',
	url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
	lang: 'en-US',
	vtt: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello.\n',
	mediaUrls: [
		'https://upos-sz-mirrorcos.bilivideo.com/v.mp4?deadline=1788433957',
	],
	mediaSize: 7725547,
	mediaQuality: '720P',
	mediaExpiresAt: 1788433957,
};

describe('Bilibili session paths', () => {
	it('keeps single-part names short and disambiguates later parts', () => {
		expect(
			bilibiliSubtitlePath('Glean/Bilibili', base.bvid, 1, 'en-US'),
		).toBe(`Glean/Bilibili/${base.bvid}.en-US.vtt`);
		expect(bilibiliMediaPath('Glean/Bilibili', base.bvid, 2)).toBe(
			`Glean/Bilibili/${base.bvid}.p2.mp4`,
		);
		expect(
			bilibiliNotePath('Glean/Bilibili', 'A / B', base.bvid, 2),
		).toBe(`Glean/Bilibili/A B (${base.bvid} p2).md`);
	});

	it('records the streaming link and its expiry in frontmatter', () => {
		const note = buildBilibiliSessionNote({
			...base,
			subtitlePath: `Glean/Bilibili/${base.bvid}.en-US.vtt`,
			mediaUrl: base.mediaUrls[0]!,
		});
		expect(note).toContain('glean-kind: bilibili');
		expect(note).toContain(`glean-video-id: "${base.bvid}"`);
		expect(note).toContain(`media-url: "${base.mediaUrls[0]}"`);
		expect(note).toContain('media-expires: 1788433957');
		expect(note).toContain('media-quality: "720P"');
		// No media file is written, so nothing should claim a vault path.
		expect(note).not.toContain('media: ');
	});

	it('omits the expiry line when the link is unsigned', () => {
		const note = buildBilibiliSessionNote({
			...base,
			subtitlePath: 'sub.vtt',
			mediaUrl: 'https://upos-sz-mirrorcos.bilivideo.com/v.mp4',
			mediaExpiresAt: null,
		});
		expect(note).not.toContain('media-expires');
	});
});

describe('formatMediaSize', () => {
	it('keeps one decimal below 100 MB and rounds above it', () => {
		expect(formatMediaSize(7725547)).toBe('7.4 MB');
		expect(formatMediaSize(210 * 1048576)).toBe('210 MB');
		expect(formatMediaSize(0)).toBe('未知大小');
	});
});

describe('Bilibili import validation', () => {
	it('accepts an English track from an approved Bilibili CDN', () => {
		const result = validateBilibiliImportPayload(base);
		expect(result.ok).toBe(true);
	});

	it('carries media metadata through so the note can show the size', () => {
		const result = validateBilibiliImportPayload(base);
		expect(result.ok && result.payload.mediaSize).toBe(7725547);
		expect(result.ok && result.payload.mediaQuality).toBe('720P');
		expect(result.ok && result.payload.mediaExpiresAt).toBe(1788433957);
	});

	it('treats a missing expiry as unsigned rather than failing', () => {
		const result = validateBilibiliImportPayload({
			...base,
			mediaExpiresAt: 'soon',
		});
		expect(result.ok && result.payload.mediaExpiresAt).toBe(null);
	});

	it('accepts an AI English language code', () => {
		expect(
			validateBilibiliImportPayload({ ...base, lang: 'ai-en' }).ok,
		).toBe(true);
	});

	it('rejects Chinese tracks', () => {
		const result = validateBilibiliImportPayload({ ...base, lang: 'ai-zh' });
		expect(result).toEqual({
			ok: false,
			error: '当前只接收英文字幕轨',
		});
	});

	it('rejects arbitrary media URLs to prevent SSRF', () => {
		const result = validateBilibiliImportPayload({
			...base,
			mediaUrls: ['https://example.com/private'],
		});
		expect(result).toEqual({
			ok: false,
			error: '缺少可用的 B 站媒体地址',
		});
	});

	it('rejects invalid ids and cids', () => {
		expect(
			validateBilibiliImportPayload({ ...base, bvid: 'bad' }).ok,
		).toBe(false);
		expect(
			validateBilibiliImportPayload({ ...base, cid: 1.5 }).ok,
		).toBe(false);
	});
});
