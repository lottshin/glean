import { ItemView, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';

import type GleanPlugin from '../main';
import {
	buildReviewQueue,
	parseReviewPrompt,
	reviewQueueStats,
	type ReviewCard,
	type ReviewPrompt,
} from '../review/queue';
import {
	describeDue,
	gradeFromSpelling,
	gradeReview,
	hasGraduated,
	todayString,
	type ReviewGrade,
	type ReviewState,
} from '../review/schedule';

export const REVIEW_VIEW_TYPE = 'glean-review';

/** Where the learner is on the current card. */
type Phase = 'idle' | 'typing' | 'wrong' | 'answered' | 'done';

interface SessionTally {
	total: number;
	good: number;
	hard: number;
	again: number;
}

const GRADE_LABELS: Record<ReviewGrade, string> = {
	again: '没记住',
	hard: '有点犹豫',
	good: '记住了',
	easy: '很轻松',
};

/** Accept any inflection: the sentence may well call for one. */
export function isAcceptedSpelling(
	input: string,
	card: Pick<ReviewCard, 'lemma' | 'forms'>,
): boolean {
	const typed = input.trim().toLocaleLowerCase('en-US');
	if (!typed) {
		return false;
	}
	return [card.lemma, ...card.forms].some(
		(form) => form.trim().toLocaleLowerCase('en-US') === typed,
	);
}

export class ReviewView extends ItemView {
	private queue: ReviewCard[] = [];
	private index = 0;
	private phase: Phase = 'idle';
	private attempts = 0;
	private revealed = false;
	private prompt: ReviewPrompt = { senses: [], sentence: null };
	private result: { grade: ReviewGrade; next: ReviewState } | null = null;
	private tally: SessionTally = { total: 0, good: 0, hard: 0, again: 0 };
	private today = todayString();
	private bodyEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: GleanPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return REVIEW_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Glean 复习';
	}

	getIcon(): string {
		return 'graduation-cap';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('glean-review');
		this.renderStart();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** Rebuild the queue; called when the view is (re)activated. */
	refresh(): void {
		if (this.phase === 'idle' || this.phase === 'done') {
			this.renderStart();
		}
	}

	private cards(): ReviewCard[] {
		return this.plugin.reviewCards(this.today);
	}

	private current(): ReviewCard | null {
		return this.queue[this.index] ?? null;
	}

	private renderStart(): void {
		this.today = todayString();
		this.phase = 'idle';
		const container = this.contentEl;
		container.empty();

		const all = this.cards();
		const stats = reviewQueueStats(all, this.today);
		const panel = container.createDiv({ cls: 'glean-review-start' });

		if (all.length === 0) {
			panel.createEl('h3', { text: '生词库还是空的' });
			panel.createEl('p', {
				text: '在精听或阅读里点词加入生词库，之后就能在这里复习。',
			});
			return;
		}

		if (stats.due === 0) {
			const next = [...all].sort((left, right) =>
				left.review.due.localeCompare(right.review.due),
			)[0];
			panel.createEl('h3', { text: '今天没有要复习的词' });
			panel.createEl('p', {
				text: next
					? `下一批在${describeDue(next.review, this.today)}，共 ${all.length} 张卡在库。`
					: `共 ${all.length} 张卡在库。`,
			});
			return;
		}

		panel.createEl('h3', { text: `${stats.due} 张待复习` });
		const detail: string[] = [];
		if (stats.fresh > 0) {
			detail.push(`${stats.fresh} 张新词`);
		}
		if (stats.overdue > 0) {
			detail.push(`${stats.overdue} 张已过期`);
		}
		if (detail.length > 0) {
			panel.createEl('p', { text: detail.join('，') });
		}

		const limit = this.plugin.settings.reviewDailyLimit;
		const planned = buildReviewQueue(all, { today: this.today, limit });
		if (limit > 0 && stats.due > planned.length) {
			panel.createEl('p', {
				cls: 'glean-review-note',
				text: `这次先过 ${planned.length} 张，上限可以在设置里调。`,
			});
		}

		const start = panel.createEl('button', {
			cls: 'mod-cta',
			text: '开始复习',
		});
		start.addEventListener('click', () => {
			this.startSession(planned);
		});
		start.focus();
	}

	private startSession(queue: ReviewCard[]): void {
		this.queue = queue;
		this.index = 0;
		this.tally = { total: 0, good: 0, hard: 0, again: 0 };
		void this.showCard();
	}

	private async showCard(): Promise<void> {
		const card = this.current();
		if (!card) {
			this.renderDone();
			return;
		}
		this.attempts = 0;
		this.revealed = false;
		this.result = null;
		this.phase = 'typing';
		const content = await this.plugin.readWordNote(card.path);
		// A card whose file vanished mid-session should not abort the run.
		this.prompt = content
			? parseReviewPrompt(content, [card.lemma, ...card.forms])
			: { senses: [], sentence: null };
		this.render();
	}

	private render(): void {
		const card = this.current();
		if (!card) {
			this.renderDone();
			return;
		}
		const container = this.contentEl;
		container.empty();

		const header = container.createDiv({ cls: 'glean-review-header' });
		header.createSpan({
			cls: 'glean-review-progress',
			text: `${this.index + 1} / ${this.queue.length}`,
		});
		const openNote = header.createEl('button', {
			cls: 'glean-review-icon',
			attr: { 'aria-label': '打开这张卡', title: '打开这张卡' },
		});
		setIcon(openNote, 'file-text');
		openNote.addEventListener('click', () => {
			void this.plugin.openWordNotePath(card.path);
		});

		this.bodyEl = container.createDiv({ cls: 'glean-review-body' });
		const body = this.bodyEl;

		if (this.prompt.senses.length > 0) {
			const senses = body.createEl('ul', { cls: 'glean-review-senses' });
			for (const sense of this.prompt.senses) {
				senses.createEl('li', { text: sense });
			}
		} else {
			body.createEl('p', {
				cls: 'glean-review-note',
				text: '这张卡还没有释义，凭例句回忆。',
			});
		}

		if (this.prompt.sentence) {
			body.createEl('blockquote', {
				cls: 'glean-review-sentence',
				text: this.prompt.sentence,
			});
		}

		const input = body.createEl('input', {
			cls: 'glean-review-input',
			attr: {
				type: 'text',
				placeholder: '拼出这个词',
				autocapitalize: 'off',
				autocomplete: 'off',
				autocorrect: 'off',
				spellcheck: 'false',
			},
		});
		this.inputEl = input;
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.onEnter();
			}
		});

		const feedback = body.createDiv({ cls: 'glean-review-feedback' });
		if (this.phase === 'wrong') {
			feedback.addClass('is-wrong');
			feedback.setText('再试一次');
		}
		if (this.phase === 'answered' && this.result) {
			feedback.addClass(this.revealed ? 'is-revealed' : 'is-correct');
			feedback.createSpan({ cls: 'glean-review-answer', text: card.lemma });
			// Say how it was scored and when it returns, so the schedule does
			// not feel arbitrary.
			feedback.createSpan({
				cls: 'glean-review-verdict',
				text: `${GRADE_LABELS[this.result.grade]} · ${describeDue(this.result.next, this.today)}再见`,
			});
		}

		const actions = container.createDiv({ cls: 'glean-review-actions' });
		if (this.phase === 'answered') {
			const next = actions.createEl('button', {
				cls: 'mod-cta',
				text: this.index + 1 < this.queue.length ? '下一张' : '完成',
			});
			next.addEventListener('click', () => {
				void this.advance();
			});
			next.focus();
			input.disabled = true;
			input.value = card.lemma;
		} else {
			const reveal = actions.createEl('button', { text: '不会，看答案' });
			reveal.addEventListener('click', () => {
				void this.revealAnswer();
			});
			input.focus();
		}
	}

	private onEnter(): void {
		if (this.phase === 'answered') {
			void this.advance();
			return;
		}
		void this.submit();
	}

	private async submit(): Promise<void> {
		const card = this.current();
		const input = this.inputEl;
		if (!card || !input) {
			return;
		}
		const typed = input.value;
		if (!typed.trim()) {
			return;
		}
		this.attempts += 1;
		if (!isAcceptedSpelling(typed, card)) {
			this.phase = 'wrong';
			this.render();
			return;
		}
		this.phase = 'answered';
		await this.commit(card);
		this.render();
	}

	private async revealAnswer(): Promise<void> {
		const card = this.current();
		if (!card) {
			return;
		}
		this.revealed = true;
		this.phase = 'answered';
		await this.commit(card);
		this.render();
	}

	private async commit(card: ReviewCard): Promise<void> {
		// Grading is idempotent per card: a double Enter must not advance the
		// schedule twice.
		if (this.result) {
			return;
		}
		try {
			const grade = gradeFromSpelling({
				correct: !this.revealed,
				attempts: this.attempts,
				revealed: this.revealed,
			});
			const next = gradeReview(card.review, grade, this.today);
			// Graduating flips the card out of 学习中 so the library reads
			// honestly, but the schedule still brings it back.
			const status =
				this.plugin.settings.reviewAutoKnown && hasGraduated(next)
					? 'known'
					: grade === 'again'
						? 'learning'
						: card.status === 'new'
							? 'learning'
							: undefined;
			this.result = { grade, next };
			this.tally.total += 1;
			this.tally[grade === 'easy' ? 'good' : grade] += 1;
			await this.plugin.recordReview(card, next, status);
		} catch (error) {
			new Notice(
				error instanceof Error ? error.message : '这张卡的复习进度没能保存',
			);
		}
	}

	private async advance(): Promise<void> {
		this.index += 1;
		await this.showCard();
	}

	private renderDone(): void {
		this.phase = 'done';
		const container = this.contentEl;
		container.empty();
		const panel = container.createDiv({ cls: 'glean-review-start' });
		panel.createEl('h3', { text: '这轮复习完成' });
		panel.createEl('p', {
			text: `${this.tally.total} 张：记住 ${this.tally.good}，犹豫 ${this.tally.hard}，没记住 ${this.tally.again}。`,
		});

		const remaining = reviewQueueStats(this.cards(), this.today).due;
		if (remaining > 0) {
			panel.createEl('p', {
				cls: 'glean-review-note',
				text: `还剩 ${remaining} 张今天到期。`,
			});
			const again = panel.createEl('button', {
				cls: 'mod-cta',
				text: '接着复习',
			});
			again.addEventListener('click', () => {
				this.renderStart();
			});
			again.focus();
		} else {
			panel.createEl('p', { cls: 'glean-review-note', text: '今天的词都过完了。' });
		}
	}
}
