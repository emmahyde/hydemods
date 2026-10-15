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

const GREP_MATCH_ROW = /^([^\s:][^:\r\n]*?):(\d+):(.*)$/;

function isGrepPath(path: string): boolean {
	return /[/.]/.test(path) && !/\s/.test(path) && !path.includes("://");
}

/**
 * `grep -rn` / `rg -n` output with the repeated `path:line:` prefix lifted into one `path`
 * header per file. Rows keep their text and indentation exactly; the line number goes with
 * the prefix (as {@link stripLineNumbers} does), `--` group separators become `…`, and
 * `path-line-text` context rows are folded in only for a path that has a match row. Output
 * that is not mostly prefixed rows (URLs, prose with a colon) is returned untouched.
 */
export function groupGrepPrefixes(text: string): { text: string; grouped: boolean } {
	const rows = text.split("\n");
	const content = rows.filter(row => row.trim() !== "" && row !== "--");
	const matches = content.map(row => GREP_MATCH_ROW.exec(row)).filter((m): m is RegExpExecArray => m !== null && isGrepPath(m[1]));
	if (matches.length === 0 || matches.length * 2 < content.length) return { text, grouped: false };
	const paths = [...new Set(matches.map(m => m[1]))].sort((a, b) => b.length - a.length);
	const out: string[] = [];
	let current: string | undefined;
	const open = (path: string) => {
		if (path === current) return;
		if (current !== undefined) out.push("");
		out.push(path);
		current = path;
	};
	for (const row of rows) {
		const match = GREP_MATCH_ROW.exec(row);
		if (match && isGrepPath(match[1])) {
			open(match[1]);
			out.push(match[3]);
			continue;
		}
		if (row === "--") { out.push("…"); continue; }
		const context = paths.map(path => row.startsWith(`${path}-`) ? /^(\d+)-(.*)$/.exec(row.slice(path.length + 1)) : null);
		const index = context.findIndex(found => found !== null);
		if (index >= 0) {
			open(paths[index]);
			out.push(context[index]![2]);
			continue;
		}
		out.push(row);
	}
	return { text: out.join("\n"), grouped: true };
}

const SOURCE_TOKEN = /(?:^|[\s"'=<>(])((?:~\/|\.{0,2}\/)?[\w@.+/-]*\.([A-Za-z0-9]+))(?=$|[\s"'|&;:)<>])/g;

/** The last source file a shell command names (`sed -n 1,5p src/a.ts`), whose text it prints. */
export function commandSourcePath(command: string): string | undefined {
	let found: string | undefined;
	for (const match of command.matchAll(SOURCE_TOKEN)) if (hasCommentStyle(match[2])) found = match[1];
	return found;
}

const BRACE_LANGUAGES = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "rs", "go", "c", "h", "cc", "cpp", "hpp", "cs", "java", "kt", "kts", "swift", "scala", "dart", "php", "zig"]);

/** Whether {@link compactBlocks} knows how to fold this language's blocks. */
export function isBraceLanguage(ext: string | undefined): boolean {
	return ext !== undefined && BRACE_LANGUAGES.has(ext.toLowerCase());
}

function bracketDelta(line: string, singleQuotes: boolean): number {
	const bare = line.replace(singleQuotes ? /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g : /"(?:\\.|[^"\\])*"|`[^`]*`/g, "");
	let depth = 0;
	for (const ch of bare) {
		if (ch === "{" || ch === "(" || ch === "[") depth++;
		else if (ch === "}" || ch === ")" || ch === "]") depth--;
	}
	return depth;
}

/** A row of only closing parens or brackets, optionally after a closing quote, and trailing `;`/`,`: `)`, `);`, `");`, `'),`. A row with a brace is left alone. */
const LONE_CLOSER = /^\s*["'`]*[)\]][)\];,]*\s*$/;

/**
 * Rows of one block as a single line. Words are separated by a space, except that nothing pads the
 * inside of `[`/`(` or `]`/`)`, and a trailing comma before a closing `]`/`)` is dropped:
 * `[`, `x,`, `y,`, `]` becomes `[x, y]`. Only the seams between rows are touched, never row text.
 */
function joinRows(block: string[]): string {
	let acc = "";
	for (const part of block.map(p => p.trim()).filter(Boolean)) {
		const closes = part[0] === "]" || part[0] === ")";
		if (closes) acc = acc.replace(/,$/, "");
		const tight = acc === "" || /[[(]$/.test(acc) || closes;
		acc += tight ? part : ` ${part}`;
	}
	return acc;
}

const EMPTY_PAIRS: Record<string, string> = { "[": "]", "(": ")", "{": "}" };

/** A row that only closes: brackets, braces, quotes and trailing `;`/`,`. Used for empty pairs. */
const CLOSING_ROW = /^[)\]}"'`;,]+$/;

/**
 * Rows holding nothing but a closing paren or bracket are appended to the row above, so a call
 * whose arguments were too wide to join ends `...\n  run(x);` rather than leaving `)` alone on a
 * line. An empty pair (`[` then `]`, `(` then `)`, `{` then `}`) becomes `[]`. Any other bare `}`
 * keeps its own row, and a closer after a blank row stays where it is.
 */
export function joinLoneClosers(code: string): string {
	const out: string[] = [];
	for (const row of code.split("\n")) {
		const last = out.length > 0 ? out[out.length - 1].trimEnd() : "";
		const closer = EMPTY_PAIRS[last.slice(-1)];
		const emptyPair = closer !== undefined && CLOSING_ROW.test(row.trim()) && row.trim().startsWith(closer);
		if (last !== "" && (emptyPair || LONE_CLOSER.test(row))) {
			out[out.length - 1] = last + row.trim();
		} else {
			out.push(row);
		}
	}
	return out.join("\n");
}

/**
 * Source made shorter for a card: the shared indent is dropped, and any bracketed block that
 * fits `maxWidth` once its lines are joined becomes one row (`try { a(); } catch { b(); }`).
 * A block too wide for one row keeps its opener and closer and folds what is inside. Blank
 * lines and bracket-free lines pass through. Only for brace languages; `code` is left alone
 * when it cannot be folded safely.
 */
export function compactBlocks(code: string, { maxWidth = 100, singleQuotes = true } = {}): string {
	const lines = code.split("\n");
	const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
	const indented = lines.filter(line => line.trim() !== "");
	if (indented.length === 0) return code;
	const common = Math.min(...indented.map(indentOf));
	const dedented = lines.map(line => line.slice(Math.min(common, indentOf(line))));

	const fold = (rows: string[]): string[] => {
		const out: string[] = [];
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			let depth = bracketDelta(row, singleQuotes);
			if (row.trim() === "" || depth <= 0) { out.push(row); continue; }
			let end = i;
			while (depth > 0 && end + 1 < rows.length) depth += bracketDelta(rows[++end], singleQuotes);
			if (depth !== 0) { out.push(row); continue; }
			const block = rows.slice(i, end + 1);
			const joined = `${row.slice(0, indentOf(row))}${joinRows(block)}`;
			if (joined.length <= maxWidth && block.length <= 12) {
				out.push(joined);
			} else {
				out.push(row, ...fold(block.slice(1, -1)), block[block.length - 1]);
			}
			i = end;
		}
		return out;
	};
	return joinLoneClosers(fold(dedented).join("\n"));
}
