import {
	formatIpa,
	type AccentPhonetics,
} from './community';

export interface AccentSpeakHost {
	onSpeak: (accent: 'en-US' | 'en-GB') => void | Promise<void>;
}

/**
 * Speaker glyph with two wave arcs that can animate independently.
 * Obsidian's lucide `volume-2` is one opaque SVG; we need named arcs.
 */
export function mountSpeakerIcon(parent: HTMLElement): void {
	parent.empty();
	const svgNamespace = 'http://www.w3.org/2000/svg';
	const svg = parent.ownerDocument.createElementNS(svgNamespace, 'svg');
	svg.classList.add('glean-speaker-icon');
	for (const [name, value] of Object.entries({
		viewBox: '0 0 24 24',
		width: '14',
		height: '14',
		'aria-hidden': 'true',
		focusable: 'false',
	})) {
		svg.setAttribute(name, value);
	}
	for (const [className, pathData] of [
		['glean-speaker-body', 'M11 5 6 9H3v6h3l5 4V5z'],
		['glean-speaker-wave glean-speaker-wave-1', 'M15.54 8.46a5 5 0 0 1 0 7.07'],
		['glean-speaker-wave glean-speaker-wave-2', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
	] as const) {
		const path = parent.ownerDocument.createElementNS(svgNamespace, 'path');
		path.setAttribute('class', className);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '2');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		path.setAttribute('d', pathData);
		svg.appendChild(path);
	}
	parent.appendChild(svg);
}

/**
 * Two-line 美/英 IPA + speaker icons. When only a single offline phonetic exists,
 * it is shown on both rows until dual IPA is filled in.
 */
export function renderAccentPhoneticRows(
	parent: HTMLElement,
	phonetics: AccentPhonetics,
	host: AccentSpeakHost,
	fallback = '',
): void {
	parent.empty();
	parent.addClass('glean-accent-phonetics');
	const bareFallback = fallback.replace(/^\/+|\/+$/g, '').trim();
	for (const [accent, label, value] of [
		['en-US', '美', phonetics.us ?? bareFallback],
		['en-GB', '英', phonetics.gb ?? bareFallback],
	] as const) {
		const row = parent.createDiv({ cls: 'glean-accent-phonetic-row' });
		row.createSpan({
			cls: 'glean-accent-label',
			text: label,
		});
		const ipa = value ? formatIpa(value) : '';
		if (ipa) {
			row.createSpan({
				cls: 'glean-accent-ipa',
				text: ipa,
			});
		}
		const aria = accent === 'en-US' ? '播放美音' : '播放英音';
		const button = row.createEl('button', {
			cls: 'glean-speak-play',
			attr: {
				type: 'button',
				'aria-label': aria,
				title: aria,
			},
		});
		mountSpeakerIcon(button);
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			void playWithFeedback(button, () => host.onSpeak(accent));
		});
	}
}

async function playWithFeedback(
	button: HTMLElement,
	speak: () => void | Promise<void>,
): Promise<void> {
	const root = button.closest('.glean-accent-phonetics') ?? button.parentElement;
	root
		?.querySelectorAll('.glean-speak-play.is-playing')
		.forEach((node) => node.removeClass('is-playing'));
	button.addClass('is-playing');
	try {
		await speak();
	} finally {
		button.removeClass('is-playing');
	}
}
