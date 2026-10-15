// Display-only text clean-up for source code shown on hydemods cards: comments out, line-number
// gutters off. The model never sees any of this; it only changes what the card draws.

type CommentStyle = { line: string[]; block?: [string, string]; quotes: string; charLiterals?: boolean; needsSpaceBefore?: boolean };

const SLASH: CommentStyle = { line: ["//"], block: ["/*", "*/"], quotes: "\"'`" };
// Rust, Go, C-likes: a lone `'` is a lifetime or a char literal, not a string.
const SLASH_CHARS: CommentStyle = { line: ["//"], block: ["/*", "*/"], quotes: "\"`", charLiterals: true };
const HASH: CommentStyle = { line: ["#"], quotes: "\"'", needsSpaceBefore: true };
const DASH: CommentStyle = { line: ["--"], quotes: "\"'", needsSpaceBefore: true };

const STYLES: Record<string, CommentStyle> = {
	ts: SLASH, tsx: SLASH, js: SLASH, jsx: SLASH, mjs: SLASH, cjs: SLASH, mts: SLASH, cts: SLASH,
	rs: SLASH_CHARS, go: SLASH_CHARS, c: SLASH_CHARS, h: SLASH_CHARS, cc: SLASH_CHARS, cpp: SLASH_CHARS, hpp: SLASH_CHARS,
	cs: SLASH_CHARS, java: SLASH_CHARS, kt: SLASH_CHARS, kts: SLASH_CHARS, swift: SLASH_CHARS, scala: SLASH_CHARS,
	dart: SLASH, php: SLASH, zig: SLASH_CHARS,
	py: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, yaml: HASH, yml: HASH, toml: HASH, conf: HASH, ex: HASH, exs: HASH,
	sql: DASH, lua: DASH,
};

/** Languages whose comments {@link stripComments} understands, by file extension. */
export function hasCommentStyle(ext: string | undefined): boolean {
	return ext !== undefined && ext.toLowerCase() in STYLES;
}

export function extensionOf(path: string): string | undefined {
	return /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
}

export interface CommentScan {
	/** Every line of the input, comments blanked out and trailing space trimmed. */
	lines: string[];
	/** Lines that held only a comment: nothing is left of them once it is gone. */
	dropped: boolean[];
}

/**
 * Lexically finds the comments in `code` without parsing it, so it works on excerpts too.
 * Strings are respected; a block comment left open by an excerpt blanks the rest of it.
 * Line count is preserved so line numbers stay valid.
 */
export function scanComments(code: string, ext: string | undefined): CommentScan {
	const original = code.split("\n");
	const style = ext === undefined ? undefined : STYLES[ext.toLowerCase()];
	if (!style) return { lines: original, dropped: original.map(() => false) };
	const lines: string[] = [];
	const dropped: boolean[] = [];
	let inBlock = false;
	for (const [index, line] of original.entries()) {
		let out = "";
		let quote = "";
		let i = 0;
		while (i < line.length) {
			if (inBlock) {
				const end = line.indexOf(style.block![1], i);
				if (end < 0) { i = line.length; break; }
				inBlock = false;
				i = end + style.block![1].length;
				continue;
			}
			const ch = line[i];
			if (quote) {
				out += ch;
				if (ch === "\\" && i + 1 < line.length) { out += line[i + 1]; i += 2; continue; }
				if (ch === quote) quote = "";
				i++;
				continue;
			}
			if (style.block && line.startsWith(style.block[0], i)) { inBlock = true; i += style.block[0].length; continue; }
			const marker = style.line.find(candidate => line.startsWith(candidate, i));
			if (marker && (!style.needsSpaceBefore || i === 0 || /\s/.test(line[i - 1]!)) && !(index === 0 && i === 0 && line.startsWith("#!"))) break;
			if (style.quotes.includes(ch)) { quote = ch; out += ch; i++; continue; }
			if (ch === "'" && style.charLiterals) {
				const literal = /^'(?:\\.[^']*|[^'\\])'/.exec(line.slice(i));
				if (literal) { out += literal[0]; i += literal[0].length; continue; }
			}
			out += ch;
			i++;
		}
		const trimmed = out.replace(/\s+$/, "");
		lines.push(trimmed);
		dropped.push(trimmed === "" && line.trim() !== "");
	}
	return { lines, dropped };
}

/** `code` without comments. Lines that were only a comment disappear; blank lines stay. */
export function stripComments(code: string, ext: string | undefined): string {
	if (!hasCommentStyle(ext)) return code;
	const scan = scanComments(code, ext);
	return scan.lines.filter((_, index) => !scan.dropped[index]).join("\n");
}

const NUMBERED_LINE = /^[ \t]*\*?(\d+)[:|\t-]/;
const GAP_LINE = /^\s*(?:…|\.\.\.)\s*$/;

const MIN_RUN = 3;

const NUMBERING_COMMAND = /\bgrep\b[^|;&]*\s-[a-zA-Z]*n|\b(?:rg|ag|ack)\b[^|;&]*(?:\s-[a-zA-Z]*n|--line-number)|\bcat\s+-[a-zA-Z]*n|\bnl\b/;

/** Whether a shell command is one that prefixes its output rows with line numbers. */
export function printsLineNumbers(command: string): boolean {
	return NUMBERING_COMMAND.test(command);
}

/**
 * Tool output that prints a line-number gutter (`grep -n`, `cat -n`, OMP read excerpts) with the
 * gutter removed. A gutter is a run of at least three consecutive rows numbered in ascending
 * order (gap rows and blanks between them allowed), or output that is mostly such rows, so one
 * command printing a numbered listing and then plain text is stripped only where it is numbered.
 */
export function stripLineNumbers(text: string, minRun = MIN_RUN): { text: string; numbered: boolean } {
	const rows = text.split("\n");
	const gutter = new Array<boolean>(rows.length).fill(false);
	let run: number[] = [];
	let previous = 0;
	const flush = () => {
		if (run.length >= minRun) for (const index of run) gutter[index] = true;
		run = [];
		previous = 0;
	};
	for (const [index, row] of rows.entries()) {
		if (row.trim() === "" || GAP_LINE.test(row)) continue;
		const number = NUMBERED_LINE.exec(row)?.[1];
		if (number !== undefined && Number(number) >= previous) {
			run.push(index);
			previous = Number(number);
			continue;
		}
		flush();
		if (number !== undefined) { run.push(index); previous = Number(number); }
	}
	flush();
	if (!gutter.includes(true)) {
		// A short listing (two rows) still counts when it is all there is.
		const content = rows.filter(row => row.trim() !== "" && !GAP_LINE.test(row));
		const numbered = content.filter(row => NUMBERED_LINE.test(row));
		if (content.length < 2 || numbered.length !== content.length) return { text, numbered: false };
		let last = 0;
		for (const row of numbered) {
			const number = Number(NUMBERED_LINE.exec(row)![1]);
			if (number < last) return { text, numbered: false };
			last = number;
		}
		return { text: rows.map(row => row.replace(NUMBERED_LINE, "")).join("\n"), numbered: true };
	}
	return { text: rows.map((row, index) => gutter[index] ? row.replace(NUMBERED_LINE, "") : row).join("\n"), numbered: true };
}

const SOURCE_TOKEN = /(?:^|[\s"'=<>(])((?:~\/|\.{0,2}\/)?[\w@.+/-]*\.([A-Za-z0-9]+))(?=$|[\s"'|&;:)<>])/g;

/** The last source file a shell command names (`sed -n 1,5p src/a.ts`), whose text it prints. */
export function commandSourcePath(command: string): string | undefined {
	let found: string | undefined;
	for (const match of command.matchAll(SOURCE_TOKEN)) if (hasCommentStyle(match[2])) found = match[1];
	return found;
}
