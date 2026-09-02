#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'csv-parse';

const DEFAULT_RANK_LIMIT = 60_000;
const MEASURE_RANKS = [20_000, 40_000, 60_000, 80_000, 100_000, 150_000, 200_000];
const WORD = /^[a-z0-9]+(?:['-][a-z0-9]+)*$/i;

function usage() {
	console.log(`Usage:
  node tools/build-dict.mjs --input <ecdict.csv> [--out-dir <dir>] [--rank-limit <n>]

Outputs:
  glean-dict-v1.tsv      Sorted lookup records
  glean-inflect-v1.tsv   Sorted inflection → lemma records
  report.json           Source, filtering, size and truncation measurements`);
}

function parseArgs(argv) {
	const args = {
		input: '',
		outDir: 'data/generated',
		rankLimit: DEFAULT_RANK_LIMIT,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = argv[i + 1];
		if (arg === '--help' || arg === '-h') {
			usage();
			process.exit(0);
		}
		if (arg === '--input' && value) {
			args.input = value;
			i += 1;
		} else if (arg === '--out-dir' && value) {
			args.outDir = value;
			i += 1;
		} else if (arg === '--rank-limit' && value) {
			args.rankLimit = Number.parseInt(value, 10);
			i += 1;
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!args.input) {
		throw new Error('--input is required');
	}
	if (!Number.isSafeInteger(args.rankLimit) || args.rankLimit <= 0) {
		throw new Error('--rank-limit must be a positive integer');
	}
	return args;
}

function normalizeLookup(value) {
	return value
		.normalize('NFKC')
		.replaceAll('’', "'")
		.trim()
		.toLowerCase();
}

function cleanField(value) {
	return String(value ?? '')
		.replaceAll('\t', ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function splitMeanings(value, limit) {
	const meanings = String(value ?? '')
		.split(/\r?\n|\\n/)
		.map(cleanField)
		.filter(Boolean);
	return {
		value: meanings.slice(0, limit).join(' | '),
		truncated: meanings.length > limit,
	};
}

function rank(value) {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

function flag(value) {
	const normalized = cleanField(value).toLowerCase();
	return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

function isCoreAt(record, rankLimit) {
	return (
		flag(record.oxford) ||
		rank(record.collins) > 0 && Number.isFinite(rank(record.collins)) ||
		cleanField(record.tag) !== '' ||
		rank(record.bnc) <= rankLimit ||
		rank(record.frq) <= rankLimit
	);
}

function compactRecord(record) {
	const lookup = normalizeLookup(record.word ?? '');
	if (!WORD.test(lookup)) {
		return null;
	}
	const translation = splitMeanings(record.translation, 3);
	const definition = splitMeanings(record.definition, 1);
	if (!translation.value && !definition.value) {
		return null;
	}
	return {
		lookup,
		word: cleanField(record.word),
		phonetic: cleanField(record.phonetic),
		pos: cleanField(record.pos),
		translation: translation.value,
		definition: definition.value,
		tag: cleanField(record.tag),
		collins: cleanField(record.collins),
		oxford: flag(record.oxford) ? '1' : '',
		bnc: Number.isFinite(rank(record.bnc)) ? String(rank(record.bnc)) : '',
		frq: Number.isFinite(rank(record.frq)) ? String(rank(record.frq)) : '',
		exchange: cleanField(record.exchange),
		translationTruncated: translation.truncated,
		definitionTruncated: definition.truncated,
	};
}

function recordLine(record) {
	return [
		record.lookup,
		record.word,
		record.phonetic,
		record.pos,
		record.translation,
		record.definition,
		record.tag,
		record.collins,
		record.oxford,
		record.bnc,
		record.frq,
	].join('\t');
}

function importance(record) {
	const minimumRank = Math.min(rank(record.bnc), rank(record.frq));
	return (
		(flag(record.oxford) ? 1_000_000_000 : 0) +
		(Number.parseInt(record.collins || '0', 10) || 0) * 10_000_000 +
		(record.tag ? 1_000_000 : 0) +
		(Number.isFinite(minimumRank) ? Math.max(0, 500_000 - minimumRank) : 0) +
		(record.translation ? 10_000 : 0)
	);
}

function compareKeys(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

function exchangeForms(record) {
	const forms = [];
	for (const item of record.exchange.split('/')) {
		const separator = item.indexOf(':');
		if (separator < 1) {
			continue;
		}
		const type = item.slice(0, separator);
		const form = normalizeLookup(item.slice(separator + 1));
		if (type !== '0' && WORD.test(form) && form !== record.lookup) {
			forms.push(form);
		}
	}
	return forms;
}

function explicitLemma(exchange) {
	for (const item of exchange.split('/')) {
		if (item.startsWith('0:')) {
			const lemma = normalizeLookup(item.slice(2));
			return WORD.test(lemma) ? lemma : '';
		}
	}
	return '';
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const input = path.resolve(args.input);
	const outDir = path.resolve(args.outDir);
	const selected = new Map();
	const explicitLemmas = new Map();
	const measurement = new Map(
		MEASURE_RANKS.map((limit) => [limit, { entries: 0, estimatedBytes: 0 }]),
	);
	const stats = {
		sourceRows: 0,
		eligibleRows: 0,
		rejectedNonWordOrEmpty: 0,
		duplicateLookups: 0,
		translationTruncated: 0,
		definitionTruncated: 0,
	};
	const hash = createHash('sha256');
	const source = createReadStream(input);
	source.on('data', (chunk) => hash.update(chunk));
	const parser = source.pipe(
		parse({
			bom: true,
			columns: true,
			relax_column_count: true,
			skip_empty_lines: true,
		}),
	);

	for await (const raw of parser) {
		stats.sourceRows += 1;
		const compact = compactRecord(raw);
		if (!compact) {
			stats.rejectedNonWordOrEmpty += 1;
			continue;
		}
		stats.eligibleRows += 1;
		const lemma = explicitLemma(compact.exchange);
		if (lemma && lemma !== compact.lookup) {
			explicitLemmas.set(compact.lookup, lemma);
		}
		const bytes = Buffer.byteLength(`${recordLine(compact)}\n`);
		for (const [limit, result] of measurement) {
			if (isCoreAt(raw, limit)) {
				result.entries += 1;
				result.estimatedBytes += bytes;
			}
		}
		if (!isCoreAt(raw, args.rankLimit)) {
			continue;
		}
		const existing = selected.get(compact.lookup);
		if (existing) {
			stats.duplicateLookups += 1;
			if (importance(compact) <= importance(existing)) {
				continue;
			}
		}
		selected.set(compact.lookup, compact);
	}

	const entries = [...selected.values()].sort((a, b) => compareKeys(a.lookup, b.lookup));
	for (const entry of entries) {
		if (entry.translationTruncated) {
			stats.translationTruncated += 1;
		}
		if (entry.definitionTruncated) {
			stats.definitionTruncated += 1;
		}
	}
	const dictionaryText = entries.map(recordLine).join('\n') + (entries.length ? '\n' : '');

	const inflections = new Map();
	for (const entry of entries) {
		for (const form of exchangeForms(entry)) {
			const existingLemma = inflections.get(form);
			if (!existingLemma || compareKeys(entry.lookup, existingLemma) < 0) {
				inflections.set(form, entry.lookup);
			}
		}
	}
	for (const [form, lemma] of explicitLemmas) {
		if (selected.has(lemma) && !inflections.has(form)) {
			inflections.set(form, lemma);
		}
	}
	const inflectionText =
		[...inflections.entries()]
			.sort(([a], [b]) => compareKeys(a, b))
			.map(([form, lemma]) => `${form}\t${lemma}`)
			.join('\n') + (inflections.size ? '\n' : '');

	await fs.mkdir(outDir, { recursive: true });
	const dictionaryPath = path.join(outDir, 'glean-dict-v1.tsv');
	const inflectionPath = path.join(outDir, 'glean-inflect-v1.tsv');
	await Promise.all([
		fs.writeFile(dictionaryPath, dictionaryText),
		fs.writeFile(inflectionPath, inflectionText),
	]);

	const dictionaryBytes = Buffer.byteLength(dictionaryText);
	const inflectionBytes = Buffer.byteLength(inflectionText);
	const report = {
		generatedAt: new Date().toISOString(),
		source: {
			path: input,
			bytes: (await fs.stat(input)).size,
			sha256: hash.digest('hex'),
		},
		config: {
			rankLimit: args.rankLimit,
			selection: 'oxford OR collins OR tagged OR bnc<=limit OR frq<=limit',
			wordShape: WORD.source,
			translationLimit: 3,
			definitionLimit: 1,
		},
		stats,
		measurements: Object.fromEntries(
			[...measurement].map(([limit, result]) => [
				String(limit),
				{
					...result,
					estimatedMiB: Number((result.estimatedBytes / 1024 / 1024).toFixed(2)),
				},
			]),
		),
		output: {
			dictionary: {
				path: dictionaryPath,
				entries: entries.length,
				bytes: dictionaryBytes,
				mib: Number((dictionaryBytes / 1024 / 1024).toFixed(2)),
			},
			inflections: {
				path: inflectionPath,
				entries: inflections.size,
				bytes: inflectionBytes,
				mib: Number((inflectionBytes / 1024 / 1024).toFixed(2)),
			},
		},
	};
	await fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

	console.log(
		`Built ${entries.length.toLocaleString()} entries (${report.output.dictionary.mib} MiB)`,
	);
	console.log(
		`Built ${inflections.size.toLocaleString()} inflections (${report.output.inflections.mib} MiB)`,
	);
	console.log(`Report: ${path.join(outDir, 'report.json')}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
