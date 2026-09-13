/** True while this content script still belongs to a living extension. */
export function extensionAlive(): boolean {
	try {
		return Boolean(chrome.runtime?.id);
	} catch {
		return false;
	}
}

export async function sendBackground<T>(message: unknown): Promise<T> {
	if (!extensionAlive()) {
		throw new Error('扩展已重载，请刷新这个视频页');
	}
	try {
		const response = (await chrome.runtime.sendMessage(message)) as T;
		if (chrome.runtime.lastError) {
			throw new Error(
				chrome.runtime.lastError.message || '扩展后台无响应',
			);
		}
		return response;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		if (/context invalidated|extension context/i.test(text)) {
			throw new Error('扩展已重载，请刷新这个视频页');
		}
		throw error instanceof Error ? error : new Error(text);
	}
}
