// Declaration outlines for read and edit cards. Structure comes from the host's tree-sitter
// summarizer (`summarizeCode`): each elided segment is a body, and the kept text just before
// it is the declaration that owns it. Nested declarations come from summarizing one
// declaration's own slice with its body unfolded one level. The model never sees any of this;
// it only changes what the card shows.

export interface SummarySegmentLike {
	kind: string;
	startLine: number;
	endLine: number;
	text?: string;
}

export interface SummaryLike {
	parsed: boolean;
	language?: string;
	totalLines: number;
	segments: SummarySegmentLike[];
}

export interface SummarizeOptions {
	code: string;
	lang?: string;
	path?: string;
	minBodyLines?: number;
	minCommentLines?: number;
	unfoldUntilLines?: number;
	unfoldLimitLines?: number;
}

export type Summarize = (options: SummarizeOptions) => SummaryLike;

export interface Declaration {
	/** First signature line, 1-based in the full source. */
	line: number;
	/** Last line of the declaration (closing brace when the language has one). */
	endLine: number;
	bodyStart: number;
	bodyEnd: number;
	depth: number;
	signature: string;
	children: Declaration[];
}

export interface Outline {
	language: string;
	totalLines: number;
	declarations: Declaration[];
}

const MAX_DEPTH = 3;
const NO_COMMENT_ELISION = 1_000_000;

const DECLARATION_START =
	/^(?:@[\w.]+(?:\([^)]*\))?\s+|(?:export|default|public|private|protected|internal|static|async|override|abstract|readonly|declare|final|unsafe|pub(?:\([^)]*\))?)\s+)*(?:function\*?|class|interface|type|enum|struct|impl|trait|mod|namespace|module|def|fn|func|proc|let|var|const|val|get|set|constructor|[#\w$][\w$]*\s*(?:<[^>]*>)?\s*\(|[#\w$][\w$.]*\s*[:=]\s)/;
const CONTROL_START = /^(?:if|else|for|while|do|switch|match|case|try|catch|finally|return|throw|await|yield|with|new|import|from|using)\b|^[)\]}.]/;
const CALL_LITERAL_END = /(?:\(\s*[{[]|,\s*[{[]|\(\s*)$/;
const COMMENT_LINE = /^(?:\/\/|#|\*|\/\*)/;

function count(text: string, char: string): number {
	let total = 0;
	for (const current of text) if (current === char) total++;
	return total;
}

function isDeclarationSignature(signature: string): boolean {
	if (!signature || CONTROL_START.test(signature) || CALL_LITERAL_END.test(signature)) return false;
	if (count(signature, ")") !== count(signature, "(") || count(signature, "]") !== count(signature, "[")) return false;
	return DECLARATION_START.test(signature);
}

// Languages where the summarizer keeps a block's first and last line, so the elision begins one
// line into the body and the signature is the nearest shallower block header above it. The
// header shape is per language: Python ends in `:`, Ruby opens with class/module/def.
const BLOCK_HEADER: Record<string, RegExp> = {
	python: /:$/,
	ruby: /^(?:(?:private|protected|public|module_function)\s+)?(?:class|module|def)\b/,
};

interface Signature {
	line: number;
	text: string;
	bodyStart: number;
	bodyEnd: number;
	endLine: number;
}

function collapseSignature(lines: string[], top: number, bottom: number): string {
	return lines.slice(top - 1, bottom).map(line => line.trim()).join(" ").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/,?\s+\)/g, ")")
		.replace(/\s*(?:\{|:|=>\s*\{|=\s*\{|=\s*\[)\s*$/, "")
		.replace(/^((?:export\s+|default\s+|async\s+)*)function\*?\s+/, "$1fn ")
		.trim();
}

// The signature owning the elided body [start, end]: the statement ending on the line just
// above the body, extended upward while a parameter list is still open. `floor` is the parent
// declaration's line when outlining its slice, so a signature at or above it is the parent.
function signatureFor(lines: string[], body: { start: number; end: number }, lang: string, floor = 0): Signature | undefined {
	const header = BLOCK_HEADER[lang];
	if (header) {
		const indentOf = (line: string | undefined) => /^[ \t]*/.exec(line ?? "")?.[0].length ?? 0;
		const closerAt = (line: number, indent: number) => indentOf(lines[line - 1]) === indent && /^end\b/.test(lines[line - 1]?.trim() ?? "");
		const above = lines[body.start - 2];
		if (above === undefined) return undefined;
		const aboveIndent = indentOf(above);
		// The summarizer keeps a block's first body line, so the header is the nearest shallower
		// line above it; the kept last body line is followed by Ruby's `end` at header depth.
		const outer = (): Signature | undefined => {
			for (let line = body.start - 1; line >= 1; line--) {
				const candidate = lines[line - 1];
				if (!candidate.trim()) continue;
				const indent = indentOf(candidate);
				if (indent >= aboveIndent) continue;
				if (!header.test(candidate.trim())) return undefined;
				const text = collapseSignature(lines, line, line);
				if (!isDeclarationSignature(text)) return undefined;
				const bodyEnd = Math.min(lines.length, body.end + 1);
				return { line, text, bodyStart: line + 1, bodyEnd, endLine: closerAt(bodyEnd + 1, indent) ? bodyEnd + 1 : bodyEnd };
			}
			return undefined;
		};
		// Ruby elides a method body whole: its header sits right above and its `end` right below.
		const inner = (): Signature | undefined => {
			if (!header.test(above.trim()) || !closerAt(body.end + 1, aboveIndent)) return undefined;
			if (lines.slice(body.start - 1, body.end).some(line => line.trim() && indentOf(line) <= aboveIndent)) return undefined;
			const text = collapseSignature(lines, body.start - 1, body.start - 1);
			if (!isDeclarationSignature(text)) return undefined;
			return { line: body.start - 1, text, bodyStart: body.start, bodyEnd: body.end, endLine: body.end + 1 };
		};
		const found = outer();
		return found && found.line > floor ? found : inner();
	}
	const opener = body.start - 1;
	if (opener < 1) return undefined;
	let top = opener;
	while (top > 1) {
		const joined = lines.slice(top - 1, opener).join(" ");
		const open = count(joined, ")") > count(joined, "(") || count(joined, "]") > count(joined, "[");
		if (!open) {
			const current = lines[top - 1].trim();
			if (DECLARATION_START.test(current)) break;
			const previous = lines[top - 2].trim();
			if (!previous || COMMENT_LINE.test(previous) || /[;{}]$/.test(previous)) break;
		}
		top--;
	}
	const text = collapseSignature(lines, top, opener);
	if (!isDeclarationSignature(text)) return undefined;
	const closer = lines[body.end]?.trim();
	const endLine = closer !== undefined && /^[}\])]|^end\b/.test(closer) ? body.end + 1 : body.end;
	return { line: top, text, bodyStart: body.start, bodyEnd: body.end, endLine };
}

function keptLineCount(summary: SummaryLike): number {
	let total = 0;
	for (const segment of summary.segments) if (segment.kind === "kept") total += segment.endLine - segment.startLine + 1;
	return total;
}

function elidedRanges(summary: SummaryLike): Array<{ start: number; end: number }> {
	return summary.segments.filter(segment => segment.kind === "elided").map(segment => ({ start: segment.startLine, end: segment.endLine }));
}

function declarationsFromBodies(lines: string[], bodies: Array<{ start: number; end: number }>, depth: number, lang: string, floor = 0): Declaration[] {
	const declarations: Declaration[] = [];
	for (const body of bodies) {
		const signature = signatureFor(lines, body, lang, floor);
		if (!signature) continue;
		if (declarations.some(existing => existing.line === signature.line)) continue;
		declarations.push({
			line: signature.line,
			endLine: signature.endLine,
			bodyStart: signature.bodyStart,
			bodyEnd: signature.bodyEnd,
			depth,
			signature: signature.text,
			children: [],
		});
	}
	return declarations;
}

function childDeclarations(lines: string[], parent: Declaration, lang: string, summarize: Summarize): Declaration[] {
	if (parent.depth + 1 >= MAX_DEPTH || parent.bodyEnd - parent.bodyStart < 3) return [];
	const raw = lines.slice(parent.line - 1, parent.endLine);
	const indent = /^[ \t]*/.exec(raw[0])?.[0] ?? "";
	const slice = raw.map(line => line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()).join("\n");
	const folded = summarize({ code: slice, lang, minBodyLines: 2, minCommentLines: NO_COMMENT_ELISION });
	if (!folded.parsed) return [];
	const opened = summarize({
		code: slice,
		lang,
		minBodyLines: 2,
		minCommentLines: NO_COMMENT_ELISION,
		unfoldUntilLines: keptLineCount(folded) + 1,
		unfoldLimitLines: raw.length + 1,
	});
	const offset = parent.line - 1;
	const bodies = elidedRanges(opened)
		.map(range => ({ start: range.start + offset, end: range.end + offset }))
		.filter(range => range.start > parent.bodyStart - 1 && range.end <= parent.bodyEnd && !(range.start === parent.bodyStart && range.end === parent.bodyEnd));
	const children = declarationsFromBodies(lines, bodies, parent.depth + 1, lang, parent.line).filter(child => child.line > parent.line && child.endLine <= parent.endLine);
	for (const child of children) child.children = childDeclarations(lines, child, lang, summarize);
	return children;
}

/** Declaration tree of one source file, or undefined when tree-sitter cannot parse it. */
export function outlineSource(code: string, source: { path?: string; lang?: string }, summarize: Summarize): Outline | undefined {
	if (!code.trim()) return undefined;
	const summary = summarize({ code, path: source.path, lang: source.lang, minBodyLines: 2, minCommentLines: NO_COMMENT_ELISION });
	if (!summary.parsed || !summary.language) return undefined;
	const lines = code.split(/\r?\n/);
	const declarations = declarationsFromBodies(lines, elidedRanges(summary), 0, summary.language);
	for (const declaration of declarations) declaration.children = childDeclarations(lines, declaration, summary.language, summarize);
	return { language: summary.language, totalLines: lines.length, declarations };
}

export function flattenDeclarations(declarations: Declaration[]): Declaration[] {
	const flat: Declaration[] = [];
	const visit = (list: Declaration[]) => {
		for (const declaration of list) {
			flat.push(declaration);
			visit(declaration.children);
		}
	};
	visit(declarations);
	return flat;
}

// Rows carry no line numbers: the card label already names the range, and the declaration
// tree reads as structure rather than as a listing.
function signatureRow(declaration: Declaration): string {
	return `${"  ".repeat(declaration.depth + 1)}${declaration.signature}`;
}

function outlineRow(declaration: Declaration): string {
	return `${signatureRow(declaration)}  ⋯${declaration.bodyEnd - declaration.bodyStart + 1}`;
}

/** Whole-file outline: header row, then one row per declaration in source order. */
export function renderOutline(outline: Outline, label: string): string[] {
	const flat = flattenDeclarations(outline.declarations);
	const count = flat.length;
	return [
		`${label} · ${outline.language} · ${outline.totalLines} lines · ${count} decl${count === 1 ? "" : "s"}`,
		...flat.map(outlineRow),
	];
}

// The innermost declaration chain (outermost first) whose span contains lines [start, end].
function enclosingChain(declarations: Declaration[], start: number, end: number): Declaration[] {
	for (const declaration of declarations) {
		if (declaration.line <= start && declaration.endLine >= end) {
			return [declaration, ...enclosingChain(declaration.children, start, end)];
		}
	}
	return [];
}

/**
 * Line-range read. Declarations that begin inside the range are listed as an outline, with
 * their ancestors above them. A range that lies inside one declaration's body shows that
 * declaration's signature chain and the range's lines beneath it. Undefined when the range
 * touches no declaration at all.
 */
export function renderRange(outline: Outline, lines: string[], start: number, end: number, label: string): string[] | undefined {
	const chain = enclosingChain(outline.declarations, start, end);
	const inside = flattenDeclarations(outline.declarations).filter(declaration => declaration.line >= start && declaration.line <= end);
	if (inside.length > 0) {
		const ancestors = chain.filter(declaration => declaration.line < start);
		const count = inside.length;
		return [
			`${label}:${start}-${end} · ${count} decl${count === 1 ? "" : "s"}`,
			...ancestors.map(signatureRow),
			...inside.map(outlineRow),
		];
	}
	if (chain.length === 0) return undefined;
	const innermost = chain[chain.length - 1];
	const rows = [`${label}:${start}-${end}`];
	for (const declaration of chain) rows.push(signatureRow(declaration));
	const indent = "  ".repeat(innermost.depth + 2);
	const hiddenBefore = start - innermost.bodyStart;
	if (hiddenBefore > 0) rows.push(`${indent}⋯${hiddenBefore}`);
	const excerpt = lines.slice(start - 1, end);
	const common = commonIndent(excerpt);
	excerpt.forEach(line => rows.push(`${indent}${line.slice(common)}`));
	const hiddenAfter = innermost.bodyEnd - end;
	if (hiddenAfter > 0) rows.push(`${indent}⋯${hiddenAfter}`);
	if (innermost.endLine > innermost.bodyEnd) rows.push(`${"  ".repeat(innermost.depth + 1)}${lines[innermost.endLine - 1].trim()}`);
	return rows;
}

function commonIndent(lines: string[]): number {
	let common: number | undefined;
	for (const line of lines) {
		if (!line.trim()) continue;
		const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
		common = common === undefined ? indent : Math.min(common, indent);
	}
	return common ?? 0;
}

/* ------------------------------ edits by declaration ------------------------------ */

interface DiffChange {
	kind: "+" | "-";
	/** Line in the new text (for removals: the new-side position where the line was). */
	newLine: number;
	oldLine: number;
	text: string;
}

function parseUnifiedDiff(diff: string): DiffChange[] {
	const changes: DiffChange[] = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const raw of diff.split(/\r?\n/)) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk || raw.startsWith("\\")) continue;
		if (raw.startsWith("+")) {
			changes.push({ kind: "+", newLine, oldLine, text: raw.slice(1) });
			newLine++;
		} else if (raw.startsWith("-")) {
			changes.push({ kind: "-", newLine, oldLine, text: raw.slice(1) });
			oldLine++;
		} else if (raw.startsWith(" ") || raw === "") {
			oldLine++;
			newLine++;
		} else {
			inHunk = false;
		}
	}
	return changes;
}

// OMP's edit diff: `-N|text` numbers the old side, `+N|text` the new side, ` N|text` context
// carries old numbers, and a blank line separates hunks.
function parseNumberedDiff(diff: string): DiffChange[] {
	const changes: DiffChange[] = [];
	let delta = 0;
	for (const raw of diff.split(/\r?\n/)) {
		const match = /^([ +-])(\d+)\|(.*)$/.exec(raw);
		if (!match) continue;
		const number = Number(match[2]);
		if (match[1] === "-") {
			changes.push({ kind: "-", oldLine: number, newLine: number + delta, text: match[3] });
			delta--;
		} else if (match[1] === "+") {
			changes.push({ kind: "+", newLine: number, oldLine: number - delta, text: match[3] });
			delta++;
		}
	}
	return changes;
}

function parseDiff(diff: string): DiffChange[] {
	return /^@@ /m.test(diff) ? parseUnifiedDiff(diff) : parseNumberedDiff(diff);
}

/**
 * The text before an edit, rebuilt from the text after it and the diff: added lines drop out,
 * removed lines slot back in. Undefined when an added line is not where the diff says it is,
 * so a file edited again since is never described by a stale diff.
 */
export function recoverOldText(newText: string, diff: string): string | undefined {
	const changes = parseDiff(diff);
	if (changes.length === 0) return undefined;
	const newLines = newText.split(/\r?\n/);
	const added = new Set<number>();
	const removedBefore = new Map<number, string[]>();
	for (const change of changes) {
		if (change.kind === "+") {
			if (change.newLine < 1 || change.newLine > newLines.length || newLines[change.newLine - 1].trimEnd() !== change.text.trimEnd()) return undefined;
			added.add(change.newLine);
		} else {
			if (change.newLine < 1 || change.newLine > newLines.length + 1) return undefined;
			const run = removedBefore.get(change.newLine);
			if (run) run.push(change.text);
			else removedBefore.set(change.newLine, [change.text]);
		}
	}
	const oldLines: string[] = [];
	for (let line = 1; line <= newLines.length + 1; line++) {
		const run = removedBefore.get(line);
		if (run) oldLines.push(...run);
		if (line <= newLines.length && !added.has(line)) oldLines.push(newLines[line - 1]);
	}
	return oldLines.join("\n");
}

interface ChangeRow {
	newLine: number;
	oldLine: number;
	removed?: string;
	added?: string;
}

// Equal-length adjacent removed/added runs pair up as modifications; other runs stay
// single-sided, since pairing line i with line i of a rewrite would show unrelated text as one change.
function pairChanges(changes: DiffChange[]): ChangeRow[] {
	const rows: ChangeRow[] = [];
	let index = 0;
	while (index < changes.length) {
		const removed: DiffChange[] = [];
		const added: DiffChange[] = [];
		while (index < changes.length && changes[index].kind === "-" && (removed.length === 0 || changes[index].oldLine === removed[removed.length - 1].oldLine + 1)) removed.push(changes[index++]);
		while (index < changes.length && changes[index].kind === "+" && (added.length === 0 || changes[index].newLine === added[added.length - 1].newLine + 1) && (removed.length === 0 || changes[index].newLine === removed[0].newLine + added.length)) added.push(changes[index++]);
		if (removed.length === 0 && added.length === 0) {
			const change = changes[index++];
			rows.push(change.kind === "+" ? { newLine: change.newLine, oldLine: change.oldLine, added: change.text } : { newLine: change.newLine, oldLine: change.oldLine, removed: change.text });
			continue;
		}
		const paired = removed.length === added.length ? removed.length : 0;
		for (let i = 0; i < paired; i++) rows.push({ newLine: added[i].newLine, oldLine: removed[i].oldLine, removed: removed[i].text, added: added[i].text });
		for (let i = paired; i < removed.length; i++) rows.push({ newLine: removed[i].newLine, oldLine: removed[i].oldLine, removed: removed[i].text });
		for (let i = paired; i < added.length; i++) rows.push({ newLine: added[i].newLine, oldLine: added[i].oldLine, added: added[i].text });
	}
	return rows;
}

// Declarations whose span contains the line, outermost first.
function chainAt(declarations: Declaration[], line: number): Declaration[] {
	for (const declaration of declarations) {
		if (declaration.line <= line && declaration.endLine >= line) return [declaration, ...chainAt(declaration.children, line)];
	}
	return [];
}

// The identifier a declaration introduces, so a rewritten signature still names the same thing.
function declarationName(signature: string): string {
	const named = /\b(?:fn|function|class|def|module|interface|type|enum|struct|impl|trait|const|let|var|val|namespace|func|proc)\s+([\w$.?!]+)/.exec(signature);
	return named?.[1] ?? /^(?:[\w]+\s+)*?([\w$.]+)/.exec(signature)?.[1] ?? signature;
}

export interface EditOutlineInput {
	oldText: string;
	newText: string;
	diff: string;
	path?: string;
	lang?: string;
}

/**
 * Edit as the declaration tree it touched: `~` a declaration with a changed line, `+` one
 * added whole, `−` one removed whole, and unmarked ancestors for context. Line contents are
 * not shown. Undefined when neither side parses or the diff carries no line changes.
 */
export function renderEditOutline(input: EditOutlineInput, label: string, summarize: Summarize): string[] | undefined {
	const rows = pairChanges(parseDiff(input.diff));
	if (rows.length === 0) return undefined;
	const after = outlineSource(input.newText, { path: input.path, lang: input.lang }, summarize);
	const before = input.oldText.trim() ? outlineSource(input.oldText, { path: input.path, lang: input.lang }, summarize) : undefined;
	if (!after && !before) return undefined;

	const adds = rows.filter(row => row.added !== undefined).length;
	const dels = rows.filter(row => row.removed !== undefined).length;
	const addedLines = new Set(rows.filter(row => row.added !== undefined && row.removed === undefined).map(row => row.newLine));
	const removedLines = new Set(rows.filter(row => row.removed !== undefined && row.added === undefined).map(row => row.oldLine));
	const wholeSpan = (declaration: Declaration, lines: Set<number>) => {
		for (let line = declaration.line; line <= declaration.endLine; line++) if (!lines.has(line)) return false;
		return true;
	};
	const addedWhole = new Set(after ? flattenDeclarations(after.declarations).filter(declaration => wholeSpan(declaration, addedLines)) : []);
	const removedWhole = new Set(before ? flattenDeclarations(before.declarations).filter(declaration => wholeSpan(declaration, removedLines)) : []);

	// One output row per declaration; the marker says how the edit met it. Whole additions and
	// removals stop at the outermost such declaration, since their interiors are implied.
	const marks = new Map<Declaration, "~" | "+" | "−" | " ">();
	const mark = (chain: Declaration[], marker: "~" | "+" | "−") => {
		for (const declaration of chain.slice(0, -1)) if (!marks.has(declaration)) marks.set(declaration, " ");
		const target = chain[chain.length - 1];
		if (target && marks.get(target) !== "+" && marks.get(target) !== "−") marks.set(target, marker);
	};
	// Lines outside every declaration (imports, constants, module statements) share one row.
	// Each row remembers the change lines that hit it, for the expanded view.
	const detailsFor = new Map<Declaration | "top", string[]>();
	const detail = (row: ChangeRow) => row.removed !== undefined && row.added !== undefined
		? [`− ${row.removed.trim()}`, `→ ${row.added.trim()}`]
		: row.added !== undefined ? [`+ ${row.added.trim()}`] : [`− ${row.removed!.trim()}`];
	const attach = (key: Declaration | "top", row: ChangeRow) => {
		if (!row.added?.trim() && !row.removed?.trim()) return;
		const list = detailsFor.get(key) ?? [];
		list.push(...detail(row));
		detailsFor.set(key, list);
	};
	let topLevelAdds = 0;
	let topLevelDels = 0;
	for (const row of rows) {
		// Blank-line churn counts toward the header totals but touches no declaration row.
		if (!row.added?.trim() && !row.removed?.trim()) continue;
		const chain = after ? chainAt(after.declarations, row.newLine) : [];
		if (chain.length === 0) {
			const oldChain = before && row.removed !== undefined ? chainAt(before.declarations, row.oldLine) : [];
			if (oldChain.length > 0) {
				// A rewritten signature line pairs with whatever the diff put beside it, so its new
				// line can land just outside the declaration; the same-named after-side declaration
				// starting there is the one that changed.
				const old = oldChain[oldChain.length - 1];
				const renamed = after && flattenDeclarations(after.declarations).find(candidate =>
					candidate.depth === old.depth && !addedWhole.has(candidate) && Math.abs(candidate.line - row.newLine) <= 3
					&& declarationName(candidate.signature) === declarationName(old.signature));
				const target = renamed ? chainAt(after!.declarations, renamed.line) : oldChain;
				mark(target, "~");
				attach(target[target.length - 1], row);
				continue;
			}
			if (row.added !== undefined) topLevelAdds++;
			if (row.removed !== undefined) topLevelDels++;
			attach("top", row);
			continue;
		}
		const cut = chain.findIndex(declaration => addedWhole.has(declaration));
		mark(cut >= 0 ? chain.slice(0, cut + 1) : chain, cut >= 0 ? "+" : "~");
		// A whole added declaration is its own detail; individual lines add nothing.
		if (cut < 0) attach(chain[chain.length - 1], row);
	}
	for (const declaration of removedWhole) {
		const chain = chainAt(before!.declarations, declaration.line);
		mark(chain.slice(0, chain.findIndex(candidate => removedWhole.has(candidate)) + 1), "−");
	}

	// New-side rows in source order; old-side rows follow the new-side line they sat at.
	const listed: Array<{ declaration: Declaration; marker: string; order: number }> = [];
	for (const declaration of after ? flattenDeclarations(after.declarations) : []) {
		const marker = marks.get(declaration);
		if (marker) listed.push({ declaration, marker, order: declaration.line });
	}
	for (const declaration of before ? flattenDeclarations(before.declarations) : []) {
		const marker = marks.get(declaration);
		if (!marker) continue;
		const row = rows.find(candidate => candidate.oldLine >= declaration.line && candidate.oldLine <= declaration.endLine);
		listed.push({ declaration, marker, order: (row?.newLine ?? declaration.line) + 0.5 });
	}
	listed.sort((a, b) => a.order - b.order);
	const changed = listed.filter(row => row.marker !== " ").length + (topLevelAdds + topLevelDels > 0 ? 1 : 0);
	if (changed === 0) return undefined;
	// Detail lines sit under their row at depth + 1; the collapsed card drops them.
	const output = [`${label} · ${changed} decl${changed === 1 ? "" : "s"} changed · +${adds} −${dels}`];
	const pushDetails = (key: Declaration | "top", depth: number) => {
		for (const line of detailsFor.get(key) ?? []) output.push(`${"  ".repeat(depth + 1)}   ${line}`);
	};
	if (topLevelAdds + topLevelDels > 0) {
		const counts = [topLevelAdds > 0 ? `+${topLevelAdds}` : "", topLevelDels > 0 ? `−${topLevelDels}` : ""].filter(Boolean).join(" ");
		output.push(` ~ (top level)  (${counts})`);
		pushDetails("top", 0);
	}
	for (const { declaration, marker } of listed) {
		const size = marker === "+" || marker === "−" ? `  (${marker}${declaration.endLine - declaration.line + 1})` : "";
		output.push(` ${marker} ${"  ".repeat(declaration.depth)}${declaration.signature}${size}`);
		if (marker === "~") pushDetails(declaration, declaration.depth);
	}
	return output;
}
