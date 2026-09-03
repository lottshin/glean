import { TFile } from 'obsidian';
import type GleanPlugin from '../main';
import { LISTEN_VIEW_TYPE } from '../views/listen';
import { MEDIA_EXTENSIONS } from './types';

const ACTION_CLASS = 'glean-media-action';

/** The wheat mark means "Glean acts here"; on a media file that is listening. */
const LISTEN_ICON = 'wheat';

/**
 * Minimal shape of Obsidian's built-in file views. Typed structurally because
 * the audio/video viewers are not exported from the API.
 */
interface MediaFileView {
	file?: TFile | null;
	containerEl: HTMLElement;
	getViewType(): string;
	addAction(icon: string, title: string, callback: () => void): HTMLElement;
}

function asMediaView(view: unknown): MediaFileView | null {
	const candidate = view as MediaFileView | null;
	if (!candidate || typeof candidate.addAction !== 'function') {
		return null;
	}
	if (candidate.getViewType?.() === LISTEN_VIEW_TYPE) {
		return null;
	}
	const file = candidate.file;
	if (!(file instanceof TFile)) {
		return null;
	}
	return MEDIA_EXTENSIONS.has(file.extension.toLowerCase()) ? candidate : null;
}

/**
 * Put a wheat entry on Obsidian's own audio/video player.
 *
 * Opening a media file lands in the built-in viewer, which knows nothing about
 * Glean, so intensive listening was only reachable from the file context menu —
 * invisible to anyone who just double-clicked their video.
 */
export function registerMediaChrome(plugin: GleanPlugin): void {
	const sync = () => {
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = asMediaView(leaf.view);
			if (!view) {
				return;
			}
			// Obsidian rebuilds view actions on its own; clear ours first so a
			// re-sync cannot stack duplicate buttons.
			view.containerEl
				.querySelectorAll(`.view-actions .${ACTION_CLASS}`)
				.forEach((node) => node.remove());
			const file = view.file;
			if (!(file instanceof TFile)) {
				return;
			}
			const button = view.addAction(LISTEN_ICON, 'Glean 精听', () => {
				void plugin.openVideo(file);
			});
			button.addClass(ACTION_CLASS);
		});
	};

	plugin.registerEvent(plugin.app.workspace.on('file-open', sync));
	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', sync));
	plugin.registerEvent(plugin.app.workspace.on('layout-change', sync));
	plugin.app.workspace.onLayoutReady(sync);
}

/** Drop every button we added, for plugin unload. */
export function clearMediaChrome(plugin: GleanPlugin): void {
	plugin.app.workspace.iterateAllLeaves((leaf) => {
		leaf.view?.containerEl
			?.querySelectorAll(`.view-actions .${ACTION_CLASS}`)
			.forEach((node) => node.remove());
	});
}
