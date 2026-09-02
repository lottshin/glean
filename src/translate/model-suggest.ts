import { FuzzySuggestModal, type App } from 'obsidian';

export class TranslationModelModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private readonly models: string[],
		private readonly onPick: (model: string) => void,
	) {
		super(app);
		this.setPlaceholder('搜索上游返回的模型名');
	}

	getItems(): string[] {
		return this.models;
	}

	getItemText(model: string): string {
		return model;
	}

	onChooseItem(model: string): void {
		this.onPick(model);
	}
}
