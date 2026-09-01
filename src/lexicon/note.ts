import type { DictionaryLookup } from '../dictionary';

export type WordStatus = 'new' | 'learning' | 'known' | 'ignored';

export interface WordContext {
	sentence: string;
	sourcePath: string;
	time?: number;
	timeLabel: string;
}

export interface WordNoteInput {
	lookup: DictionaryLookup;
	context: WordContext;
	date: string;
	uid: string;
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function markdownText(value: string): string {
	const compact = value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
	return compact.length > 300 ? `${compact.slice(0, 297)}…` : compact;
}

export function sourceWikiLink(context: WordContext): string {
	return `[[${context.sourcePath}]]`;
}

export function createGleanUid(): string {
	const time = Date.now().toString(36);
	const random = crypto.randomUUID().slice(0, 8);
	return `glean-${time}-${random}`;
}

export function wordNoteUri(context: WordContext): string | null {
	if (context.time === undefined) {
		return null;
	}
	const source = encodeURIComponent(context.sourcePath);
	const time = Math.max(0, context.time);
	return `obsidian://glean?src=${source}&t=${time}`;
}

export function contextLine(context: WordContext): string {
	const sentence = markdownText(context.sentence).replace(/"/g, '\\"');
	const uri = wordNoteUri(context);
	if (uri) {
		return `- [${context.timeLabel}](${uri}) · ${sourceWikiLink(context)} — "${sentence}"`;
	}
	return `- ${sourceWikiLink(context)} — "${sentence}"`;
}

export function contextIdentity(context: WordContext): string {
	const uri = wordNoteUri(context);
	if (uri) {
		return `](${uri})`;
	}
	const sentence = markdownText(context.sentence).replace(/"/g, '\\"');
	return `${sourceWikiLink(context)} — "${sentence}"`;
}

export function createWordNote(input: WordNoteInput): string {
	const { lookup, context, date, uid } = input;
	const entry = lookup.entry;
	const lemma = lookup.lemma;
	const forms =
		lookup.surface.toLocaleLowerCase('en-US') !== lemma ? [lookup.surface] : [];
	const translations = entry?.translations ?? [];
	const definition = entry?.definition.trim() ?? '';
	const summary = translations.join('；') || definition;

	const lines = [
		'---',
		'glean: true',
		`uid: ${yamlString(uid)}`,
		`lemma: ${yamlString(lemma)}`,
		'status: new',
		`created: ${date}`,
		`updated: ${date}`,
		`phonetic: ${yamlString(entry?.phonetic ?? '')}`,
		`pos: ${yamlString(entry?.pos ?? '')}`,
		forms.length > 0 ? 'forms:' : 'forms: []',
		...forms.map((form) => `  - ${yamlString(form)}`),
		'sources:',
		`  - ${yamlString(sourceWikiLink(context))}`,
		'---',
		'',
		`# ${lemma}`,
		'',
		`> ${summary}`,
		'',
		'## Senses',
		'',
		...(translations.length > 0
			? translations.map((translation) => `- ${translation}`)
			: definition
				? [`- ${definition}`]
				: ['- ']),
		'',
		'## Contexts',
		'<!-- glean-contexts -->',
		'',
		contextLine(context),
		'',
	];
	return lines.join('\n');
}

export function hasGleanFrontmatter(content: string): boolean {
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
	return frontmatter ? /^glean:\s*true(?:\s+#.*)?\s*$/m.test(frontmatter) : false;
}

export function appendWordContext(content: string, context: WordContext): {
	content: string;
	added: boolean;
} {
	const line = contextLine(context);
	if (content.includes(contextIdentity(context))) {
		return { content, added: false };
	}

	const section = findContextsSection(content);
	if (!section) {
		return {
			content: `${content.trimEnd()}\n\n## Contexts\n<!-- glean-contexts -->\n\n${line}\n`,
			added: true,
		};
	}

	const insertAt = section.end;
	const before = content.slice(0, insertAt).trimEnd();
	const after = content.slice(insertAt).trimStart();
	return {
		content: `${before}\n\n${line}\n${after ? `\n${after}` : ''}`,
		added: true,
	};
}

function findContextsSection(content: string): { start: number; end: number } | null {
	const lines = content.split(/(?<=\n)/);
	const sections: Array<{ start: number; end: number; marked: boolean }> = [];
	let offset = 0;
	let inFence = false;

	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index] ?? '';
		const line = raw.replace(/\r?\n$/, '');
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			offset += raw.length;
			continue;
		}
		if (!inFence && /^## Contexts\s*$/.test(line)) {
			let end = content.length;
			let cursor = offset + raw.length;
			let marked = false;
			for (let next = index + 1; next < lines.length; next += 1) {
				const nextRaw = lines[next] ?? '';
				const nextLine = nextRaw.replace(/\r?\n$/, '');
				if (/^\s*<!--\s*glean-contexts\s*-->\s*$/.test(nextLine)) {
					marked = true;
				}
				if (/^#{1,2}\s+/.test(nextLine)) {
					end = cursor;
					break;
				}
				cursor += nextRaw.length;
			}
			sections.push({ start: offset, end, marked });
		}
		offset += raw.length;
	}

	return (
		sections.find((section) => section.marked) ??
		sections.at(-1) ??
		null
	);
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}
	return typeof value === 'string' ? [value] : [];
}

function fieldIndex(lines: string[], key: string): number {
	return lines.findIndex((line) => line.startsWith(`${key}:`));
}

function fieldEnd(lines: string[], index: number): number {
	let end = index + 1;
	while (end < lines.length && /^\s+/.test(lines[end] ?? '')) {
		end += 1;
	}
	return end;
}

function removeField(lines: string[], key: string): void {
	const index = fieldIndex(lines, key);
	if (index < 0) {
		return;
	}
	lines.splice(index, fieldEnd(lines, index) - index);
}

function sameWord(a: string, b: string): boolean {
	return a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US');
}

function replaceScalar(lines: string[], key: string, value: string): void {
	const line = `${key}: ${value}`;
	const index = fieldIndex(lines, key);
	if (index < 0) {
		lines.push(line);
		return;
	}
	lines.splice(index, fieldEnd(lines, index) - index, line);
}

function appendListValue(
	lines: string[],
	key: string,
	existingValues: string[],
	value?: string,
): void {
	const index = fieldIndex(lines, key);
	if (index < 0) {
		lines.push(
			value === undefined ? `${key}: []` : `${key}:`,
			...(value === undefined ? [] : [`  - ${yamlString(value)}`]),
		);
		return;
	}
	if (value === undefined) {
		return;
	}
	const fieldLine = lines[index] ?? '';
	const inline = fieldLine.slice(fieldLine.indexOf(':') + 1).trim();
	if (inline && inline !== '[]') {
		lines.splice(
			index,
			1,
			`${key}:`,
			...existingValues.map((item) => `  - ${yamlString(item)}`),
			`  - ${yamlString(value)}`,
		);
		return;
	}
	if (inline === '[]') {
		lines[index] = `${key}:`;
	}
	lines.splice(fieldEnd(lines, index), 0, `  - ${yamlString(value)}`);
}

/**
 * Upgrade an existing card without serializing all YAML. Only Glean-owned
 * fields are patched; user fields, formatting, comments and date literals
 * remain byte-for-byte unchanged.
 */
export function updateWordNote(
	content: string,
	frontmatter: Record<string, unknown>,
	input: WordNoteInput,
): { content: string; changed: boolean } {
	if (frontmatter.glean !== true) {
		throw new Error('已有同名笔记且不是 Glean 生词');
	}
	const existingLemma = frontmatter.lemma;
	if (
		typeof existingLemma === 'string' &&
		existingLemma.toLocaleLowerCase('en-US') !==
			input.lookup.lemma.toLocaleLowerCase('en-US')
	) {
		throw new Error(
			`文件名冲突：已有词条 ${existingLemma}，无法写入 ${input.lookup.lemma}`,
		);
	}

	const frontmatterMatch = content.match(
		/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
	);
	if (!frontmatterMatch?.[1]) {
		throw new Error('生词笔记缺少有效的 frontmatter');
	}
	const lines = frontmatterMatch[1].split(/\r?\n/);
	let schemaChanged = false;
	// `value` is compared raw but written serialized: comparing the quoted
	// form would make an empty field look different from an empty value and
	// rewrite the card on every save.
	const setMissing = (key: string, value: string, quoted = true) => {
		if (
			frontmatter[key] === undefined ||
			(frontmatter[key] === '' && value !== '')
		) {
			replaceScalar(lines, key, quoted ? yamlString(value) : value);
			schemaChanged = true;
		}
	};

	setMissing('uid', input.uid);
	setMissing('lemma', input.lookup.lemma);
	setMissing('status', 'new', false);
	setMissing('created', input.date, false);
	setMissing('phonetic', input.lookup.entry?.phonetic ?? '');
	setMissing('pos', input.lookup.entry?.pos ?? '');

	const forms = stringList(frontmatter.forms);
	// Cards written before `forms` existed kept inflections in Obsidian's
	// global `aliases`, which floods the quick switcher. Fold them in once.
	const legacyForms = stringList(frontmatter.aliases);
	const pending = [...legacyForms, input.lookup.surface].filter(
		(form, index, all) =>
			!sameWord(form, input.lookup.lemma) &&
			!forms.some((existing) => sameWord(existing, form)) &&
			all.findIndex((other) => sameWord(other, form)) === index,
	);
	for (const form of pending) {
		appendListValue(lines, 'forms', forms, form);
		forms.push(form);
		schemaChanged = true;
	}
	if (pending.length === 0 && frontmatter.forms === undefined) {
		appendListValue(lines, 'forms', forms);
		schemaChanged = true;
	}
	if (frontmatter.aliases !== undefined) {
		removeField(lines, 'aliases');
		schemaChanged = true;
	}

	const source = sourceWikiLink(input.context);
	const sources = stringList(frontmatter.sources);
	if (!sources.includes(source)) {
		appendListValue(lines, 'sources', sources, source);
		schemaChanged = true;
	}

	const appended = appendWordContext(content, input.context);
	if (!schemaChanged && !appended.added) {
		return { content, changed: false };
	}
	replaceScalar(lines, 'updated', input.date);
	const currentFrontmatter = appended.content.match(
		/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
	);
	if (!currentFrontmatter) {
		throw new Error('生词笔记缺少有效的 frontmatter');
	}
	return {
		content:
			`---\n${lines.join('\n')}\n---\n` +
			appended.content.slice(currentFrontmatter[0].length),
		changed: true,
	};
}

export function updateWordStatus(content: string, status: WordStatus): string {
	if (!hasGleanFrontmatter(content)) {
		throw new Error('这不是 Glean 生词笔记');
	}
	const frontmatterMatch = content.match(
		/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
	);
	if (!frontmatterMatch?.[1]) {
		throw new Error('生词笔记缺少有效的 frontmatter');
	}
	const lines = frontmatterMatch[1].split(/\r?\n/);
	replaceScalar(lines, 'status', status);
	return content.replace(frontmatterMatch[1], lines.join('\n'));
}
