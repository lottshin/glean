export function normalizeLexiconKey(value: string): string {
	return value
		.normalize('NFKC')
		.replaceAll('’', "'")
		.trim()
		.toLocaleLowerCase('en-US');
}
