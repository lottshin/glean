import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseName = 'glean-site-20260922';
const outputRoot = path.join(repositoryRoot, 'output');
const releaseDirectory = path.join(outputRoot, releaseName);
const archivePath = path.join(outputRoot, `${releaseName}.zip`);

const assetFiles = [
	'PixPin_2026-09-15_11-26-22.png',
	'PixPin_2026-09-15_11-27-59.png',
	'glean-listen.png',
	'glean-reading-hero.webp',
	'harvest-wheat.svg',
	'paper-grain.svg',
];

await rm(releaseDirectory, { recursive: true, force: true });
await rm(archivePath, { force: true });
await Promise.all([
	mkdir(path.join(releaseDirectory, 'assets'), { recursive: true }),
	mkdir(path.join(releaseDirectory, 'icons'), { recursive: true }),
	mkdir(path.join(releaseDirectory, 'downloads'), { recursive: true }),
]);

let html = await readFile(path.join(repositoryRoot, 'promo', 'index.html'), 'utf8');
const replacements = [
	['../extension/icons/icon-32.png', 'icons/icon-32.png'],
	['../extension/icons/icon.svg', 'icons/icon.svg'],
	['../dist/glean-0.0.1-test-20260914.zip', 'downloads/glean-0.0.1-test-20260914.zip'],
];

for (const [source, destination] of replacements) {
	if (!html.includes(source)) {
		throw new Error(`Expected deployment path is missing from promo/index.html: ${source}`);
	}
	html = html.replaceAll(source, destination);
}

await writeFile(path.join(releaseDirectory, 'index.html'), html);
await Promise.all([
	copyFile(path.join(repositoryRoot, 'promo', 'styles.css'), path.join(releaseDirectory, 'styles.css')),
	copyFile(path.join(repositoryRoot, 'promo', 'script.js'), path.join(releaseDirectory, 'script.js')),
	copyFile(path.join(repositoryRoot, 'extension', 'icons', 'icon.svg'), path.join(releaseDirectory, 'icons', 'icon.svg')),
	copyFile(path.join(repositoryRoot, 'extension', 'icons', 'icon-32.png'), path.join(releaseDirectory, 'icons', 'icon-32.png')),
	copyFile(
		path.join(repositoryRoot, 'dist', 'glean-0.0.1-test-20260914.zip'),
		path.join(releaseDirectory, 'downloads', 'glean-0.0.1-test-20260914.zip'),
	),
	...assetFiles.map((file) =>
		copyFile(
			path.join(repositoryRoot, 'promo', 'assets', file),
			path.join(releaseDirectory, 'assets', file),
		),
	),
]);

execFileSync('zip', ['-q', '-r', archivePath, '.'], { cwd: releaseDirectory });
const archive = await readFile(archivePath);
const checksum = createHash('sha256').update(archive).digest('hex');
await writeFile(path.join(outputRoot, `${releaseName}.sha256`), `${checksum}  ${releaseName}.zip\n`);

console.log(releaseDirectory);
console.log(archivePath);
console.log(`sha256 ${checksum}`);
