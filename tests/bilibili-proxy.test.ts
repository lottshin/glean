import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import {
	BILIBILI_PROXY_PATH,
	YouTubeImportReceiver,
	bilibiliProxyUrl,
	isBilibiliMediaUrl,
} from '../src/import/receiver';

/**
 * A live URL to exercise the real CDN hop, e.g.
 * `GLEAN_BILI_URL='https://upos-...' npx vitest run tests/bilibili-proxy.test.ts`
 * Signed links expire in about two hours, so this cannot be a fixture.
 */
const LIVE_URL = process.env.GLEAN_BILI_URL ?? '';

const emptyApp = {
	vault: { getAbstractFileByPath: () => null, createFolder: async () => undefined },
} as unknown as App;

describe('isBilibiliMediaUrl', () => {
	it('accepts Bilibili CDN hosts over https', () => {
		expect(isBilibiliMediaUrl('https://upos-sz-estghw.bilivideo.com/v.mp4')).toBe(
			true,
		);
		expect(isBilibiliMediaUrl('https://cn-hk.bilivideo.cn/v.mp4')).toBe(true);
	});

	it('rejects other hosts, plain http, and lookalike domains', () => {
		expect(isBilibiliMediaUrl('https://example.com/v.mp4')).toBe(false);
		expect(isBilibiliMediaUrl('http://x.bilivideo.com/v.mp4')).toBe(false);
		expect(isBilibiliMediaUrl('https://evil-bilivideo.com/v.mp4')).toBe(false);
		expect(isBilibiliMediaUrl('https://bilivideo.com.evil.net/v.mp4')).toBe(false);
		expect(isBilibiliMediaUrl('not a url')).toBe(false);
	});
});

describe('bilibiliProxyUrl', () => {
	it('encodes the target so its query survives the round trip', () => {
		const target = 'https://x.bilivideo.com/v.mp4?deadline=1&upsig=a%2Bb&o=1,3';
		const proxied = bilibiliProxyUrl(17865, 'tok', target);
		const parsed = new URL(proxied);
		expect(parsed.port).toBe('17865');
		expect(parsed.pathname).toBe(BILIBILI_PROXY_PATH);
		expect(parsed.searchParams.get('url')).toBe(target);
		expect(parsed.searchParams.get('token')).toBe('tok');
	});
});

describe('the Bilibili media proxy', () => {
	async function withReceiver(
		run: (base: (query: string) => string) => Promise<void>,
	): Promise<void> {
		const port = await freePort();
		const receiver = new YouTubeImportReceiver(emptyApp, {
			port,
			token: 'secret',
			folder: 'Glean/YouTube',
		});
		await receiver.start();
		try {
			await run(
				(query) => `http://127.0.0.1:${port}${BILIBILI_PROXY_PATH}?${query}`,
			);
		} finally {
			await receiver.stop();
		}
	}

	it('refuses a wrong token', async () => {
		await withReceiver(async (base) => {
			const response = await fetch(
				base('token=nope&url=https%3A%2F%2Fx.bilivideo.com%2Fv.mp4'),
			);
			expect(response.status).toBe(401);
		});
	});

	// Without this the endpoint would be an open relay for anything on the host.
	it('refuses a target outside the Bilibili CDN', async () => {
		await withReceiver(async (base) => {
			const response = await fetch(
				base('token=secret&url=https%3A%2F%2Fexample.com%2Fsecret'),
			);
			expect(response.status).toBe(400);
		});
	});

	it.skipIf(!LIVE_URL)(
		'fetches a real signed link that a browser gets 403 on',
		async () => {
			await withReceiver(async (base) => {
				const proxied = base(
					`token=secret&url=${encodeURIComponent(LIVE_URL)}`,
				);

				const ranged = await fetch(proxied, {
					headers: { Range: 'bytes=0-99' },
				});
				expect(ranged.status).toBe(206);
				expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-99\//);
				expect((await ranged.arrayBuffer()).byteLength).toBe(100);

				// Seeking mid-file must work, or sentence jumps would refetch.
				const middle = await fetch(proxied, {
					headers: { Range: 'bytes=100000-100099' },
				});
				expect(middle.status).toBe(206);
				expect(middle.headers.get('content-range')).toMatch(
					/^bytes 100000-100099\//,
				);

				const full = await fetch(proxied);
				expect(full.status).toBe(200);
				expect(Number(full.headers.get('content-length'))).toBeGreaterThan(0);
				expect(full.headers.get('content-type')).toContain('video');
				await full.body?.cancel();
			});
		},
		30_000,
	);
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('无法分配测试端口');
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}
