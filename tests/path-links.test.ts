import { describe, expect, test } from "bun:test";
import { createPathResolver, linkPathRows } from "../lib/path-links";

const files = new Set(["/repo/lib/tool-rows.ts", "/repo/index.ts", "/repo/lib", "/repo/a/very/long/path/to/file.ts"]);
const resolver = createPathResolver(() => "/repo", path => files.has(path));
const wrap = (path: string, text: string, opts?: { line?: number }) => `\x1b]8;;file://${path}${opts?.line ? `?line=${opts.line}` : ""}\x1b\\${text}\x1b]8;;\x1b\\`;
const strip = (row: string) => row.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const targets = (row: string) => [...row.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)/g)].map(match => match[1]);

describe("linkPathRows", () => {
	test("links existing relative paths and bare filenames, keeps visible text", () => {
		const [row] = linkPathRows(["Edit lib/tool-rows.ts and index.ts, not e.g. or missing.ts."], resolver, wrap);
		expect(strip(row!)).toBe("Edit lib/tool-rows.ts and index.ts, not e.g. or missing.ts.");
		expect(targets(row!).map(uri => uri.split("?")[0])).toEqual(["file:///repo/lib/tool-rows.ts", "file:///repo/index.ts"]);
	});

	test("matches a path split by colour codes and carries a line suffix", () => {
		const row = "see \x1b[36mlib/\x1b[1mtool-rows.ts:42\x1b[0m";
		const [linked] = linkPathRows([row], resolver, wrap);
		expect(strip(linked!)).toBe(row);
		expect(targets(linked!)).toHaveLength(1);
		expect(targets(linked!)[0]).toContain("/repo/lib/tool-rows.ts");
	});

	test("leaves text that is already inside a link alone", () => {
		const row = "\x1b]8;;file:///x\x1b\\index.ts\x1b]8;;\x1b\\";
		expect(linkPathRows([row], resolver, wrap)[0]).toBe(row);
	});

	test("joins a path hard-wrapped across two rows", () => {
		const rows = linkPathRows(["open a/very/long/pa", "th/to/file.ts now"], resolver, wrap);
		expect(targets(rows[0]!)).toHaveLength(1);
		expect(targets(rows[1]!)).toHaveLength(1);
		expect(targets(rows[0]!)[0]).toBe(targets(rows[1]!)[0]);
		expect(strip(rows[1]!)).toBe("th/to/file.ts now");
	});
});
