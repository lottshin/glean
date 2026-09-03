import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { YouTubeImportReceiver } from '../src/import/receiver';

const MEDIA_URL =
	'https://upos-sz-mirrorcos.bilivideo.com/v.mp4?deadline=1788433957';

describe('Bilibili import receiver', () => {
	it('writes the VTT and session note without downloading any media', async () => {
		const port = await freePort();
		const textFiles = new Map<string, string>();
		const binaryFiles = new Map<string, ArrayBuffer>();
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					textFiles.has(path) || binaryFiles.has(path) ? { path } : null,
				createFolder: async () => undefined,
				create: async (path: string, content: string) => {
					textFiles.set(path, content);
					return { path };
				},
				modify: async (file: { path: string }, content: string) => {
					textFiles.set(file.path, content);
				},
				createBinary: async (path: string, content: ArrayBuffer) => {
					binaryFiles.set(path, content);
					return { path };
				},
				modifyBinary: async (file: { path: string }, content: ArrayBuffer) => {
					binaryFiles.set(file.path, content);
				},
			},
		} as unknown as App;
		const imported = vi.fn();
		const receiver = new YouTubeImportReceiver(app, {
			port,
			token: 'secret',
			folder: 'Glean/YouTube',
			bilibiliFolder: 'Glean/Bilibili',
			onBilibiliImported: imported,
		});
		await receiver.start();

		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/glean/import/bilibili`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						token: 'secret',
						bvid: 'BV1GJ411x7h7',
						page: 1,
						cid: 123456,
						title: 'English Podcast',
						owner: 'Teacher',
						url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
						lang: 'en-US',
						vtt: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello.\n',
						mediaUrls: [MEDIA_URL],
						mediaSize: 7725547,
						mediaQuality: '720P',
						mediaExpiresAt: 1788433957,
					}),
				},
			);
			expect(response.status).toBe(200);
			expect(
				textFiles.get('Glean/Bilibili/BV1GJ411x7h7.en-US.vtt'),
			).toContain('Hello.');
			// Streaming means nothing heavy lands in the vault.
			expect(binaryFiles.size).toBe(0);

			const note = textFiles.get(
				'Glean/Bilibili/English Podcast (BV1GJ411x7h7).md',
			);
			expect(note).toContain('glean-kind: bilibili');
			expect(note).toContain(`media-url: "${MEDIA_URL}"`);
			expect(note).toContain('7.4 MB');
			expect(imported).toHaveBeenCalledOnce();
			expect(imported.mock.calls[0]?.[0]).toMatchObject({
				mediaUrl: MEDIA_URL,
				mediaSize: 7725547,
				mediaExpiresAt: 1788433957,
			});
		} finally {
			await receiver.stop();
		}
	});

	it('rejects a payload whose media URL is not a Bilibili CDN', async () => {
		const port = await freePort();
		const app = {
			vault: {
				getAbstractFileByPath: () => null,
				createFolder: async () => undefined,
				create: async () => ({ path: 'x' }),
			},
		} as unknown as App;
		const receiver = new YouTubeImportReceiver(app, {
			port,
			token: 'secret',
			folder: 'Glean/YouTube',
		});
		await receiver.start();
		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/glean/import/bilibili`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						token: 'secret',
						bvid: 'BV1GJ411x7h7',
						page: 1,
						cid: 123456,
						title: 'English Podcast',
						lang: 'en-US',
						vtt: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi.\n',
						mediaUrls: ['https://evil.example.com/v.mp4'],
					}),
				},
			);
			expect(response.status).toBe(400);
		} finally {
			await receiver.stop();
		}
	});
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) =>
		server.listen(0, '127.0.0.1', resolve),
	);
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('无法分配测试端口');
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}
