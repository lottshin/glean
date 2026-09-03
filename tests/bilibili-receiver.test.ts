import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { YouTubeImportReceiver } from '../src/import/receiver';

describe('Bilibili import receiver', () => {
	it('downloads audio and writes the VTT, audio and session note', async () => {
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
		const download = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
		const receiver = new YouTubeImportReceiver(app, {
			port,
			token: 'secret',
			folder: 'Glean/YouTube',
			bilibiliFolder: 'Glean/Bilibili',
			downloadBilibiliAudio: download,
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
						audioUrls: [
							'https://upos-sz-mirrorcos.bilivideo.com/a.m4s',
						],
					}),
				},
			);
			expect(response.status).toBe(200);
			expect(download).toHaveBeenCalledOnce();
			expect(
				textFiles.get('Glean/Bilibili/BV1GJ411x7h7.en-US.vtt'),
			).toContain('Hello.');
			expect(binaryFiles.get('Glean/Bilibili/BV1GJ411x7h7.m4a'))
				.toHaveProperty('byteLength', 3);
			expect(
				textFiles.get(
					'Glean/Bilibili/English Podcast (BV1GJ411x7h7).md',
				),
			).toContain('glean-kind: bilibili');
			expect(imported).toHaveBeenCalledOnce();
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
