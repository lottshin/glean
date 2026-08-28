export function siblingSubtitlePaths(folder: string, stem: string): string[] {
	const names = [
		`${stem}.srt`,
		`${stem}.vtt`,
		`${stem}.en.srt`,
		`${stem}.en.vtt`,
		`${stem}.zh.srt`,
		`${stem}.en-US.srt`,
	];
	const prefix = folder === '' || folder === '/' ? '' : `${folder}/`;
	return names.map((name) => `${prefix}${name}`);
}
