import { open, type FileHandle } from 'fs/promises';

type LineResult = {
	line: string;
	nextOffset: number;
};

/**
 * Exact lookup for a UTF-8 TSV sorted by its first (ASCII-normalized) column.
 * Only small chunks around binary-search positions are read from disk.
 */
export class SortedTsvFile {
	private constructor(
		private handle: FileHandle,
		private size: number,
	) {}

	static async open(path: string): Promise<SortedTsvFile> {
		const handle = await open(path, 'r');
		const stat = await handle.stat();
		return new SortedTsvFile(handle, stat.size);
	}

	async find(key: string): Promise<string | null> {
		if (!key || this.size === 0) {
			return null;
		}
		let low = 0;
		let high = this.size;

		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const lineStart = await this.findLineStart(middle);
			const current = await this.readLine(lineStart);
			const separator = current.line.indexOf('\t');
			const currentKey =
				separator < 0 ? current.line : current.line.slice(0, separator);

			if (currentKey === key) {
				return current.line;
			}
			if (currentKey < key) {
				low = current.nextOffset;
			} else {
				high = lineStart;
			}
		}
		return null;
	}

	async close(): Promise<void> {
		await this.handle.close();
	}

	private async findLineStart(offset: number): Promise<number> {
		let end = offset;
		const buffer = Buffer.allocUnsafe(4096);
		while (end > 0) {
			const position = Math.max(0, end - buffer.length);
			const length = end - position;
			const { bytesRead } = await this.handle.read(buffer, 0, length, position);
			if (bytesRead === 0) {
				return 0;
			}
			const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
			if (newline >= 0) {
				return position + newline + 1;
			}
			end = position;
		}
		return 0;
	}

	private async readLine(offset: number): Promise<LineResult> {
		let position = offset;
		const chunks: Buffer[] = [];
		const buffer = Buffer.allocUnsafe(4096);
		while (position < this.size) {
			const length = Math.min(buffer.length, this.size - position);
			const { bytesRead } = await this.handle.read(buffer, 0, length, position);
			if (bytesRead === 0) {
				break;
			}
			const bytes = buffer.subarray(0, bytesRead);
			const newline = bytes.indexOf(0x0a);
			if (newline >= 0) {
				chunks.push(Buffer.from(bytes.subarray(0, newline)));
				return {
					line: Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''),
					nextOffset: position + newline + 1,
				};
			}
			chunks.push(Buffer.from(bytes));
			position += bytesRead;
		}
		return {
			line: Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''),
			nextOffset: this.size,
		};
	}
}
