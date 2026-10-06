import { describe, expect, it } from 'vitest';
import {
	insertBeforeFirstNativeControl,
	isButtonBeforeFirstNativeControl,
	isNativeBilibiliControl,
} from '../extension/src/control-layout';

const GLEAN = 'glean-sync-button';
const native = (id: string) => ({ id, className: 'bpx-player-ctrl-btn' });
const external = (id: string) => ({ id, className: 'external-control' });

describe('extension control layout', () => {
	it('recognizes only Bilibili native control items', () => {
		expect(isNativeBilibiliControl(native('quality'), GLEAN)).toBe(true);
		expect(isNativeBilibiliControl(external('immersive'), GLEAN)).toBe(false);
		expect(isNativeBilibiliControl(native(GLEAN), GLEAN)).toBe(false);
	});

	it('keeps Immersive Translate before Glean and Glean before native controls', () => {
		const children = [external('immersive'), native('quality'), native('rate')];
		expect(insertBeforeFirstNativeControl(children, { id: GLEAN }, GLEAN).map((child) => child.id)).toEqual([
			'immersive',
			GLEAN,
			'quality',
			'rate',
		]);
	});

	it('does not duplicate or move the button when the order is already correct', () => {
		const children = [external('immersive'), { id: GLEAN }, native('quality')];
		expect(isButtonBeforeFirstNativeControl(children, GLEAN)).toBe(true);
		expect(insertBeforeFirstNativeControl(children, { id: GLEAN }, GLEAN)).toEqual(children);
	});

	it('appends Glean when the player has not mounted native controls yet', () => {
		const children = [external('immersive')];
		expect(insertBeforeFirstNativeControl(children, { id: GLEAN }, GLEAN).map((child) => child.id)).toEqual([
			'immersive',
			GLEAN,
		]);
	});
});
