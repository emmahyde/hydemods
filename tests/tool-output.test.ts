import { expect, test } from "bun:test";
import {
	GREP_MATCH_LIMIT,
	MAX_RENDER_BYTES,
	collapseTextLines,
	cappedRenderPayload,
	decodeNestedJson,
	formatFileExcerpt,
	formatJsonOutput,
	parseGrepOutput,
	parseYamlDocument,
	sanitizeTerminalText,
} from "../lib/tool-output";
import { underlineLabel, underlinePathTokens } from "../lib/path-styling";

test("terminal sanitizer drops OSC and non-SGR CSI while keeping colour", () => {
	const input = "plain\x1b]0;title\x07 text\x1b[2J\x1b[?25l\x1b[31mred\x1b[0m\x1b]8;;http://example\x1b\\link\x1b]8;;\x1b\\";
	expect(sanitizeTerminalText(input)).toBe("plain text\x1b[31mred\x1b[0mlink");
});

test("terminal sanitizer keeps tabs and newlines but drops other controls", () => {
	expect(sanitizeTerminalText("keep\n\ttabs")).toBe("keep\n\ttabs");
	expect(sanitizeTerminalText("a\x00b\x0cc\rd")).toBe("abcd");
});

test("nested JSON decoding stops at the depth limit", () => {
	const shallow = decodeNestedJson({ a: { b: { c: "[1,2]" } } }) as { a: { b: { c: unknown } } };
	expect(shallow.a.b.c).toEqual([1, 2]);
	const deep = decodeNestedJson({ a: { b: { c: { d: { e: "[1,2]" } } } } }) as { a: { b: { c: { d: { e: unknown } } } } };
	expect(deep.a.b.c.d.e).toBe("[1,2]");
});

test("nested JSON decoding leaves huge strings unchanged", () => {
	const huge = `["${"x".repeat(70_000)}"]`;
	expect(decodeNestedJson(huge)).toBe(huge);
	expect(decodeNestedJson('["x"]')).toEqual(["x"]);
});

test("YAML is re-encoded only as a real mapping or sequence", () => {
	expect(parseYamlDocument("Error: something went wrong.")).toBeUndefined();
	expect(parseYamlDocument("Error: foo")).toBeUndefined();
	expect(parseYamlDocument("- first thing.\n- second thing.")).toBeUndefined();
	expect(parseYamlDocument("name: hydemods\nversion: 1.0.0")).toEqual({ name: "hydemods", version: "1.0.0" });
});

test("grep output past the match limit reports what it hid", () => {
	const hidden = 4;
	const rows = Array.from({ length: GREP_MATCH_LIMIT + hidden }, (_, index) => `${index + 1}|match ${index + 1}`).join("\n");
	expect(parseGrepOutput(rows)).toEqual({
		matches: Array.from({ length: GREP_MATCH_LIMIT }, (_, index) => ({ line: index + 1, match: `match ${index + 1}` })),
		notice: `… ${hidden} more matches`,
	});
	expect(parseGrepOutput("1|only")).toEqual({ matches: [{ line: 1, match: "only" }] });
});

test("payloads past the render cap are handed to the native card", () => {
	expect(cappedRenderPayload("x".repeat(MAX_RENDER_BYTES))).toBeDefined();
	expect(cappedRenderPayload("x".repeat(MAX_RENDER_BYTES + 1))).toBeUndefined();
	expect(cappedRenderPayload({ small: true })).toEqual({ small: true });
});

test("collapsed tool previews retain the last line and expansion restores every line", () => {
	const lines = ["instruction one", "instruction two", "instruction three", "instruction four"];
	expect(collapseTextLines(lines, 3, false)).toEqual(["instruction one", "…", "instruction four"]);
	expect(collapseTextLines(lines, 3, true)).toEqual(lines);
});

test("the TOON toggle switches JSON output to pretty JSON", () => {
	const value = { name: "hydemods", nested: { count: 2 } };
	expect(formatJsonOutput(value).format).toBe("toon");
	const off = formatJsonOutput(value, false);
	expect(off.format).toBe("json");
	expect(off.text).toBe(JSON.stringify(value, null, 2));
});

test("file excerpts honour the TOON toggle and keep string values verbatim when off", () => {
	const excerpt = '[src/a.ts#abc123]\n{\n  "notes": "line one\\nline two",\n  "count": 2\n}';
	expect(formatFileExcerpt(excerpt).startsWith("[src/a.ts#abc123]\n")).toBe(true);
	const off = formatFileExcerpt(excerpt, false);
	const parsed = JSON.parse(off.slice(off.indexOf("\n") + 1)) as { notes: string; count: number };
	expect(parsed).toEqual({ notes: "line one\nline two", count: 2 });
});

test("file excerpt fields that are not JSON objects stay verbatim", () => {
	const excerpt = '[src/a.ts#abc123]\n{\n  "text": "ok",\n  count: items.length\n}';
	expect(formatFileExcerpt(excerpt)).toBe('[src/a.ts#abc123]\n"text": "ok"\ncount: items.length');
});

test("an OSC sequence followed by ESC is stripped", () => {
	expect(sanitizeTerminalText("\x1b]52;c;ZXZpbA==\x1b[0m done")).toBe("\x1b[0m done");
});

test("nested JSON decode unpacks fenced markdown json code blocks", () => {
	const fenced = "```json\n{\n  \"status\": \"ok\",\n  \"data\": [1, 2, 3]\n}\n```";
	const decoded = decodeNestedJson(fenced);
	expect(decoded).toEqual({ status: "ok", data: [1, 2, 3] });
});

test("path styling underlines filesystem tokens but not URLs or prose", () => {
	expect(underlineLabel("src/index.ts")).toBe("\x1b[4msrc/index.ts\x1b[24m");
	expect(underlinePathTokens("edit src/index.ts and /tmp/output.txt")).toBe(
		"edit \x1b[4msrc/index.ts\x1b[24m and \x1b[4m/tmp/output.txt\x1b[24m",
	);
	expect(underlinePathTokens("See https://example.test/src/index.ts for details")).toBe(
		"See https://example.test/src/index.ts for details",
	);
});

test("plain text path tokens are underlined while URLs remain unchanged", () => {
	expect(underlinePathTokens("stdout: wrote src/result.json")).toBe("stdout: wrote \x1b[4msrc/result.json\x1b[24m");
	expect(underlinePathTokens("error: see https://example.test/src/result.json")).toBe("error: see https://example.test/src/result.json");
});
