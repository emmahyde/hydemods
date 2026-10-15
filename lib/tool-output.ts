import { encode } from "@toon-format/toon";
import { parse as parseYaml } from "yaml";

/** Nesting and string size past which re-parsing a string value can only misstate its type. */
const MAX_NESTED_JSON_DEPTH = 4;
const MAX_NESTED_JSON_STRING = 64 * 1024;

/** Hydemods re-parses, colours and Markdown-renders a payload on every repaint; above this
 * size the native card takes over, since it already has its own limits. */
export const MAX_RENDER_BYTES = 256 * 1024;

/**
 * Tool output is untrusted, and it reaches the terminal through coloured card lines: OSC 0/2
 * (title), OSC 8 (links) and OSC 52 (clipboard), cursor moves and C0 controls must not survive.
 * SGR (`\x1b[...m`) stays — that is the colour the renderer itself writes.
 */
export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|(?=\x1b)|$)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, sequence => sequence.endsWith("m") ? sequence : "")
		.replace(/\x1b(?![\[\]])[\s\S]?/g, "")
		.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}

/** The payload hydemods may render, or undefined when it is past `MAX_RENDER_BYTES`. */
export function cappedRenderPayload<T>(value: T): T | undefined {
	let bytes: number;
	if (typeof value === "string") bytes = Buffer.byteLength(value, "utf8");
	else if (value === null || value === undefined) bytes = 0;
	else if (typeof value === "object") {
		try {
			bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
		} catch {
			bytes = Number.POSITIVE_INFINITY;
		}
	} else bytes = String(value).length;
	return bytes > MAX_RENDER_BYTES ? undefined : value;
}

/**
 * Keep a bounded preview while retaining every line when the host requests expansion. By default
 * the first rows are followed by a `… N more` row and the last row. With `options.marker`, the
 * full budget goes to content and the marker is appended to the last shown row instead.
 */
export function collapseTextLines(
	lines: string[],
	limit: number,
	expanded: boolean,
	options: { marker?: string | (() => string) } = {},
): string[] {
	if (options.marker !== undefined) {
		const count = Math.max(1, Math.floor(limit));
		if (expanded || lines.length <= count) return lines;
		const marker = typeof options.marker === "function" ? options.marker() : options.marker;
		const shown = lines.slice(0, count);
		const last = shown[shown.length - 1];
		shown[shown.length - 1] = last.trimEnd() ? `${last.trimEnd()} ${marker}` : marker;
		return shown;
	}
	if (expanded || lines.length <= limit) return lines;
	if (limit <= 1) return [`${lines[0] ?? ""} …`];
	if (limit < 3) return [...lines.slice(0, limit - 1), `… ${lines.length - (limit - 1)} more`];
	const head = limit - 2;
	return [...lines.slice(0, head), `… ${lines.length - head - 1} more`, lines[lines.length - 1]];
}

/**
 * The parsed document when `text` is a YAML mapping or sequence worth re-encoding, otherwise
 * undefined. A single `key: value` line, a collection of prose lines, or anything with a
 * sentence-like line stays text: a YAML round-trip reorders keys and requotes scalars, which
 * must never happen to output that was not written as YAML.
 */
export function parseYamlDocument(text: string): unknown | undefined {
	if (!/^(?:---|[a-zA-Z0-9_.-]+:|\s*-)/m.test(text)) return undefined;
	const prose = text.split(/\r?\n/).some(line => {
		const trimmed = line.trim();
		return (trimmed.length > 100 && !trimmed.includes(":")) || trimmed.endsWith(".");
	});
	if (prose) return undefined;
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const entries = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
	return entries >= 2 ? parsed : undefined;
}

function parseJsonDocuments(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
		if (lines.length < 2) throw error;
		// JSON Lines is complete only when every record parses; never drop a bad row.
		return lines.map(line => JSON.parse(line));
	}
}

const GENERATED_NOTICE_FOOTER = /(?:\r?\n)+\[(?:Showing (?:lines \d+(?:-\d+)?|\d+|line \d+|head and tail bytes) of [\d,]+|\d+ (?:matches|results) limit reached|Some lines truncated to \d+|Full output was not saved|raw output: artifact:\/\/\d+|Source: artifact:\/\/\d+)[^\]\r\n]*\]\s*$/;

export function separateGeneratedNoticeFooter(text: string): { body: string; footer: string } {
	let current = text;
	let footers = "";
	while (true) {
		const match = GENERATED_NOTICE_FOOTER.exec(current);
		if (!match) break;
		footers = match[0] + footers;
		current = current.slice(0, match.index);
	}
	return { body: current, footer: footers };
}

export function stripGeneratedNoticeFooter(text: string): string {
	return separateGeneratedNoticeFooter(text).body;
}

export function decodeNestedJson(value: unknown, depth = 0): unknown {
	if (depth >= MAX_NESTED_JSON_DEPTH) return value;
	if (isTruncatedPreview(value) || artifactPreview(value) || isCommandResult(value)) return value;
	if (typeof value === "string") {
		// A huge string is never a readable document, and re-parsing it can only misstate it.
		if (value.length > MAX_NESTED_JSON_STRING) return value;
		let text = stripGeneratedNoticeFooter(value.trim()).replace(/^display\[\d+\]:\s*/, "");
		const fencedMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
		if (fencedMatch && /^[\[{]/.test(fencedMatch[1].trim())) {
			text = fencedMatch[1].trim();
		}
		if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"') || (/^(?:-?\d|true\b|false\b|null\b)/.test(text) && /[\r\n]/.test(text))) {
			try {
				const parsed = parseJsonDocuments(text);
				if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
					const decoded = decodeNestedJson(parsed, depth + 1);
					if (decoded !== null && typeof decoded === "object") return decoded;
				}
			} catch {
				// Incomplete JSON and ordinary text must remain unchanged.
			}
		}
		return value;
	}
	if (Array.isArray(value)) return value.map(item => decodeNestedJson(item, depth + 1));
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNestedJson(item, depth + 1)]));
	}
	return value;
}

function isTruncatedPreview(value: unknown): value is { preview: string; truncated: true; totalBytes: number } {
	return value !== null && typeof value === "object" &&
		"preview" in value && typeof value.preview === "string" &&
		"truncated" in value && value.truncated === true &&
		"totalBytes" in value && typeof value.totalBytes === "number" &&
		Object.keys(value).every(key => ["preview", "truncated", "totalBytes"].includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type CommandResult = Record<string, unknown> & { text: string };

function isCommandResult(value: unknown): value is CommandResult {
	if (!isRecord(value) || typeof value.text !== "string") return false;
	const details = value.details;
	return (isRecord(details) && ["exitCode", "wallTimeMs", "timeoutSeconds"].some(key => typeof details[key] === "number")) ||
		(typeof value.hasError === "boolean" && splitCommandFooter(value.text) !== undefined);
}

function splitCommandFooter(text: string) {
	const match = /^([\s\S]*?)(?:\r?\n|^)([ \t]*Wall time: (\d+(?:\.\d+)?) seconds(?:\s*\r?\n[ \t]*Command exited with code (-?\d+))?[ \t\r\n]*)$/.exec(text);
	if (!match) return;
	return {
		body: match[1].replace(/(?:\r?\n[ \t]*)+$/, ""),
		text: match[2].trim(),
		seconds: Number(match[3]),
		exitCode: match[4] === undefined ? undefined : Number(match[4]),
	};
}

function formatCommandResult(value: CommandResult, label = "Result", useToon = true): { text: string; format: "command" } {
	const details = isRecord(value.details) ? value.details : {};
	const text = sanitizeTerminalText(value.text);
	const footer = splitCommandFooter(text);
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : footer?.exitCode;
	const seconds = typeof details.wallTimeMs === "number" ? details.wallTimeMs / 1000 : footer?.seconds;
	const status = value.hasError === true || (exitCode !== undefined && exitCode !== 0) ? "failed"
		: exitCode === 0 ? "succeeded" : undefined;
	const heading = [label];
	if (status) heading.push(status);
	if (exitCode !== undefined) heading.push(`exit ${exitCode}`);
	if (seconds !== undefined) heading.push(`${Number(seconds.toFixed(2))} s`);
	if (typeof details.timeoutSeconds === "number") heading.push(`timeout ${details.timeoutSeconds} s`);
	const source = footer?.body ?? text;
	const decoded = decodeNestedJson(source);
	const body = typeof decoded === "string" ? decoded : formatJsonOutput(decoded, useToon).text;
	const extra = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "text" && key !== "details" && !(key === "hasError" && typeof value.hasError === "boolean")));
	const remainingDetails = Object.fromEntries(Object.entries(details).filter(([key, item]) =>
		!["exitCode", "wallTimeMs", "timeoutSeconds"].includes(key) || typeof item !== "number"));
	if (Object.keys(remainingDetails).length) extra.details = remainingDetails;
	if (value.details !== undefined && !isRecord(value.details)) extra.details = value.details;
	// Keep conflicting footer data rather than silently choosing one report.
	if (footer && ((footer.exitCode !== undefined && footer.exitCode !== exitCode) ||
		(seconds !== undefined && Math.abs(footer.seconds - seconds) > 0.01))) extra.footer = footer.text;
	const metadata = Object.keys(extra).length ? `\n\nMetadata:\n${formatJsonOutput(extra, useToon).text}` : "";
	return { text: `${heading.join("; ")}\n${body || "(no output)"}${metadata}`, format: "command" };
}

/**
 * A shell result whose body is plain text: `Result; exit N; T s` heading from the Wall-time
 * footer, then the body verbatim. Undefined without the footer, since then there is nothing
 * to lift out of the text.
 */
export function formatCommandText(text: string): { text: string; format: "command" } | undefined {
	const footer = splitCommandFooter(text);
	if (!footer) return;
	const heading = ["Result"];
	if (footer.exitCode !== undefined) heading.push(footer.exitCode === 0 ? "succeeded" : "failed", `exit ${footer.exitCode}`);
	heading.push(`${Number(footer.seconds.toFixed(2))} s`);
	return { text: `${heading.join("; ")}\n${footer.body || "(no output)"}`, format: "command" };
}


function artifactPreview(value: unknown) {
	if (!isRecord(value) || typeof value.text !== "string" || !isRecord(value.details)) return;
	const { details } = value;
	const display = details.displayContent;
	const meta = details.meta;
	if (!isRecord(display) || display.text !== value.text || !isRecord(meta) || !isRecord(meta.source)) return;
	if (meta.source.type !== "internal" || typeof meta.source.value !== "string" || !meta.source.value.startsWith("artifact://")) return;
	const notes = [`Source: ${meta.source.value}`];
	if (typeof display.startLine === "number") notes.push(`page starts at line ${display.startLine}`);
	if (typeof details.totalLines === "number") notes.push(`total lines: ${details.totalLines}`);
	const limits = meta.limits;
	if (isRecord(limits) && isRecord(limits.columnTruncated) && typeof limits.columnTruncated.maxColumn === "number") {
		notes.push(`source lines clipped at ${limits.columnTruncated.maxColumn} ${typeof limits.columnTruncated.unit === "string" ? limits.columnTruncated.unit : "columns"}`);
	}
	return { text: value.text, notice: `[${notes.join("; ")}]` };
}

function isMultilineJson(value: unknown): value is string {
	return typeof value === "string" && /^\s*(?:[\[{]|"(?:\\.|[^"\\])*"\s*:|display\[\d+\]:)/.test(value) && /[\r\n]/.test(value);
}

function needsTextLayout(value: unknown): boolean {
	if (isTruncatedPreview(value) || artifactPreview(value) || isMultilineJson(value) || isCommandResult(value)) return true;
	if (typeof value === "string" && formatSearchOutput(value) !== undefined) return true;
	if (markdownOutput(value) !== undefined) return true;
	return value !== null && typeof value === "object" && Object.values(value).some(needsTextLayout);
}

export function isFileExcerpt(text: string): boolean {
	return /^(?:\[[^\]\r\n]+#[\da-f]+\]|#{1,6} [^\r\n]+#[\da-f]+)\r?$/im.test(text);
}

export function markdownOutput(value: unknown): string | undefined {
	if (isCommandResult(value)) return;
	if (isTruncatedPreview(value)) {
		const body = markdownOutput(previewText(value.preview) ?? value.preview);
		return body === undefined ? undefined : `${body}\n\n[truncated; original size: ${value.totalBytes} bytes]`;
	}
	const artifact = artifactPreview(value);
	const raw = typeof value === "string" ? value : isRecord(value) && typeof value.text === "string" ? value.text : undefined;
	if (raw === undefined) return;
	const text = sanitizeTerminalText(raw);
	if (formatSearchOutput(text) !== undefined) return;
	let body = text;
	if (isFileExcerpt(text)) {
		const headers = text.match(/^(?:\[[^\]\r\n]+#[\da-f]+\]|#{1,6} [^\r\n]+#[\da-f]+)\r?$/gim) ?? [];
		if (!headers.every(header => /\.(?:md|markdown)#[\da-f]+\]?\r?$/i.test(header))) return;
		body = stripSourceLineNumbers(text);
	} else {
		if (/^\s*(?:\{|\[\s*(?:\r?\n|[\[{"\d])|"(?:\\.|[^"\\])*"\s*:|display\[\d+\]:)/.test(text)) return;
		const block = /^(?:[ \t]{0,3}#{1,6}\s+\S|[ \t]{0,3}(?:`{3,}|~{3,})|[ \t]{0,3}>[ \t]+\S)/m;
		const list = /(?:^|\r?\n[ \t]*\r?\n)[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+\S/;
		const table = /^.*\|.*\r?\n[ \t]*\|?[ \t]*:?-{3,}.*\|/m;
		const inline = /(?:\*\*[^\r\n]+\*\*|\[[^\]\r\n]+\]\([^\s)]+\))/;
		const setext = /^[^\r\n]+\r?\n[ \t]{0,3}(?:={3,}|-{3,})[ \t]*$/m;
		if (!block.test(text) && !list.test(text) && !table.test(text) && !inline.test(text) && !setext.test(text)) return;
	}
	return artifact ? `${body}\n\n${artifact.notice}` : body;
}

export function formatSearchOutput(text: string): string | undefined {
	if (!/^\d+ hit\(s\) for .+ in .+/m.test(text)) return;
	return text.replace(
		/^([ \t]*)([^\r\n]+:\d+(?:-\d+)?)[ \t]+(\d+\.\d+)[ \t]+([^\r\n]*)/gm,
		(_match, indent: string, path: string, score: string, excerpt: string) => `${indent}${path}  [score ${score}]\n${indent}  ${excerpt}`,
	);
}
/**
 * Attempts to parse tabular text (CSV, TSV, or whitespace-aligned fixed-width columns)
 * into an array of objects. Returns undefined if the text is not clearly tabular.
 */
export function parseTabularData(text: string): Record<string, string>[] | undefined {
	const clean = text.trim();
	if (!clean) return undefined;
	const lines = clean.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
	if (lines.length < 2) return undefined;

	// Helper to check if a token looks like a valid column header label
	const isLikelyHeaderToken = (token: string, mode: "csv" | "tsv" | "fixed"): boolean => {
		const t = token.trim();
		if (!t || t.length > 64) return false;
		// Must contain at least one letter
		if (!/[a-zA-Z]/.test(t)) return false;
		// Reject exclamation/question marks typical of prose/errors
		if (/[!?]/.test(t)) return false;
		// Reject tokens containing colons (e.g. "warning: x is deprecated", "note: see docs")
		if (t.includes(":")) return false;

		// Prose guard: column headers are concise labels/phrases (<= 4 words), not sentences
		const words = t.split(/\s+/).filter(Boolean);
		if (words.length > 4) return false;

		// For TSV and fixed-width tables, reject trailing dots
		if (mode !== "csv" && t.endsWith(".")) return false;

		// Reject file size / numeric unit strings: e.g. 4.0K, 100M, 12B, 10ms, 5s
		if (/^-?\d+(?:\.\d+)?[a-zA-Z]{1,3}$/.test(t)) return false;
		// Reject file paths or files with extensions in fixed-width / TSV tables (e.g. README.md, lib/x.ts)
		// Dotted keys like user.id in CSV are preserved
		if (t.includes("/") || t.includes("\\")) {
			if (!/^[A-Z0-9_]+(?:\/[A-Z0-9_]+)+$/.test(t)) {
				return false;
			}
		}
		if (mode !== "csv" && /\.[a-zA-Z0-9]{1,5}$/.test(t)) {
			return false;
		}
		// Reject short status codes like git status flags (M, A, D, R, C, U, ??, !!)
		if (/^[MADRCU?!]{1,2}$/.test(t)) return false;
		return true;
	};

	const isNumOrSize = (s: string): boolean => /^-?\d+(?:\.\d+)?(?:[a-zA-Z]{1,3})?$/.test(s.trim());
	const isPathOrFile = (s: string): boolean => {
		const t = s.trim();
		if (/^[A-Z0-9_]+(?:\/[A-Z0-9_]+)+$/.test(t)) return false;
		return t.includes("/") || t.includes("\\") || /\.[a-zA-Z0-9]{1,5}$/.test(t);
	};

	// Check if a header token matches data patterns found in subsequent rows of the same column
	const headerMatchesDataColumn = (headerToken: string, colIndex: number, dataRows: string[][]): boolean => {
		const h = headerToken.trim();
		if (dataRows.some(row => row[colIndex] !== undefined && row[colIndex].trim() === h)) {
			return true;
		}
		if (isNumOrSize(h) && dataRows.length > 0 && dataRows.every(row => row[colIndex] && isNumOrSize(row[colIndex]))) {
			return true;
		}
		if (isPathOrFile(h) && dataRows.length > 0 && dataRows.every(row => row[colIndex] && isPathOrFile(row[colIndex]))) {
			return true;
		}
		return false;
	};

	// 1. TSV: first line has tabs
	if (lines[0].includes("\t")) {
		const headerCols = lines[0].split("\t").map(c => c.trim());
		if (headerCols.length >= 2 && headerCols.every(c => isLikelyHeaderToken(c, "tsv"))) {
			const rawDataRows: string[][] = [];
			let isTsv = true;
			for (let i = 1; i < lines.length; i++) {
				const parts = lines[i].split("\t").map(c => c.trim());
				if (parts.length !== headerCols.length) {
					isTsv = false;
					break;
				}
				rawDataRows.push(parts);
			}

			// Reject if any header column matches data signatures of that column (e.g. du -sh *)
			const headerIsData = headerCols.some((col, idx) => headerMatchesDataColumn(col, idx, rawDataRows));
			if (isTsv && !headerIsData && rawDataRows.length > 0) {
				return rawDataRows.map(parts => {
					const row: Record<string, string> = {};
					for (let j = 0; j < headerCols.length; j++) {
						row[headerCols[j]] = parts[j];
					}
					return row;
				});
			}
		}
	}

	// 2. CSV: comma-delimited
	if (lines[0].includes(",") && !lines[0].startsWith("#")) {
		const splitCsvLine = (line: string): string[] => {
			const cols: string[] = [];
			let current = "";
			let inQuotes = false;
			for (let i = 0; i < line.length; i++) {
				const char = line[i];
				if (char === '"') {
					if (inQuotes && line[i + 1] === '"') {
						current += '"';
						i++;
					} else {
						inQuotes = !inQuotes;
					}
				} else if (char === "," && !inQuotes) {
					cols.push(current.trim());
					current = "";
				} else {
					current += char;
				}
			}
			cols.push(current.trim());
			return cols;
		};

		const headerCols = splitCsvLine(lines[0]);
		// Require at least 2 columns, valid header labels (spaces allowed, e.g. "First Name"), and not prose
		if (headerCols.length >= 2 && headerCols.every(c => isLikelyHeaderToken(c, "csv"))) {
			const rawDataRows: string[][] = [];
			let isCsv = true;
			for (let i = 1; i < lines.length; i++) {
				const parts = splitCsvLine(lines[i]);
				if (parts.length !== headerCols.length) {
					isCsv = false;
					break;
				}
				rawDataRows.push(parts);
			}

			const headerIsData = headerCols.some((col, idx) => headerMatchesDataColumn(col, idx, rawDataRows));
			if (isCsv && !headerIsData && rawDataRows.length > 0) {
				return rawDataRows.map(parts => {
					const row: Record<string, string> = {};
					for (let j = 0; j < headerCols.length; j++) {
						row[headerCols[j]] = parts[j];
					}
					return row;
				});
			}
		}
	}

	// 3. Whitespace-aligned fixed-width columns (e.g. ps, lsof, df, docker ps)
	const headerLine = lines[0];
	if (
		!/^\s*[|#\-]/.test(headerLine) &&
		!headerLine.includes(" | ") &&
		!headerLine.includes("---") &&
		(/\S\s{2,}\S/.test(headerLine) || headerLine.includes("\t"))
	) {
		const colRegex = /\S+/g;
		const colSpans: Array<{ name: string; start: number; end: number }> = [];
		let match: RegExpExecArray | null;
		while ((match = colRegex.exec(headerLine)) !== null) {
			colSpans.push({ name: match[0], start: match.index, end: match.index + match[0].length });
		}

		if (
			colSpans.length >= 2 &&
			colSpans.every(c => isLikelyHeaderToken(c.name, "fixed") && !c.name.includes(":") && !c.name.includes("|"))
		) {
			// Find boundaries by finding space gaps across lines between each header column
			const cuts = [0];
			for (let j = 0; j < colSpans.length - 1; j++) {
				const cur = colSpans[j];
				const nxt = colSpans[j + 1];

				let bestCut = -1;
				for (let c = nxt.start; c >= cur.end; c--) {
					let allSpaces = true;
					for (let r = 0; r < lines.length; r++) {
						const ch = lines[r][c] ?? " ";
						if (ch !== " " && ch !== "\t") {
							allSpaces = false;
							break;
						}
					}
					if (allSpaces) {
						bestCut = c + 1;
						break;
					}
				}
				if (bestCut === -1) {
					bestCut = nxt.start;
				}
				cuts.push(bestCut);
			}

			const rawDataRows: string[][] = [];
			for (let i = 1; i < lines.length; i++) {
				const line = lines[i];
				if (/^[-=\s+]+$/.test(line)) continue;
				const parts: string[] = [];
				for (let j = 0; j < colSpans.length; j++) {
					const start = cuts[j];
					const end = cuts[j + 1];
					const val = end !== undefined ? line.slice(start, end).trim() : line.slice(start).trim();
					parts.push(val);
				}
				rawDataRows.push(parts);
			}

			const headerIsData = colSpans.some((col, idx) => headerMatchesDataColumn(col.name, idx, rawDataRows));
			if (!headerIsData && rawDataRows.length > 0) {
				return rawDataRows.map(parts => {
					const row: Record<string, string> = {};
					for (let j = 0; j < colSpans.length; j++) {
						row[colSpans[j].name] = parts[j];
					}
					return row;
				});
			}
		}
	}

	return undefined;
}

export const GREP_MATCH_LIMIT = 16;

/**
 * OMP's `N|text` grep rows, starred hits preferred. Past `GREP_MATCH_LIMIT` a notice carries
 * the hidden count: the card must not look like every match when some were dropped.
 */
export function parseGrepOutput(rawText: string): unknown {
	const lines = rawText.split(/\r?\n/);
	const matches: Array<{ line: number; match: string }> = [];
	const starMatches: Array<{ line: number; match: string }> = [];

	for (const line of lines) {
		const m = line.match(/^\s*(\*)?\s*(\d+)\|\s*(.*)$/);
		if (m) {
			const item = { line: parseInt(m[2], 10), match: m[3].trim() };
			if (m[1]) starMatches.push(item);
			matches.push(item);
		}
	}

	const items = starMatches.length > 0 ? starMatches : matches;
	if (items.length === 0) return null;
	const shown = items.slice(0, GREP_MATCH_LIMIT);
	const omitted = items.length - shown.length;
	return omitted > 0 ? { matches: shown, notice: `… ${omitted} more matches` } : { matches: shown };
}

function stripSourceLineNumbers(text: string): string {
	if (!isFileExcerpt(text)) return text;
	return text.replace(/^[ \t]*\*?\d+(?:-\d+)?:/gm, "");
}

export function formatFileExcerpt(text: string, useToon = true): string {
	const clean = stripSourceLineNumbers(sanitizeTerminalText(text));
	const headerEnd = clean.indexOf("\n");
	if (headerEnd < 0) return clean;
	const body = stripGeneratedNoticeFooter(clean.slice(headerEnd + 1)).trim();
	if (body.startsWith("{") || body.startsWith("[")) {
		try {
			const value = decodeNestedJson(JSON.parse(body));
			return `${clean.slice(0, headerEnd)}\n${structuredValueText(value, useToon)}`;
		} catch {
			// Partial excerpts remain readable text, without inventing missing fields.
		}
	}
	const objectExcerpt = /^\{\s*\n([\s\S]*)\n\s*\},?$/.exec(body);
	if (objectExcerpt) {
		const fields: string[] = [];
		for (const line of objectExcerpt[1].split(/\r?\n/)) {
			const field = line.trim();
			if (!field) continue;
			if (field === "…" || field === "...") {
				fields.push(field);
				continue;
			}
			const property = /^([a-zA-Z_$][\w$]*|"(?:\\.|[^"\\])*")\s*:\s*(.+?)(?:,)?$/.exec(field);
			if (!property) {
				fields.push(field);
				continue;
			}
			const [, key, source] = property;
			// Only a value that is itself a JSON object or array is worth re-encoding; every
			// other field stays exactly as the excerpt wrote it.
			if (source.startsWith("{") || source.startsWith("[")) {
				try {
					const name = key.charCodeAt(0) === 34 ? JSON.parse(key) : key;
					fields.push(structuredValueText({ [name]: decodeNestedJson(JSON.parse(source)) }, useToon));
					continue;
				} catch {
					// Malformed JSON is source text, not a value to guess at.
				}
			}
			fields.push(`${key}: ${source}`);
		}
		if (fields.length) return `${clean.slice(0, headerEnd)}\n${fields.join("\n")}`;
	}
	return clean;
}

// TOON is the compact layout, and its rows read better with string values inlined. With the
// tweak off the value stays pretty JSON with every string exactly as the tool returned it.
function structuredValueText(value: unknown, useToon: boolean): string {
	if (!useToon) return JSON.stringify(value, null, 2) ?? String(value);
	return encode(inlineStringValues(value));
}

function inlineText(text: string): string {
	const lines = text.split(/\r\n|\r|\n/);
	while (lines.length > 1 && lines[0].trim() === "") lines.shift();
	while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
	if (lines.length < 2) return lines[0].replace(/\s+/g, " ").trim();
	// A multi-line value keeps its lines as indented continuations: collapsing them to `; `
	// hid the structure the value came from.
	return [lines[0].trim(), ...lines.slice(1).map(line => `  ${line.replace(/\s+$/, "")}`)].join("\n");
}

function inlineStringValues(value: unknown): unknown {
	if (typeof value === "string") return inlineText(stripSourceLineNumbers(value));
	if (Array.isArray(value)) return value.map(inlineStringValues);
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineStringValues(item)]));
	}
	return value;
}

function previewText(preview: string, useToon = true): string | undefined {
	const textField = /^\s*(?:display\[\d+\]:\s*)?\{\s*"text"\s*:\s*"((?:\\[^\r\n]|[^"\\\r\n])*)/.exec(preview);
	if (!textField) return;
	// Decode available string characters only; the outer JSON can be incomplete.
	const fragment = textField[1].replace(/\\u[\da-f]{0,3}$/i, "");
	try {
		const text: string = sanitizeTerminalText(JSON.parse(`"${fragment}"`));
		if (isFileExcerpt(text)) return formatFileExcerpt(text, useToon);
		const decoded = decodeNestedJson(text);
		if (decoded !== null && typeof decoded === "object") return formatJsonOutput(decoded, useToon).text;
		const timedJson = formatJsonWithFooter(text, useToon);
		if (timedJson) return timedJson.text;
		const markdown = markdownOutput(text);
		if (markdown !== undefined) return markdown;
		return isMultilineJson(text) ? text : inlineText(text);
	} catch {
		// Keep invalid escapes visible in the original preview.
		return;
	}
}

export function formatJsonWithFooter(text: string, useToon = true): { text: string; format: "toon" | "json" | "text" | "command" } | undefined {
	const footer = splitCommandFooter(text);
	if (!footer) return;
	try {
		const value = parseJsonDocuments(footer.body.trim().replace(/^display\[\d+\]:\s*/, ""));
		if (value === null || typeof value !== "object") return;
		const body = formatJsonOutput(decodeNestedJson(value), useToon);
		return { text: `${body.text}\n${footer.text}`, format: body.format };
	} catch {
		// A timing footer does not make an incomplete or malformed JSON body valid.
		return;
	}
}

export function formatJsonOutput(value: unknown, useToon = true): { text: string; format: "toon" | "json" | "text" | "command" } {
	if (isCommandResult(value)) return formatCommandResult(value, "Result", useToon);
	if (Array.isArray(value) && value.some(isCommandResult)) {
		return {
			text: value.map((item, index) => isCommandResult(item)
				? formatCommandResult(item, `Result ${index + 1}`, useToon).text
				: `Result ${index + 1}\n${formatJsonOutput(item, useToon).text}`).join("\n\n"),
			format: "command",
		};
	}
	const artifact = artifactPreview(value);
	if (artifact) {
		const decoded = decodeNestedJson(artifact.text);
		const output = typeof decoded === "string"
			? formatJsonWithFooter(decoded, useToon) ?? { text: previewText(decoded, useToon) ?? decoded, format: "text" as const }
			: formatJsonOutput(decoded, useToon);
		return { ...output, text: `${output.text}\n${artifact.notice}` };
	}
	// Preview envelopes have already lost data. Do not parse them as complete values.
	if (isTruncatedPreview(value)) {
		const text = previewText(value.preview, useToon);
		if (text !== undefined) {
			return { text: `${text}\n[truncated; original size: ${value.totalBytes} bytes]`, format: "text" };
		}
		const preview = value.preview.replace(/"(?:\\.|[^"\\])*"?/g, token =>
			token.replace(/\\r\\n|\\[\s\S]/g, escape =>
				escape === "\\n" || escape === "\\r" || escape === "\\r\\n" ? "; " : escape,
			),
		);
		return { text: `${sanitizeTerminalText(preview)}\n[truncated; original size: ${value.totalBytes} bytes]`, format: "text" };
	}
	if (value && typeof value === "object" && "text" in value && typeof value.text === "string" &&
		isFileExcerpt(value.text)) {
		return { text: formatFileExcerpt(value.text, useToon), format: "text" };
	}
	const text = typeof value === "string" ? sanitizeTerminalText(value) : isRecord(value) && typeof value.text === "string" ? sanitizeTerminalText(value.text) : undefined;
	const search = text === undefined ? undefined : formatSearchOutput(text);
	if (search !== undefined) return { text: search, format: "text" };
	const timedJson = typeof value === "string" ? formatJsonWithFooter(value, useToon) : undefined;
	if (timedJson) return timedJson;
	const markdown = markdownOutput(value);
	if (markdown !== undefined) return { text: markdown, format: "text" };
	if (isMultilineJson(value)) return { text: value, format: "text" };
	if (typeof value === "string") {
		const tabular = parseTabularData(value);
		if (tabular !== undefined && tabular.length > 0) {
			return { text: structuredValueText(tabular, useToon), format: useToon ? "toon" : "json" };
		}
	}
	if (!needsTextLayout(value)) return { text: structuredValueText(value, useToon), format: useToon ? "toon" : "json" };

	// Keep available values readable beside incomplete previews, without claiming
	// that the mixed display is a valid TOON document.
	const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as object);
	let format: "text" | "command" = "text";
	const mixedText = entries.map(([key, item]) => {
		const label = useToon ? encode({ [key]: null }).replace(/: null$/, ":") : `${key}:`;
		const output = formatJsonOutput(item, useToon);
		if (output.format === "command") format = "command";
		return `${label}\n${output.text.split("\n").map(line => `  ${line}`).join("\n")}`;
	}).join("\n");
	return { text: mixedText, format };
}
