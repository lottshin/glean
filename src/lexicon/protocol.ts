export interface EchoProtocolTarget {
	sourcePath: string;
	time: number;
}

export function parseEchoProtocol(parameters: Record<string, string>): EchoProtocolTarget | null {
	const sourcePath = parameters.src?.trim();
	const time = Number(parameters.t);
	if (!sourcePath || !Number.isFinite(time) || time < 0) {
		return null;
	}
	return { sourcePath, time };
}
