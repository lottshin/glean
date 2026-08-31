#!/usr/bin/env node

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const TOKEN = /[a-z0-9]+(?:['’-][a-z0-9]+)*/gi;
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);

function usage() {
	console.log(`Usage:
  node tools/sample-coverage.mjs --dict <echo-dict-v1.tsv>
    [--inflections <echo-inflect-v1.tsv>] [--sample-size 200] [--out <report.json>]
    <subtitle.srt|subtitle.vtt|directory> [...]`);
}

function parseArgs(argv) {
	const args = {
		dict: '',
		inflections: '',
		sampleSize: 200,
		out: '',
		inputs: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = argv[i + 1];
		if (arg === '--help' || arg === '-h') {
			usage();
			process.exit(0);
		}
		if (arg === '--dict' && value) {
			args.dict = value;
			i += 1;
		} else if (arg === '--inflections' && value) {
			args.inflections = value;
			i += 1;
		} else if (arg === '--sample-size' && value) {
			args.sampleSize = Number.parseInt(value, 10);
			i += 1;
		} else if (arg === '--out' && value) {
			args.out = value;
			i += 1;
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown argument: ${arg}`);
		} else {
			args.inputs.push(arg);
		}
	}
	if (!args.dict) {
		throw new Error('--dict is required');
	}
	if (!Number.isSafeInteger(args.sampleSize) || args.sampleSize <= 0) {
		throw new Error('--sample-size must be a positive integer');
	}
	if (args.inputs.length === 0) {
		throw new Error('Provide at least one subtitle file or directory');
	}
	return args;
}

function normalizeToken(token) {
	return token.normalize('NFKC').replaceAll('’', "'").toLowerCase();
}

async function loadFirstColumn(file) {
	const values = new Set();
	const lines = createInterface({
		input: createReadStream(file),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		const separator = line.indexOf('\t');
		const value = separator < 0 ? line : line.slice(0, separator);
		if (value) {
			values.add(value);
		}
	}
	return values;
}

async function loadInflections(file) {
	const values = new Map();
	if (!file) {
		return values;
	}
	const lines = createInterface({
		input: createReadStream(file),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		const separator = line.indexOf('\t');
		if (separator > 0) {
			values.set(line.slice(0, separator), line.slice(separator + 1));
		}
	}
	return values;
}

async function collectSubtitleFiles(input) {
	const absolute = path.resolve(input);
	const stat = await fs.stat(absolute);
	if (stat.isFile()) {
		return SUBTITLE_EXTENSIONS.has(path.extname(absolute).toLowerCase()) ? [absolute] : [];
	}
	if (!stat.isDirectory()) {
		return [];
	}
	const files = [];
	for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
		const child = path.join(absolute, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectSubtitleFiles(child)));
		} else if (SUBTITLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			files.push(child);
		}
	}
	return files;
}

function subtitleText(source) {
	const chunks = [];
	let inCue = false;
	for (const rawLine of source.replaceAll('\r', '').split('\n')) {
		const line = rawLine.trim();
		if (line.includes('-->')) {
			inCue = true;
			continue;
		}
		if (!line) {
			inCue = false;
			continue;
		}
		if (inCue) {
			chunks.push(line.replace(/<[^>]+>/g, ' '));
		}
	}
	return chunks.join(' ');
}

function stableHash(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const dictionaryPath = path.resolve(args.dict);
	const inflectionPath = args.inflections ? path.resolve(args.inflections) : '';
	const [dictionary, inflections] = await Promise.all([
		loadFirstColumn(dictionaryPath),
		loadInflections(inflectionPath),
	]);
	const files = (
		await Promise.all(args.inputs.map((input) => collectSubtitleFiles(input)))
	)
		.flat()
		.sort();
	if (files.length === 0) {
		throw new Error('No .srt or .vtt files found');
	}

	const occurrences = new Map();
	let tokenCount = 0;
	for (const file of files) {
		const text = subtitleText(await fs.readFile(file, 'utf8'));
		for (const match of text.matchAll(TOKEN)) {
			const token = normalizeToken(match[0]);
			tokenCount += 1;
			occurrences.set(token, (occurrences.get(token) ?? 0) + 1);
		}
	}

	const sample = [...occurrences.keys()]
		.sort((a, b) => stableHash(a) - stableHash(b) || a.localeCompare(b))
		.slice(0, args.sampleSize);
	const classify = (token) => {
		if (dictionary.has(token)) {
			return { kind: 'direct' };
		}
		const lemma = inflections.get(token);
		if (lemma && dictionary.has(lemma)) {
			return { kind: 'lemma', lemma };
		}
		return { kind: 'unmatched' };
	};
	const result = {
		direct: [],
		inflected: [],
		unmatched: [],
	};
	for (const token of sample) {
		const match = classify(token);
		if (match.kind === 'direct') {
			result.direct.push(token);
			continue;
		}
		if (match.kind === 'lemma') {
			result.inflected.push({ token, lemma: match.lemma });
			continue;
		}
		result.unmatched.push({ token, occurrences: occurrences.get(token) ?? 0 });
	}
	result.unmatched.sort((a, b) => b.occurrences - a.occurrences || a.token.localeCompare(b.token));

	const matched = result.direct.length + result.inflected.length;
	const occurrenceCoverage = { direct: 0, viaLemma: 0, unmatched: 0 };
	for (const [token, count] of occurrences) {
		const match = classify(token);
		if (match.kind === 'direct') {
			occurrenceCoverage.direct += count;
		} else if (match.kind === 'lemma') {
			occurrenceCoverage.viaLemma += count;
		} else {
			occurrenceCoverage.unmatched += count;
		}
	}
	const matchedOccurrences = occurrenceCoverage.direct + occurrenceCoverage.viaLemma;
	const report = {
		generatedAt: new Date().toISOString(),
		dictionary: dictionaryPath,
		inflections: inflectionPath || null,
		files,
		corpus: {
			tokens: tokenCount,
			uniqueTokens: occurrences.size,
			sampleRequested: args.sampleSize,
			sampleActual: sample.length,
		},
		coverage: {
			direct: result.direct.length,
			viaLemma: result.inflected.length,
			unmatched: result.unmatched.length,
			percent: sample.length ? Number((matched / sample.length * 100).toFixed(2)) : 0,
		},
		occurrenceCoverage: {
			...occurrenceCoverage,
			percent: tokenCount
				? Number((matchedOccurrences / tokenCount * 100).toFixed(2))
				: 0,
		},
		unmatched: result.unmatched,
		lemmaMatches: result.inflected,
	};

	if (args.out) {
		const output = path.resolve(args.out);
		await fs.mkdir(path.dirname(output), { recursive: true });
		await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`Report: ${output}`);
	}
	console.log(
		`Coverage: ${report.coverage.percent}% (${matched}/${sample.length}, ${result.inflected.length} via lemma)`,
	);
	console.log(
		`Occurrence coverage: ${report.occurrenceCoverage.percent}% (${matchedOccurrences}/${tokenCount})`,
	);
	if (result.unmatched.length) {
		console.log(
			`Top unmatched: ${result.unmatched.slice(0, 12).map((item) => item.token).join(', ')}`,
		);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
