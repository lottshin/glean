const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function normalizeRelPath(path: string): string {
	return path.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

export function sanitizeLemmaFileName(lemma: string): string {
	let safe = lemma
		.normalize('NFKC')
		.replace(/[\\/:*?"<>|#[\]^]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
	if (WINDOWS_RESERVED.test(safe)) {
		safe = `_${safe}`;
	}
	if (!safe || safe === '.' || safe === '..') {
		throw new Error('无法为这个词生成安全的笔记文件名');
	}
	return safe;
}

/**
 * Split the word folder so the file explorer never lists thousands of
 * siblings. Lookup stays O(1): the bucket is a pure function of the lemma.
 */
export function lemmaBucket(lemma: string): string {
	const initial = sanitizeLemmaFileName(lemma).charAt(0).toLowerCase();
	if (initial >= 'a' && initial <= 'z') {
		return initial;
	}
	if (initial >= '0' && initial <= '9') {
		return '0-9';
	}
	return '_';
}

export function wordNotePath(wordsFolder: string, lemma: string): string {
	const file = `${sanitizeLemmaFileName(lemma)}.md`;
	return normalizeRelPath(`${wordsFolder}/${lemmaBucket(lemma)}/${file}`);
}

export function wordNoteLegacyPath(wordsFolder: string, lemma: string): string {
	return normalizeRelPath(`${wordsFolder}/${sanitizeLemmaFileName(lemma)}.md`);
}

export function isInsideWordsFolder(path: string, wordsFolder: string): boolean {
	const folder = normalizeRelPath(wordsFolder);
	const normalized = normalizeRelPath(path);
	return normalized === folder || normalized.startsWith(`${folder}/`);
}
