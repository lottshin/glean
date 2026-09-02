import { gunzipSync } from 'fflate';
import type { DataAdapter } from 'obsidian';
import { loadNodeModule } from '../node-bridge';
const EXPECTED_FILES = new Set([
	'glean-dict-v1.tsv',
	'glean-inflect-v1.tsv',
]);

export interface BundledDictionaryFile {
	name: string;
	bytes: number;
	sha256: string;
	gzipBase64: string;
}

export interface BundledDictionaryPackage {
	version: number;
	files: BundledDictionaryFile[];
}

export interface DictionaryInstallProgress {
	completed: number;
	total: number;
	file: string;
}

export interface VaultDictionaryTarget {
	adapter: DataAdapter;
	directory: string;
}

export async function installBundledDictionary(
	target: string | VaultDictionaryTarget,
	bundle: BundledDictionaryPackage,
	onProgress?: (progress: DictionaryInstallProgress) => void,
): Promise<void> {
	validatePackage(bundle);
	const storage =
		typeof target === 'string'
			? await nodeStorage(target)
			: await adapterStorage(target);
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const prepared: Array<{ temporary: string; destination: string }> = [];
	try {
		for (const [index, file] of bundle.files.entries()) {
			const data = gunzipSync(decodeBase64(file.gzipBase64));
			if (
				data.byteLength !== file.bytes ||
				(await digest(data)) !== file.sha256
			) {
				throw new Error(`内置词典校验失败：${file.name}`);
			}
			const temporary = storage.path(`.${file.name}.${nonce}.tmp`);
			await storage.writeBinary(temporary, data);
			prepared.push({
				temporary,
				destination: storage.path(file.name),
			});
			onProgress?.({
				completed: index + 1,
				total: bundle.files.length,
				file: file.name,
			});
		}

		for (const file of prepared) {
			await storage.remove(file.destination);
			await storage.rename(file.temporary, file.destination);
		}
		await storage.writeText(
			storage.path('.glean-dictionary.json'),
			`${JSON.stringify({
				version: bundle.version,
				files: bundle.files.map(({ name, bytes, sha256 }) => ({
					name,
					bytes,
					sha256,
				})),
			}, null, 2)}\n`,
		);
	} finally {
		await Promise.all(
			prepared.map(({ temporary }) => storage.remove(temporary)),
		);
	}
}

function validatePackage(bundle: BundledDictionaryPackage): void {
	if (
		!Number.isInteger(bundle.version) ||
		bundle.version < 1 ||
		bundle.files.length !== EXPECTED_FILES.size
	) {
		throw new Error('内置词典包无效');
	}
	const names = new Set(bundle.files.map((file) => file.name));
	for (const name of EXPECTED_FILES) {
		if (!names.has(name)) {
			throw new Error(`内置词典缺少文件：${name}`);
		}
	}
	for (const file of bundle.files) {
		if (
			!EXPECTED_FILES.has(file.name) ||
			!Number.isInteger(file.bytes) ||
			file.bytes < 1 ||
			!/^[a-f0-9]{64}$/.test(file.sha256) ||
			file.gzipBase64.length === 0
		) {
			throw new Error(`内置词典文件无效：${file.name}`);
		}
	}
}

interface DictionaryStorage {
	path(name: string): string;
	writeBinary(path: string, data: Uint8Array): Promise<void>;
	writeText(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

async function digest(data: Uint8Array): Promise<string> {
	const copy = new Uint8Array(data);
	const hash = await crypto.subtle.digest('SHA-256', copy.buffer);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

async function adapterStorage(
	target: VaultDictionaryTarget,
): Promise<DictionaryStorage> {
	const { adapter } = target;
	const directory = target.directory.replace(/^\/+|\/+$/g, '');
	await mkdirAdapter(adapter, directory);
	return {
		path: (name) => `${directory}/${name}`,
		writeBinary: async (path, data) => {
			const copy = new Uint8Array(data);
			await adapter.writeBinary(path, copy.buffer);
		},
		writeText: (path, data) => adapter.write(path, data),
		remove: async (path) => {
			if (await adapter.exists(path)) {
				await adapter.remove(path);
			}
		},
		rename: (from, to) => adapter.rename(from, to),
	};
}

async function mkdirAdapter(adapter: DataAdapter, directory: string): Promise<void> {
	const parts = directory.split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) {
			await adapter.mkdir(current);
		}
	}
}

async function nodeStorage(directory: string): Promise<DictionaryStorage> {
	const { mkdir, rename, rm, writeFile } =
		loadNodeModule<typeof import('fs/promises')>('fs/promises');
	const pathModule = loadNodeModule<typeof import('path')>('path');
	await mkdir(directory, { recursive: true });
	return {
		path: (name) => pathModule.join(directory, name),
		writeBinary: (path, data) => writeFile(path, data),
		writeText: (path, data) => writeFile(path, data),
		remove: (path) => rm(path, { force: true }),
		rename,
	};
}
