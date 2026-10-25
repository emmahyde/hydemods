import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileHyperlink } from "@oh-my-pi/pi-tui/render/hyperlink";

/**
 * Bare filesystem paths in rendered rows → OSC 8 `file://` links. Markdown only links `[x](y)`,
 * `<autolinks>` and bare http(s) URLs, so a path in prose or a code span stays dead text. This pass
 * runs on the final rows: it finds path-like tokens in the visible text (ANSI stripped, so a path
 * that spans colour changes still matches), keeps those that exist on disk, and wraps them without
 * changing the row's visible width. A path the wrapper hard-broke across two rows is joined back
 * and both halves link to the same file.
 */

/** CSI/OSC escape sequences. */
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Path-like token: no whitespace, quotes, brackets or backticks. Validated further below. */
const TOKEN = /[^\s"'`()<>\[\]{}|,;]+/g;
/** `path:12` or `path:12:3` (grep/compiler style), and `path#L12`. */
const LOCATION = /(?::(\d+)(?::(\d+))?|#L(\d+))$/;
const TRAILING = /[.,;:!?*_~]+$/;
/** Markdown emphasis left glued to a token; `~/` is a home path, not strikethrough. */
const LEADING = /^(?:[*_]|~(?!\/))+/;

type Visible = { text: string; raw: number[]; linked: boolean[] };

/** Visible text of `row` with, per visible char, its raw offset and whether it already sits in an OSC 8 link. */
function visible(row: string): Visible {
	const out: Visible = { text: "", raw: [], linked: [] };
	let inLink = false;
	let last = 0;
	const take = (end: number) => {
		for (let i = last; i < end; i++) { out.text += row[i]; out.raw.push(i); out.linked.push(inLink); }
	};
	for (const match of row.matchAll(ESCAPE)) {
		take(match.index);
		const sequence = match[0];
		if (sequence.startsWith("\x1b]8;")) inLink = !/^\x1b\]8;;(?:\x07|\x1b\\)$/.test(sequence);
		last = match.index + sequence.length;
	}
	take(row.length);
	return out;
}

export type PathResolver = (token: string) => string | undefined;

/**
 * Absolute path for `token` when it names an existing file or directory, else undefined. Only
 * tokens that look like paths are checked (a slash, a `~/` prefix, or a `name.ext` filename).
 * A hit is cached so a repaint never re-stats it. A miss is cached for `missMs` only: a row for a
 * write paints before its file exists, and must link once the write lands.
 */
export function createPathResolver(cwd: () => string, exists: (path: string) => boolean = defaultExists, limit = 2000, missMs = 1000, now: () => number = Date.now): PathResolver {
	const cache = new Map<string, { path: string | undefined; at: number }>();
	return token => {
		const base = cwd();
		const key = `${base}\0${token}`;
		const cached = cache.get(key);
		if (cached && (cached.path || now() - cached.at < missMs)) return cached.path;
		let result: string | undefined;
		if (looksLikePath(token)) {
			const expanded = token === "~" || token.startsWith("~/") ? homedir() + token.slice(1) : token;
			const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
			if (exists(absolute)) result = absolute;
		}
		cache.delete(key);
		if (cache.size >= limit) cache.delete(cache.keys().next().value!);
		cache.set(key, { path: result, at: now() });
		return result;
	};
}

function defaultExists(path: string): boolean {
	try { statSync(path); return true; } catch { return false; }
}

function looksLikePath(token: string): boolean {
	if (token.length < 3 || token.includes("://") || token.includes("@") && !token.includes("/")) return false;
	if (token.startsWith("~/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("/")) return token.length > 1 && !/^\/+$/.test(token);
	if (token.includes("/")) return /[A-Za-z0-9]/.test(token);
	// A bare filename needs an extension that starts with a letter: `index.ts`, not `1.5` or `e.g`.
	return /^[\w@+-][\w.@+-]*\.[A-Za-z][\w-]{0,9}$/.test(token);
}

type Hit = { start: number; end: number; path: string; line?: number; col?: number };

/** Strip markdown/punctuation decoration and a location suffix from a raw token at `offset`. */
function parseToken(raw: string, offset: number): { start: number; end: number; path: string; line?: number; col?: number } | undefined {
	let start = offset;
	let text = raw;
	const lead = LEADING.exec(text)?.[0].length ?? 0;
	text = text.slice(lead);
	start += lead;
	text = text.replace(TRAILING, "");
	if (!text) return undefined;
	const end = start + text.length;
	const location = LOCATION.exec(text);
	if (location) {
		const line = Number(location[1] ?? location[3]);
		const col = location[2] === undefined ? undefined : Number(location[2]);
		return { start, end, path: text.slice(0, location.index), line, col };
	}
	return { start, end, path: text };
}

function hits(text: string, resolvePath: PathResolver): Hit[] {
	const found: Hit[] = [];
	for (const match of text.matchAll(TOKEN)) {
		const parsed = parseToken(match[0], match.index);
		if (!parsed) continue;
		const absolute = resolvePath(parsed.path);
		if (absolute) found.push({ ...parsed, path: absolute });
	}
	return found;
}

export type FileWrap = (path: string, text: string, opts?: { line?: number; col?: number }) => string;

/** OSC 8 open/close for `path` from `wrap` (pi-tui's policy-aware `fileHyperlink`); empty when links are off. */
function markers(wrap: FileWrap, path: string, line?: number, col?: number): [string, string] {
	const wrapped = wrap(path, "\u0000", line === undefined ? undefined : { line, col });
	const at = wrapped.indexOf("\u0000");
	return at <= 0 ? ["", ""] : [wrapped.slice(0, at), wrapped.slice(at + 1)];
}

/** Insert link markers around visible ranges of `row`, skipping ranges already inside a link. */
function apply(row: string, view: Visible, ranges: readonly Hit[], wrap: FileWrap): string {
	const inserts: { at: number; text: string }[] = [];
	for (const range of ranges) {
		if (range.end <= range.start || view.linked.slice(range.start, range.end).some(Boolean)) continue;
		const [open, close] = markers(wrap, range.path, range.line, range.col);
		if (!open) continue;
		inserts.push({ at: view.raw[range.start]!, text: open }, { at: view.raw[range.end - 1]! + 1, text: close });
	}
	if (inserts.length === 0) return row;
	inserts.sort((a, b) => a.at - b.at);
	let out = "";
	let last = 0;
	for (const insert of inserts) { out += row.slice(last, insert.at) + insert.text; last = insert.at; }
	return out + row.slice(last);
}

/** Link every existing path in `rows`, including a path hard-wrapped across two adjacent rows. */
export function linkPathRows(rows: readonly string[], resolvePath: PathResolver, wrap: FileWrap = fileHyperlink): string[] {
	if (!rows.some(row => /[/.~]/.test(row))) return [...rows];
	const views = rows.map(visible);
	const ranges: Hit[][] = views.map(view => (/[/.~]/.test(view.text) ? hits(view.text, resolvePath) : []));
	for (let i = 0; i + 1 < views.length; i++) {
		const tail = /[^\s"'`()<>\[\]{}|,;]+$/.exec(views[i]!.text.trimEnd());
		const nextText = views[i + 1]!.text;
		const head = /^(\s*)([^\s"'`()<>\[\]{}|,;]+)/.exec(nextText);
		if (!tail || !head) continue;
		const tailStart = tail.index;
		const tailEnd = tailStart + tail[0].length;
		const headStart = head[1]!.length;
		const headEnd = headStart + head[2]!.length;
		// Only join when the left half is not already a complete path on its own row.
		if (ranges[i]!.some(hit => hit.end === tailEnd || hit.start === tailStart)) continue;
		const parsed = parseToken(tail[0] + head[2]!, 0);
		if (!parsed || parsed.start >= tail[0].length) continue;
		const absolute = resolvePath(parsed.path);
		if (!absolute) continue;
		const split = tail[0].length;
		const hit = { path: absolute, line: parsed.line, col: parsed.col };
		ranges[i] = ranges[i]!.filter(range => range.end <= tailStart);
		ranges[i]!.push({ ...hit, start: tailStart + parsed.start, end: tailEnd });
		ranges[i + 1] = ranges[i + 1]!.filter(range => range.start >= headEnd);
		ranges[i + 1]!.unshift({ ...hit, start: headStart, end: headStart + Math.min(head[2]!.length, parsed.end - split) });
	}
	return rows.map((row, index) => apply(row, views[index]!, ranges[index]!, wrap));
}
