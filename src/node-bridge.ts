/**
 * Load Node builtins in Obsidian desktop plugins.
 * Dynamic `import('node:…')` often fails in the plugin sandbox with
 * "Failed to fetch dynamically imported module".
 */
export function loadNodeModule<T>(id: string): T {
	const candidates = id.startsWith('node:')
		? [id.slice('node:'.length), id]
		: [id, `node:${id}`];

	const req = resolveRequire();
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			return req(candidate) as T;
		} catch (error) {
			errors.push(
				`${candidate}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	throw new Error(
		`无法加载 Node 模块 ${id}（${errors.join('；') || '未知原因'}）`,
	);
}

function resolveRequire(): (id: string) => unknown {
	const globalRequire = (globalThis as { require?: (id: string) => unknown }).require;
	if (typeof globalRequire === 'function') {
		return globalRequire;
	}
	if (typeof require === 'function') {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require;
	}
	throw new Error('当前环境没有 Node require（移动端或不支持桌面能力）');
}
