import { expect, test } from "bun:test";
import { theme, ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { compactEvalResult, fitCollapseLine } from "../lib/eval-collapse";
import { outlineSource, renderRange } from "../lib/code-outline";
import { summarizeCode } from "@oh-my-pi/pi-natives";
ensureThemeSync();
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const rows = Array.from({ length: 9 }, (_, i) => `row ${i + 1}`);
const fixture = () => ({ content: [{ type: "image", data: "untouched" }], details: {
 cells: [{ output: rows.join("\n"), code: "print(data)", title: "Read data", status: "error", durationMs: 100, exitCode: 3 }],
 notice: "partial capture", statusEvents: [{ op: "read" }],
} });

test("native preview uses every row for content and marks only the hidden gap", () => {
 const result = fixture();
 const compact = compactEvalResult(result, { expanded: false, limit: 5, theme });
	expect(plain(compact.details.cells[0].output).split("\n")).toEqual(["row 1", "row 2", "row 3", "row 4", "row 5 [...]"]);
 expect(compact.details.cells[0]).toMatchObject({ code: "print(data)", status: "error", exitCode: 3, durationMs: 100 });
 expect(compact.content).toBe(result.content);
 expect(compact.details.notice).toBe("partial capture");
 expect(compact.details.statusEvents).toBe(result.details.statusEvents);
 expect(result.details.cells[0].output).toBe(rows.join("\n"));
 expect(compactEvalResult(result, { expanded: true, limit: 5, theme })).toBe(result);
});

test("visual wrapping keeps the glyph within the content budget at narrow widths", () => {
 for (const width of [5, 8, 20, 80]) {
  const result = fixture();
  result.details.cells[0].output = "long data row ".repeat(30);
  const output = compactEvalResult(result, { expanded: false, limit: 3, width, theme }).details.cells[0].output;
		const lines = output.split("\n");
		expect(lines).toHaveLength(3);
		expect(plain(lines[lines.length - 1])).toMatch(width >= 20 ? /\[\.\.\.\]$/ : /…$/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width - 4));
	}
});

test("literal omission text is content, not a renderer control", () => {
 const result = fixture();
 result.details.cells[0].output = "...\n… 30 more lines\nlast";
 expect(plain(compactEvalResult(result, { expanded: false, limit: 5, theme }).details.cells[0].output)).toBe(result.details.cells[0].output);
	expect(plain(fitCollapseLine("abcdefghijklmnop " + theme.fg("dim", "[...]"), 10))).toEndWith(" [...]");
});

test("fallback content preserves non-text blocks and complete expansion", () => {
 const result = { content: [{ type: "text", text: rows.join("\n") }, { type: "image", text: "image metadata" }] };
 const compact = compactEvalResult(result, { expanded: false, limit: 2, theme });
	expect(plain(compact.content[0].text!)).toBe("row 1\nrow 2 [...]");
 expect(compact.content[1]).toBe(result.content[1]);
 expect(compactEvalResult(result, { expanded: true, limit: 2, theme })).toBe(result);
});

test("streaming context output replaces stale fallback text without losing attachments", () => {
	const original = { content: [{ type: "text", text: "stale" }, { type: "image", text: "attachment" }] };
	const compact = compactEvalResult(original, { expanded: false, limit: 2, theme, output: rows.join("\n") });
	expect(plain(compact.content[0].text!)).toBe("row 1\nrow 2 [...]");
	expect(compact.content[1]).toBe(original.content[1]);
	expect(compactEvalResult(original, { expanded: true, limit: 2, theme, output: rows.join("\n") }).content[0].text).toBe(rows.join("\n"));
	expect(original.content[0].text).toBe("stale");
});

test("Markdown is folded by rendered rows without changing the expansion source", () => {
	const result = { content: [], details: { cells: [{ output: rows.map(row => "**" + row + "**").join("\n\n"), hasMarkdown: true, status: "complete" }] } };
	const compact = compactEvalResult(result, { expanded: false, limit: 3, width: 40, theme });
	expect(compact.details.cells[0].output.split("\n")).toHaveLength(3);
	expect(plain(compact.details.cells[0].output)).toContain("[...]");
	expect(compact.details.cells[0].hasMarkdown).toBe(false);
	expect(compactEvalResult(result, { expanded: true, limit: 3, width: 40, theme })).toBe(result);
});

test("source-range folds attach both gaps to content rather than standalone rows", () => {
	const lines = ["function demo() {", "  prepare();", "  execute();", "  finish();", "}"];
	const outline = outlineSource(lines.join("\n"), { lang: "typescript" }, summarizeCode)!;
	const shown = renderRange(outline, lines, 3, 3, "demo.ts")!;
	expect(shown.some(line => /^\s*⋯/.test(line))).toBe(false);
	expect(shown.some(line => line.includes("demo()") && line.includes("⋯1"))).toBe(true);
	expect(shown.some(line => line.includes("execute();") && line.includes("⋯1"))).toBe(true);
});

test("compacts cell code, textOutput, and strips trailing generated artifact footers", () => {
	const codeLines = Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};`).join("\n");
	const outWithFooter = [...rows.slice(0, 4), "", "[Showing lines 1-4 of 200 (20.0KB limit). Read artifact://42 for full output]"].join("\n");
	const result = {
		content: [{ type: "text", text: outWithFooter }],
		details: {
			cells: [{ code: codeLines, output: outWithFooter, textOutput: outWithFooter, status: "complete" }],
		},
	};
	const compact = compactEvalResult(result, { expanded: false, limit: 4, theme });
	expect(plain(compact.details.cells[0].code!).split("\n")).toEqual([
		"const x0 = 0;",
		"const x1 = 1;",
		"const x2 = 2;",
		"const x3 = 3; [...]",
	]);
	expect(plain(compact.details.cells[0].output).split("\n")).toEqual(["row 1", "row 2", "row 3", "row 4"]);
	expect(plain(compact.details.cells[0].textOutput!).split("\n")).toEqual(["row 1", "row 2", "row 3", "row 4"]);
});

