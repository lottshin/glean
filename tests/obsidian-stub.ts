export class TFile {
	constructor(public path: string) {}
}

export class Notice {
	constructor(_message?: string, _timeout?: number) {}
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/|\/$/g, '');
}
