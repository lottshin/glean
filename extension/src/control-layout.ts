export interface ControlChildShape {
	id?: string;
	className?: string;
}

export function isNativeBilibiliControl(
	child: ControlChildShape,
	buttonId: string,
): boolean {
	return (
		child.id !== buttonId &&
		child.className?.split(/\s+/).includes('bpx-player-ctrl-btn') === true
	);
}

/** Keep third-party controls where they are; insert Glean before Bilibili's group. */
export function insertBeforeFirstNativeControl(
	children: readonly ControlChildShape[],
	button: ControlChildShape,
	buttonId: string,
): ControlChildShape[] {
	const withoutButton = children.filter((child) => child.id !== buttonId);
	const nativeIndex = withoutButton.findIndex((child) =>
		isNativeBilibiliControl(child, buttonId),
	);
	const insertAt = nativeIndex < 0 ? withoutButton.length : nativeIndex;
	return [
		...withoutButton.slice(0, insertAt),
		button,
		...withoutButton.slice(insertAt),
	];
}

export function isButtonBeforeFirstNativeControl(
	children: readonly ControlChildShape[],
	buttonId: string,
): boolean {
	const expected = insertBeforeFirstNativeControl(
		children,
		{ id: buttonId },
		buttonId,
	).map((child) => child.id);
	return children.map((child) => child.id).join('\u0000') === expected.join('\u0000');
}
