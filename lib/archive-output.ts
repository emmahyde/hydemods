// Printed forms of the OMP `archive` prelude (projects, sessions, prompts/search, recaps, one session).
// The API prints plain listings; these parsers recover only what those exact layouts state, so
// unrecognised text stays prose and nothing is invented.

export type ArchiveSegment =
	| { kind: "prose"; text: string }
	| { kind: "archive"; text: string; value: Record<string, unknown> };

const FACT_SEPARATOR = " · ";
const LISTING_HEADER = /^(?:Recent projects|Sessions|Prompts|Recaps)\b.*, newest first:$/;
const SESSION_HEADER = /^Session (\S+) · (.+)$/;
const SESSION_FACTS = /^project .+ · created .+/;
const PROMPTS_HEADER = /^Prompts, (?:latest (\d+), )?oldest first:$/;

// Entries are `- facts` rows, each followed by indented detail rows; returns the line after the block.
function listing(lines: string[], start: number): { end: number; value: Record<string, unknown> } | undefined {
	const entries: Array<Record<string, unknown>> = [];
	let at = start + 1;
	while (at < lines.length && lines[at].startsWith("- ")) {
		const detail: string[] = [];
		const entry: Record<string, unknown> = { facts: lines[at].slice(2).split(FACT_SEPARATOR) };
		at++;
		while (at < lines.length && /^ {2}\S/.test(lines[at])) detail.push(lines[at++].trim());
		if (detail.length) entry.detail = detail.length === 1 ? detail[0] : detail;
		entries.push(entry);
	}
	if (entries.length === 0) return undefined;
	return { end: at, value: { view: lines[start].slice(0, -1), entries } };
}

function bullets(lines: string[], start: number): { end: number; rows: unknown[] } {
	const rows: unknown[] = [];
	let at = start;
	for (; at < lines.length && lines[at].startsWith("- "); at++) {
		const row = /^- (.+?): (.*)$/.exec(lines[at]);
		rows.push(row ? { at: row[1], text: row[2] } : lines[at].slice(2));
	}
	return { end: at, rows };
}

function sessionDetail(lines: string[], start: number): { end: number; value: Record<string, unknown> } | undefined {
	const header = SESSION_HEADER.exec(lines[start]);
	const factsLine = lines[start + 1];
	const file = /^file (.+)$/.exec(lines[start + 2] ?? "");
	if (!header || factsLine === undefined || !SESSION_FACTS.test(factsLine) || !file) return undefined;
	const session: Record<string, unknown> = { id: header[1], title: header[2], facts: factsLine.split(FACT_SEPARATOR), file: file[1] };
	let at = start + 3;
	const parent = /^forked from (.+)$/.exec(lines[at] ?? "");
	if (parent) { session.forked_from = parent[1]; at++; }
	const value: Record<string, unknown> = { session };
	if (lines[at] === "") at++;
	if (lines[at] === "No recaps journaled.") { value.recaps = lines[at++]; }
	else if (lines[at] === "Recaps, oldest first:") {
		const recaps = bullets(lines, at + 1);
		if (recaps.rows.length > 0) { value.recaps = recaps.rows; at = recaps.end; }
	}
	if (lines[at] === "No prompts in prompt history.") { value.prompts = lines[at++]; }
	else {
		const prompts = PROMPTS_HEADER.exec(lines[at] ?? "");
		if (prompts) {
			const rows = bullets(lines, at + 1);
			if (rows.rows.length > 0) {
				if (prompts[1]) value.prompts_latest = Number(prompts[1]);
				value.prompts = rows.rows;
				at = rows.end;
			}
		}
	}
	return { end: at, value };
}

/** Splits printed output into archive blocks and the prose around them; segment texts concatenate to the input. */
export function splitArchiveOutput(text: string): ArchiveSegment[] {
	const lines = text.split("\n");
	const segments: ArchiveSegment[] = [];
	let proseStart = 0;
	const flushProse = (end: number) => {
		if (end > proseStart) segments.push({ kind: "prose", text: lines.slice(proseStart, end).join("\n") + "\n" });
	};
	for (let at = 0; at < lines.length;) {
		const parsed = LISTING_HEADER.test(lines[at]) ? listing(lines, at) : SESSION_HEADER.test(lines[at]) ? sessionDetail(lines, at) : undefined;
		if (!parsed) { at++; continue; }
		flushProse(at);
		const last = parsed.end >= lines.length;
		segments.push({ kind: "archive", text: lines.slice(at, parsed.end).join("\n") + (last ? "" : "\n"), value: parsed.value });
		at = proseStart = parsed.end;
	}
	if (segments.length === 0) return [{ kind: "prose", text }];
	if (proseStart < lines.length) segments.push({ kind: "prose", text: lines.slice(proseStart).join("\n") });
	return segments;
}
