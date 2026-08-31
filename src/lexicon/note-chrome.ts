import { MarkdownView, TFile } from 'obsidian';
import type EchoPlugin from '../main';

const ACTION_CLASS = 'echo-word-note-action';
const TOOLBAR_CLASS = 'echo-word-note-toolbar';

/**
 * Visible remove affordances for Echo word notes: a header action and a
 * reading/preview toolbar. Commands and file menus stay available too.
 */
export function registerWordNoteChrome(plugin: EchoPlugin): void {
	const syncHeaderAction = () => {
		for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			clearHeaderAction(view);
			clearBodyToolbar(view);
			const file = view.file;
			if (!file || !plugin.isWordNote(file)) {
				continue;
			}
			const button = view.addAction('trash', '移出生词', () => {
				void plugin.removeWordFile(file);
			});
			button.addClass(ACTION_CLASS);
			syncBodyToolbar(view, file, plugin);
		}
	};

	plugin.registerEvent(plugin.app.workspace.on('file-open', syncHeaderAction));
	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', syncHeaderAction));
	plugin.registerEvent(plugin.app.workspace.on('layout-change', syncHeaderAction));
	plugin.app.workspace.onLayoutReady(syncHeaderAction);

	plugin.registerMarkdownPostProcessor((_element, context) => {
		const file = plugin.app.vault.getAbstractFileByPath(context.sourcePath);
		if (!(file instanceof TFile) || !plugin.isWordNote(file)) {
			return;
		}
		window.setTimeout(syncHeaderAction, 0);
	});
}

function clearHeaderAction(view: MarkdownView): void {
	view.containerEl
		.querySelectorAll(`.view-actions .${ACTION_CLASS}`)
		.forEach((node) => node.remove());
}

function clearBodyToolbar(view: MarkdownView): void {
	view.containerEl
		.querySelectorAll(`.${TOOLBAR_CLASS}`)
		.forEach((node) => node.remove());
}

function syncBodyToolbar(
	view: MarkdownView,
	file: TFile,
	plugin: EchoPlugin,
): void {
	if (view.getMode() !== 'preview') {
		return;
	}
	const host = view.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
	if (!host) {
		return;
	}
	const toolbar = host.createDiv({ cls: TOOLBAR_CLASS });
	host.prepend(toolbar);
	toolbar.createDiv({
		cls: 'echo-word-note-toolbar-label',
		text: 'Echo 生词',
	});
	const remove = toolbar.createEl('button', {
		cls: 'echo-btn echo-word-note-toolbar-remove',
		text: '移出生词',
	});
	remove.addEventListener('click', (event) => {
		event.preventDefault();
		void plugin.removeWordFile(file);
	});
}
