import { parseYouTubeSourcePath } from '../youtube/id';

export interface GleanProtocolTarget {
	sourcePath: string;
	time: number;
	kind: 'local' | 'youtube';
	videoId?: string;
}

export function parseGleanProtocol(parameters: Record<string, string>): GleanProtocolTarget | null {
	const sourcePath = parameters.src?.trim();
	const time = Number(parameters.t);
	if (!sourcePath || !Number.isFinite(time) || time < 0) {
		return null;
	}
	const videoId = parseYouTubeSourcePath(sourcePath);
	return videoId
		? { sourcePath, time, kind: 'youtube', videoId }
		: { sourcePath, time, kind: 'local' };
}
