export type DictCell = {
	ch: string;
	/** Index into the normalized target; null = punctuation/space auto-filled. */
	normIndex: number | null;
};

/** Letters and digits the learner must type; everything else auto-advances. */
export function isTypedChar(ch: string): boolean {
	return /[A-Za-z0-9]/.test(ch);
}

export function normalizeChar(ch: string): string {
	return ch.toLowerCase();
}

/** Build display cells and the normalized string used for matching. */
export function buildDictCells(text: string): { cells: DictCell[]; norm: string } {
	const cells: DictCell[] = [];
	let norm = '';
	for (const ch of text) {
		if (isTypedChar(ch)) {
			cells.push({ ch, normIndex: norm.length });
			norm += normalizeChar(ch);
		} else {
			cells.push({ ch, normIndex: null });
		}
	}
	return { cells, norm };
}

/**
 * Given how many norm chars are already correct, return the display index
 * of the next cell the user should fill (skipping auto cells), or cells.length if done.
 */
export function nextDisplayIndex(cells: DictCell[], matched: number): number {
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		if (!cell) {
			continue;
		}
		if (cell.normIndex === null) {
			continue;
		}
		if (cell.normIndex >= matched) {
			return i;
		}
	}
	return cells.length;
}

export function isComplete(matched: number, normLen: number): boolean {
	return normLen > 0 && matched >= normLen;
}
