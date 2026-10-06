/// <reference lib="dom" />

declare const chrome: {
	storage: {
		sync: {
			get: (
				defaults: Record<string, unknown>,
			) => Promise<Record<string, unknown>>;
			set: (values: Record<string, unknown>) => Promise<void>;
		};
		local: {
			get: (
				keys: string | string[] | Record<string, unknown>,
			) => Promise<Record<string, unknown>>;
			set: (values: Record<string, unknown>) => Promise<void>;
			remove: (keys: string | string[]) => Promise<void>;
		};
	};
	runtime: {
		id?: string;
		lastError?: { message?: string };
		getURL: (path: string) => string;
		sendMessage: (message: unknown) => Promise<unknown>;
		onMessage: {
			addListener: (
				callback: (
					message: unknown,
					sender: unknown,
					sendResponse: (response?: unknown) => void,
				) => boolean | void,
			) => void;
		};
	};
	tabs: {
		query: (query: {
			active?: boolean;
			currentWindow?: boolean;
		}) => Promise<Array<{ id?: number; url?: string }>>;
		sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
	};
	scripting: {
		executeScript: (injection: {
			target: { tabId: number };
			files?: string[];
			func?: () => unknown;
		}) => Promise<unknown[]>;
		insertCSS: (injection: {
			target: { tabId: number };
			files: string[];
		}) => Promise<void>;
	};
};
