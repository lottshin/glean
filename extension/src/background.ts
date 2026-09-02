interface SyncMessage {
	type: 'glean-sync';
	payload: {
		videoId: string;
		title: string;
		channel: string;
		url: string;
		lang: string;
		vtt: string;
	};
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (
		!message ||
		typeof message !== 'object' ||
		(message as { type?: unknown }).type !== 'glean-sync'
	) {
		return false;
	}
	void syncToObsidian(message as SyncMessage)
		.then((result) => sendResponse(result))
		.catch((error: unknown) =>
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : '同步失败',
			}),
		);
	return true;
});

async function syncToObsidian(message: SyncMessage): Promise<{ ok: boolean; error?: string }> {
	const stored = await chrome.storage.sync.get({
		port: 17865,
		token: '',
	});
	const port = typeof stored.port === 'number' ? stored.port : Number(stored.port) || 17865;
	const token = typeof stored.token === 'string' ? stored.token.trim() : '';
	if (!token) {
		return { ok: false, error: '未配置 token' };
	}

	const endpoint = `http://127.0.0.1:${port}/glean/import`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				token,
				...message.payload,
			}),
		});
	} catch {
		return {
			ok: false,
			error: '连不上 Obsidian。请确认桌面端已打开并启用 Glean 接收端。',
		};
	}

	const raw = await response.text();
	let body: { ok?: boolean; error?: string } = {};
	if (raw.trim()) {
		try {
			body = JSON.parse(raw) as { ok?: boolean; error?: string };
		} catch {
			return {
				ok: false,
				error: `接收端返回了无法解析的响应（HTTP ${response.status}）`,
			};
		}
	}

	if (!response.ok || body.ok === false) {
		return {
			ok: false,
			error: body.error ?? `接收端返回 HTTP ${response.status}`,
		};
	}
	return { ok: true };
}
