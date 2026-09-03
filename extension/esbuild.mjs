import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'extension', 'dist');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: {
		content: path.join(root, 'extension/src/content.ts'),
		'bilibili-content': path.join(root, 'extension/src/bilibili-content.ts'),
		background: path.join(root, 'extension/src/background.ts'),
		popup: path.join(root, 'extension/src/popup.ts'),
		'page-bridge': path.join(root, 'extension/src/page-bridge.ts'),
	},
	bundle: true,
	outdir,
	format: 'esm',
	target: ['chrome110'],
	sourcemap: true,
	logLevel: 'info',
});

await cp(path.join(root, 'extension/manifest.json'), path.join(outdir, 'manifest.json'));
await cp(path.join(root, 'extension/src/popup.html'), path.join(outdir, 'popup.html'));
await cp(path.join(root, 'extension/src/popup.css'), path.join(outdir, 'popup.css'));
await cp(path.join(root, 'extension/src/content.css'), path.join(outdir, 'content.css'));
// PNGs only — the SVG master stays in the repo and is not shipped.
await cp(path.join(root, 'extension/icons'), path.join(outdir, 'icons'), {
	recursive: true,
	filter: (src) => !src.endsWith('.svg'),
});

console.log(`extension built → ${outdir}`);
