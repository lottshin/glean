import { describe, expect, it } from 'vitest';
import type { DictionaryLookup } from '../src/dictionary';
import {
	appendWordContext,
	contextLine,
	createWordNote,
	hasEchoFrontmatter,
	type WordContext,
	updateWordNote,
	updateWordStatus,
} from '../src/lexicon/note';
import { LexiconCatalog } from '../src/lexicon/catalog';
import {
	lemmaBucket,
	sanitizeLemmaFileName,
	wordNoteLegacyPath,
	wordNotePath,
} from '../src/lexicon/path';
import { parseEchoProtocol } from '../src/lexicon/protocol';

const lookup: DictionaryLookup = {
	surface: 'went',
	lemma: 'go',
	match: 'inflection',
	entry: {
		lookup: 'go',
		word: 'go',
		phonetic: 'ɡəʊ',
		pos: 'v.',
		translations: ['去；离开'],
		definition: 'move from one place to another',
		tags: [],
		collins: 5,
		oxford: true,
		bnc: 100,
		frq: 100,
	},
};

const context: WordContext = {
	sentence: 'We went home.',
	sourcePath: 'Media/TED talk.mp4',
	time: 12.34,
	timeLabel: '00:12',
};

describe('word note', () => {
	it('creates a readable Markdown card with source context', () => {
		const note = createWordNote({
			lookup,
			context,
			date: '2026-08-31',
			uid: 'echo-test-123',
		});
		expect(hasEchoFrontmatter(note)).toBe(true);
		expect(note).toContain('uid: "echo-test-123"');
		expect(note).toContain('lemma: "go"');
		expect(note).toContain('forms:\n  - "went"');
		expect(note).not.toContain('aliases:');
		expect(note).toContain('# go');
		expect(note).toContain(
			'[00:12](obsidian://echo?src=Media%2FTED%20talk.mp4&t=12.34) · [[Media/TED talk.mp4]]',
		);
	});

	it('recognizes comments on Echo frontmatter and updates only status', () => {
		const content = [
			'---',
			'echo: true # managed',
			'status: new # old',
			'custom: keep',
			'---',
			'',
			'# go',
		].join('\n');
		expect(hasEchoFrontmatter(content)).toBe(true);
		const updated = updateWordStatus(content, 'known');
		expect(updated).toContain('status: known');
		expect(updated).toContain('custom: keep');
		expect(updated).toContain('# go');
	});

	it('appends unique contexts without changing user content', () => {
		const original = `${createWordNote({
			lookup,
			context,
			date: '2026-08-31',
			uid: 'echo-test-123',
		})}\n## My notes\n\nA mnemonic.\n`;
		const duplicate = appendWordContext(original, context);
		expect(duplicate).toEqual({ content: original, added: false });

		const next = {
			...context,
			sentence: 'They go now.',
			time: 20,
			timeLabel: '00:20',
		};
		const appended = appendWordContext(original, next);
		expect(appended.added).toBe(true);
		expect(appended.content).toContain(contextLine(next));
		expect(appended.content).toContain('## My notes\n\nA mnemonic.');
		expect(appended.content.indexOf(contextLine(next))).toBeLessThan(
			appended.content.indexOf('## My notes'),
		);
	});

	it('writes a readable reading context without a media timestamp', () => {
		const reading = {
			sentence: 'He abandoned the project.',
			sourcePath: 'Clippings/article.md',
			timeLabel: '阅读',
		};
		expect(contextLine(reading)).toBe(
			'- [[Clippings/article.md]] — "He abandoned the project."',
		);
		expect(appendWordContext('## Contexts\n\n', reading).added).toBe(true);
		expect(appendWordContext(contextLine(reading), reading).added).toBe(false);
	});

	it('identifies a cue by timestamp, not by its rendered line', () => {
		const card = [
			'## Contexts',
			'',
			'- [00:12](obsidian://echo?src=Media%2FTED%20talk.mp4&t=12.34) — "Older format."',
			'',
		].join('\n');
		expect(appendWordContext(card, context).added).toBe(false);
	});

	it('adds a Contexts section to older cards that do not have one', () => {
		const appended = appendWordContext('---\necho: true\n---\n\n# go\n', context);
		expect(appended.content).toContain(
			`## Contexts\n<!-- echo-contexts -->\n\n${contextLine(context)}`,
		);
	});

	it('does not insert contexts into a heading shown inside a code fence', () => {
		const content = [
			'---',
			'echo: true',
			'---',
			'',
			'# go',
			'',
			'```markdown',
			'## Contexts',
			'```',
			'',
		].join('\n');
		const appended = appendWordContext(content, context);
		expect(appended.content).toContain('```markdown\n## Contexts\n```');
		expect(appended.content).toContain(
			`## Contexts\n<!-- echo-contexts -->\n\n${contextLine(context)}`,
		);
	});

	it('truncates pathological subtitle lines', () => {
		const line = contextLine({ ...context, sentence: 'x'.repeat(500) });
		expect(line).toContain(`${'x'.repeat(297)}…`);
		expect(line).not.toContain('x'.repeat(298));
	});

	it('upgrades only Echo-owned frontmatter without rewriting user YAML', () => {
		const original = [
			'---',
			'echo: true',
			'lemma: go',
			'created: 2026-08-31',
			'review: 2026-09-01 # keep this comment',
			'custom:',
			'  nested: value',
			'---',
			'',
			'# go',
			'',
		].join('\n');
		const updated = updateWordNote(
			original,
			{
				echo: true,
				lemma: 'go',
				created: new Date('2026-08-31'),
				review: new Date('2026-09-01'),
				custom: { nested: 'value' },
			},
			{ lookup, context, date: '2026-08-31', uid: 'echo-stable-id' },
		);
		expect(updated.changed).toBe(true);
		expect(updated.content).toContain('created: 2026-08-31');
		expect(updated.content).toContain(
			'review: 2026-09-01 # keep this comment',
		);
		expect(updated.content).toContain('custom:\n  nested: value');
		expect(updated.content).toContain('uid: "echo-stable-id"');
	});

	it('rejects sanitized filename collisions between different lemmas', () => {
		expect(() =>
			updateWordNote(
				'---\necho: true\nlemma: "ok?"\n---\n',
				{ echo: true, lemma: 'ok?' },
				{
					lookup: { ...lookup, surface: 'ok*', lemma: 'ok*' },
					context,
					date: '2026-08-31',
					uid: 'echo-test',
				},
			),
		).toThrow(/文件名冲突/);
	});

	it('leaves an unchanged card byte-for-byte untouched', () => {
		const input = {
			lookup,
			context,
			date: '2026-08-31',
			uid: 'echo-stable-id',
		};
		const original = createWordNote(input);
		const updated = updateWordNote(
			original,
			{
				echo: true,
				uid: 'echo-stable-id',
				lemma: 'go',
				status: 'new',
				created: '2026-08-31',
				updated: '2026-08-31',
				phonetic: 'ɡəʊ',
				pos: 'v.',
				forms: ['went'],
				sources: ['[[Media/TED talk.mp4]]'],
			},
			input,
		);
		expect(updated).toEqual({ content: original, changed: false });
	});

	it('does not rewrite a card whose optional fields are legitimately empty', () => {
		const wordless = {
			...lookup,
			surface: 'go',
			entry: { ...lookup.entry!, phonetic: '', pos: '' },
		};
		const input = {
			lookup: wordless,
			context,
			date: '2026-08-31',
			uid: 'echo-stable-id',
		};
		const original = createWordNote(input);
		expect(
			updateWordNote(
				original,
				{
					echo: true,
					uid: 'echo-stable-id',
					lemma: 'go',
					status: 'new',
					created: '2026-08-31',
					updated: '2026-08-31',
					phonetic: '',
					pos: '',
					forms: [],
					sources: ['[[Media/TED talk.mp4]]'],
				},
				input,
			),
		).toEqual({ content: original, changed: false });
	});

	it('folds legacy aliases into forms and drops the global field', () => {
		const original = [
			'---',
			'echo: true',
			'lemma: go',
			'aliases:',
			'  - went',
			'  - Going',
			'---',
			'',
			'# go',
		].join('\n');
		const updated = updateWordNote(
			original,
			{ echo: true, lemma: 'go', aliases: ['went', 'Going'] },
			{
				lookup: { ...lookup, surface: 'WENT' },
				context,
				date: '2026-09-01',
				uid: 'echo-stable-id',
			},
		);
		expect(updated.content).not.toContain('aliases:');
		expect(updated.content).toContain('forms:\n  - "went"\n  - "Going"');
		expect(updated.content).not.toContain('"WENT"');
	});

	it('preserves list comments and removes stale scalar continuations', () => {
		const original = [
			'---',
			'echo: true',
			'uid: echo-stable-id',
			'lemma: go',
			'status: new',
			'created: 2026-08-31',
			'updated: |',
			'  old value',
			'forms:',
			'  - went',
			'  # keep this list comment',
			'  - 123',
			'sources:',
			'  - "[[Media/TED talk.mp4]]"',
			'---',
			'',
			'# go',
		].join('\n');
		const updated = updateWordNote(
			original,
			{
				echo: true,
				uid: 'echo-stable-id',
				lemma: 'go',
				status: 'new',
				created: '2026-08-31',
				updated: 'old value',
				forms: ['went', 123],
				sources: ['[[Media/TED talk.mp4]]'],
			},
			{
				lookup: { ...lookup, surface: 'gone' },
				context,
				date: '2026-09-01',
				uid: 'echo-stable-id',
			},
		);
		expect(updated.content).toContain('  # keep this list comment');
		expect(updated.content).toContain('  - 123');
		expect(updated.content).toContain('  - "gone"');
		expect(updated.content).toContain('updated: 2026-09-01');
		expect(updated.content).not.toContain('  old value');
	});
});

describe('word note paths', () => {
	it('shards by first letter so a folder never holds the whole lexicon', () => {
		expect(lemmaBucket('go')).toBe('g');
		expect(wordNotePath('Echo/Words', 'go')).toBe('Echo/Words/g/go.md');
		expect(wordNotePath('Echo/Words', 'went')).toBe('Echo/Words/w/went.md');
		expect(wordNoteLegacyPath('Echo/Words', 'bracket')).toBe(
			'Echo/Words/bracket.md',
		);
	});

	it('keeps Windows reserved names and odd lemmas writable', () => {
		expect(sanitizeLemmaFileName('con')).toBe('_con');
		expect(lemmaBucket('3d')).toBe('0-9');
		expect(wordNotePath('Echo/Words', 'ok?')).toBe('Echo/Words/o/ok-.md');
	});
});

describe('lexicon catalog', () => {
	it('resolves saved inflections for reading highlight without scanning files', () => {
		const catalog = new LexiconCatalog();
		catalog.upsert({
			path: 'Echo/Words/g/go.md',
			lemma: 'go',
			forms: ['went', 'going'],
			status: 'new',
		});
		expect(catalog.get('Went')?.path).toBe('Echo/Words/g/go.md');
		expect(catalog.get('GO')?.lemma).toBe('go');
		expect(catalog.statusOf('going')).toBe('new');
		expect(catalog.size).toBe(1);
	});

	it('does not remove another card that owns the same lemma key', () => {
		const catalog = new LexiconCatalog();
		catalog.upsert({
			path: 'Echo/Words/a/alpha.md',
			lemma: 'same',
			forms: [],
			status: 'new',
		});
		catalog.upsert({
			path: 'Echo/Words/b/beta.md',
			lemma: 'same',
			forms: [],
			status: 'new',
		});
		catalog.removePath('Echo/Words/a/alpha.md');
		expect(catalog.get('same')?.path).toBe('Echo/Words/b/beta.md');
	});
});

describe('Echo protocol', () => {
	it('accepts a valid source and timestamp', () => {
		expect(parseEchoProtocol({ src: 'Media/TED talk.mp4', t: '12.34' })).toEqual({
			sourcePath: 'Media/TED talk.mp4',
			time: 12.34,
		});
	});

	it('rejects missing, negative and non-numeric targets', () => {
		expect(parseEchoProtocol({ src: '', t: '1' })).toBeNull();
		expect(parseEchoProtocol({ src: 'movie.mp4', t: '-1' })).toBeNull();
		expect(parseEchoProtocol({ src: 'movie.mp4', t: 'later' })).toBeNull();
	});
});
