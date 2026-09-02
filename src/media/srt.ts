import type { Cue } from './types';

const TIMESTAMP =
	/(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

export function parseTimestamp(raw: string): number {
	const m = raw.trim().match(TIMESTAMP);
	if (!m) {
		throw new Error(`Invalid timestamp: ${raw}`);
	}
	const hours = m[1] !== undefined ? Number(m[1]) : 0;
	const minutes = Number(m[2]);
	const seconds = Number(m[3]);
	const frac = m[4] ?? '0';
	const ms = Number(frac) * 10 ** (3 - frac.length);
	return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function stripBom(input: string): string {
	return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function stripMarkup(text: string): string {
	return text
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/\{[^}]+\}/g, '')
		.replace(/\s+\n/g, '\n')
		.trim();
}

function isIgnorableBlock(firstLine: string): boolean {
	return /^(NOTE|STYLE|REGION|WEBVTT)\b/i.test(firstLine);
}

function parseTimingLine(line: string): { start: number; end: number } | null {
	const arrow = line.indexOf('-->');
	if (arrow < 0) {
		return null;
	}
	const startRaw = line.slice(0, arrow).trim();
	const rest = line.slice(arrow + 3).trim();
	const endRaw = rest.split(/\s+/)[0];
	if (!endRaw) {
		return null;
	}
	try {
		const start = parseTimestamp(startRaw);
		const end = parseTimestamp(endRaw);
		if (!(end > start)) {
			return null;
		}
		return { start, end };
	} catch {
		return null;
	}
}

/**
 * Parse SRT or WebVTT into cues. Malformed blocks are skipped.
 */
export function parseSubtitles(input: string): Cue[] {
	const text = stripBom(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (text.trim() === '') {
		return [];
	}

	let body = text;
	if (/^WEBVTT/i.test(body)) {
		const firstBlank = body.indexOf('\n\n');
		body = firstBlank >= 0 ? body.slice(firstBlank + 2) : '';
	}

	const blocks = body.split(/\n{2,}/);
	const cues: Cue[] = [];

	for (const block of blocks) {
		const lines = block.split('\n').filter((l) => l.trim() !== '');
		if (lines.length === 0) {
			continue;
		}
		const head = lines[0];
		if (head === undefined || isIgnorableBlock(head)) {
			continue;
		}

		let timingIndex = lines.findIndex((l) => l.includes('-->'));
		if (timingIndex < 0) {
			continue;
		}

		const timingLine = lines[timingIndex];
		if (timingLine === undefined) {
			continue;
		}
		const timing = parseTimingLine(timingLine);
		if (!timing) {
			continue;
		}

		const payload = lines.slice(timingIndex + 1).join('\n');
		const cueText = stripMarkup(payload);
		if (cueText === '') {
			continue;
		}

		cues.push({
			index: cues.length,
			start: timing.start,
			end: timing.end,
			text: cueText,
		});
	}

	return cues;
}

/** Written into saved subtitle files so listen-load will not re-run auto-split. */
export const GLEAN_EDITED_NOTE = 'NOTE glean-edited';

export function isGleanEditedSubtitles(input: string): boolean {
	return /NOTE\s+glean-edited\b/i.test(input);
}

function padClock(n: number, width = 2): string {
	return n.toString().padStart(width, '0');
}

function formatClock(seconds: number, fractionSep: ',' | '.'): string {
	const clamped = Math.max(0, seconds);
	const hours = Math.floor(clamped / 3600);
	const minutes = Math.floor((clamped % 3600) / 60);
	const whole = Math.floor(clamped % 60);
	const millis = Math.min(999, Math.round((clamped - Math.floor(clamped)) * 1000));
	return `${padClock(hours)}:${padClock(minutes)}:${padClock(whole)}${fractionSep}${padClock(millis, 3)}`;
}

/**
 * Serialize cues for writing back to the vault. Marks the file as user-edited
 * so the next open will not re-run automatic clause splitting.
 */
export function serializeSubtitles(cues: Cue[], format: 'srt' | 'vtt'): string {
	const blocks = cues.map((cue, index) => {
		const stamp =
			format === 'vtt'
				? `${formatClock(cue.start, '.')} --> ${formatClock(cue.end, '.')}`
				: `${formatClock(cue.start, ',')} --> ${formatClock(cue.end, ',')}`;
		return `${index + 1}\n${stamp}\n${cue.text}`;
	});
	if (format === 'vtt') {
		return `WEBVTT\n\n${GLEAN_EDITED_NOTE}\n\n${blocks.join('\n\n')}\n`;
	}
	return `${GLEAN_EDITED_NOTE}\n\n${blocks.join('\n\n')}\n`;
}

export function formatTimestamp(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const h = Math.floor(clamped / 3600);
	const m = Math.floor((clamped % 3600) / 60);
	const s = Math.floor(clamped % 60);
	const pad = (n: number) => n.toString().padStart(2, '0');
	if (h > 0) {
		return `${pad(h)}:${pad(m)}:${pad(s)}`;
	}
	return `${pad(m)}:${pad(s)}`;
}
