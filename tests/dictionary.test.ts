import { execFileSync } from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DictionaryService } from '../src/dictionary';
import { SortedTsvFile } from '../src/dictionary/sorted-tsv';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'tests/fixtures/ecdict-mini.csv');
const output = mkdtempSync(path.join(tmpdir(), 'glean-runtime-dict-'));
let dictionary: DictionaryService;

beforeAll(async () => {
	execFileSync(
		process.execPath,
		[
			'tools/build-dict.mjs',
			'--input',
			fixture,
			'--out-dir',
			output,
			'--rank-limit',
			'50000',
		],
		{ cwd: root },
	);
	dictionary = await DictionaryService.open(
		path.join(output, 'glean-dict-v1.tsv'),
		path.join(output, 'glean-inflect-v1.tsv'),
	);
});

afterAll(async () => {
	await dictionary.close();
	rmSync(output, { recursive: true, force: true });
});

describe('SortedTsvFile', () => {
	it('finds first, middle and final lines in CRLF files', async () => {
		const filePath = path.join(output, 'boundaries.tsv');
		writeFileSync(filePath, `alpha\t1\r\n${'middle\t' + 'x'.repeat(5000)}\r\nzulu\t3\r\n`);
		const file = await SortedTsvFile.open(filePath);
		try {
			expect(await file.find('alpha')).toBe('alpha\t1');
			expect(await file.find('middle')).toBe(`middle\t${'x'.repeat(5000)}`);
			expect(await file.find('zulu')).toBe('zulu\t3');
			expect(await file.find('missing')).toBeNull();
		} finally {
			await file.close();
		}
	});

	it('handles empty files', async () => {
		const filePath = path.join(output, 'empty.tsv');
		writeFileSync(filePath, '');
		const file = await SortedTsvFile.open(filePath);
		try {
			expect(await file.find('anything')).toBeNull();
		} finally {
			await file.close();
		}
	});
});

describe('DictionaryService', () => {
	it('returns structured direct matches', async () => {
		const result = await dictionary.lookup('Hello');
		expect(result.match).toBe('direct');
		expect(result.lemma).toBe('hello');
		expect(result.entry?.translations).toEqual(['你好']);
		expect(result.entry?.phonetic).toBe('həˈləʊ');
	});

	it('resolves generated and explicit lemma mappings', async () => {
		expect(await dictionary.lookup('went')).toMatchObject({
			match: 'inflection',
			lemma: 'go',
		});
		expect(await dictionary.lookup('were')).toMatchObject({
			match: 'inflection',
			lemma: 'be',
		});
	});

	it('falls back from possessives and curly apostrophes', async () => {
		expect(await dictionary.lookup('Hello’s')).toMatchObject({
			match: 'possessive',
			lemma: 'hello',
		});
	});

	it('returns a useful missing result', async () => {
		expect(await dictionary.lookup('Not-In-The-Dictionary')).toEqual({
			surface: 'Not-In-The-Dictionary',
			lemma: 'not-in-the-dictionary',
			match: 'missing',
			entry: null,
		});
	});

	it('keeps the generated files sorted', () => {
		const keys = readFileSync(path.join(output, 'glean-dict-v1.tsv'), 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split('\t')[0] ?? '');
		expect(keys).toEqual([...keys].sort());
	});
});
