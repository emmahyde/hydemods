export function referenceLocations(value: unknown): { locations: { path: string; line: number; column: number }[]; incomplete: boolean } | undefined {
	let text: unknown = value;
	let truncated = false;
	if (value && typeof value === "object") {
		if ("text" in value) text = value.text;
		else if ("preview" in value && typeof value.preview === "string" && "truncated" in value && value.truncated === true) {
			truncated = true;
			const field = /^\s*\{\s*"text"\s*:\s*"((?:\\[^\r\n]|[^"\\\r\n])*)/.exec(value.preview);
			if (!field) return undefined;
			try { text = JSON.parse(`"${field[1]}"`); } catch { return undefined; }
		}
	}
	if (typeof text !== "string") return undefined;
	const heading = /^Found (\d+) reference\(s\):\r?\n/.exec(text);
	if (!heading) return undefined;
	const locations = [...text.matchAll(/^ {2}([^\s\x00-\x1f\x7f][^\r\n\x00-\x1f\x7f]*):(\d+):(\d+)\s*$/gm)]
		.map(([, path, line, column]) => ({ path, line: Number(line), column: Number(column) }));
	if (locations.length === 0) return undefined;
	return { locations, incomplete: truncated || locations.length < Number(heading[1]) };
}
