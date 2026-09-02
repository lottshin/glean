import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataAdapter } from 'obsidian';
import {
	installBundledDictionary,
	type BundledDictionaryPackage,
} from '../src/dictionary/install';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) =>
			rm(path, { recursive: true, force: true }),
		),
	);
});

describe('bundled dictionary installer', () => {
	it('validates and installs both files with metadata', async () => {
		const directory = await temporaryDirectory();
		const bundle = packageFrom({
			'glean-dict-v1.tsv': 'hello\thello\n',
			'glean-inflect-v1.tsv': 'went\tgo\n',
		});
		const progress: string[] = [];

		await installBundledDictionary(directory, bundle, ({ file }) => {
			progress.push(file);
		});

		expect(await readFile(join(directory, 'glean-dict-v1.tsv'), 'utf8')).toBe(
			'hello\thello\n',
		);
		expect(
			await readFile(join(directory, 'glean-inflect-v1.tsv'), 'utf8'),
		).toBe('went\tgo\n');
		expect(progress).toEqual([
			'glean-dict-v1.tsv',
			'glean-inflect-v1.tsv',
		]);
		const metadata = JSON.parse(
			await readFile(join(directory, '.glean-dictionary.json'), 'utf8'),
		) as { version: number };
		expect(metadata.version).toBe(1);
	});

	it('rejects corrupted content without leaving temporary files', async () => {
		const directory = await temporaryDirectory();
		const bundle = packageFrom({
			'glean-dict-v1.tsv': 'hello\thello\n',
			'glean-inflect-v1.tsv': 'went\tgo\n',
		});
		bundle.files[0]!.sha256 = '0'.repeat(64);

		await expect(
			installBundledDictionary(directory, bundle),
		).rejects.toThrow('校验失败');
		expect(await readdir(directory)).toEqual([]);
	});

	it('installs through the vault adapter for mobile platforms', async () => {
		const files = new Map<string, Uint8Array | string>();
		const directories = new Set<string>();
		const adapter = {
			exists: async (path: string) =>
				files.has(path) || directories.has(path),
			mkdir: async (path: string) => {
				directories.add(path);
			},
			writeBinary: async (path: string, data: ArrayBuffer) => {
				files.set(path, new Uint8Array(data));
			},
			write: async (path: string, data: string) => {
				files.set(path, data);
			},
			remove: async (path: string) => {
				files.delete(path);
			},
			rename: async (from: string, to: string) => {
				const value = files.get(from);
				if (value === undefined) {
					throw new Error('missing temporary file');
				}
				files.delete(from);
				files.set(to, value);
			},
		} as unknown as DataAdapter;

		await installBundledDictionary(
			{ adapter, directory: '.obsidian/glean/dict' },
			packageFrom({
				'glean-dict-v1.tsv': 'hello\thello\n',
				'glean-inflect-v1.tsv': 'went\tgo\n',
			}),
		);

		const dictionary = files.get(
			'.obsidian/glean/dict/glean-dict-v1.tsv',
		);
		expect(new TextDecoder().decode(dictionary as Uint8Array)).toBe(
			'hello\thello\n',
		);
		expect(
			files.get('.obsidian/glean/dict/.glean-dictionary.json'),
		).toContain('"version": 1');
	});
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'glean-dictionary-'));
	temporaryDirectories.push(path);
	return path;
}

function packageFrom(
	files: Record<string, string>,
): BundledDictionaryPackage {
	return {
		version: 1,
		files: Object.entries(files).map(([name, text]) => {
			const data = Buffer.from(text);
			return {
				name,
				bytes: data.byteLength,
				sha256: createHash('sha256').update(data).digest('hex'),
				gzipBase64: gzipSync(data).toString('base64'),
			};
		}),
	};
}
