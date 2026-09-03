import { describe, expect, it } from 'vitest';
import { mediaTrackFromPlayUrl, playUrlExpiry } from '../src/bilibili/playurl';

// Shape taken from a real `fnval=1` response for a 5-minute TED-Ed clip.
const response = {
	code: 0,
	message: 'OK',
	data: {
		quality: 64,
		format: 'mp4720',
		accept_description: ['高清 720P', '流畅 360P'],
		durl: [
			{
				order: 1,
				length: 321194,
				size: 7725547,
				url: 'https://upos-sz-estghw.bilivideo.com/v.mp4?deadline=1788433957&os=upos',
				backup_url: [
					'https://upos-sz-mirrorhwo1.bilivideo.com/v.mp4?deadline=1788433957',
				],
			},
		],
	},
};

describe('mediaTrackFromPlayUrl', () => {
	it('reads the muxed MP4 with its size and expiry', () => {
		const track = mediaTrackFromPlayUrl(response);
		expect(track).toMatchObject({
			quality: 64,
			format: 'mp4720',
			size: 7725547,
			durationMs: 321194,
			expiresAt: 1788433957,
		});
		expect(track?.urls).toHaveLength(2);
	});

	it('accepts a bare data object as well as a full envelope', () => {
		expect(mediaTrackFromPlayUrl(response.data)?.size).toBe(7725547);
	});

	it('declines multi-segment videos, which would need a remux', () => {
		const split = {
			data: {
				quality: 64,
				durl: [
					{ url: 'https://a.bilivideo.com/1.mp4', size: 10 },
					{ url: 'https://a.bilivideo.com/2.mp4', size: 10 },
				],
			},
		};
		expect(mediaTrackFromPlayUrl(split)).toBeNull();
	});

	it('declines a DASH-only response', () => {
		expect(
			mediaTrackFromPlayUrl({ data: { dash: { video: [], audio: [] } } }),
		).toBeNull();
	});

	it('tolerates a segment with no usable URL', () => {
		expect(
			mediaTrackFromPlayUrl({ data: { durl: [{ size: 10 }] } }),
		).toBeNull();
	});
});

describe('playUrlExpiry', () => {
	it('pulls the deadline out of a signed CDN link', () => {
		expect(
			playUrlExpiry('https://x.bilivideo.com/v.mp4?os=upos&deadline=1788433957'),
		).toBe(1788433957);
	});

	it('returns null when the link carries no deadline', () => {
		expect(playUrlExpiry('https://x.bilivideo.com/v.mp4')).toBeNull();
		expect(playUrlExpiry('https://x.bilivideo.com/v.mp4?deadline=abc')).toBeNull();
	});
});
