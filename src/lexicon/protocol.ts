import { parseBilibiliSourcePath } from '../bilibili/id';
import { parseYouTubeSourcePath } from '../youtube/id';

export interface GleanProtocolTarget {
	sourcePath: string;
	time: number;
	kind: 'local' | 'youtube' | 'bilibili';
	videoId?: string;
	bvid?: string;
}

export function parseGleanProtocol(parameters: Record<string, string>): GleanProtocolTarget | null {
	const sourcePath = parameters.src?.trim();
	const time = Number(parameters.t);
	if (!sourcePath || !Number.isFinite(time) || time < 0) {
		return null;
	}
	const videoId = parseYouTubeSourcePath(sourcePath);
	if (videoId) {
		return { sourcePath, time, kind: 'youtube', videoId };
	}
	const bvid = parseBilibiliSourcePath(sourcePath);
	if (bvid) {
		return { sourcePath, time, kind: 'bilibili', bvid };
	}
	return { sourcePath, time, kind: 'local' };
}
