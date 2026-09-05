import { describe, expect, it } from 'vitest';

import {
	YOUDAO_VOICE_GB,
	YOUDAO_VOICE_US,
	buildYoudaoTtsForm,
	parseYoudaoTtsResponse,
	youdaoSignInput,
	youdaoVoiceName,
} from '../src/speak/youdao';

describe('youdao TTS helpers', () => {
	it('keeps short queries intact for the v3 input', () => {
		expect(youdaoSignInput('pull')).toBe('pull');
	});

	it('truncates long queries the way Youdao documents', () => {
		const q = 'abcdefghijklmnopqrstuvwxyz';
		expect(youdaoSignInput(q)).toBe(`abcdefghij${q.length}qrstuvwxyz`);
	});

	it('maps 美/英 to the dictionary voices', () => {
		expect(youdaoVoiceName('en-US')).toBe(YOUDAO_VOICE_US);
		expect(youdaoVoiceName('auto')).toBe(YOUDAO_VOICE_US);
		expect(youdaoVoiceName('en-GB')).toBe(YOUDAO_VOICE_GB);
	});

	it('signs a form without putting the secret in query keys', async () => {
		const body = await buildYoudaoTtsForm(
			'later',
			'en-GB',
			{ appKey: 'id', appSecret: 'secret' },
			1_700_000_000,
			'salt-1',
		);
		expect(body.get('voiceName')).toBe(YOUDAO_VOICE_GB);
		expect(body.get('appKey')).toBe('id');
		expect(body.get('signType')).toBe('v3');
		expect(body.get('appSecret')).toBeNull();
		expect(body.get('sign')).toHaveLength(64);
	});

	it('treats audio content as success', () => {
		const data = new Uint8Array([1, 2, 3]).buffer;
		expect(
			parseYoudaoTtsResponse('audio/mp3', '', data),
		).toEqual({ status: 'ok', data });
	});

	it('maps Youdao JSON error codes', () => {
		const result = parseYoudaoTtsResponse(
			'application/json',
			'{"errorCode":"202"}',
			new ArrayBuffer(0),
		);
		expect(result.status).toBe('error');
		if (result.status === 'error') {
			expect(result.message).toContain('密钥');
		}
	});
});
