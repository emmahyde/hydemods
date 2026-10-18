import { readFileSync, statSync } from "node:fs";

/** How often a lookup may re-check the registry files for changes. */
const RecheckMs = 5_000;

/** Lower-case words of `text`: `tool-rows_host.ts`, `toolRowsHost` and `Tool rows host` all become `tool rows host ts`. */
function words(text: string): string {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.join(" ");
}

/**
 * Which row subjects the knowledge wiki has a page on. It reads each vault's `meta/registry.json`
 * (page titles, slugs, tags) and re-reads a file only when its modification time changes. A subject
 * matches when its file stem (`gallery.ts` → `gallery`, `tool-rows.ts:4-9` → `tool rows`) appears as
 * whole words in a page's title, slug or tags. Stems shorter than 4 letters never match.
 */
export class WikiIndex {
	private files = new Map<string, { mtimeMs: number; text: string }>();
	private checkedAt = 0;
	private haystack = "";

	constructor(private readonly registries: () => readonly string[]) {}

	knows(subject: string): boolean {
		const stem = words(subject.replace(/:[^/]*$/, "").replace(/\/$/, "").replace(/\.[A-Za-z][A-Za-z0-9]{0,5}$/, ""));
		if (stem.replace(/ /g, "").length < 4) return false;
		this.refresh();
		return this.haystack.includes(` ${stem} `);
	}

	private refresh(): void {
		const now = Date.now();
		if (now - this.checkedAt < RecheckMs) return;
		this.checkedAt = now;
		let changed = false;
		const paths = this.registries();
		for (const path of paths) {
			let mtimeMs: number;
			try {
				mtimeMs = statSync(path).mtimeMs;
			} catch {
				changed ||= this.files.delete(path);
				continue;
			}
			if (this.files.get(path)?.mtimeMs === mtimeMs) continue;
			try {
				this.files.set(path, { mtimeMs, text: pageWords(readFileSync(path, "utf8")) });
				changed = true;
			} catch {
				// A registry mid-write or unreadable keeps the last good copy.
			}
		}
		for (const path of this.files.keys()) if (!paths.includes(path)) changed ||= this.files.delete(path);
		if (changed) this.haystack = ` ${[...this.files.values()].map(file => file.text).join(" | ")} `;
	}
}

/** One words line per page (`title | slug | tags`), pages joined by ` | ` so a stem never spans two pages. */
function pageWords(json: string): string {
	const parsed: unknown = JSON.parse(json);
	const pages = parsed && typeof parsed === "object" && "pages" in parsed && parsed.pages && typeof parsed.pages === "object" ? parsed.pages : {};
	return Object.entries(pages)
		.map(([id, page]: [string, unknown]) => {
			const field = (key: string) => (page && typeof page === "object" && key in page ? Reflect.get(page, key) : undefined);
			const title = field("title");
			const slug = field("slug");
			const tags = field("tags");
			const tagWords = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
			return [typeof title === "string" ? title : "", typeof slug === "string" ? slug : id.slice(id.lastIndexOf("/") + 1), ...tagWords].map(words).join(" | ");
		})
		.join(" | ");
}
