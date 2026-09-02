import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { App } from 'obsidian';
import { YouTubeImportReceiver } from '../src/import/receiver';

describe('YouTube import receiver', () => {
	it('rejects a bad token, accepts a valid payload and writes both files', async () => {
		const port = await freePort();
		const files = new Map<string, string>();
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					files.has(path) ? { path } : null,
				createFolder: async () => undefined,
				create: async (path: string, content: string) => {
					files.set(path, content);
					return { path };
				},
				modify: async (file: { path: string }, content: string) => {
					files.set(file.path, content);
				},
			},
		} as unknown as App;
		const imported = vi.fn();
		const receiver = new YouTubeImportReceiver(app, {
			port,
			token: 'secret',
			folder: 'Glean/YouTube',
			onImported: imported,
		});
		await receiver.start();

		try {
			const base = {
				videoId: 'dQw4w9WgXcQ',
				title: 'A video',
				channel: 'Creator',
				url: 'https://youtu.be/dQw4w9WgXcQ',
				lang: 'en',
				vtt: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello.\n',
			};
			const denied = await fetch(`http://127.0.0.1:${port}/glean/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...base, token: 'wrong' }),
			});
			expect(denied.status).toBe(401);
			expect(denied.headers.get('access-control-allow-origin')).toBe('*');

			const accepted = await fetch(`http://127.0.0.1:${port}/glean/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...base, token: 'secret' }),
			});
			expect(accepted.status).toBe(200);
			expect(files.get('Glean/YouTube/dQw4w9WgXcQ.en.vtt')).toContain(
				'Hello.',
			);
			expect(
				files.get('Glean/YouTube/A video (dQw4w9WgXcQ).md'),
			).toContain('glean-kind: youtube');
			expect(imported).toHaveBeenCalledOnce();
		} finally {
			await receiver.stop();
		}
	});
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
