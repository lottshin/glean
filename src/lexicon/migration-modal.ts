import { Modal, Setting, type App } from 'obsidian';
import type { LexiconMigrationPlan } from './store';

export class LexiconMigrationModal extends Modal {
	constructor(
		app: App,
		private readonly plan: LexiconMigrationPlan,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('整理 Echo 生词目录');
		const { contentEl } = this;
		contentEl.createEl('p', {
			text: `将移动 ${this.plan.moves.length} 个生词文件到首字母目录。`,
		});
		if (this.plan.conflicts.length > 0) {
			contentEl.createEl('p', {
				cls: 'mod-warning',
				text: `${this.plan.conflicts.length} 个文件存在目标冲突，将保持原位并写入报告。`,
			});
		}
		contentEl.createEl('p', {
			text: '整理会改变文件路径，并可能触发同步。请先确认其他设备已完成同步。',
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('取消').onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText('开始整理')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						await this.onConfirm();
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
