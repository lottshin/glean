export interface GleanProtocolTarget {
	sourcePath: string;
	time: number;
}

export function parseGleanProtocol(parameters: Record<string, string>): GleanProtocolTarget | null {
	const sourcePath = parameters.src?.trim();
	const time = Number(parameters.t);
	if (!sourcePath || !Number.isFinite(time) || time < 0) {
		return null;
	}
	return { sourcePath, time };
}
