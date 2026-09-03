import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListenView } from '../src/views/listen';

/**
 * A player whose clock only advances when we say so, so a test can watch what
 * happens between two time reports — which is exactly where the bug lived.
 */
function fakePlayer(start = 0, rate = 1) {
	return {
		time: start,
		rate,
		playing: true,
		pauses: 0,
		pausedAt: null as number | null,
		isPlaying() {
			return this.playing;
		},
		getCurrentTime() {
			return this.time;
		},
		getPlaybackRate() {
			return this.rate;
		},
		pause() {
			this.playing = false;
			this.pauses += 1;
			this.pausedAt = this.time;
		},
		/** Advance the clock the way real playback would over `seconds`. */
		advance(seconds: number) {
			if (this.playing) {
				this.time += seconds * this.rate;
			}
		},
	};
}

type Harness = ReturnType<typeof fakePlayer>;

/**
 * Build a view without running the constructor: we only exercise the sentence
 * stop scheduling, which needs no DOM.
 */
interface TestView {
	scheduleSentenceStop(remaining?: number): void;
	onTick(t: number): void;
	sentenceMode: boolean;
	sentenceArmed: boolean;
}

function viewWith(player: Harness, end: number, armed = true): TestView {
	const view = Object.create(ListenView.prototype) as Record<string, unknown>;
	view.source = player;
	view.sentenceMode = true;
	view.sentenceArmed = armed;
	view.sentenceStart = 0;
	view.sentenceEnd = end;
	view.sentenceStopTimer = null;
	view.mode = 'listen';
	view.timeEl = null;
	view.cues = [];
	view.activeIndex = -1;
	return view as unknown as TestView;
}

/**
 * Move the clock and the timers together, reporting the time to the view every
 * 250ms the way the YouTube player does. That report is what re-books a stop,
 * so a test without it would not exercise the real arrangement.
 */
async function runFor(
	player: Harness,
	seconds: number,
	view?: TestView,
	step = 0.01,
	tickEvery = 0.25,
): Promise<void> {
	let sinceTick = 0;
	for (let elapsed = 0; elapsed < seconds; elapsed += step) {
		player.advance(step);
		await vi.advanceTimersByTimeAsync(step * 1000);
		sinceTick += step;
		if (view && sinceTick >= tickEvery - 1e-9) {
			sinceTick = 0;
			view.onTick(player.getCurrentTime());
		}
	}
}

describe('stopping at the end of a sentence', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// The plugin schedules through `window`, as Obsidian code does.
		(globalThis as Record<string, unknown>).window = globalThis;
	});
	afterEach(() => {
		vi.useRealTimers();
		delete (globalThis as Record<string, unknown>).window;
	});

	// Start off the 250ms grid: waiting for a time report would land at 10.13,
	// which is the bleed you hear as the next word.
	it('pauses at the boundary, not on the next time report', async () => {
		const player = fakePlayer(9.13);
		const view = viewWith(player, 10.0);
		view.scheduleSentenceStop();

		await runFor(player, 1.5, view);

		expect(player.pauses).toBe(1);
		expect(player.pausedAt!).toBeGreaterThan(9.97);
		expect(player.pausedAt!).toBeLessThan(10.03);
		expect(view.sentenceMode).toBe(false);
	});

	it('accounts for playback rate', async () => {
		const player = fakePlayer(9.13, 1.5);
		const view = viewWith(player, 10.0);
		view.scheduleSentenceStop();

		await runFor(player, 1.5, view);

		expect(player.pauses).toBe(1);
		expect(player.pausedAt!).toBeLessThan(10.05);
	});

	it('does not cut the sentence short when a seek is still buffering', async () => {
		// Booked for a one second sentence, but the seek has not landed: the
		// clock is still back where we came from when the booking comes due.
		const player = fakePlayer(2.0);
		player.playing = false;
		const view = viewWith(player, 10.0, false);
		view.scheduleSentenceStop(1.0);

		await runFor(player, 1.2, view);
		expect(player.pauses).toBe(0);

		// The seek lands and playback starts inside the sentence.
		player.time = 9.5;
		player.playing = true;
		await runFor(player, 1.0, view);

		expect(player.pauses).toBe(1);
		expect(player.pausedAt!).toBeGreaterThan(9.97);
		expect(player.pausedAt!).toBeLessThan(10.03);
	});

	it('stops immediately when the boundary has already passed', () => {
		const player = fakePlayer(10.5);
		const view = viewWith(player, 10.0);
		view.scheduleSentenceStop();
		expect(player.pauses).toBe(1);
		expect(view.sentenceMode).toBe(false);
	});
});
