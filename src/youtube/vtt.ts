import nlp from 'compromise';

export interface TimedTextEvent {
	tStartMs?: number;
	dDurationMs?: number;
	segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
}

export interface TimedTextPayload {
	events?: TimedTextEvent[];
}

/** A word carrying its real audio start time (seconds) from the ASR track. */
export interface TimedWord {
	text: string;
	start: number;
}

export interface CaptionCue {
	start: number;
	end: number;
	text: string;
	/** Per-word timing, when known. Lets splits land on real word starts. */
	words?: TimedWord[];
}

/**
 * Intensive-listening cue model — GENERAL principles (not phrase exceptions):
 *
 * P1 Function-word open — never end on a closed-class word that still needs a complement.
 * P2 Prenominal open — never end on a prenominal modifier before a content word
 *    (high-freq prenominals + demonym morphology: -ese/-ian/-ish…).
 * P3 Light-verb / participle open — never end on light verbs/participles before content.
 * P4 Subjectless VP — cues starting with *n't / aux / bare participle attach left
 *    (subject was in the previous cue).
 * P5 Short fragment — ≤2-word content fragments attach left unless they open a new utterance;
 *    also DET+N compounds ("the people | square") and verb+particle/PP ("we start | here").
 * P6 Filler — um/uh attach forward only; never stand alone.
 * P7 Clause cut — before closed-class clause markers when the left side is already usable.
 * P8 Length — aim ~12–18 words; allow up to ~24 rather than a bad mid-constituent cut.
 */

export const TARGET_WORDS = 18;
export const TARGET_CHARS = 100;
export const HARD_WORDS = 24;
export const HARD_CHARS = 130;

function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0');
}

/** Format seconds as WebVTT timestamp `HH:MM:SS.mmm`. */
export function formatVttTimestamp(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const hours = Math.floor(clamped / 3600);
	const minutes = Math.floor((clamped % 3600) / 60);
	const whole = Math.floor(clamped % 60);
	const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
	return `${pad(hours)}:${pad(minutes)}:${pad(whole)}.${pad(millis, 3)}`;
}

function cleanCaptionText(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\u200b/g, '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&gt;/gi, '>')
		.replace(/&lt;/gi, '<')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/&amp;/gi, '&')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/\s*>>+\s*/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** YouTube ASR noise rows such as [Music] / [Applause]. */
export function isNoiseCaption(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) {
		return true;
	}
	return /^\[[^\]]+\]$/.test(trimmed);
}

function endsWithSentence(text: string): boolean {
	return /[.!?…。！？]$/.test(text.trim());
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

/** Concatenate word timing only when both sides carry it (keeps alignment). */
function concatWords(
	left: TimedWord[] | undefined,
	right: TimedWord[] | undefined,
): TimedWord[] | undefined {
	return left && right ? [...left, ...right] : undefined;
}

/**
 * Split one cue's text into two, dating each half by REAL word starts when
 * available. `first`/`second` need not cover the whole text (a dropped linker
 * like "and" may sit between them); we align by word counts from each end.
 * Falls back to char-ratio interpolation only when word timing is missing.
 */
function splitCueByWords(
	cue: CaptionCue,
	first: string,
	second: string,
): [CaptionCue, CaptionCue] {
	const leftCount = wordCount(first);
	const rightCount = wordCount(second);
	const words = cue.words;
	if (
		words &&
		words.length === wordCount(cue.text) &&
		leftCount > 0 &&
		rightCount > 0 &&
		leftCount + rightCount <= words.length
	) {
		const leftWords = words.slice(0, leftCount);
		const rightWords = words.slice(words.length - rightCount);
		const leftStart = leftWords[0]?.start ?? cue.start;
		const boundary = rightWords[0]?.start ?? cue.end;
		// Only trust per-word timing when it actually advances at the cut. Manual
		// captions give every word in a line the same start (no per-word offsets),
		// so using it here would make both halves share one timestamp — the "two
		// 00:00 cues" bug. In that case fall through to length interpolation.
		if (boundary > leftStart) {
			const rightEnd = Math.max(boundary + 0.2, cue.end);
			return [
				{
					start: leftStart,
					end: Math.max(leftStart + 0.2, boundary),
					text: first,
					words: leftWords,
				},
				{ start: boundary, end: rightEnd, text: second, words: rightWords },
			];
		}
	}
	// No usable word timing (e.g. manual captions, or re-refining an old vault
	// VTT): interpolate by length so each half gets a distinct, proportional time.
	const span = Math.max(cue.end - cue.start, 0.6);
	const ratio = Math.min(0.85, Math.max(0.15, first.length / (cue.text.length || 1)));
	const mid = cue.start + span * ratio;
	return [
		{ start: cue.start, end: Math.max(cue.start + 0.35, mid), text: first },
		{ start: mid, end: cue.end, text: second },
	];
}

/**
 * Breath-gap thresholds. We only have word START times, so a word's silence is
 * approximated as (next start − this start − estimated spoken duration).
 */
const PAUSE_CONTINUOUS = 0.24; // below this, two words share one breath group
const PAUSE_SPLIT = 0.5; // above this, a real breath — a natural place to cut

function estWordDuration(word: string): number {
	return Math.min(0.55, 0.075 * word.length + 0.12);
}

/**
 * Silence (seconds) after `words[i]`. `null` means the gap is unknown — either
 * there is no timing, or two words share a start (missing per-word offsets), in
 * which case we must not treat it as continuous speech.
 */
function pauseAfter(words: TimedWord[] | undefined, i: number): number | null {
	if (!words) {
		return null;
	}
	const current = words[i];
	const next = words[i + 1];
	if (!current) {
		return null;
	}
	if (!next) {
		return Infinity;
	}
	if (!(next.start > current.start)) {
		return null;
	}
	return Math.max(0, next.start - current.start - estWordDuration(current.text));
}

/** The longest reliable internal breath in a cue (0 when timing is unknown). */
function strongestInternalPause(words: TimedWord[] | undefined): number {
	if (!words) {
		return 0;
	}
	let max = 0;
	for (let i = 0; i < words.length - 1; i += 1) {
		const gap = pauseAfter(words, i);
		if (gap !== null && gap !== Infinity && gap > max) {
			max = gap;
		}
	}
	return max;
}

function normalizeToken(word: string): string {
	return word.toLowerCase().replace(/[^a-z0-9'’-]/gi, '');
}

/**
 * Silence (seconds) between two cues, measured on real word starts when
 * available, otherwise on cue clocks. `null` when it cannot be known.
 */
function boundaryGap(a: CaptionCue, b: CaptionCue): number | null {
	const lastA = a.words?.[a.words.length - 1];
	const firstB = b.words?.[0];
	if (lastA && firstB && firstB.start > lastA.start) {
		return Math.max(0, firstB.start - lastA.start - estWordDuration(lastA.text));
	}
	if (b.start > a.end) {
		return b.start - a.end;
	}
	return null;
}

function lastToken(text: string): string {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	return normalizeToken(parts[parts.length - 1] ?? '');
}

function firstToken(text: string): string {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	return normalizeToken(parts[0] ?? '');
}

/** Filler-only cues should never stand alone. */
const FILLER_ONLY = /^(um+|uh+|erm+|hmm+|mm+|ah+|oh+)\.?$/i;


function isFillerOnly(text: string): boolean {
	return FILLER_ONLY.test(text.trim());
}

interface NlpTerm {
	text: string;
	tags: string[];
}

interface NlpPhrase {
	offset?: {
		start: number;
		length: number;
	};
}

function nlpTerms(text: string): NlpTerm[] {
	const sentence = nlp(text).json()[0];
	return (sentence?.terms ?? []).map((term: NlpTerm) => ({
		text: term.text,
		tags: term.tags ?? [],
	}));
}

function hasTag(term: NlpTerm | undefined, ...tags: string[]): boolean {
	return !!term && tags.some((tag) => term.tags.includes(tag));
}

function firstVisibleTerm(text: string): NlpTerm | undefined {
	return nlpTerms(text).find((term) => term.text.length > 0);
}

function lastNlpTerm(text: string): NlpTerm | undefined {
	// Keep implicit contraction terms: in "she's", compromise emits visible
	// Pronoun + implicit Copula. The implicit final term is exactly the open edge.
	return nlpTerms(text).at(-1);
}

function isContentWord(word: string): boolean {
	if (!word || FILLER_ONLY.test(word)) {
		return false;
	}
	return hasTag(
		firstVisibleTerm(word),
		'Noun',
		'Verb',
		'Adjective',
		'Adverb',
		'Value',
	);
}

function phraseCrossesBoundary(left: string, right: string): boolean {
	const joined = `${left.trim()} ${right.trim()}`;
	const boundary = left.trim().length;
	const document = nlp(joined);
	const phrases = [
		...document.nouns().json({ offset: true }),
		...document.verbs().json({ offset: true }),
	] as NlpPhrase[];
	return phrases.some((phrase) => {
		const start = phrase.offset?.start;
		const length = phrase.offset?.length;
		return (
			start !== undefined &&
			length !== undefined &&
			start < boundary &&
			start + length > boundary + 1
		);
	});
}

/**
 * Closed-class FUNCTION words — a small, fixed set that never grows per video.
 * These are the two roles compromise tags unreliably (so/yet/to/then), so an
 * explicit finite list is more robust than a POS guess. Unlike the old lists,
 * these hold no open-class content words (no names, no "welcome"/"guys").
 */
// Coordinators / subordinators that open a clause and must not end a cue.
const CLAUSE_CONNECTOR =
	/^(so|and|but|or|nor|because|although|though|while|since|if|unless|whereas|plus|when|where)$/i;
// Relative pronouns / complementizers: they attach a clause to what precedes,
// so they can never END a cue, and they are NOT independent cut points either.
const REL_PRONOUN = /^(that|which|who|whom|whose)$/i;
// Prepositions / infinitival "to" — they need the complement that follows.
const NEEDS_COMPLEMENT =
	/^(to|of|for|with|at|in|on|by|from|into|onto|about|as|than|toward|towards|per)$/i;

/**
 * General POS/chunk boundary check. Unlike the old word lists, this asks what
 * grammatical role the edge has and whether the joined text forms one phrase.
 */
function nlpSaysAttach(left: string, right: string): boolean {
	if (phraseCrossesBoundary(left, right)) {
		return true;
	}
	const tail = lastNlpTerm(left);
	const head = firstVisibleTerm(right);
	const tailWord = lastToken(left);
	// A clause connector, relative pronoun, or preposition cannot close a cue —
	// the next words complete it. (Closed-class list: reliable where POS wavers.)
	if (
		CLAUSE_CONNECTOR.test(tailWord) ||
		REL_PRONOUN.test(tailWord) ||
		NEEDS_COMPLEMENT.test(tailWord)
	) {
		return true;
	}
	// These categories cannot normally close a constituent.
	if (
		hasTag(
			tail,
			'Determiner',
			'Preposition',
			'Auxiliary',
			'Modal',
			'Particle',
			'Possessive',
		)
	) {
		return true;
	}
	// Pronoun subject + predicate ("we | start", "she | walked").
	if (hasTag(tail, 'Pronoun') && hasTag(head, 'Verb')) {
		return true;
	}
	// A verbal continuation whose subject lives in the previous cue.
	if (
		hasTag(head, 'Auxiliary', 'Participle', 'Gerund') &&
		!endsWithSentence(left)
	) {
		return true;
	}
	// A participle at the left edge commonly still takes a complement
	// ("haven't seen | much", "was made | in China").
	if (hasTag(tail, 'Participle') && !endsWithSentence(left)) {
		return true;
	}
	return false;
}

/**
 * Closed-class discourse markers compromise misses out of context ("all right",
 * "well", "anyway"). This is a FINITE set — it never grows per video — so it is
 * not the open-class enumeration we are trying to avoid.
 */
const DISCOURSE_MARKER = /^(all right|alright|well|anyway|right|now)\b[,.!?]?$/i;

/** A standalone discourse opener ("all right", "okay", "so", "um"). */
function opensDiscourse(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) {
		return false;
	}
	return (
		hasTag(firstVisibleTerm(trimmed), 'Expression') ||
		DISCOURSE_MARKER.test(trimmed)
	);
}

/**
 * Does `right` begin a new clause? Pure POS — no open-class words. A clause
 * opens on a discourse marker (Expression), a conjunction, or a fresh
 * subject+predicate (pronoun followed by a verb).
 */
/**
 * Does `text` begin a NEW main clause? Reliable, video-independent signals only:
 * a discourse marker, or a coordinating/subordinating connector. A bare
 * "pronoun + verb" is deliberately NOT treated as a cut point — it fires inside
 * relative, complement and adverbial clauses ("the thing that I love", "by the
 * time I got there"), so using it as a boundary shreds those constituents.
 * Real main-clause boundaries are carried by punctuation and breath instead.
 */
function opensNewClause(text: string): boolean {
	const terms = nlpTerms(text).filter((term) => term.text.length > 0);
	const head = terms[0];
	if (!head) {
		return false;
	}
	if (opensDiscourse(text)) {
		return true;
	}
	if (CLAUSE_CONNECTOR.test(head.text)) {
		return true;
	}
	return false;
}

/**
 * P4: subject was left behind — morphological, not per-phrase.
 * Covers haven't/don't/can't… and bare auxiliaries/participles.
 */
function isSubjectlessVpHead(text: string): boolean {
	const trimmed = text.trim();
	if (/^[A-Za-z]+n't\b/i.test(trimmed) || /^am not\b/i.test(trimmed)) {
		return true;
	}
	return /^(is|are|was|were|am|do|does|did|have|has|had|will|would|can|could|should|may|might|must|got|gotten|been|seen|gone|done|made|taken|given|found|left|shown|told)\b/i.test(
		trimmed,
	);
}

/** Clause / turn openings that should NOT be glued leftward. */
function isNewUtteranceHead(text: string): boolean {
	return opensNewClause(text);
}

/** Locative/temporal particles and PP openers that continue the previous verb/noun. */
const CONTINUING_PARTICLE =
	/^(here|there|home|abroad|inside|outside|away|back|down|up|out|off|around|through|in|on|at|to|from|with|into|onto|over|under|about)\b/i;

/** P5: ASR crumbs of 1–2 content words belong with the previous cue. */
function isShortContentFragment(text: string): boolean {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0 || words.length > 2) {
		return false;
	}
	if (isNewUtteranceHead(text)) {
		return false;
	}
	return words.every((word) => isContentWord(normalizeToken(word)));
}

/**
 * Determiner + noun is often still open for a compound or postmodifier
 * ("the people | square", "a brand | new …" already handled by prenominal).
 */
function isOpenDeterminerNoun(text: string): boolean {
	return /\b(the|a|an|this|that|my|your|his|her|their|our)\s+[a-z']+$/i.test(
		text.trim(),
	);
}

/** True when two neighboring cues must stay glued by P1–P6. */
function shouldAttachCues(left: string, right: string): boolean {
	if (!left.trim() || !right.trim()) {
		return false;
	}
	// A completed sentence never needs the next cue to finish it.
	if (endsWithSentence(left)) {
		return false;
	}
	// P6: fillers attach forward only.
	if (isFillerOnly(right)) {
		return false;
	}
	if (isFillerOnly(left)) {
		return true;
	}
	// P4 always wins — elliptical VP needs the previous subject.
	if (isSubjectlessVpHead(right)) {
		return true;
	}
	// Do not glue across a clear clause opening.
	if (isNewUtteranceHead(right)) {
		return false;
	}
	// Primary decision: POS tags and noun/verb phrase chunks across the edge.
	if (nlpSaysAttach(left, right)) {
		return true;
	}
	// Verb/noun + particle/PP opener ("we start | here…", "walking | around…").
	if (
		isContentWord(lastToken(left)) &&
		CONTINUING_PARTICLE.test(right.trim()) &&
		!endsWithSentence(left)
	) {
		return true;
	}
	// Open DET+N before a content continuation ("the people | square").
	if (
		isOpenDeterminerNoun(left) &&
		isContentWord(firstToken(right)) &&
		!endsWithSentence(left)
	) {
		return true;
	}
	// P5: short content crumb.
	if (isShortContentFragment(right)) {
		return true;
	}
	return false;
}

/**
 * Hard constituent check for the split side. When a cue is already too long (or
 * sits on a real breath), only a genuine grammatical violation should stop the
 * cut — not the soft "this phrase might still grow" heuristics used for gluing.
 */
function breaksConstituent(left: string, right: string): boolean {
	if (!left.trim() || !right.trim()) {
		return true;
	}
	if (endsWithSentence(left)) {
		return false;
	}
	if (isFillerOnly(left) || isFillerOnly(right)) {
		return true;
	}
	// Never strand a clause-opening discourse marker at the end of a cue.
	if (hasTag(lastNlpTerm(left), 'Expression')) {
		return true;
	}
	// Never strand a connector, relative pronoun, or preposition — this outranks
	// the "safe to cut before a new clause" allowance below.
	const tailWord = lastToken(left);
	if (
		CLAUSE_CONNECTOR.test(tailWord) ||
		REL_PRONOUN.test(tailWord) ||
		NEEDS_COMPLEMENT.test(tailWord)
	) {
		return true;
	}
	if (isSubjectlessVpHead(right)) {
		return true;
	}
	// A new clause/utterance opening is always a safe place to cut before.
	if (isNewUtteranceHead(right)) {
		return false;
	}
	return nlpSaysAttach(left, right);
}

function startsNewUtterance(text: string): boolean {
	return opensNewClause(text);
}

function joinCaptionTexts(left: string, right: string): string {
	const a = left.trim();
	const b = right.trim();
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) {
		return `${a} ${b}`;
	}
	if (/\s$/.test(a) || /^\s/.test(b)) {
		return `${a}${b}`.replace(/\s+/g, ' ').trim();
	}
	return `${a} ${b}`;
}

/**
 * The single, video-independent split rule. It scans every inter-word gap and
 * scores it from three signal families only — never from any word list:
 *   • acoustic  — a real breath (silence) after the word
 *   • orthographic — a sentence terminator or comma closing the left side
 *   • grammatical — the right side opens a new clause (POS: Expression /
 *     Conjunction / fresh subject+verb)
 * A hard grammatical gate (`breaksConstituent`) forbids cutting inside a
 * phrase. Without any real signal it declines to split, unless `force` is set
 * (the cue is so long it must be broken somewhere safe).
 */
const SPLIT_MIN_SIGNAL = 25;
const SPLIT_CONSIDER_WORDS = 8;

function findBestSplit(
	cue: CaptionCue,
	force: boolean,
): { first: string; second: string } | null {
	const tokens = cleanCaptionText(cue.text).split(/\s+/).filter(Boolean);
	if (tokens.length < 4) {
		return null;
	}
	const words =
		cue.words && cue.words.length === tokens.length ? cue.words : undefined;
	const mid = (tokens.length - 1) / 2;
	let best: { first: string; second: string } | null = null;
	let bestScore = -Infinity;

	for (let i = 0; i < tokens.length - 1; i += 1) {
		const first = tokens.slice(0, i + 1).join(' ');
		const second = tokens.slice(i + 1).join(' ');
		const gap = pauseAfter(words, i);
		const atBreath = gap !== null && gap !== Infinity && gap >= PAUSE_SPLIT;
		const sentenceLeft = endsWithSentence(first);
		const commaLeft = /,$/.test(first);
		// A real breath or a finished sentence lets short chunks stand alone.
		const minSide = atBreath || sentenceLeft ? 2 : 3;
		if (wordCount(first) < minSide || wordCount(second) < minSide) {
			continue;
		}
		if (breaksConstituent(first, second)) {
			continue;
		}
		const balance = 1 - Math.abs(i - mid) / mid;
		let score = balance * 4;
		if (sentenceLeft) {
			score += 100;
		} else if (commaLeft) {
			score += 30;
		}
		// A connector / discourse marker is a strong clause boundary; a bare
		// subject+verb is weaker (it is often a complement clause we shouldn't
		// break off), so it scores lower.
		const secondHead = second.split(/\s+/)[0] ?? '';
		if (opensDiscourse(second) || CLAUSE_CONNECTOR.test(secondHead)) {
			score += 70;
		} else if (opensNewClause(second)) {
			score += 35;
		}
		if (gap !== null && gap !== Infinity) {
			score += Math.min(gap, 1.5) * 45;
		}
		if (score > bestScore) {
			bestScore = score;
			best = { first, second };
		}
	}

	if (!best) {
		return null;
	}
	// Balance alone (≤6) is not a real signal; require a genuine cue to cut.
	if (!force && bestScore < SPLIT_MIN_SIGNAL) {
		return null;
	}
	return best;
}

function splitOneLongCue(cue: CaptionCue): CaptionCue[] {
	const text = cleanCaptionText(cue.text);
	if (!text) {
		return [];
	}
	const normalized: CaptionCue = { ...cue, text };
	const words = wordCount(text);
	// A clear breath inside a short cue is still worth cutting on.
	const hasStrongPause = strongestInternalPause(normalized.words) >= PAUSE_SPLIT;
	// Several sentences glued together should still be broken apart.
	const hasInnerSentence = /[.?!]["'”]?\s+\S/.test(text);
	// Long enough to hold more than one clause → look for a boundary; findBestSplit
	// only actually cuts when a real signal (clause open / breath / punctuation)
	// is present, so cohesive cues are left alone.
	const consider =
		words > SPLIT_CONSIDER_WORDS ||
		text.length > TARGET_CHARS ||
		hasStrongPause ||
		hasInnerSentence;

	if (!consider) {
		return [normalized];
	}

	const parts = findBestSplit(normalized, words > HARD_WORDS);
	if (!parts) {
		// Prefer a slightly long cue over a broken phrase.
		return [normalized];
	}

	const { first, second } = parts;
	const [leftCue, rightCue] = splitCueByWords(normalized, first, second);
	return [...splitOneLongCue(leftCue), ...splitOneLongCue(rightCue)];
}

/**
 * Split a standalone discourse opener off the next utterance,
 * e.g. "all right welcome to China" → "all right" + "welcome to China".
 * The opener set is closed-class (finite) — interjections only, never the
 * open-class words that made the old lists unmaintainable.
 */
const STANDALONE_OPENER =
	/^(all right|alright|oh okay|okay|ok|well|anyway|yeah|yep|yup|right|now)$/i;

export function splitDiscourseCues(cues: CaptionCue[]): CaptionCue[] {
	const out: CaptionCue[] = [];
	for (const cue of cues) {
		const text = cleanCaptionText(cue.text);
		const tokens = text.split(/\s+/).filter(Boolean);
		let openerLen = 0;
		for (const n of [2, 1]) {
			if (
				tokens.length > n &&
				STANDALONE_OPENER.test(
					tokens
						.slice(0, n)
						.join(' ')
						.replace(/[,.!?]+$/, ''),
				)
			) {
				openerLen = n;
				break;
			}
		}
		if (!openerLen) {
			out.push({ ...cue, text });
			continue;
		}
		const opener = tokens.slice(0, openerLen).join(' ');
		const rest = tokens.slice(openerLen).join(' ');
		if (wordCount(rest) < 2) {
			out.push({ ...cue, text });
			continue;
		}
		// If the speaker runs the opener straight into the next word (no breath),
		// keep them together — a later breath is where the real cut belongs.
		const openerGap = pauseAfter(cue.words, openerLen - 1);
		if (openerGap !== null && openerGap !== Infinity && openerGap < PAUSE_CONTINUOUS) {
			out.push({ ...cue, text });
			continue;
		}
		const [openerCue, restCue] = splitCueByWords({ ...cue, text }, opener, rest);
		out.push(openerCue, restCue);
	}
	return out;
}

/**
 * If a cue grew too long for intensive listening, split it at a clause boundary.
 */
export function splitLongCues(cues: CaptionCue[]): CaptionCue[] {
	const out: CaptionCue[] = [];
	for (const cue of cues) {
		out.push(...splitOneLongCue(cue));
	}
	return out;
}

/**
 * Pull dangling tails and collocations onto the next cue's head until each cue
 * ends on a grammatical boundary ("Chinese New|Year", "American|guy", "um").
 */
export function healIncompleteCues(cues: CaptionCue[]): CaptionCue[] {
	const healed: CaptionCue[] = [];
	let index = 0;
	while (index < cues.length) {
		const head = cues[index];
		if (!head) {
			break;
		}
		let current: CaptionCue = {
			start: head.start,
			end: head.end,
			text: cleanCaptionText(head.text),
			words: head.words,
		};
		index += 1;
		while (index < cues.length) {
			const next = cues[index];
			if (!next) {
				break;
			}
			const nextText = cleanCaptionText(next.text);
			// A real breath is a hard boundary — never heal across silence,
			// unless a bare filler must lean on its neighbor, or the two sides
			// form one unbreakable phrase (preposition + object, etc.).
			const gap = boundaryGap(current, next);
			if (
				gap !== null &&
				gap >= PAUSE_SPLIT &&
				wordCount(current.text) >= 2 &&
				!isFillerOnly(current.text) &&
				!isFillerOnly(nextText) &&
				!breaksConstituent(current.text, nextText)
			) {
				break;
			}
			// A bare discourse opener ("all right", "okay") stands on its own —
			// it must not absorb the next utterance.
			if (
				opensDiscourse(current.text) &&
				!isFillerOnly(current.text) &&
				wordCount(current.text) <= 3
			) {
				break;
			}
			if (!shouldAttachCues(current.text, nextText)) {
				break;
			}
			current = {
				start: current.start,
				end: Math.max(current.end, next.end),
				text: joinCaptionTexts(current.text, nextText),
				words: concatWords(current.words, next.words),
			};
			index += 1;
		}
		// Drop leftover filler-only drafts that never found a neighbor.
		if (current.text && !isFillerOnly(current.text)) {
			healed.push(current);
		}
	}
	return splitLongCues(healed);
}

/**
 * Merge fragmented YouTube ASR cues into more readable sentence-like cues.
 * Keeps discourse openers from swallowing the next sentence, and reunites
 * mid-clause cuts like "I've been" + "wanting to come…".
 */
function isInlineNoiseToken(token: string): boolean {
	return /^\[[^\]]*\]$/.test(token);
}

function isTurnToken(token: string): boolean {
	return /^>>+$/.test(token);
}

/**
 * Split ">>" speaker turns into separate cues and drop inline noise like
 * [Music]. A turn change is the strongest possible boundary — never merge
 * across it. Uses word timing when present so each turn keeps real starts.
 */
function explodeSpeakerTurns(cues: CaptionCue[]): CaptionCue[] {
	const out: CaptionCue[] = [];
	for (const cue of cues) {
		if (!/>>/.test(cue.text) && !/\[[^\]]*\]/.test(cue.text)) {
			out.push(cue);
			continue;
		}
		if (cue.words && cue.words.length === wordCount(cue.text)) {
			const runs: TimedWord[][] = [];
			let run: TimedWord[] = [];
			for (const word of cue.words) {
				if (isTurnToken(word.text)) {
					if (run.length) {
						runs.push(run);
						run = [];
					}
					continue;
				}
				if (isInlineNoiseToken(word.text)) {
					continue;
				}
				run.push(word);
			}
			if (run.length) {
				runs.push(run);
			}
			for (let r = 0; r < runs.length; r += 1) {
				const group = runs[r];
				const head = group?.[0];
				if (!group || !head) {
					continue;
				}
				const start = head.start;
				const nextStart = runs[r + 1]?.[0]?.start;
				const rawEnd =
					nextStart !== undefined && nextStart > start ? nextStart : cue.end;
				out.push({
					start,
					end: Math.max(start + 0.3, rawEnd),
					text: group.map((word) => word.text).join(' '),
					words: group,
				});
			}
			continue;
		}
		// No word timing: split the text and interpolate by character length.
		const segments = cue.text
			.split(/>>+/)
			.map((segment) => cleanCaptionText(segment))
			.filter(Boolean);
		if (segments.length === 0) {
			continue;
		}
		const span = Math.max(cue.end - cue.start, 0.4);
		const total = segments.reduce((sum, seg) => sum + seg.length, 0) || 1;
		let cursor = cue.start;
		for (const seg of segments) {
			const start = cursor;
			const end = Math.max(start + 0.3, start + (seg.length / total) * span);
			out.push({ start, end, text: seg });
			cursor = end;
		}
	}
	return out;
}

export function mergeCaptionCues(cues: CaptionCue[]): CaptionCue[] {
	const MAX_DURATION = 8;
	const MAX_GAP = 0.85;

	const merged: CaptionCue[] = [];
	let draft: CaptionCue | null = null;

	const flush = () => {
		if (!draft) {
			return;
		}
		merged.push({
			start: draft.start,
			end: Math.max(draft.end, draft.start + 0.4),
			text: cleanCaptionText(draft.text),
			words: draft.words,
		});
		draft = null;
	};

	for (const cue of explodeSpeakerTurns(cues)) {
		const text = cleanCaptionText(cue.text);
		if (!text || isNoiseCaption(text)) {
			continue;
		}
		if (!draft) {
			draft = { start: cue.start, end: cue.end, text, words: cue.words };
			continue;
		}

		const gap = cue.start - draft.end;
		const joined = joinCaptionTexts(draft.text, text);
		const duration = Math.max(draft.end, cue.end) - draft.start;
		const draftWords = wordCount(draft.text);
		const nextWords = wordCount(text);
		const mustAttach = shouldAttachCues(draft.text, text);
		const draftIsOpener =
			opensDiscourse(draft.text) && wordCount(draft.text) <= 3;
		const nextIsNewUtterance = startsNewUtterance(text);
		// Breath between the two drafts, measured on real word starts.
		const lastDraftWord = draft.words?.[draft.words.length - 1];
		const firstNextWord = cue.words?.[0];
		const boundaryPause =
			lastDraftWord && firstNextWord && firstNextWord.start > lastDraftWord.start
				? Math.max(
						0,
						firstNextWord.start - lastDraftWord.start - estWordDuration(lastDraftWord.text),
					)
				: null;
		const continuousIntoNext =
			boundaryPause !== null && boundaryPause < PAUSE_CONTINUOUS;

		// A real breath is a hard boundary — never merge across silence, unless
		// the two sides form one unbreakable phrase (a preposition needing its
		// object, etc.). A lone word is too incomplete to strand.
		if (
			boundaryPause !== null &&
			boundaryPause >= PAUSE_SPLIT &&
			wordCount(draft.text) >= 2 &&
			!breaksConstituent(draft.text, text)
		) {
			flush();
			draft = { start: cue.start, end: cue.end, text, words: cue.words };
			continue;
		}

		// Don't glue "all right" onto "welcome to China" — unless it's read as one
		// breath group, in which case keep it for a later breath-aligned cut.
		if (draftIsOpener && nextIsNewUtterance && !mustAttach && !continuousIntoNext) {
			flush();
			draft = { start: cue.start, end: cue.end, text, words: cue.words };
			continue;
		}

		const softGap = mustAttach
			? nextWords <= 4
				? 25
				: 8
			: draftWords <= 8 && !endsWithSentence(draft.text)
				? 1.6
				: MAX_GAP;
		const softDuration = mustAttach
			? nextWords <= 4
				? 40
				: 14
			: MAX_DURATION;
		// Prefer reuniting a clause first; splitLongCues enforces listening length.
		const softChars = mustAttach ? Math.max(HARD_CHARS, 260) : TARGET_CHARS;
		const softWords = mustAttach ? Math.max(HARD_WORDS, 48) : TARGET_WORDS;
		const canMerge =
			gap <= softGap &&
			!endsWithSentence(draft.text) &&
			joined.length <= softChars &&
			wordCount(joined) <= softWords &&
			duration <= softDuration &&
			!(
				nextIsNewUtterance &&
				gap > 0.35 &&
				draftWords >= 3 &&
				!mustAttach
			);

		if (canMerge) {
			draft = {
				start: draft.start,
				end: Math.max(draft.end, cue.end),
				text: joined,
				words: concatWords(draft.words, cue.words),
			};
			continue;
		}

		flush();
		draft = { start: cue.start, end: cue.end, text, words: cue.words };
	}

	flush();
	return healIncompleteCues(
		splitDiscourseCues(
			merged.filter((cue) => cue.text.length > 0 && cue.end > cue.start),
		),
	);
}

/**
 * Convert YouTube timedtext JSON3 events into cue objects.
 * Invalid, empty, and noise events are skipped; short ASR fragments are merged.
 */
export function cuesFromTimedText(payload: TimedTextPayload): CaptionCue[] {
	const events = payload.events ?? [];
	const raw: CaptionCue[] = [];

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (
			!event ||
			typeof event.tStartMs !== 'number' ||
			!Array.isArray(event.segs)
		) {
			continue;
		}
		// Real per-word timing: each seg carries an offset from the event start.
		const words: TimedWord[] = [];
		for (const segment of event.segs) {
			const segStart = event.tStartMs + (segment.tOffsetMs ?? 0);
			for (const token of (segment.utf8 ?? '').split(/\s+/)) {
				if (token) {
					words.push({ text: token, start: segStart / 1000 });
				}
			}
		}
		const text = words.map((word) => word.text).join(' ');
		if (!text || isNoiseCaption(text)) {
			continue;
		}
		const start = words[0]?.start ?? event.tStartMs / 1000;
		const durationMs =
			typeof event.dDurationMs === 'number' && event.dDurationMs > 0
				? event.dDurationMs
				: 2000;
		const rawDuration = durationMs / 1000;
		const guessed = Math.max(0.7, Math.min(5.5, words.length * 0.42 + 0.35));
		let end =
			rawDuration > Math.max(guessed * 2.5, 4)
				? start + guessed
				: start + rawDuration;

		for (let look = index + 1; look < events.length; look += 1) {
			const next = events[look];
			if (
				!next ||
				typeof next.tStartMs !== 'number' ||
				!Array.isArray(next.segs)
			) {
				continue;
			}
			const nextText = cleanCaptionText(
				next.segs.map((segment) => segment.utf8 ?? '').join(''),
			);
			if (!nextText || isNoiseCaption(nextText)) {
				continue;
			}
			const nextStart = next.tStartMs / 1000;
			if (nextStart > start) {
				end = Math.min(end, Math.max(start + 0.35, nextStart));
			}
			break;
		}

		if (!(end > start)) {
			continue;
		}
		raw.push({ start, end, text, words });
	}

	return mergeCaptionCues(raw);
}

export function cuesToWebVtt(cues: CaptionCue[]): string {
	const blocks = cues.map((cue, index) => {
		return [
			String(index + 1),
			`${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}`,
			cue.text,
		].join('\n');
	});
	return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

export function timedTextToWebVtt(payload: TimedTextPayload): string {
	return cuesToWebVtt(cuesFromTimedText(payload));
}

/** Ensure a VTT/string body starts with WEBVTT; pass through when already VTT. */
export function ensureWebVtt(input: string): string {
	const text = input.replace(/^\uFEFF/, '').trimStart();
	if (/^WEBVTT/i.test(text)) {
		return text.endsWith('\n') ? text : `${text}\n`;
	}
	return text;
}

/**
 * Re-run grammar heal + length splits on already-built cues.
 * Used when loading an old vault VTT, or when the extension sent a stale cut.
 */
export function refineCaptionCues(cues: CaptionCue[]): CaptionCue[] {
	const exploded = explodeSpeakerTurns(
		cues.filter((cue) => cue.end > cue.start),
	);
	return healIncompleteCues(
		exploded
			.map((cue) => ({
				start: cue.start,
				end: cue.end,
				text: cleanCaptionText(cue.text),
				words: cue.words,
			}))
			.filter((cue) => cue.text.length > 0 && cue.end > cue.start),
	);
}

/** Re-segment a WebVTT body with the current clause rules. */
export function refineWebVtt(input: string): string {
	const ensured = ensureWebVtt(input);
	// Lightweight cue extract so import/listen can heal without a full SRT dependency cycle.
	const blocks = ensured
		.replace(/^WEBVTT[^\n]*\n?/i, '')
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean);
	const cues: CaptionCue[] = [];
	for (const block of blocks) {
		const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
		if (lines.length < 2) {
			continue;
		}
		const timingIndex = /-->/.test(lines[0] ?? '') ? 0 : 1;
		const timing = lines[timingIndex] ?? '';
		const arrow = timing.indexOf('-->');
		if (arrow < 0) {
			continue;
		}
		const start = parseVttClock(timing.slice(0, arrow).trim());
		const end = parseVttClock(
			timing
				.slice(arrow + 3)
				.trim()
				.replace(/\s.*/, ''),
		);
		const text = lines
			.slice(timingIndex + 1)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (
			start === null ||
			end === null ||
			!(end > start) ||
			!text ||
			isNoiseCaption(text)
		) {
			continue;
		}
		cues.push({ start, end, text });
	}
	return cuesToWebVtt(refineCaptionCues(cues));
}

function parseVttClock(raw: string): number | null {
	const match = raw
		.trim()
		.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
	if (!match) {
		return null;
	}
	const hours = match[1] !== undefined ? Number(match[1]) : 0;
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const frac = match[4] ?? '0';
	const millis = Number(frac) * 10 ** (3 - frac.length);
	return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}
