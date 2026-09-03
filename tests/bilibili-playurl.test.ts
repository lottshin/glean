import { describe, expect, it } from 'vitest';
import {
	audioTracksFromPlayInfo,
	pickSpeechAudioTrack,
} from '../src/bilibili/playurl';

describe('Bilibili audio tracks', () => {
	const payload = {
		data: {
			dash: {
				audio: [
					{
						id: 30232,
						bandwidth: 82668,
						mimeType: 'audio/mp4',
						codecs: 'mp4a.40.2',
						baseUrl: 'https://a.bilivideo.com/132.m4s',
						backupUrl: ['https://b.bilivideo.com/132.m4s'],
					},
					{
						id: 30216,
						bandwidth: 43091,
						mime_type: 'audio/mp4',
						codecs: 'mp4a.40.5',
						base_url: 'https://a.bilivideo.com/64.m4s',
						backup_url: ['https://b.bilivideo.com/64.m4s'],
					},
				],
			},
		},
	};

	it('parses camelCase and snake_case responses', () => {
		const tracks = audioTracksFromPlayInfo(payload);
		expect(tracks).toHaveLength(2);
		expect(tracks[1]?.urls).toEqual([
			'https://a.bilivideo.com/64.m4s',
			'https://b.bilivideo.com/64.m4s',
		]);
	});

	it('chooses the smallest speech-usable AAC stream', () => {
		expect(pickSpeechAudioTrack(audioTracksFromPlayInfo(payload))?.id).toBe(
			30216,
		);
	});

	it('returns null for a response with no audio', () => {
		expect(audioTracksFromPlayInfo({ data: { dash: {} } })).toEqual([]);
		expect(pickSpeechAudioTrack([])).toBeNull();
	});
});
