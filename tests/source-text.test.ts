import { expect, test } from "bun:test";
import { commandSourcePath, printsLineNumbers, scanComments, stripComments, stripLineNumbers } from "../lib/source-text";

test("comment-only lines vanish while trailing comments, strings and URLs survive", () => {
	const code = [
		"// header",
		"const url = 'http://x.test/a'; // why",
		"const s = \"a // not a comment\";",
		"/** doc",
		" * more */",
		"export const a = 1; /* tail */",
		"",
		"const b = `x // y`;",
	].join("\n");
	expect(stripComments(code, "ts")).toBe([
		"const url = 'http://x.test/a';",
		"const s = \"a // not a comment\";",
		"export const a = 1;",
		"",
		"const b = `x // y`;",
	].join("\n"));
});

test("line count is preserved by the scan so line numbers stay valid", () => {
	const scan = scanComments("a\n// c\nb\n/* x\ny */\nc", "ts");
	expect(scan.lines).toEqual(["a", "", "b", "", "", "c"]);
	expect(scan.dropped).toEqual([false, true, false, true, true, false]);
});

test("rust lifetimes and char literals are not strings; attributes are not comments", () => {
	const code = "#[derive(Debug)]\nfn f<'a>(x: &'a str) -> char { '\"' } // c\n// gone";
	expect(stripComments(code, "rs")).toBe("#[derive(Debug)]\nfn f<'a>(x: &'a str) -> char { '\"' }");
});

test("hash comments need leading space, so shell $# and a shebang stay", () => {
	expect(stripComments("#!/bin/sh\necho $# # count\n# note\nls", "sh")).toBe("#!/bin/sh\necho $#\nls");
});

test("unknown languages are returned untouched", () => {
	expect(stripComments("# heading\n// x", "md")).toBe("# heading\n// x");
	expect(stripComments("// x", undefined)).toBe("// x");
});

test("a numbered gutter is removed from grep -n, cat -n and context rows", () => {
	const grep = ["21:export type A = 1;", "22:/** doc */", "…", "559:function f() {", "560-  return 1;"].join("\n");
	expect(stripLineNumbers(grep)).toEqual({ text: ["export type A = 1;", "/** doc */", "…", "function f() {", "  return 1;"].join("\n"), numbered: true });
	expect(stripLineNumbers("     3\tfoo\n     4\tbar")).toEqual({ text: "foo\nbar", numbered: true });
});

test("ordinary output with the odd numeric prefix is not mistaken for a gutter", () => {
	const text = "total 3\n12:30 meeting\nhello\nworld";
	expect(stripLineNumbers(text)).toEqual({ text, numbered: false });
	expect(stripLineNumbers("only one line")).toEqual({ text: "only one line", numbered: false });
});

test("the source file a shell command prints is the last known source path in it", () => {
	expect(commandSourcePath("sed -n '21,66p' node_modules/x/src/tools/todo.ts")).toBe("node_modules/x/src/tools/todo.ts");
	expect(commandSourcePath("grep -n foo ~/a/b.rs | head")).toBe("~/a/b.rs");
	expect(commandSourcePath("cat README.md && ls")).toBeUndefined();
	expect(commandSourcePath("git status")).toBeUndefined();
});

test("a numbered listing followed by plain text is stripped only where it is numbered", () => {
	const text = ["22:export function a() {", "26:export function b() {", "42:export function c() {", "…", "", "plain 1", "plain 2"].join("\n");
	expect(stripLineNumbers(text).text).toBe(["export function a() {", "export function b() {", "export function c() {", "…", "", "plain 1", "plain 2"].join("\n"));
});

test("unrelated numbered-looking rows inside prose are left alone", () => {
	const text = "start\n12:30 meeting\n13:00 lunch\nend";
	expect(stripLineNumbers(text)).toEqual({ text, numbered: false });
});

test("a single numbered row is a gutter when the command is one that numbers its output", () => {
	expect(stripLineNumbers("5:const plain = 1;\n112 pass\n0 fail").numbered).toBe(false);
	expect(stripLineNumbers("5:const plain = 1;\n112 pass\n0 fail", 1)).toEqual({ text: "const plain = 1;\n112 pass\n0 fail", numbered: true });
	expect(printsLineNumbers("grep -n plain tests/a.ts; bun test | grep pass")).toBe(true);
	expect(printsLineNumbers("rg --line-number foo")).toBe(true);
	expect(printsLineNumbers("cat -n a.ts")).toBe(true);
	expect(printsLineNumbers("grep -rl foo src")).toBe(false);
	expect(printsLineNumbers("git log --oneline")).toBe(false);
});
