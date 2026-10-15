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
	parseTabularData,
	sanitizeTerminalText,
	separateGeneratedNoticeFooter,
	stripGeneratedNoticeFooter,
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

test("collapsed tool previews count what they hide and expansion restores every line", () => {
	const lines = ["instruction one", "instruction two", "instruction three", "instruction four"];
	expect(collapseTextLines(lines, 3, false)).toEqual(["instruction one", "… 2 more", "instruction four"]);
	expect(collapseTextLines(lines, 3, true)).toEqual(lines);
	expect(collapseTextLines(lines, 1, false)).toEqual(["instruction one …"]);
	expect(collapseTextLines(lines, 2, false)).toEqual(["instruction one", "… 3 more"]);
	expect(collapseTextLines(lines, 4, false)).toEqual(lines);
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
test("separateGeneratedNoticeFooter isolates artifact and truncation notices", () => {
	const raw = '{"ok": true}\n\n[Showing lines 1-10 of 100. Read artifact://42 for full output]';
	const { body, footer } = separateGeneratedNoticeFooter(raw);
	expect(body).toBe('{"ok": true}');
	expect(footer).toBe('\n\n[Showing lines 1-10 of 100. Read artifact://42 for full output]');
	expect(stripGeneratedNoticeFooter(raw)).toBe('{"ok": true}');
});
test("parseTabularData parses CSV, TSV, and whitespace-aligned command tables into TOON-ready rows", () => {
	const csv = "id,name,role\n007,alice,admin\n1.10,bob,user";
	const csvRows = parseTabularData(csv);
	expect(csvRows).toEqual([
		{ id: "007", name: "alice", role: "admin" },
		{ id: "1.10", name: "bob", role: "user" }
	]);
	expect(formatJsonOutput(csv).format).toBe("toon");

	const tsv = "pid\tcpu\tcommand\n507\t22.3\tbun omp\n94212\t19.1\tbun omp";
	const tsvRows = parseTabularData(tsv);
	expect(tsvRows).toEqual([
		{ pid: "507", cpu: "22.3", command: "bun omp" },
		{ pid: "94212", cpu: "19.1", command: "bun omp" }
	]);
	expect(formatJsonOutput(tsv).format).toBe("toon");

	// Real ps aux with right-aligned PIDs (3-digit and 5-digit) under PID column
	const realPsAux = `USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
emmahyde   507  22.3  5.3 509984784 883008 s011  S+   10:30AM   5:09.79 bun /Users/emmahyde/.bun/bin/omp --resume
emmahyde 94212  19.1  2.9 509535712 482688 s017  S+   10:28AM   2:12.78 bun /Users/emmahyde/.bun/bin/omp`;
	const psRows = parseTabularData(realPsAux);
	expect(psRows).toBeDefined();
	expect(psRows?.length).toBe(2);
	expect(psRows?.[0]["USER"]).toBe("emmahyde");
	expect(psRows?.[0]["PID"]).toBe("507");
	expect(psRows?.[1]["PID"]).toBe("94212");
	expect(psRows?.[0]["COMMAND"]).toBe("bun /Users/emmahyde/.bun/bin/omp --resume");

	const lsof = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nbun       507 emma   58w   REG   1,18   776250 9756 /path/file1\nbun     94212 emma   65u   REG   1,18        0 9756 /path/file2";
	const tableRows = parseTabularData(lsof);
	expect(tableRows).toBeDefined();
	expect(tableRows?.length).toBe(2);
	expect(tableRows?.[0]["COMMAND"]).toBe("bun");
	expect(tableRows?.[0]["PID"]).toBe("507");
	expect(tableRows?.[1]["PID"]).toBe("94212");
	expect(tableRows?.[1]["FD"]).toBe("65u");
	expect(formatJsonOutput(lsof).format).toBe("toon");
});

test("parseTabularData rejects git diff stat, prose with commas, du -sh *, and git status --short", () => {
	const gitDiffStat = ` README.md                 |  31 +++++-
 index.ts                  | 246 +++++++++++++++++++++++++++++++++++++++-------
 lib/code-outline.ts       |  75 ++++++++++++++`;
	expect(parseTabularData(gitDiffStat)).toBeUndefined();

	const proseWithCommas = `Hello, world!
This is some text, and here is more.`;
	expect(parseTabularData(proseWithCommas)).toBeUndefined();

	const proseEqualCommas = `warning: x is deprecated, use y
note: see docs, section 2`;
	expect(parseTabularData(proseEqualCommas)).toBeUndefined();

	const duOutput = "4.0K\tREADME.md\n8.0K\tpackage.json";
	expect(parseTabularData(duOutput)).toBeUndefined();

	const gitStatus = "M  lib/tool-output.ts\n?? tests/new.test.ts";
	expect(parseTabularData(gitStatus)).toBeUndefined();
});

test("parseTabularData supports CSV headers with spaces, dotted keys, and abbreviations", () => {
	const csvSpaces = "First Name,Last Name,Created At\nAlice,Smith,2026-01-01\nBob,Jones,2026-02-01";
	const rowsSpaces = parseTabularData(csvSpaces);
	expect(rowsSpaces).toEqual([
		{ "First Name": "Alice", "Last Name": "Smith", "Created At": "2026-01-01" },
		{ "First Name": "Bob", "Last Name": "Jones", "Created At": "2026-02-01" }
	]);

	const csvDotted = "user.id,address.city,meta.count\nu123,Seattle,42\nu456,Portland,10";
	const rowsDotted = parseTabularData(csvDotted);
	expect(rowsDotted).toEqual([
		{ "user.id": "u123", "address.city": "Seattle", "meta.count": "42" },
		{ "user.id": "u456", "address.city": "Portland", "meta.count": "10" }
	]);

	const csvAbbrev = "No.,Avg.,Dept.,Mins.\n1,95.5,Engineering,45\n2,88.0,Design,30";
	const rowsAbbrev = parseTabularData(csvAbbrev);
	expect(rowsAbbrev).toEqual([
		{ "No.": "1", "Avg.": "95.5", "Dept.": "Engineering", "Mins.": "45" },
		{ "No.": "2", "Avg.": "88.0", "Dept.": "Design", "Mins.": "30" }
	]);

	const csvSection = "Section,Is Active,Use Case\nAuth,true,Login flow\nBilling,false,Invoicing";
	const rowsSection = parseTabularData(csvSection);
	expect(rowsSection).toEqual([
		{ Section: "Auth", "Is Active": "true", "Use Case": "Login flow" },
		{ Section: "Billing", "Is Active": "false", "Use Case": "Invoicing" }
	]);
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

test("a marker spends the whole budget on content and tags the last shown row", () => {
	const lines = ["one", "two", "three", "four"];
	expect(collapseTextLines(lines, 3, false, { marker: "[...]" })).toEqual(["one", "two", "three [...]"]);
	expect(collapseTextLines(lines, 4, false, { marker: "[...]" })).toEqual(lines);
});
