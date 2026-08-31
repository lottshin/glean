import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'tests/fixtures/ecdict-mini.csv');
const subtitle = path.join(root, 'tests/fixtures/coverage.srt');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), 'echo-dict-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('dictionary data tools', () => {
	it('builds sorted compact entries and inflection mappings', () => {
		const output = temporaryDirectory();
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

		const dictionary = readFileSync(path.join(output, 'echo-dict-v1.tsv'), 'utf8');
		const inflections = readFileSync(path.join(output, 'echo-inflect-v1.tsv'), 'utf8');
		const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8')) as {
			output: { dictionary: { entries: number } };
			stats: { translationTruncated: number };
		};

		expect(dictionary.split('\n').filter(Boolean).map((line) => line.split('\t')[0])).toEqual([
			'be',
			'go',
			'hello',
		]);
		expect(dictionary).toContain('去 | 走 | 移动');
		expect(dictionary).not.toContain('第四条会被截断');
		expect(inflections).toContain('went\tgo');
		expect(inflections).toContain('were\tbe');
		expect(report.output.dictionary.entries).toBe(3);
		expect(report.stats.translationTruncated).toBe(1);
	});

	it('reports direct, lemma and unmatched subtitle tokens', () => {
		const output = temporaryDirectory();
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
		const reportPath = path.join(output, 'coverage.json');
		execFileSync(
			process.execPath,
			[
				'tools/sample-coverage.mjs',
				'--dict',
				path.join(output, 'echo-dict-v1.tsv'),
				'--inflections',
				path.join(output, 'echo-inflect-v1.tsv'),
				'--out',
				reportPath,
				subtitle,
			],
			{ cwd: root },
		);
		const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
			coverage: { direct: number; viaLemma: number; unmatched: number };
			lemmaMatches: Array<{ token: string; lemma: string }>;
		};

		expect(report.coverage).toEqual({ direct: 1, viaLemma: 2, unmatched: 2, percent: 60 });
		expect(report.lemmaMatches).toEqual(
			expect.arrayContaining([
				{ token: 'went', lemma: 'go' },
				{ token: 'goes', lemma: 'go' },
			]),
		);
	});
});
