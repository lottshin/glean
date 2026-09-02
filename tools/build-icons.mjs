/**
 * Rasterises the Glean app icon master into the PNG sizes Chrome asks for.
 *
 * Kept out of `extension:build` on purpose: the PNGs are committed, so a normal
 * build needs neither `sharp` nor a network round trip. Re-run this by hand
 * (`npm run icons:build`) whenever `extension/icons/icon.svg` changes.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'extension', 'icons');
const master = path.join(iconsDir, 'icon.svg');

/** 16 = toolbar, 32 = Windows tray/HiDPI toolbar, 48 = extensions page, 128 = store. */
const SIZES = [16, 32, 48, 128];
/** Side-by-side sheet for design review; not shipped with the extension. */
const PREVIEW = path.join(root, 'docs', 'assets', 'extension-icon-preview.png');

const svg = await readFile(master);

/**
 * Renders at 4x and Lanczos-downsamples. Rasterising straight to 16px drops the
 * thinner grain edges; supersampling keeps them as soft pixels instead.
 */
async function render(size) {
	return sharp(svg, { density: (72 * size * 4) / 128 })
		.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png({ compressionLevel: 9 })
		.toBuffer();
}

await mkdir(path.dirname(PREVIEW), { recursive: true });

for (const size of SIZES) {
	const png = await render(size);
	await writeFile(path.join(iconsDir, `icon-${size}.png`), png);
	console.log(`icon-${size}.png  ${png.length} B`);
}

// Preview sheet: every shipped size on a neutral card, plus the 128 at 2x.
const gap = 24;
const pad = 32;
const cells = [...SIZES, 128];
const width = pad * 2 + cells.reduce((sum, s) => sum + s, 0) + gap * (cells.length - 1);
const height = pad * 2 + 128;

let x = pad;
const composites = [];
for (const size of cells) {
	composites.push({
		input: await render(size),
		left: Math.round(x),
		top: Math.round(pad + (128 - size) / 2),
	});
	x += size + gap;
}

await sharp({
	create: {
		width,
		height,
		channels: 4,
		background: { r: 244, g: 244, b: 246, alpha: 1 },
	},
})
	.composite(composites)
	.png()
	.toFile(PREVIEW);

console.log(`preview → ${path.relative(process.cwd(), PREVIEW)}`);
