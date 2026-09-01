import { describe, expect, it, vi } from 'vitest';
import type { DictionaryEntry, DictionaryLookup } from '../src/dictionary';
import { glossPassage, isContentWord, MAX_GLOSS_ITEMS } from '../src/translate/gloss';
import {
	buildRequest,
	DEFAULT_OPENAI_ENDPOINT,
	parseResponse,
	MAX_TRANSLATION_CHARS,
	translateText,
	TranslationError,
	type TranslationConfig,
} from '../src/translate/provider';

function entry(word: string, translations: string[]): DictionaryEntry {
	return {
		lookup: word,
		word,
		phonetic: 'test',
		pos: 'n.',
		translations,
		definition: '',
		tags: [],
		collins: null,
		oxford: false,
		bnc: null,
		frq: null,
	};
}

function dictionary(map: Record<string, { lemma: string; senses: string[] }>) {
	return async (word: string): Promise<DictionaryLookup | null> => {
		const hit = map[word];
		if (!hit) {
			return { surface: word, lemma: word, match: 'missing', entry: null };
		}
		return {
			surface: word,
			lemma: hit.lemma,
			match: hit.lemma === word ? 'direct' : 'inflection',
			entry: entry(hit.lemma, hit.senses),
		};
	};
}

describe('isContentWord', () => {
	it('drops function words, punctuation and single letters', () => {
		expect(isContentWord('the')).toBe(false);
		expect(isContentWord('Of')).toBe(false);
		expect(isContentWord('a')).toBe(false);
		expect(isContentWord('123')).toBe(false);
		expect(isContentWord('—')).toBe(false);
	});

	it('keeps ordinary vocabulary including hyphens and apostrophes', () => {
		expect(isContentWord('memory')).toBe(true);
		expect(isContentWord('well-known')).toBe(true);
		expect(isContentWord("don't")).toBe(true);
	});
});

describe('glossPassage', () => {
	const statusOf = () => null;

	it('keeps first-appearance order and skips stopwords', async () => {
		const gloss = await glossPassage(
			'The brain stores the memory of a moment.',
			dictionary({
				brain: { lemma: 'brain', senses: ['大脑'] },
				stores: { lemma: 'store', senses: ['储存'] },
				memory: { lemma: 'memory', senses: ['记忆'] },
				moment: { lemma: 'moment', senses: ['瞬间'] },
			}),
			statusOf,
		);

		expect(gloss.items.map((item) => item.lemma)).toEqual([
			'brain',
			'store',
			'memory',
			'moment',
		]);
		expect(gloss.items[1]).toMatchObject({ surface: 'stores', senses: ['储存'] });
	});

	it('collapses inflections of one lemma into a single entry', async () => {
		const gloss = await glossPassage(
			'She stores what the archive stored.',
			dictionary({
				stores: { lemma: 'store', senses: ['储存'] },
				archive: { lemma: 'archive', senses: ['档案'] },
				stored: { lemma: 'store', senses: ['储存'] },
			}),
			statusOf,
		);

		expect(gloss.items.map((item) => item.lemma)).toEqual(['store', 'archive']);
	});

	it('marks words the offline dictionary does not carry', async () => {
		const gloss = await glossPassage('Obsidian rocks.', dictionary({}), statusOf);
		expect(gloss.items[0]).toMatchObject({ lemma: 'obsidian', missing: true });
	});

	it('surfaces lexicon status for known words', async () => {
		const gloss = await glossPassage(
			'Memory matters.',
			dictionary({ memory: { lemma: 'memory', senses: ['记忆'] } }),
			(word) => (word === 'memory' ? 'learning' : null),
		);
		expect(gloss.items[0]?.status).toBe('learning');
	});

	it('caps the list and reports the remainder', async () => {
		const alphabet = 'abcdefghijklmnopqrstuvwxyz';
		const words = Array.from(
			{ length: MAX_GLOSS_ITEMS + 5 },
			(_, i) => `q${alphabet[Math.floor(i / 26)]}${alphabet[i % 26]}`,
		);
		const gloss = await glossPassage(words.join(' '), dictionary({}), statusOf);
		expect(gloss.items).toHaveLength(MAX_GLOSS_ITEMS);
		expect(gloss.truncated).toBe(5);
	});
});

const openai: TranslationConfig = {
	enabled: true,
	provider: 'openai',
	apiKey: 'sk-test',
	endpoint: '',
	model: 'gpt-4o-mini',
	targetLang: '简体中文',
};

const deepl: TranslationConfig = {
	...openai,
	provider: 'deepl',
	apiKey: 'key:fx',
	endpoint: '',
};

describe('buildRequest', () => {
	it('targets the default OpenAI endpoint and carries the model', () => {
		const request = buildRequest(openai, 'hello');
		expect(request.url).toBe(`${DEFAULT_OPENAI_ENDPOINT}/chat/completions`);
		expect(request.headers.Authorization).toBe('Bearer sk-test');
		const body = JSON.parse(request.body) as {
			model: string;
			messages: { role: string; content: string }[];
		};
		expect(body.model).toBe('gpt-4o-mini');
		expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
	});

	it('honours a custom OpenAI-compatible base url without doubling slashes', () => {
		const request = buildRequest(
			{ ...openai, endpoint: 'https://proxy.test/v1/' },
			'hello',
		);
		expect(request.url).toBe('https://proxy.test/v1/chat/completions');
	});

	it('routes DeepL free keys to the free host', () => {
		expect(buildRequest(deepl, 'hello').url).toBe(
			'https://api-free.deepl.com/v2/translate',
		);
		expect(buildRequest({ ...deepl, apiKey: 'paid' }, 'hello').url).toBe(
			'https://api.deepl.com/v2/translate',
		);
	});

	it('maps human-readable target names onto DeepL language codes', () => {
		const target = (config: TranslationConfig) =>
			(JSON.parse(buildRequest(config, 'hello').body) as { target_lang: string })
				.target_lang;
		expect(target(deepl)).toBe('ZH');
		expect(target({ ...deepl, targetLang: '繁体中文' })).toBe('ZH-HANT');
		expect(target({ ...deepl, targetLang: 'ja' })).toBe('JA');
	});
});

describe('parseResponse', () => {
	it('reads the OpenAI and DeepL shapes', () => {
		expect(
			parseResponse('openai', {
				status: 200,
				text: JSON.stringify({ choices: [{ message: { content: ' 你好 ' } }] }),
			}),
		).toBe('你好');
		expect(
			parseResponse('deepl', {
				status: 200,
				text: JSON.stringify({ translations: [{ text: '你好' }] }),
			}),
		).toBe('你好');
	});

	it('reports the provider error instead of a blank result', () => {
		expect(() =>
			parseResponse('openai', { status: 401, text: '{"error":"bad key"}' }),
		).toThrow(/401/);
		expect(() => parseResponse('openai', { status: 200, text: 'not json' })).toThrow(
			TranslationError,
		);
		expect(() => parseResponse('openai', { status: 200, text: '{}' })).toThrow(
			/没有返回译文/,
		);
	});
});

describe('translateText', () => {
	const transport = vi.fn(async () => ({
		status: 200,
		text: JSON.stringify({ choices: [{ message: { content: '你好' } }] }),
	}));

	it('never touches the network while translation is disabled', async () => {
		const spy = vi.fn();
		await expect(
			translateText({ ...openai, enabled: false }, 'hello', spy),
		).rejects.toThrow(/未开启/);
		expect(spy).not.toHaveBeenCalled();
	});

	it('refuses to call out without an API key', async () => {
		const spy = vi.fn();
		await expect(translateText({ ...openai, apiKey: '  ' }, 'hi', spy)).rejects.toThrow(
			/API key/,
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it('rejects oversized selections before spending a request', async () => {
		const spy = vi.fn();
		await expect(
			translateText(openai, 'a'.repeat(MAX_TRANSLATION_CHARS + 1), spy),
		).rejects.toThrow(/分段翻译/);
		expect(spy).not.toHaveBeenCalled();
	});

	it('returns the translation on the happy path', async () => {
		await expect(translateText(openai, 'hello', transport)).resolves.toBe('你好');
	});

	it('gives up on a hanging endpoint instead of waiting forever', async () => {
		await expect(
			translateText(openai, 'hello', () => new Promise(() => undefined), 20),
		).rejects.toThrow(/无响应/);
	});
});
