import { SortedTsvFile } from './sorted-tsv';

export class LemmaFile {
	private constructor(private file: SortedTsvFile) {}

	static async open(path: string): Promise<LemmaFile> {
		return new LemmaFile(await SortedTsvFile.open(path));
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
