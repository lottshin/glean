declare module 'glean:dictionary-package' {
	export const bundledDictionary: {
		version: number;
		files: Array<{
			name: string;
			bytes: number;
			sha256: string;
			gzipBase64: string;
		}>;
	} | null;
}
