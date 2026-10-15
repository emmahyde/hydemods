import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { drawerResolveContext, drawerSession, listDrawerResources, readDrawerResource } from "./drawer-host";
import { drawerScheme, type DrawerAdapter, type DrawerEntry, type DrawerPage, type DrawerScheme } from "./drawer-types";

/**
 * Content-scheme drawers: `memory://`, `artifact://`, `local://`, `attachment://`, `skill://`,
 * `rule://`, `omp://`.
 *
 * Roots enumerate through the host's own `complete()` (via `listDrawerResources`). File-backed
 * leaves locate their path and read a bounded 16 KiB prefix, so a whole binary, database, or
 * oversized artifact is never materialized. Virtual leaves (attachments, rules, embedded docs,
 * mnemopi `memory://<id>` rows) resolve through `readDrawerResource`, which is itself bounded and
 * returns the handler's text projection — never an image body. No scheme here is remote:
 * `request.fetch` is ignored and `needsFetch` is never set.
 */

/** One directory entry after a bounded scan. */
type DirEntry = { name: string; isDirectory: boolean };

/** `locate()` outcome: a path, or the handler's own error message when locating failed. */
type LocateResult = { path: string | null; error?: string };

const SCHEMES = ["memory", "artifact", "local", "attachment", "skill", "rule", "omp"] as const;
const MAX_ENTRIES = 100;
const MAX_EXCERPT_LINES = 40;
const MAX_EXCERPT_CHARS = 4_000;
const PREVIEW_BYTES = 16 * 1024;

/** Extensions whose bytes are never previewed as text. */
const BINARY_EXTENSIONS: Record<string, true> = {
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".bmp": true, ".tiff": true, ".avif": true,
	".pdf": true, ".zip": true, ".gz": true, ".tar": true, ".bz2": true, ".xz": true, ".7z": true, ".rar": true,
	".woff": true, ".woff2": true, ".ttf": true, ".otf": true, ".mp3": true, ".mp4": true, ".mov": true, ".avi": true, ".webm": true,
	".wasm": true, ".so": true, ".dylib": true, ".dll": true, ".exe": true, ".o": true, ".a": true, ".class": true, ".jar": true, ".bin": true,
};

/** Database extensions shown as metadata only, regardless of their bytes. */
const DATABASE_EXTENSIONS: Record<string, true> = { ".db": true, ".sqlite": true, ".sqlite3": true, ".duckdb": true, ".mdb": true, ".ldb": true };

/** Extension -> mime for text previews. */
const TEXT_CONTENT_TYPES: Record<string, string> = { ".md": "text/markdown", ".json": "application/json" };

/** Append one URL-encoded path segment to a scheme root (`local://`) or a nested URI (`local://a/b`). */
function joinUri(base: string, name: string): string {
	return base.endsWith("://") ? `${base}${encodeURIComponent(name)}` : `${base.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
}

/** Parent of a node URI, or undefined for a scheme root. */
function parentUri(uri: string): string | undefined {
	const trimmed = uri.replace(/\/+$/, "");
	const schemeEnd = trimmed.indexOf("://");
	if (schemeEnd < 0) return undefined;
	const authorityEnd = schemeEnd + 3;
	const idx = trimmed.lastIndexOf("/");
	if (idx < authorityEnd) return trimmed.slice(0, authorityEnd);
	return trimmed.slice(0, idx);
}

/** Cap an excerpt to `MAX_EXCERPT_LINES` lines and `MAX_EXCERPT_CHARS` characters, reporting the total. */
export function boundedLines(content: string): { lines: string[]; total: number } {
	const all = content.split("\n");
	const shown: string[] = [];
	let chars = 0;
	for (const line of all.slice(0, MAX_EXCERPT_LINES)) {
		if (chars + line.length > MAX_EXCERPT_CHARS) {
			shown.push("…");
			break;
		}
		shown.push(line);
		chars += line.length + 1;
	}
	if (shown.length < all.length && shown[shown.length - 1] !== "…") shown.push(`… ${all.length - shown.length} more line(s)`);
	return { lines: shown, total: all.length };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function missingPage(uri: string, title: string, reason: string): DrawerPage {
	return { uri, title, entries: [], sections: [], status: reason, parent: parentUri(uri) };
}

/** `router.locate` with the drawer's shared context; never throws, so callers can surface the reason. */
async function locateForPage(
	uri: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	directory: boolean,
): Promise<LocateResult> {
	try {
		return {
			path: await InternalUrlRouter.instance().locate(uri, drawerResolveContext(ctx, signal), directory ? { directory: true } : undefined),
		};
	} catch (error) {
		return { path: null, error: errorMessage(error) };
	}
}

/** Read at most `maxBytes` from the start of `file`; never loads the whole file. */
async function readPrefix(file: string, maxBytes: number): Promise<Buffer> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function metadataLines(filePath: string | null): Promise<string[]> {
	if (!filePath) return [];
	try {
		const stat = await fs.stat(filePath);
		return [`size: ${formatBytes(stat.size)}`, `modified: ${new Date(stat.mtimeMs).toISOString()}`, `path: ${filePath}`];
	} catch {
		return [`path: ${filePath}`];
	}
}

/** A bounded directory scan: stop at the entry cap instead of reading the whole directory. */
async function listDirectoryPage(uri: string, title: string, directory: string, baseUri: string): Promise<DrawerPage> {
	const kept: DirEntry[] = [];
	let partial = false;
	try {
		const dir = await fs.opendir(directory);
		for await (const dirent of dir) {
			if (kept.length >= MAX_ENTRIES) {
				partial = true;
				break;
			}
			kept.push({ name: dirent.name, isDirectory: dirent.isDirectory() });
		}
	} catch (error) {
		return missingPage(uri, title, `Cannot list ${uri}: ${errorMessage(error)}`);
	}
	kept.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	const entries: DrawerEntry[] = kept.map(child => ({
		uri: joinUri(baseUri, child.name),
		label: child.name,
		description: child.isDirectory ? "directory" : "file",
		kind: child.isDirectory ? "collection" : "resource",
	}));
	const status = entries.length === 0 ? "empty directory" : partial ? `first ${entries.length} entries (more not listed)` : `${entries.length} entries`;
	return { uri, title, entries, sections: [], status, parent: parentUri(uri), refreshMs: 5_000 };
}

/** Metadata-only view of a file whose bytes are not previewed (binary or database). */
async function metadataOnlyPage(uri: string, filePath: string, reason: string): Promise<DrawerPage> {
	return { uri, title: uri, entries: [], sections: [{ title: "Source", lines: await metadataLines(filePath) }], status: reason, parent: parentUri(uri) };
}

/** A file preview from a bounded prefix; binary, database, and NUL-bearing files show metadata only. */
async function boundedFilePage(uri: string, filePath: string): Promise<DrawerPage> {
	let stat: Stats;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		return missingPage(uri, uri, `Cannot stat ${uri}: ${errorMessage(error)}`);
	}
	const extension = path.extname(filePath).toLowerCase();
	if (DATABASE_EXTENSIONS[extension] === true) {
		return metadataOnlyPage(uri, filePath, `database file (${extension}) — content not previewed`);
	}
	if (BINARY_EXTENSIONS[extension] === true) {
		return metadataOnlyPage(uri, filePath, `binary file (${extension}) — content not previewed`);
	}
	let prefix: Buffer;
	try {
		prefix = await readPrefix(filePath, PREVIEW_BYTES);
	} catch (error) {
		return metadataOnlyPage(uri, filePath, `Cannot read ${uri}: ${errorMessage(error)}`);
	}
	if (prefix.includes(0)) return metadataOnlyPage(uri, filePath, "binary file — content not previewed");

	const { lines, total } = boundedLines(prefix.toString("utf8"));
	const truncated = stat.size > prefix.length;
	const contentType = TEXT_CONTENT_TYPES[extension] ?? "text/plain";
	const status = `${contentType} · ${lines.length} of ${total} line(s)${truncated ? " (first 16 KiB)" : ""}`;
	return {
		uri,
		title: uri,
		entries: [],
		sections: [
			{ title: "Content", lines },
			{ title: "Source", lines: await metadataLines(filePath) },
		],
		status,
		parent: parentUri(uri),
	};
}

/** Resolve a virtual resource through the host router and show its bounded projection. */
async function resolveExcerptPage(uri: string, ctx: ExtensionContext, signal: AbortSignal, locatedPath: string | null): Promise<DrawerPage> {
	let excerpt: { content: string; contentType?: string };
	try {
		excerpt = await readDrawerResource(uri, ctx, signal);
	} catch (error) {
		const meta = await metadataLines(locatedPath);
		return { uri, title: uri, entries: [], sections: meta.length ? [{ title: "Source", lines: meta }] : [], status: `Cannot read: ${errorMessage(error)}`, parent: parentUri(uri) };
	}
	const { lines, total } = boundedLines(excerpt.content);
	const sections = [{ title: "Content", lines }];
	const meta = await metadataLines(locatedPath);
	if (meta.length > 0) sections.push({ title: "Source", lines: meta });
	return { uri, title: uri, entries: [], sections, status: `${excerpt.contentType ?? "text/plain"} · ${lines.length} of ${total} line(s)`, parent: parentUri(uri) };
}

/**
 * One node. A file-backed scheme (`preferResolve` false) locates its path and previews a bounded
 * prefix, or lists a directory. A virtual scheme (`preferResolve` true) resolves through the router
 * even when it also locates a backing path, because its resolved text differs from the raw file
 * (frontmatter, attachment descriptors, embedded docs).
 */
async function fileNodePage(uri: string, ctx: ExtensionContext, signal: AbortSignal, directory: boolean, preferResolve: boolean): Promise<DrawerPage> {
	const located = await locateForPage(uri, ctx, signal, directory);
	if (!preferResolve) {
		if (located.error) return missingPage(uri, uri, `Cannot open ${uri}: ${located.error}`);
		if (located.path !== null) {
			try {
				if ((await fs.stat(located.path)).isDirectory()) return listDirectoryPage(uri, uri, located.path, uri);
			} catch (error) {
				return missingPage(uri, uri, `Cannot open ${uri}: ${errorMessage(error)}`);
			}
			return boundedFilePage(uri, located.path);
		}
	}
	return resolveExcerptPage(uri, ctx, signal, located.path);
}

/* -------------------------------------------------------------------------- */
/*                                attachment://                               */
/* -------------------------------------------------------------------------- */

function attachmentPage(uri: string, ctx: ExtensionContext): DrawerPage {
	const items = drawerSession(ctx)?.getImageAttachments?.() ?? [];
	if (items.length === 0) return missingPage(uri, uri, "No image attachments in this session");
	const entries: DrawerEntry[] = items.slice(0, MAX_ENTRIES).map(item => ({
		uri: item.uri,
		label: item.label,
		description: `${item.image.mimeType}${item.sourcePath ? ` · ${item.sourcePath.split("/").pop() ?? ""}` : ""}`,
		kind: "resource",
	}));
	return { uri, title: "attachment://", entries, sections: [], status: `${entries.length} attachment(s)`, parent: parentUri(uri) };
}

/* -------------------------------------------------------------------------- */
/*                                  list roots                                */
/* -------------------------------------------------------------------------- */

async function completionRootPage(
	uri: string,
	title: string,
	scheme: DrawerScheme,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<DrawerPage> {
	let candidates: Array<{ value: string; label?: string; description?: string }>;
	try {
		candidates = await listDrawerResources(scheme, "", ctx, signal);
	} catch (error) {
		return missingPage(uri, title, errorMessage(error));
	}
	const entries: DrawerEntry[] = [];
	for (const candidate of candidates.slice(0, MAX_ENTRIES)) {
		// `memory://` marks an addressable id it cannot enumerate with a placeholder; keep it out of
		// the entry list and explain it in the status instead.
		if (candidate.value.includes("<") || candidate.value.includes(">")) continue;
		entries.push({ uri: joinUri(uri, candidate.value), label: candidate.label ?? candidate.value, description: candidate.description, kind: "resource" });
	}
	const status = entries.length === 0 ? "no resources" : `${entries.length} item(s)`;
	return { uri, title, entries, sections: [], status, parent: parentUri(uri) };
}

/* -------------------------------------------------------------------------- */
/*                                  memory://                                 */
/* -------------------------------------------------------------------------- */

async function memoryPage(uri: string, ctx: ExtensionContext, signal: AbortSignal): Promise<DrawerPage> {
	const parsed = parseInternalUrl(uri);
	const host = parsed.rawHost;
	const rawPath = parsed.rawPathname ?? parsed.pathname;
	const hasPath = Boolean(rawPath && rawPath !== "/");

	// Root: the file-backed namespace is a directory; list it. When it is unavailable (another
	// memory backend owns this session) fall back to the router's namespace candidates.
	if (!host) {
		const rootDir = await locateForPage("memory://root", ctx, signal, true);
		if (rootDir.path !== null) return listDirectoryPage(uri, "memory://root", rootDir.path, "memory://root");
		const page = await completionRootPage(uri, "memory://", "memory", ctx, signal);
		if (page.entries.length === 0) {
			page.status = rootDir.error ?? "File-backed memory is unavailable for this backend. Use `recall` to list mnemopi ids, then browse `memory://<id>`.";
		}
		return page;
	}

	// `memory://root/<path>` is file-backed; any other host is a mnemopi memory id (a virtual row).
	if (host === "root" && hasPath) return fileNodePage(uri, ctx, signal, true, false);
	return fileNodePage(uri, ctx, signal, false, true);
}

/* -------------------------------------------------------------------------- */
/*                                  local://                                  */
/* -------------------------------------------------------------------------- */

async function localPage(uri: string, ctx: ExtensionContext, signal: AbortSignal): Promise<DrawerPage> {
	const parsed = parseInternalUrl(uri);
	const rawPath = parsed.rawPathname ?? parsed.pathname;
	const hasPath = Boolean(rawPath && rawPath !== "/" && rawPath !== "");
	if (!parsed.rawHost && !hasPath) {
		const root = await locateForPage("local://", ctx, signal, true);
		if (root.error) return missingPage(uri, "local://", `local:// unavailable: ${root.error}`);
		if (root.path === null) return missingPage(uri, "local://", "local:// root is empty or unavailable for this session");
		return listDirectoryPage(uri, "local://", root.path, "local://");
	}
	return fileNodePage(uri, ctx, signal, false, false);
}

/* -------------------------------------------------------------------------- */
/*                                   skill://                                 */
/* -------------------------------------------------------------------------- */

async function skillPage(uri: string, ctx: ExtensionContext, signal: AbortSignal): Promise<DrawerPage> {
	const parsed = parseInternalUrl(uri);
	const hasPath = Boolean(parsed.rawPathname && parsed.rawPathname !== "/");
	if (!parsed.rawHost && !hasPath) {
		const page = await completionRootPage(uri, "skill://", "skill", ctx, signal);
		// A skill is a directory (SKILL.md plus supporting files); accepting one browses it.
		for (const entry of page.entries) entry.kind = "collection";
		return page;
	}
	return fileNodePage(uri, ctx, signal, true, false);
}

/* -------------------------------------------------------------------------- */
/*                                 entry point                                */
/* -------------------------------------------------------------------------- */

export const contentDrawer: DrawerAdapter = {
	schemes: SCHEMES,
	async load(uri: string, ctx: ExtensionContext, request): Promise<DrawerPage> {
		const scheme = drawerScheme(uri);
		if (!scheme || !(SCHEMES as readonly DrawerScheme[]).includes(scheme)) return missingPage(uri, uri, `Not a content scheme: ${uri}`);
		switch (scheme) {
			case "memory":
				return memoryPage(uri, ctx, request.signal);
			case "artifact": {
				const parsed = parseInternalUrl(uri);
				return parsed.rawHost
					? fileNodePage(uri, ctx, request.signal, false, false)
					: completionRootPage(uri, "artifact://", "artifact", ctx, request.signal);
			}
			case "local":
				return localPage(uri, ctx, request.signal);
			case "attachment": {
				const parsed = parseInternalUrl(uri);
				return parsed.rawHost ? fileNodePage(uri, ctx, request.signal, false, true) : attachmentPage(uri, ctx);
			}
			case "skill":
				return skillPage(uri, ctx, request.signal);
			default: {
				// rule:// and omp:// resolve their own text (frontmatter stripping, embedded docs).
				const parsed = parseInternalUrl(uri);
				return parsed.rawHost
					? fileNodePage(uri, ctx, request.signal, false, true)
					: completionRootPage(uri, `${scheme}://`, scheme, ctx, request.signal);
			}
		}
	},
};
