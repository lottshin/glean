export class TFile {
	constructor(public path: string) {}
}

export class WorkspaceLeaf {}

/**
 * Bases that only need to exist so the modules importing them can load; tests
 * reach the logic through the prototype rather than constructing views.
 */
export class ItemView {
	constructor(public leaf?: WorkspaceLeaf) {}
}
export class Modal {}
export class FuzzySuggestModal<_T> {}

export class Notice {
	constructor(_message?: string, _timeout?: number) {}
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/|\/$/g, '');
}
