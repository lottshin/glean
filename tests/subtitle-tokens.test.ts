import { describe, expect, it } from 'vitest';
import { tokenizeSubtitle } from '../src/media/subtitle-tokens';

describe('tokenizeSubtitle', () => {
	it('preserves separators and makes words clickable', () => {
		expect(tokenizeSubtitle("Don't click, please.")).toEqual([
			{ text: "Don't", kind: 'word', lookup: "don't" },
			{ text: ' ', kind: 'separator' },
			{ text: 'click', kind: 'word', lookup: 'click' },
			{ text: ', ', kind: 'separator' },
			{ text: 'please', kind: 'word', lookup: 'please' },
			{ text: '.', kind: 'separator' },
		]);
	});

	it('keeps line breaks and supports unicode words', () => {
		const tokens = tokenizeSubtitle('state-of-the-art\n技术');
		expect(tokens.map((token) => token.text).join('')).toBe('state-of-the-art\n技术');
		expect(tokens.filter((token) => token.kind === 'word')).toHaveLength(2);
	});

	it('normalizes curved apostrophes and compatibility characters', () => {
		const words = tokenizeSubtitle('Don’t ＲＵＮ')
			.filter((token) => token.kind === 'word')
			.map((token) => token.lookup);
		expect(words).toEqual(["don't", 'run']);
	});
});
