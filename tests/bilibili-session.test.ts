import { describe, expect, it } from 'vitest';
import {
	bilibiliAudioPath,
	bilibiliNotePath,
	bilibiliSubtitlePath,
	buildBilibiliSessionNote,
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
	audioUrls: ['https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?token=x'],
};

describe('Bilibili session paths', () => {
	it('keeps single-part names short and disambiguates later parts', () => {
		expect(
			bilibiliSubtitlePath('Glean/Bilibili', base.bvid, 1, 'en-US'),
		).toBe(`Glean/Bilibili/${base.bvid}.en-US.vtt`);
		expect(bilibiliAudioPath('Glean/Bilibili', base.bvid, 2)).toBe(
			`Glean/Bilibili/${base.bvid}.p2.m4a`,
		);
		expect(
			bilibiliNotePath('Glean/Bilibili', 'A / B', base.bvid, 2),
		).toBe(`Glean/Bilibili/A B (${base.bvid} p2).md`);
	});

	it('writes local audio and subtitle paths into frontmatter', () => {
		const note = buildBilibiliSessionNote({
			...base,
			subtitlePath: `Glean/Bilibili/${base.bvid}.en-US.vtt`,
			audioPath: `Glean/Bilibili/${base.bvid}.m4a`,
		});
		expect(note).toContain('glean-kind: bilibili');
		expect(note).toContain(`glean-video-id: "${base.bvid}"`);
		expect(note).toContain(`audio: "Glean/Bilibili/${base.bvid}.m4a"`);
	});
});

describe('Bilibili import validation', () => {
	it('accepts an English track from an approved Bilibili CDN', () => {
		const result = validateBilibiliImportPayload(base);
		expect(result.ok).toBe(true);
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

	it('rejects arbitrary download URLs to prevent SSRF', () => {
		const result = validateBilibiliImportPayload({
			...base,
			audioUrls: ['https://example.com/private'],
		});
		expect(result).toEqual({
			ok: false,
			error: '缺少可用的 B 站音频地址',
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
