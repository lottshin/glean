import { SortedTsvFile } from './sorted-tsv';
import type { DictionaryEntry } from './types';

function optionalNumber(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export class EcdictFile {
	private constructor(private file: SortedTsvFile) {}

	static async open(path: string): Promise<EcdictFile> {
		return new EcdictFile(await SortedTsvFile.open(path));
	}

	async lookup(key: string): Promise<DictionaryEntry | null> {
		const line = await this.file.find(key);
		if (!line) {
			return null;
		}
		const fields = line.split('\t');
		return {
			lookup: fields[0] ?? '',
			word: fields[1] ?? '',
			phonetic: fields[2] ?? '',
			pos: fields[3] ?? '',
			translations: fields[4]?.split(' | ').filter(Boolean) ?? [],
			definition: fields[5] ?? '',
			tags: fields[6]?.split(' ').filter(Boolean) ?? [],
			collins: optionalNumber(fields[7]),
			oxford: fields[8] === '1',
			bnc: optionalNumber(fields[9]),
			frq: optionalNumber(fields[10]),
		};
	}

	async close(): Promise<void> {
		await this.file.close();
	}
}
