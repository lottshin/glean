import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const distDir = path.join(root, 'extension', 'dist');
const releaseDir = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const archive = path.join(releaseDir, `glean-capture-${manifest.version}.zip`);

await execFileAsync(process.execPath, ['extension/esbuild.mjs'], { cwd: root });
await mkdir(releaseDir, { recursive: true });
await rm(archive, { force: true });
await execFileAsync(
	'zip',
	['-r', archive, '.', '-x', '*.map', '-x', '*.DS_Store'],
	{ cwd: distDir },
);

console.log(`extension package → ${archive}`);
