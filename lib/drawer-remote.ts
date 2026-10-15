import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { drawerSession, listMcpResources, readDrawerResource } from "./drawer-host";
import type { DrawerResource, McpResourceRow } from "./drawer-host";
import type { DrawerAdapter, DrawerEntry, DrawerPage, DrawerRequest, DrawerSection } from "./drawer-types";
import { drawerScheme } from "./drawer-types";

/**
 * Browse/inspect adapters for OMP's remote and local-registry internal URLs:
 * `issue://`, `pr://`, `ssh://`, `mcp://`, `security://`, and `conflict://`.
 *
 * Every page is built from authoritative host output, never a hand-written stub:
 *
 * - Remote schemes (`issue`, `pr`, `ssh`, `mcp`) call `readDrawerResource` only when the caller
 *   passes `request.fetch` (the shell's explicit Fetch control). Without it the adapter serves the
 *   last explicit fetch from its cache and sets `needsFetch`, so typing or focusing a URL never
 *   reaches GitHub, an SSH host, or an MCP server on its own.
 * - Local schemes (`security`, `conflict`) read the stored store / session registry through the same
 *   host reader, with no Fetch gate. They never start a scan, apply a conflict, write over SSH, or
 *   invoke a tool. `conflict://` enumerates the caller's live `ConflictHistory` — the exact registry
 *   `read <path>:conflicts` fills and `write conflict://<N>` resolves against — via the real
 *   `ToolSession` `drawerSession(ctx)` recovers, then reads each block through the host reader. A
 *   session with no registered conflicts reports that, never invented entries.
 *
 * The native protocol handlers own redaction and sanitization; this module parses their rendered
 * text into `DrawerEntry[]`/`DrawerSection[]` and caps every output. It never unescapes or rewrites
 * host content.
 */

export type DrawerResourceReader = (
	uri: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
) => Promise<DrawerResource>;

/** A registered merge-conflict block, projected from the session's live `ConflictHistory`. */
export type ConflictBlockView = {
	id: number;
	absolutePath: string;
	displayPath: string;
	startLine: number;
	endLine: number;
	hasBase: boolean;
	oursLabel?: string;
	theirsLabel?: string;
	baseLabel?: string;
};

/**
 * Enumerate and read the calling session's registered merge-conflict blocks. Split out so tests can
 * drive the drawer without a live host; `liveConflictSource` is the production implementation.
 */
export type ConflictSource = {
	/** Registered blocks in id order; `[]` when the session has none (or no live session). */
	list(ctx: ExtensionContext): readonly ConflictBlockView[];
	/** Resolve `conflict://<N>[/<scope>]` through the host handler, with the live session as caller. */
	read(uri: string, ctx: ExtensionContext, signal: AbortSignal): Promise<DrawerResource>;
};

/**
 * The production conflict source. `drawerSession(ctx)` recovers the caller's real `ToolSession`, whose
 * `conflictHistory` is the same object `read <path>:conflicts` fills and `write conflict://<N>`
 * resolves against, so `entries()` observes live registrations and resolves through the host reader
 * with that session as the caller.
 */
export const liveConflictSource: ConflictSource = {
	list(ctx) {
		const history = drawerSession(ctx)?.conflictHistory;
		if (!history) return [];
		return history.entries().map(entry => ({
			id: entry.id,
			absolutePath: entry.absolutePath,
			displayPath: entry.displayPath,
			startLine: entry.startLine,
			endLine: entry.endLine,
			hasBase: entry.baseLine !== undefined,
			...(entry.oursLabel !== undefined ? { oursLabel: entry.oursLabel } : {}),
			...(entry.theirsLabel !== undefined ? { theirsLabel: entry.theirsLabel } : {}),
			...(entry.baseLabel !== undefined ? { baseLabel: entry.baseLabel } : {}),
		}));
	},
	read: (uri, ctx, signal) => readDrawerResource(uri, ctx, signal),
};

const MAX_SECTION_LINES = 180;
const MAX_SECTION_LINE_CHARS = 400;
const MAX_ENTRIES = 250;
const CACHE_MAX = 64;

type CachedResource = { at: number; resource: DrawerResource };

/* -------------------------------------------------------------------------- */
/*                              shared utilities                              */
/* -------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clipLine(line: string): string {
	return line.length > MAX_SECTION_LINE_CHARS ? `${line.slice(0, MAX_SECTION_LINE_CHARS - 1)}…` : line;
}

/** Split text into lines, cap the count, clip each line, and note what was dropped. */
function boundedLines(text: string, max = MAX_SECTION_LINES): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const kept = lines.slice(0, max).map(clipLine);
	if (lines.length > kept.length) kept.push(`… ${lines.length - kept.length} more lines`);
	return kept;
}

/**
 * Markdown-ish content as sections split on `#`..`###` headings, bounded across the whole page.
 * A heading never becomes its own empty section, and the total line budget is shared.
 */
function contentSections(text: string, fallbackTitle: string): DrawerSection[] {
	const out: DrawerSection[] = [];
	let title = fallbackTitle;
	let buffer: string[] = [];
	let budget = MAX_SECTION_LINES;
	const flush = (): void => {
		if (buffer.length === 0 || !buffer.some(line => line.trim() !== "")) {
			buffer = [];
			return;
		}
		const kept = buffer.slice(0, Math.max(0, budget)).map(clipLine);
		if (buffer.length > kept.length) kept.push(`… ${buffer.length - kept.length} more lines`);
		budget -= kept.length;
		out.push({ title, lines: kept });
		buffer = [];
	};
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (budget <= 0) break;
		const heading = /^\s{0,3}#{1,3}\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			title = heading[1].trim() || fallbackTitle;
			continue;
		}
		buffer.push(line);
	}
	flush();
	return out;
}

/** Append one bounded content section plus any host notes for a resolved resource. */
function appendResource(sections: DrawerSection[], resource: DrawerResource | undefined, fallbackTitle: string): void {
	if (!resource) return;
	sections.push(...contentSections(resource.content, fallbackTitle));
	if (resource.notes && resource.notes.length > 0) {
		sections.push({ title: "Notes", lines: boundedLines(resource.notes.join("\n"), 20) });
	}
}

function formatAge(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function capEntries(entries: DrawerEntry[], sections: DrawerSection[]): DrawerEntry[] {
	if (entries.length <= MAX_ENTRIES) return entries;
	sections.push({
		title: "Truncated",
		lines: [`Showing first ${MAX_ENTRIES} of ${entries.length} entries. Fetch a narrower view.`],
	});
	return entries.slice(0, MAX_ENTRIES);
}

type UriParts = { segments: string[]; query: string };

/**
 * Split `scheme://a/b?x#y` into decoded path segments and the raw query. Uses the scheme prefix
 * literally so percent-escapes survive to `decodeURIComponent`.
 */
function splitUri(uri: string, scheme: string): UriParts {
	const prefix = `${scheme}://`;
	const rest = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
	const queryAt = rest.indexOf("?");
	const withoutQuery = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
	const query = queryAt >= 0 ? rest.slice(queryAt) : "";
	const hashAt = withoutQuery.indexOf("#");
	const path = hashAt >= 0 ? withoutQuery.slice(0, hashAt) : withoutQuery;
	const segments: string[] = [];
	for (const raw of path.split("/")) {
		if (raw === "") continue;
		try {
			segments.push(decodeURIComponent(raw));
		} catch {
			segments.push(raw);
		}
	}
	return { segments, query };
}

/** Append one percent-encoded path segment to a directory URI, dropping any query/fragment. */
function childUri(directoryUri: string, name: string): string {
	const cut = directoryUri.search(/[?#]/);
	const base = cut >= 0 ? directoryUri.slice(0, cut) : directoryUri;
	return `${base.endsWith("/") ? base : `${base}/`}${encodeURIComponent(name)}`;
}

/** Parent URI from decoded segments; `ssh` keeps a trailing slash so a parent stays a directory. */
function parentUri(scheme: string, segments: readonly string[]): string {
	if (segments.length <= 1) return `${scheme}://`;
	const encoded = segments.slice(0, -1).map(encodeURIComponent).join("/");
	return scheme === "ssh" ? `${scheme}://${encoded}/` : `${scheme}://${encoded}`;
}

function errorSections(title: string, error: string): DrawerSection[] {
	return [{ title, lines: boundedLines(error, 40) }];
}

/** Type guard that also matches the host's positive-decimal segment check. */
function isNumeric(text: string | undefined): boolean {
	return text !== undefined && /^\d+$/.test(text);
}

/* -------------------------------------------------------------------------- */
/*                              authoritative parsing                         */
/* -------------------------------------------------------------------------- */

/**
 * Parse the host's `issue://`/`pr://` list rendering back into entries.
 *
 * Each item is `- [state] #N  @author  updated`, then an indented title (with an optional
 * `  labels: …` suffix), then the item's own URL. The URL line is authoritative for the target.
 */
export function parseIssuePrEntries(content: string): DrawerEntry[] {
	const entries: DrawerEntry[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const head = /^- \[([^\]]+)\]\s+#(\d+)\s+@(\S+)\s*(.*)$/.exec(lines[i].trimEnd());
		if (!head) continue;
		let uri = "";
		let title = "";
		for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
			const text = lines[j].trim();
			if (text === "") continue;
			if (/^(?:issue|pr):\/\//.test(text)) {
				uri = text;
				break;
			}
			if (title === "") title = text;
		}
		if (uri === "") continue;
		let labels = "";
		const labelAt = title.indexOf("  labels: ");
		if (labelAt >= 0) {
			labels = title.slice(labelAt + "  labels: ".length).trim();
			title = title.slice(0, labelAt).trim();
		}
		const description = [head[1].trim(), `@${head[3]}`, head[4].trim(), labels ? `labels: ${labels}` : ""]
			.filter(part => part !== "")
			.join(" · ");
		entries.push({ uri, label: `#${head[2]} ${title}`.trim(), description, kind: "resource" });
	}
	return entries;
}

/** Parse the host's `pr://…/diff` file listing: `N. path  +a -d  [type]  (renamed from old)` + URL. */
export function parsePrDiffEntries(content: string): DrawerEntry[] {
	const entries: DrawerEntry[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const head = /^(\d+)\.\s+(.*)$/.exec(lines[i].trimEnd());
		if (!head) continue;
		let uri = "";
		for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
			const text = lines[j].trim();
			if (text === "") continue;
			if (/^pr:\/\//.test(text)) uri = text;
			break;
		}
		if (uri === "") continue;
		let rest = head[2];
		let rename = "";
		const renamed = /\s\s\(renamed from (.+)\)$/.exec(rest);
		if (renamed) {
			rename = renamed[1];
			rest = rest.slice(0, renamed.index);
		}
		const stats = /^(.*?)\s\s(\(binary\)|\+\d+ -\d+)\s\s\[([^\]]+)\]$/.exec(rest);
		const description = [stats ? stats[2] : "", stats ? stats[3] : "", rename ? `renamed from ${rename}` : ""]
			.filter(part => part !== "")
			.join(" · ");
		entries.push({
			uri,
			label: stats ? stats[1] : rest,
			description: description === "" ? undefined : description,
			kind: "resource",
		});
	}
	return entries;
}

/** Parse the host's bare `ssh://` host index (`- [name](ssh://name/) — \`addr\` (desc)`). */
export function parseSshHostEntries(content: string): DrawerEntry[] {
	const entries: DrawerEntry[] = [];
	for (const line of content.split(/\r?\n/)) {
		const match = /^- \[([^\]]+)\]\((ssh:\/\/[^)]+)\)(.*)$/.exec(line.trimEnd());
		if (!match) continue;
		const description = match[3]
			.replace(/^\s*—\s*/, "")
			.replace(/^`([^`]*)`/, "$1")
			.trim();
		entries.push({
			uri: match[2],
			label: match[1],
			description: description === "" ? undefined : description,
			kind: "collection",
		});
	}
	return entries;
}

/** Parse a host directory listing (directories first, `name/`, then files) into child entries. */
export function parseDirectoryEntries(content: string, directoryUri: string): DrawerEntry[] {
	const entries: DrawerEntry[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (line === "" || line === "(empty directory)") continue;
		if (line.endsWith("/")) {
			const name = line.slice(0, -1);
			entries.push({ uri: `${childUri(directoryUri, name)}/`, label: name, kind: "collection" });
		} else {
			entries.push({ uri: childUri(directoryUri, line), label: line, kind: "resource" });
		}
	}
	return entries;
}

/** Parse `security://scans` (`- \`id\` — status; N finding(s); producer; createdAt`). */
export function parseSecurityScanEntries(content: string): DrawerEntry[] {
	const entries: DrawerEntry[] = [];
	for (const line of content.split(/\r?\n/)) {
		const match = /^- `([^`]+)`\s*—\s*(.*)$/.exec(line.trimEnd());
		if (!match) continue;
		const description = match[2].trim();
		entries.push({
			uri: `security://scans/${encodeURIComponent(match[1])}`,
			label: match[1],
			description: description === "" ? undefined : description,
			kind: "resource",
		});
	}
	return entries;
}

/** Parse `security://scans/<id>/findings` (`- \`id\` **sev** — title (\`rule\`)`). */
export function parseSecurityFindingEntries(content: string, scanId: string): DrawerEntry[] {
	const entries: DrawerEntry[] = [];
	for (const line of content.split(/\r?\n/)) {
		const match = /^- `([^`]+)`\s+\*\*([^*]+)\*\*\s*—\s*(.*)$/.exec(line.trimEnd());
		if (!match) continue;
		const tail = match[3];
		let title = tail;
		let rule = "";
		const ruleAt = tail.lastIndexOf(" (`");
		if (ruleAt >= 0 && tail.endsWith("`)")) {
			rule = tail.slice(ruleAt + " (`".length, -"`)".length);
			title = tail.slice(0, ruleAt);
		}
		entries.push({
			uri: `security://scans/${encodeURIComponent(scanId)}/findings/${encodeURIComponent(match[1])}`,
			label: title.trim() === "" ? match[1] : title.trim(),
			description: [match[2].trim(), rule].filter(part => part !== "").join(" · "),
			kind: "resource",
		});
	}
	return entries;
}

/* -------------------------------------------------------------------------- */
/*                                issue / pr                                  */
/* -------------------------------------------------------------------------- */

type ItemView =
	| { kind: "list"; repo?: string; query: string }
	| { kind: "single"; repo?: string; number: number; query: string };

type PrDiffView =
	| { kind: "diff-list"; repo?: string; number: number }
	| { kind: "diff-all"; repo?: string; number: number }
	| { kind: "diff-slice"; repo?: string; number: number; index: number };

/** Split `issue://`/`pr://` into a list or single-item view, honoring the host's short form. */
function parseItemView(uri: string, scheme: "issue" | "pr"): ItemView {
	const { segments, query } = splitUri(uri, scheme);
	if (segments.length === 0) return { kind: "list", query };
	if (segments.length === 2 && !isNumeric(segments[0]) && !isNumeric(segments[1])) {
		return { kind: "list", repo: `${segments[0]}/${segments[1]}`, query };
	}
	if (segments.length === 1) return { kind: "single", number: Number(segments[0]), query };
	if (segments.length === 3) {
		return { kind: "single", repo: `${segments[0]}/${segments[1]}`, number: Number(segments[2]), query };
	}
	return { kind: "list", query };
}

function parsePrView(uri: string): ItemView | PrDiffView {
	const { segments, query } = splitUri(uri, "pr");
	let repo: string | undefined;
	let rest = segments;
	if (segments.length >= 2 && !isNumeric(segments[0]) && !isNumeric(segments[1])) {
		repo = `${segments[0]}/${segments[1]}`;
		rest = segments.slice(2);
	}
	if (rest.length >= 2 && rest[1] === "diff" && isNumeric(rest[0])) {
		const number = Number(rest[0]);
		if (rest.length === 2) return { kind: "diff-list", repo, number };
		if (rest.length === 3) {
			if (rest[2] === "all") return { kind: "diff-all", repo, number };
			return { kind: "diff-slice", repo, number, index: Number(rest[2]) };
		}
	}
	if (rest.length === 0) return { kind: "list", repo, query };
	if (rest.length === 1 && isNumeric(rest[0])) return { kind: "single", repo, number: Number(rest[0]), query };
	if (rest.length === 2 && !isNumeric(rest[0]) && !isNumeric(rest[1])) {
		return { kind: "list", repo: `${rest[0]}/${rest[1]}`, query };
	}
	if (rest.length === 3 && isNumeric(rest[2])) {
		return { kind: "single", repo: `${rest[0]}/${rest[1]}`, number: Number(rest[2]), query };
	}
	return { kind: "list", repo, query };
}

/* -------------------------------------------------------------------------- */
/*                              page construction                             */
/* -------------------------------------------------------------------------- */

type FetchState = "fetched" | "cached" | "missing" | "error";

type RemoteRead = { resource?: DrawerResource; state: FetchState; error?: string; at?: number };

async function remoteRead(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
	cache: Map<string, CachedResource>,
): Promise<RemoteRead> {
	// Cache identity is the session, not the URL: two agents (or two sessions in one project) must
	// never serve each other's fetched bytes. `agent.id` is the registry key; the session file
	// distinguishes a restarted or branched session that reuses an id (and falls back to the id).
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? "";
	const key = `${ctx.agent.id}\u0000${ctx.cwd}\u0000${sessionFile}\u0000${uri}`;
	if (request.fetch) {
		try {
			const resource = await reader(uri, ctx, request.signal);
			const at = Date.now();
			if (cache.size >= CACHE_MAX) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(key, { at, resource });
			return { resource, state: "fetched", at };
		} catch (error) {
			return { state: "error", error: messageOf(error) };
		}
	}
	const cached = cache.get(key);
	if (cached) return { resource: cached.resource, state: "cached", at: cached.at };
	return { state: "missing" };
}

/** The status line and `needsFetch` for a remote page drawn from a fetch state. */
function remoteStatus(read: RemoteRead): { status: string; needsFetch: boolean } {
	switch (read.state) {
		case "fetched":
			return { status: "Fetched just now", needsFetch: false };
		case "cached":
			return { status: `Cached ${read.at ? formatAge(read.at) : "earlier"} — Fetch to refresh`, needsFetch: true };
		case "error":
			return { status: "Fetch failed — Fetch to retry", needsFetch: true };
		default:
			return { status: "Not fetched — press Fetch", needsFetch: true };
	}
}

function remoteNotice(read: RemoteRead, scheme: string, uri: string): DrawerSection[] {
	if (read.state === "error") return errorSections("Fetch failed", read.error ?? "unknown error");
	if (read.state === "missing") {
		return [
			{
				title: "Fetch needed",
				lines: [`Reads ${scheme}:// through the host's own handler.`, `Press Fetch to read ${uri}.`],
			},
		];
	}
	return [];
}

async function loadIssue(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
	cache: Map<string, CachedResource>,
): Promise<DrawerPage> {
	const view = parseItemView(uri, "issue");
	const read = await remoteRead(uri, ctx, request, reader, cache);
	const { status, needsFetch } = remoteStatus(read);
	const sections = remoteNotice(read, "issue", uri);

	if (view.kind === "single") {
		const entries: DrawerEntry[] = [];
		if (/[?&]comments=0(?:&|$)/.test(view.query)) {
			entries.push({
				uri: `${uri.replace(/[?#].*$/, "")}?comments=1`,
				label: "Include comments",
				kind: "resource",
			});
		}
		appendResource(sections, read.resource, `Issue #${view.number}`);
		return {
			uri,
			title: `Issue #${view.number}`,
			parent: view.repo ? `issue://${view.repo}` : "issue://",
			entries,
			sections,
			status,
			needsFetch,
		};
	}

	const entries: DrawerEntry[] = read.resource ? parseIssuePrEntries(read.resource.content) : [];
	appendResource(sections, read.resource, view.repo ? `Issues in ${view.repo}` : "Issues");
	sections.push({
		title: "Views",
		lines: [
			view.repo
				? `Filters: issue://${view.repo}?state=open|closed|all, ?limit=1-100, ?author=<login>, ?label=<name>`
				: "Add a repo: issue://<owner>/<repo> (short issue://<N> uses the session's default repo).",
			"Read one item: issue://<owner>/<repo>/<N> (add ?comments=0 to omit comments).",
		],
	});
	return {
		uri,
		title: view.repo ? `Issues in ${view.repo}` : "Issues",
		parent: "issue://",
		entries: capEntries(entries, sections),
		sections,
		status,
		needsFetch,
	};
}

async function loadPr(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
	cache: Map<string, CachedResource>,
): Promise<DrawerPage> {
	const view = parsePrView(uri);
	const read = await remoteRead(uri, ctx, request, reader, cache);
	const { status, needsFetch } = remoteStatus(read);
	const sections = remoteNotice(read, "pr", uri);

	if (view.kind === "single") {
		const base = view.repo ? `pr://${view.repo}/${view.number}` : `pr://${view.number}`;
		const entries: DrawerEntry[] = [
			{ uri: `${base}/diff`, label: "Files changed", description: "Browse files and hunks", kind: "collection" },
		];
		if (/[?&]comments=0(?:&|$)/.test(view.query)) {
			entries.push({
				uri: `${uri.replace(/[?#].*$/, "")}?comments=1`,
				label: "Include comments",
				kind: "resource",
			});
		}
		appendResource(sections, read.resource, `Pull Request #${view.number}`);
		return {
			uri,
			title: `Pull Request #${view.number}`,
			parent: view.repo ? `pr://${view.repo}` : "pr://",
			entries,
			sections,
			status,
			needsFetch,
		};
	}

	if (view.kind === "diff-list") {
		const base = view.repo ? `pr://${view.repo}/${view.number}` : `pr://${view.number}`;
		const entries = read.resource ? parsePrDiffEntries(read.resource.content) : [];
		entries.push({ uri: `${base}/diff/all`, label: "Full diff", kind: "collection" });
		appendResource(sections, read.resource, `PR #${view.number} diff`);
		return {
			uri,
			title: `PR #${view.number} diff`,
			parent: base,
			entries: capEntries(entries, sections),
			sections,
			status,
			needsFetch,
		};
	}

	if (view.kind === "diff-slice") {
		const base = view.repo ? `pr://${view.repo}/${view.number}/diff` : `pr://${view.number}/diff`;
		const entries: DrawerEntry[] = [{ uri: base, label: "All files", kind: "collection" }];
		if (view.index > 1) {
			entries.push({ uri: `${base}/${view.index - 1}`, label: `Previous file (#${view.index - 1})`, kind: "resource" });
		}
		entries.push({ uri: `${base}/${view.index + 1}`, label: `Next file (#${view.index + 1})`, kind: "resource" });
		appendResource(sections, read.resource, `File ${view.index}`);
		return {
			uri,
			title: `PR #${view.number} — file ${view.index}`,
			parent: base,
			entries,
			sections,
			status,
			needsFetch,
		};
	}

	if (view.kind === "diff-all") {
		const base = view.repo ? `pr://${view.repo}/${view.number}/diff` : `pr://${view.number}/diff`;
		appendResource(sections, read.resource, "Full diff");
		return {
			uri,
			title: `PR #${view.number} — full diff`,
			parent: base,
			entries: [{ uri: base, label: "All files", kind: "collection" }],
			sections,
			status,
			needsFetch,
		};
	}

	const entries: DrawerEntry[] = read.resource ? parseIssuePrEntries(read.resource.content) : [];
	appendResource(sections, read.resource, view.repo ? `Pull requests in ${view.repo}` : "Pull requests");
	sections.push({
		title: "Views",
		lines: [
			view.repo
				? `Filters: pr://${view.repo}?state=open|closed|all, ?limit=1-100, ?author=<login>, ?label=<name>`
				: "Add a repo: pr://<owner>/<repo> (short pr://<N> uses the session's default repo).",
			"Browse a diff: pr://<owner>/<repo>/<N>/diff (files) · /diff/all · /diff/<i>",
		],
	});
	return {
		uri,
		title: view.repo ? `Pull requests in ${view.repo}` : "Pull requests",
		parent: "pr://",
		entries: capEntries(entries, sections),
		sections,
		status,
		needsFetch,
	};
}

/* -------------------------------------------------------------------------- */
/*                                    ssh                                     */
/* -------------------------------------------------------------------------- */

async function loadSsh(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
	cache: Map<string, CachedResource>,
): Promise<DrawerPage> {
	const { segments } = splitUri(uri, "ssh");
	if (segments.length === 0) {
		const read = await remoteRead(uri, ctx, request, reader, cache);
		const { status, needsFetch } = remoteStatus(read);
		const sections = remoteNotice(read, "ssh", uri);
		const entries: DrawerEntry[] = read.resource ? parseSshHostEntries(read.resource.content) : [];
		appendResource(sections, read.resource, "SSH hosts");
		sections.push({
			title: "Direct",
			lines: ["Any OpenSSH destination works: ssh://host/etc/hosts or ssh://user@host:2222/var/log/"],
		});
		return {
			uri,
			title: "SSH hosts",
			entries: capEntries(entries, sections),
			sections,
			status,
			needsFetch,
		};
	}

	const read = await remoteRead(uri, ctx, request, reader, cache);
	const { status, needsFetch } = remoteStatus(read);
	const sections = remoteNotice(read, "ssh", uri);
	const parent = parentUri("ssh", segments);
	const entries: DrawerEntry[] = [];
	const isDirectory = read.resource?.isDirectory === true || uri.endsWith("/");
	if (isDirectory && read.resource) {
		entries.push(...parseDirectoryEntries(read.resource.content, uri));
	} else {
		appendResource(sections, read.resource, uri);
	}
	if (parent !== uri) entries.push({ uri: parent, label: "Parent directory", kind: "collection" });
	return {
		uri,
		title: uri,
		parent: parent === uri ? undefined : parent,
		entries: capEntries(entries, sections),
		sections,
		status,
		needsFetch,
	};
}

/* -------------------------------------------------------------------------- */
/*                                    mcp                                     */
/* -------------------------------------------------------------------------- */

async function loadMcp(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
	cache: Map<string, CachedResource>,
	mcpResources: (ctx: ExtensionContext) => Promise<readonly McpResourceRow[]>,
): Promise<DrawerPage> {
	if (/^mcp:\/\/\/?$/i.test(uri)) {
		try {
			const rows = await mcpResources(ctx);
			const sections: DrawerSection[] = [];
			const entries: DrawerEntry[] = rows.map(row => ({
				uri: `mcp://${row.uri}`,
				label: row.name && row.name !== row.uri ? row.name : row.uri,
				description: [row.server, row.isTemplate ? "template" : "", row.description ?? ""]
					.filter(part => part !== "")
					.join(" · "),
				kind: "resource",
			}));
			const byServer = new Map<string, number>();
			for (const row of rows) byServer.set(row.server, (byServer.get(row.server) ?? 0) + 1);
			for (const [server, count] of byServer) sections.push({ title: server, lines: [`${count} resource(s)`] });
			if (rows.length === 0) sections.push({ title: "MCP", lines: ["No connected server advertises resources."] });
			return {
				uri,
				title: "MCP resources",
				entries: capEntries(entries, sections),
				sections,
				status: `${rows.length} resource(s)`,
			};
		} catch (error) {
			return {
				uri,
				title: "MCP resources",
				entries: [],
				sections: errorSections("Enumerator failed", messageOf(error)),
				status: "Enumerator failed",
			};
		}
	}

	const read = await remoteRead(uri, ctx, request, reader, cache);
	const { status, needsFetch } = remoteStatus(read);
	const sections = remoteNotice(read, "mcp", uri);
	appendResource(sections, read.resource, "Resource");
	return { uri, title: uri, parent: "mcp://", entries: [], sections, status, needsFetch };
}

/* -------------------------------------------------------------------------- */
/*                                 security                                   */
/* -------------------------------------------------------------------------- */

async function readLocal(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
): Promise<{ resource?: DrawerResource; error?: string }> {
	try {
		return { resource: await reader(uri, ctx, request.signal) };
	} catch (error) {
		return { error: messageOf(error) };
	}
}

const SECURITY_RESOURCES = ["manifest", "findings", "coverage", "report", "sarif", "provenance"] as const;

async function loadSecurity(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	reader: DrawerResourceReader,
): Promise<DrawerPage> {
	const { segments } = splitUri(uri, "security");
	const read = await readLocal(uri, ctx, request, reader);
	const sections: DrawerSection[] = [];
	if (read.error) sections.push(...errorSections("security://", read.error));

	if (segments.length === 0) {
		appendResource(sections, read.resource, "Security");
		return {
			uri,
			title: "Security",
			entries: [{ uri: "security://scans", label: "Scans", description: "Stored scans", kind: "collection" }],
			sections,
			status: read.error ? "Unavailable" : "Read-only",
		};
	}

	if (segments[0] !== "scans") {
		return {
			uri,
			title: "Security",
			entries: [{ uri: "security://scans", label: "Scans", kind: "collection" }],
			sections: errorSections("Unknown resource", `security://${segments.join("/")}`),
			status: "Unknown",
		};
	}

	if (segments.length === 1) {
		const entries = read.resource ? parseSecurityScanEntries(read.resource.content) : [];
		appendResource(sections, read.resource, "Security scans");
		return {
			uri,
			title: "Security scans",
			parent: "security://",
			entries: capEntries(entries, sections),
			sections,
			status: read.error ? "Unavailable" : `${entries.length} scan(s)`,
		};
	}

	const scanId = segments[1];
	const scanBase = `security://scans/${encodeURIComponent(scanId)}`;
	if (segments.length === 2) {
		const entries: DrawerEntry[] = SECURITY_RESOURCES.map(name => ({
			uri: `${scanBase}/${name}`,
			label: name,
			kind: "resource",
		}));
		appendResource(sections, read.resource, `Scan ${scanId}`);
		return {
			uri,
			title: `Scan ${scanId}`,
			parent: "security://scans",
			entries,
			sections,
			status: read.error ? "Unavailable" : "Read-only",
		};
	}

	if (segments[2] === "findings" && segments.length === 3) {
		const entries = read.resource ? parseSecurityFindingEntries(read.resource.content, scanId) : [];
		appendResource(sections, read.resource, "Findings");
		return {
			uri,
			title: `Findings — ${scanId}`,
			parent: scanBase,
			entries: capEntries(entries, sections),
			sections,
			status: read.error ? "Unavailable" : `${entries.length} finding(s)`,
		};
	}

	const leaf = segments.slice(2).join("/");
	appendResource(sections, read.resource, `${scanId} — ${leaf}`);
	return {
		uri,
		title: `${scanId} — ${leaf}`,
		parent: scanBase,
		entries: [],
		sections,
		status: read.error ? "Unavailable" : leaf,
	};
}

/* -------------------------------------------------------------------------- */
/*                                 conflict                                   */
/* -------------------------------------------------------------------------- */

async function loadConflict(
	uri: string,
	ctx: ExtensionContext,
	request: DrawerRequest,
	conflicts: ConflictSource,
): Promise<DrawerPage> {
	const { segments } = splitUri(uri, "conflict");
	const sections: DrawerSection[] = [];

	let blocks: readonly ConflictBlockView[] = [];
	let listFailed = false;
	try {
		blocks = conflicts.list(ctx);
	} catch (error) {
		listFailed = true;
		sections.push(...errorSections("Conflict registry", messageOf(error)));
	}

	// Root and the write-only `conflict://*` wildcard: the session's live registered blocks.
	if (segments.length === 0 || segments[0] === "*") {
		const entries: DrawerEntry[] = blocks.map(block => ({
			uri: `conflict://${block.id}`,
			label: `${block.displayPath}:${block.startLine}-${block.endLine}`,
			kind: "resource",
		}));
		sections.push({
			title: "Registered conflicts",
			lines:
				blocks.length === 0
					? [
							"No conflict blocks are registered in this session.",
							"Read a conflicted file (or use the <path>:conflicts selector) to register blocks, then open conflict://<N>.",
						]
					: blocks.map(block => `#${block.id}  ${block.displayPath}:${block.startLine}-${block.endLine}`),
		});
		if (segments[0] === "*") {
			sections.push({
				title: "conflict://*",
				lines: ["The wildcard is write-only: a write resolves every registered block at once."],
			});
		}
		return {
			uri,
			title: "Merge conflicts",
			entries: capEntries(entries, sections),
			sections,
			status: listFailed ? "Unavailable" : `${blocks.length} registered`,
		};
	}

	const id = Number(segments[0]);
	if (!Number.isInteger(id) || id <= 0) {
		return {
			uri,
			title: "Merge conflicts",
			parent: "conflict://",
			entries: [],
			sections: [...sections, ...errorSections("Invalid id", `conflict://${segments.join("/")}`)],
			status: "Invalid",
		};
	}

	const base = `conflict://${id}`;
	const side = segments[1];
	const block = blocks.find(entry => entry.id === id);
	const entries: DrawerEntry[] = [];
	if (side === undefined) {
		entries.push({ uri: `${base}/ours`, label: "ours", kind: "resource" });
		entries.push({ uri: `${base}/theirs`, label: "theirs", kind: "resource" });
		if (block?.hasBase === true) entries.push({ uri: `${base}/base`, label: "base", kind: "resource" });
	}
	entries.push({ uri: "conflict://", label: "All conflicts", kind: "collection" });

	let readFailed = false;
	try {
		appendResource(sections, await conflicts.read(uri, ctx, request.signal), `Conflict #${id}${side ? ` — ${side}` : ""}`);
	} catch (error) {
		readFailed = true;
		sections.push(...errorSections("conflict://", messageOf(error)));
	}
	return {
		uri,
		title: `Conflict #${id}${side ? ` — ${side}` : ""}`,
		parent: side ? base : "conflict://",
		entries,
		sections,
		status: readFailed ? "Unavailable" : "Read-only",
	};
}

/* -------------------------------------------------------------------------- */
/*                                  adapter                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a remote/local adapter around an injected host reader, MCP enumerator, and conflict source.
 * Tests inject fakes; the exported `remoteDrawer` reads through `lib/drawer-host.ts` and enumerates
 * the calling session's live conflict registry.
 */
export function createRemoteDrawer(
	reader: DrawerResourceReader,
	mcpResources: (ctx: ExtensionContext) => Promise<readonly McpResourceRow[]> = listMcpResources,
	conflicts: ConflictSource = liveConflictSource,
): DrawerAdapter {
	const cache = new Map<string, CachedResource>();
	return {
		schemes: ["issue", "pr", "ssh", "mcp", "security", "conflict"] as const,
		async load(uri, ctx, request: DrawerRequest): Promise<DrawerPage> {
			try {
				switch (drawerScheme(uri)) {
					case "issue":
						return await loadIssue(uri, ctx, request, reader, cache);
					case "pr":
						return await loadPr(uri, ctx, request, reader, cache);
					case "ssh":
						return await loadSsh(uri, ctx, request, reader, cache);
					case "mcp":
						return await loadMcp(uri, ctx, request, reader, cache, mcpResources);
					case "security":
						return await loadSecurity(uri, ctx, request, reader);
					case "conflict":
						return await loadConflict(uri, ctx, request, conflicts);
					default:
						return {
							uri,
							title: uri,
							entries: [],
							sections: [
								{
									title: "Unsupported",
									lines: ["This adapter handles issue, pr, ssh, mcp, security, and conflict URLs."],
								},
							],
							status: "Unsupported",
						};
				}
			} catch (error) {
				return {
					uri,
					title: uri,
					entries: [],
					sections: errorSections("Drawer error", messageOf(error)),
					status: "Error",
				};
			}
		},
	};
}

/** The production adapter: bounded reads through the host's internal-URL router. */
export const remoteDrawer: DrawerAdapter = createRemoteDrawer(readDrawerResource);
