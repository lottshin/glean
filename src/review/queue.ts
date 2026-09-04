import type { WordStatus } from '../lexicon/note';
import { daysBetween, isDue, type ReviewState } from './schedule';

/** A card with its schedule resolved, ready to be queued. */
export interface ReviewCard {
	path: string;
	lemma: string;
	forms: string[];
	status: WordStatus;
	review: ReviewState;
}

export interface ReviewQueueOptions {
	today: string;
	/** Daily cap, so a year of captures does not land in one sitting. */
	limit: number;
}

export interface ReviewQueueStats {
	/** Everything due today, before the cap. */
	due: number;
	/** Cards never successfully recalled. */
	fresh: number;
	/** Past their due date by at least a day. */
	overdue: number;
}

/**
 * `ignored` is the only status that opts out entirely. A graduated `known`
 * card still comes back when its interval elapses, which is the whole point
 * of spacing it out rather than deleting it.
 */
function inScope(card: ReviewCard): boolean {
	return card.status !== 'ignored';
}

export function dueCards(
	cards: ReviewCard[],
	today: string,
): ReviewCard[] {
	return cards.filter((card) => inScope(card) && isDue(card.review, today));
}

export function reviewQueueStats(
	cards: ReviewCard[],
	today: string,
): ReviewQueueStats {
	const due = dueCards(cards, today);
	return {
		due: due.length,
		fresh: due.filter((card) => card.review.reps === 0).length,
		overdue: due.filter((card) => daysBetween(card.review.due, today) > 0).length,
	};
}

/**
 * Most overdue first, then the ones that have been forgotten most often. A
 * backlog should drain oldest-first instead of showing whatever sorts first
 * by name.
 */
export function buildReviewQueue(
	cards: ReviewCard[],
	options: ReviewQueueOptions,
): ReviewCard[] {
	const limit = Math.max(0, Math.floor(options.limit));
	return dueCards(cards, options.today)
		.sort((left, right) => {
			const byDue = left.review.due.localeCompare(right.review.due);
			if (byDue !== 0) {
				return byDue;
			}
			if (left.review.lapses !== right.review.lapses) {
				return right.review.lapses - left.review.lapses;
			}
			return left.lemma.localeCompare(right.lemma);
		})
		.slice(0, limit === 0 ? undefined : limit);
}

export interface ReviewPrompt {
	/** Chinese glosses from the card's `## Senses` list. */
	senses: string[];
	/** One example with the target word blanked out, when the card has one. */
	sentence: string | null;
}

const BLANK = '＿＿＿＿';

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Blank out every inflection so the answer is not sitting in the prompt.
 * Longest form first, otherwise "go" would eat the start of "goes".
 */
export function maskWord(sentence: string, forms: string[]): string {
	const targets = [...new Set(forms.map((form) => form.trim()).filter(Boolean))].sort(
		(left, right) => right.length - left.length,
	);
	let masked = sentence;
	for (const target of targets) {
		// `\b` only anchors next to a word character, so a form like "c++"
		// would never match if we asked for one on both sides.
		const before = /^\w/.test(target) ? '\\b' : '';
		const after = /\w$/.test(target) ? '\\b' : '';
		masked = masked.replace(
			new RegExp(`${before}${escapeRegExp(target)}${after}`, 'gi'),
			BLANK,
		);
	}
	return masked;
}

function sectionLines(content: string, heading: string): string[] {
	const pattern = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
	const start = content.search(pattern);
	if (start < 0) {
		return [];
	}
	const rest = content.slice(start).split(/\r?\n/).slice(1);
	const lines: string[] = [];
	for (const line of rest) {
		if (/^#{1,2}\s+/.test(line)) {
			break;
		}
		const item = line.match(/^-\s+(.*)$/)?.[1]?.trim();
		if (item) {
			lines.push(item);
		}
	}
	return lines;
}

/**
 * Pull the prompt out of the note body. The catalog only indexes frontmatter,
 * so senses and examples have to come from the file itself.
 */
export function parseReviewPrompt(
	content: string,
	forms: string[],
): ReviewPrompt {
	const senses = sectionLines(content, 'Senses').filter(
		(sense) => sense !== BLANK,
	);
	const contexts = sectionLines(content, 'Contexts');
	// Prefer an example that actually contains the word; a masked sentence with
	// no blank in it teaches nothing.
	const quoted = contexts
		.map((line) => line.match(/—\s+"([\s\S]*)"\s*$/)?.[1]?.trim())
		.filter((sentence): sentence is string => Boolean(sentence));
	const usable = quoted.find((sentence) => maskWord(sentence, forms) !== sentence);
	return {
		senses,
		sentence: usable ? maskWord(usable, forms) : null,
	};
}
