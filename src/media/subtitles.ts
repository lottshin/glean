import { TFile, type App } from 'obsidian';
import { siblingSubtitlePaths } from './paths';
import { SUBTITLE_EXTENSIONS } from './types';

export { siblingSubtitlePaths } from './paths';

export function findSiblingSubtitle(app: App, video: TFile): string | null {
	const folder = video.parent?.path ?? '';
	for (const path of siblingSubtitlePaths(folder, video.basename)) {
		const file = app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile && SUBTITLE_EXTENSIONS.has(file.extension.toLowerCase())) {
			return file.path;
		}
	}
	return null;
}
