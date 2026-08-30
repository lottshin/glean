import { FuzzySuggestModal, TFile, type App } from 'obsidian';
import { MEDIA_EXTENSIONS } from './types';

export class MediaSuggestModal extends FuzzySuggestModal<TFile> {
	private onPick: (file: TFile) => void;

	constructor(app: App, onPick: (file: TFile) => void) {
		super(app);
		this.onPick = onPick;
		this.setPlaceholder('搜索 vault 里的视频 / 音频…');
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => MEDIA_EXTENSIONS.has(f.extension.toLowerCase()))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}
