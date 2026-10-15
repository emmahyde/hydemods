import { expect, test } from "bun:test";
import { commandSourcePath, compactBlocks, extensionOf, groupGrepPrefixes, joinLoneClosers, printsLineNumbers, scanComments, stripComments, stripLineNumbers } from "../lib/source-text";

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

test("grep -rn path:line: prefixes become one header per file, text and indent untouched", () => {
	const raw = [
		"view/mod.rs:195:    let x = 1;",
		"view/mod.rs-196-    let y = 2;",
		"view/mod.rs:210:fn f() {}",
		"--",
		"lib/a-b.ts:4:  see http://host:80:x",
	].join("\n");
	expect(groupGrepPrefixes(raw)).toEqual({
		text: ["view/mod.rs", "    let x = 1;", "    let y = 2;", "fn f() {}", "…", "lib/a-b.ts", "  see http://host:80:x"].join("\n"),
		grouped: true,
	});
});

test("colon text that is not a path:line: prefix is left alone", () => {
	for (const text of ["http://example.com:8080:x\nnote: 5: items", "Error: 12: bad\nstatus: 3: ok"]) {
		expect(groupGrepPrefixes(text)).toEqual({ text, grouped: false });
	}
});

test("a small try/catch folds to one row and the shared indent goes", () => {
	const code = [
		"          try {",
		"            linkable = statSync(path).isFile();",
		"          } catch {",
		"            linkable = false;",
		"          }",
	].join("\n");
	expect(compactBlocks(code)).toBe("try { linkable = statSync(path).isFile(); } catch { linkable = false; }");
});

test("a block too wide for one row keeps its frame and folds what is inside", () => {
	const code = [
		"if (ready) {",
		"  const a = [",
		"    1,",
		"    2,",
		"  ];",
		"  run(" + "x".repeat(110) + ");",
		"}",
	].join("\n");
	expect(compactBlocks(code)).toBe(["if (ready) {", "  const a = [1, 2];", "  run(" + "x".repeat(110) + ");", "}"].join("\n"));
});

test("braces inside strings do not unbalance a fold", () => {
	const code = "f(() => {\n  log(\"}\");\n});";
	expect(compactBlocks(code)).toBe('f(() => { log("}"); });');
});

test("unbalanced excerpts and blank lines pass through", () => {
	expect(compactBlocks("} else {\n  x();\n\ny();")).toBe("} else {\n  x();\n\ny();");
});

test("a call too wide to join ends its last argument with the paren, never a lone `)`", () => {
	const wide = "x".repeat(110);
	const code = ["run(", `  ${wide},`, `  ${wide}`, ");"].join("\n");
	const out = compactBlocks(code);
	expect(out).toBe(["run(", `  ${wide},`, `  ${wide});`].join("\n"));
	expect(out.split("\n").some(row => /^\s*[)\]]/.test(row))).toBe(false);
});

test("joinLoneClosers folds paren and bracket closers upward but keeps a bare brace", () => {
	expect(joinLoneClosers("f(\n  a,\n)")).toBe("f(\n  a,)");
	expect(joinLoneClosers("f({\n  a: 1,\n})")).toBe("f({\n  a: 1,\n})");
	expect(joinLoneClosers("xs = [\n  1,\n],\n")).toBe("xs = [\n  1,],\n");
	expect(joinLoneClosers("if x {\n  y\n}")).toBe("if x {\n  y\n}");
	expect(joinLoneClosers("a\n\n)")).toBe("a\n\n)");
	expect(joinLoneClosers('log("a\n");')).toBe('log("a");');
});

test("an empty pair is one row", () => {
	expect(joinLoneClosers("xs = [\n]")).toBe("xs = []");
	expect(joinLoneClosers("xs = [\n];")).toBe("xs = [];");
	expect(joinLoneClosers("run(\n)")).toBe("run()");
	expect(joinLoneClosers("fn f() {\n}")).toBe("fn f() {}");
	expect(joinLoneClosers("a: [\n  ],\nb: {\n},")).toBe("a: [],\nb: {},");
	expect(joinLoneClosers("xs = [\n  1,\n]")).toBe("xs = [\n  1,]");
});

test("a multi-line list that fits becomes one tight row", () => {
	expect(compactBlocks("const xs = [\n  x,\n  y,\n  z\n];")).toBe("const xs = [x, y, z];");
	expect(compactBlocks("const xs = [\n  x,\n  y,\n  z,\n];")).toBe("const xs = [x, y, z];");
	expect(compactBlocks("run(\n  a,\n  b,\n);")).toBe("run(a, b);");
});

test("path:line: prefixes are lifted into one header per file", () => {
	const out = groupGrepPrefixes("index.ts:1116:function a() {}\nindex.ts:1123:function b() {}\nlib/x.ts:4:const c = 1;");
	expect(out.grouped).toBe(true);
	expect(out.text).toBe("index.ts\nfunction a() {}\nfunction b() {}\nlib/x.ts\nconst c = 1;");
	expect(out.text).not.toMatch(/:\d+:/);
});

test("grouped grep rows drop comment-only lines in the file's own comment style, and keep code with trailing comments", () => {
	const raw = [
		"a.rs:1:// only a comment",
		"a.rs:2:let x = 1; // trailing",
		"b.sh:3:# only a comment",
		"b.sh:4:echo \"# not a comment\"",
		"notes.txt:5:// plain text keeps its slashes",
	].join("\n");
	expect(groupGrepPrefixes(raw).text).toBe(
		["a.rs", "let x = 1; // trailing", "b.sh", "echo \"# not a comment\"", "notes.txt", "// plain text keeps its slashes"].join("\n"),
	);
});

test("extensionless build files and dotfiles are #-comment sources", () => {
	expect(commandSourcePath("cat Makefile")).toBe("Makefile");
	expect(commandSourcePath("sed -n 1,20p docker/Dockerfile")).toBe("docker/Dockerfile");
	expect(stripComments("# build\nall:\n\tgo build", extensionOf("Makefile"))).toBe("all:\n\tgo build");
	expect(stripComments("# prompt\nexport A=1", extensionOf("~/.zshrc"))).toBe("export A=1");
});
