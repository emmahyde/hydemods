import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../lib/wiki-index";
import { callSubject, toolBullets } from "../lib/tool-rows";

const dir = mkdtempSync(join(tmpdir(), "wiki-index-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a subject matches a page's title, slug or tags by whole words; short stems never match", () => {
	const registry = join(dir, "registry.json");
	writeFileSync(registry, JSON.stringify({ pages: { "sources/x": { title: "Elcor tone labels on tool rows", tags: ["gallery"] }, "sources/fs-watch-misses": {} } }));
	const index = new WikiIndex(() => [registry, join(dir, "missing.json")]);
	expect(index.knows("gallery.ts")).toBe(true);
	expect(index.knows("tool-rows.ts:40-80")).toBe(true);
	expect(index.knows("toolRows.ts")).toBe(true);
	expect(index.knows("fs-watch")).toBe(true);
	expect(index.knows("tool-rows-host.ts")).toBe(false);
	expect(index.knows("gall.ts")).toBe(false);
	expect(index.knows("ts.ts")).toBe(false);
});

test("a changed registry is re-read after the recheck window", () => {
	const registry = join(dir, "later.json");
	writeFileSync(registry, JSON.stringify({ pages: {} }));
	const index = new WikiIndex(() => [registry]);
	const realNow = Date.now;
	try {
		let now = 1_000_000;
		Date.now = () => now;
		expect(index.knows("planner.ts")).toBe(false);
		writeFileSync(registry, JSON.stringify({ pages: { "concepts/planner": { title: "Planner" } } }));
		utimesSync(registry, new Date(), new Date(Date.UTC(2030, 0, 1)));
		expect(index.knows("planner.ts")).toBe(false);
		now += 6_000;
		expect(index.knows("planner.ts")).toBe(true);
	} finally {
		Date.now = realNow;
	}
});

test("eval rows name the first file the code loads or quotes; task rows name their agents", () => {
	expect(callSubject("eval", { code: 'const t = await Bun.file("lib/gallery.ts").text()' })).toBe("gallery.ts");
	expect(callSubject("eval", { code: '%load "scripts/my setup.py"' })).toBe("my setup.py");
	expect(callSubject("eval", { code: 'await fetch("https://x.dev/a.json")' })).toBeUndefined();
	expect(callSubject("eval", { code: "print(1 + 1)" })).toBeUndefined();
	expect(callSubject("task", { tasks: [{ name: "AuthRefactor" }, { name: "Docs" }] })).toBe("AuthRefactor +1");
	expect(callSubject("task", { tasks: [{ name: "Docs" }] })).toBe("Docs");
});

test("group bullets keep one line per known label, in the burst's label order", () => {
	expect(toolBullets("- **Edit**: made x work\nRead: traced y\nGrep: none\nEdit: again", ["Read", "Edit"])).toBe("Read: Traced y\nEdit: Made x work");
	expect(toolBullets("nothing labelled here", ["Read"])).toBeUndefined();
});
