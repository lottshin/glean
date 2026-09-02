import {
	MemoryTsvFile,
	SortedTsvFile,
	type SortedLineSource,
} from './sorted-tsv';

export class LemmaFile {
	private constructor(private file: SortedLineSource) {}

	static async open(path: string): Promise<LemmaFile> {
		return new LemmaFile(await SortedTsvFile.open(path));
	}

	static fromText(text: string): LemmaFile {
		return new LemmaFile(new MemoryTsvFile(text));
	}

	async lookup(form: string): Promise<string | null> {
		const line = await this.file.find(form);
		if (!line) {
			return null;
		}
		const separator = line.indexOf('\t');
		return separator < 0 ? null : line.slice(separator + 1) || null;
	}

	async close(): Promise<void> {
		await this.file.close();
	}
}
