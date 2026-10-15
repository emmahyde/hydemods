import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";

describe("card verify harness for TOON output", async () => {
	const ompPath = Bun.which("omp");
	if (!ompPath) {
		console.warn("Skipping harness test: omp not in PATH");
		return;
	}
	const hostDirectory = dirname(realpathSync(ompPath));
	const themeModule = await import(Bun.resolveSync("@oh-my-pi/pi-tui/theme", hostDirectory));
	themeModule.ensureThemeSync();

	const { toolRenderers } = await import(Bun.resolveSync("@oh-my-pi/pi-tui/tools", hostDirectory));

	// Load extension takeover
	const extModule = await import("../index");
	const anything: any = new Proxy(() => anything, { get: () => anything, apply: () => anything });
	extModule.default(anything);

	test("eval toolRenderer renders TOON in ANSI and preserves cell in TSP describeResult", () => {
		const evalRenderer = toolRenderers.eval;
		expect(evalRenderer).toBeDefined();

		const sampleResult = {
			content: [
				{
					type: "text",
					text: "display[1]:\n" + JSON.stringify({
						status: "ok",
						items: [
							{ id: 1, name: "alpha" },
							{ id: 2, name: "beta" }
						]
					})
				}
			],
			details: {
				language: "js",
				cells: [
					{
						index: 0,
						title: "Sample Cell",
						code: "display({ status: 'ok', items: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }] })",
						language: "js",
						output: "display[1]:\n" + JSON.stringify({ status: "ok", items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }] }),
						status: "complete",
						exitCode: 0,
						durationMs: 12
					}
				],
				jsonOutputs: [
					{
						status: "ok",
						items: [
							{ id: 1, name: "alpha" },
							{ id: 2, name: "beta" }
						]
					}
				]
			},
			isError: false
		};

		// 1. ANSI renderResult
		const ansiComponent = evalRenderer.renderResult(
			sampleResult,
			{ expanded: false, isPartial: false },
			themeModule.theme,
			{ code: "display(...)" }
		);
		expect(ansiComponent).toBeDefined();
		const renderedAnsi = ansiComponent!.render(100).join("\n");
		// Strip ANSI escapes when testing text content
		const plainAnsi = renderedAnsi.replace(/\u001b\[[0-9;]*m/g, "");
		expect(plainAnsi).toContain("status: ok");
		expect(plainAnsi).toContain("items[2]");

		// 2. TSP describeResult
		if (evalRenderer.describeResult) {
			const tspView = evalRenderer.describeResult(
				sampleResult,
				{ expanded: false, isPartial: false },
				{ code: "display(...)" }
			);
			expect(tspView).toBeDefined();
			expect(tspView?.body).toBeDefined();
			// Check that cell section and input code are preserved
			const cellNode = tspView!.body![0] as { c?: Array<{ p?: { role?: string } }> } | undefined;
			expect(cellNode?.c?.some(child => child.p?.role === "omp.tool.eval.input")).toBe(true);
			expect(cellNode?.c?.some(child => child.p?.role === "omp.run.foot")).toBe(true);
			const str = tspView!.body!.map((node: unknown) => plain(nativeText(node))).join("\n");
			expect(str).toContain("status: ok");
			expect(str).toContain("alpha");
		}
	});
	test("grep toolRenderer enriches matches with AST declaration outline in hydemods cards", () => {
		const grepRenderer = toolRenderers.grep;
		expect(grepRenderer).toBeDefined();

		const sampleGrepResult = {
			content: [
				{
					type: "text",
					text: "[lib/code-outline.ts#1234]\n241: export function renderOutline(outline: Outline, label: string): string[] {\n245: \t\t`${label} · ${outline.language} · ${outline.totalLines} lines · ${count} decl${count === 1 ? \"\" : \"s\"}`,\n"
				}
			],
			details: {
				cwd: process.cwd(),
				scopePath: "lib/code-outline.ts",
				displayContent: "   241│ export function renderOutline(outline: Outline, label: string): string[] {\n * 245│ \t\t`${label} · ${outline.language} · ${outline.totalLines} lines · ${count} decl${count === 1 ? \"\" : \"s\"}`,\n",
				matchCount: 2,
				fileCount: 1,
				files: ["lib/code-outline.ts"]
			},
			isError: false
		};

		const ansiComponent = grepRenderer.renderResult(
			sampleGrepResult,
			{ expanded: false, isPartial: false },
			themeModule.theme,
			{ pattern: "outline.language" }
		);
		expect(ansiComponent).toBeDefined();
		const renderedAnsi = ansiComponent!.render(100).join("\n");
		const plain = renderedAnsi.replace(/\u001b\[[0-9;]*m/g, "");
		// Check that the enclosing function declaration is rendered above or alongside matches
		expect(plain).toContain("renderOutline");
		expect(plain).toContain("245");
	});
	test("multi-file grep with markdown headers and context rows filters context and enriches with AST", () => {
		const grepRenderer = toolRenderers.grep;
		expect(grepRenderer).toBeDefined();

		// Real fixture with multi-file headers (# dir, ## file#hash) and context lines without asterisks
		const multiFileResult = {
			content: [
				{
					type: "text",
					text: `# lib/
## code-outline.ts#52B3
 240:export function renderOutline(outline: Outline, label: string): string[] {
*245:\t\t\`\${label} · \${outline.language} · \${outline.totalLines} lines · \${count} decl\${count === 1 ? "" : "s"}\`,
 246:\t\t...flat.map(outlineRow),
`
				}
			],
			details: {
				cwd: process.cwd(),
				searchPath: process.cwd(),
				displayContent: `# lib/
## code-outline.ts#52B3
 240│export function renderOutline(outline: Outline, label: string): string[] {
*245│\t\t\`\${label} · \${outline.language} · \${outline.totalLines} lines · \${count} decl\${count === 1 ? "" : "s"}\`,
    │...
 246│\t\t...flat.map(outlineRow),
`,
				matchCount: 1,
				fileCount: 1,
				files: ["lib/code-outline.ts"]
			},
			isError: false
		};

		const ansiComponent = grepRenderer.renderResult(
			multiFileResult,
			{ expanded: false, isPartial: false },
			themeModule.theme,
			{ pattern: "outline.language" }
		);
		expect(ansiComponent).toBeDefined();
		const renderedAnsi = ansiComponent!.render(100).join("\n");
		const plain = renderedAnsi.replace(/\u001b\[[0-9;]*m/g, "");
		// 1 match only, context line 240 and 246 omitted from matches, enclosing signature present
		expect(plain).toContain("1 match");
		expect(plain).toContain("renderOutline");
		expect(plain).toContain("245");
		expect(plain).not.toContain("240:");
		expect(plain).not.toContain("246:");
	});
	test("read toolRenderer renders markdown TOC outline with syntax highlighting", () => {
		const readRenderer = toolRenderers.read;
		expect(readRenderer).toBeDefined();

		const sampleMdResult = {
			content: [
				{
					type: "text",
					text: "# Main Doc\nIntroduction\n## Setup\nRun bun install\n### Advanced\nDetails\n"
				}
			],
			details: {
				resolvedPath: "/fake/path/README.md",
				displayTarget: "README.md",
				kind: "file",
				displayContent: {
					text: "# Main Doc\nIntroduction\n## Setup\nRun bun install\n### Advanced\nDetails\n",
					startLine: 1,
					lineNumbers: [1, 2, 3, 4, 5, 6]
				},
				totalLines: 6
			},
			isError: false
		};

		const ansiComponent = readRenderer.renderResult(
			sampleMdResult,
			{ expanded: false, isPartial: false },
			themeModule.theme,
			{ path: "README.md" }
		);
		expect(ansiComponent).toBeDefined();
		const renderedAnsi = ansiComponent!.render(100).join("\n");
		// Verify ANSI color sequences are present for markdown syntax components
		expect(renderedAnsi).toContain("\u001b[");
		const plain = renderedAnsi.replace(/\u001b\[[0-9;]*m/g, "");
		expect(plain).toContain("README.md · markdown · 6 lines · 3 sections");
		expect(plain).toContain("# Main Doc  :1");
		expect(plain).toContain("## Setup  :3");
		expect(plain).toContain("### Advanced  :5");
	});

	function plain(value: string): string { return value.replace(/\u001b\[[0-9;]*m/g, ""); }
	function nativeText(node: unknown): string {
		if (!node || typeof node !== "object") return "";
		const item = node as { p?: { text?: string; spans?: Array<{ text?: string }> }; c?: unknown[] };
		return [item.p?.text ?? "", ...(item.p?.spans ?? []).map(s => s.text ?? ""), ...(item.c ?? []).map(nativeText)].join("\n");
	}
	function evalResult(outputs: string[], extra: Record<string, unknown> = {}) {
		return { content: [{ type: "text", text: outputs.join("\n") }], details: {
			cells: outputs.map((output, i) => ({ index: i, language: "js", code: "print(await tool.bash({command: 'probe'}))", output, status: i ? "error" : "complete", exitCode: i ? 7 : 0, durationMs: 42 })),
			...extra,
		} };
	}
	function view(result: ReturnType<typeof evalResult>, partial = false) {
		return toolRenderers.eval.describeResult!(result, { expanded: true, isPartial: partial }, { language: "js", code: "print('probe')" })!;
	}
	test("printed command envelopes render data, not escaped wrappers, and keep per-cell failures", () => {
		const success = { text: JSON.stringify({ items: [{ id: 1, state: "ready" }, { id: 2, state: "waiting" }] }) + "\n\nWall time: 0.25 seconds", details: { exitCode: 0, wallTimeMs: 250, timeoutSeconds: 30 } };
		const failure = { text: '{"error":"missing instance"}\n\nWall time: 0.5 seconds\nCommand exited with code 7', hasError: true, details: { exitCode: 7, wallTimeMs: 500, attempt: 2 } };
		const result = evalResult([Bun.inspect(success), Bun.inspect(failure)]);
		const snapshot = JSON.stringify(result);
		const output = view(result);
		const first = plain(nativeText(output.body![0]));
		const second = plain(nativeText(output.body![1]));
		expect(first).toContain("items[2]{id,state}");
		expect(first).toContain("1,ready");
		expect(first).toContain("timeout 30 s");
		expect(first).not.toContain("missing instance");
		expect(second).toContain("missing instance");
		expect(second).toContain("exit 7");
		expect(second).toContain("attempt: 2");
		expect(second).not.toContain("1,ready");
		expect(first).toContain("print(await tool.bash");
		expect(JSON.stringify(result)).toBe(snapshot);
		const ansi = plain(toolRenderers.eval.renderResult(result, { expanded: true, isPartial: false }, themeModule.theme, {})!.render(120).join("\n"));
		expect(ansi).toContain("items[2]{id,state}");
		expect(ansi).toContain("missing instance");
	});

	test("streaming cells keep incomplete output, and malformed data does not execute", () => {
		const incomplete = "{ text: '{\\n' +";
		expect(plain(nativeText(view(evalResult([incomplete]), true).body![0]))).toContain(incomplete);
		const malicious = "{ text: (() => { throw new Error('do not run'); })() }";
		expect(plain(nativeText(view(evalResult([malicious])).body![0]))).toContain(malicious);
		const malformed = { text: "retained diagnostic", details: { meta: { source: { type: "path", value: "index.ts" } }, displayContent: { text: "one line", startLine: 2, lineNumbers: "invalid" } } };
		expect(plain(nativeText(view(evalResult([Bun.inspect(malformed, { depth: 10 })])).body![0]))).toContain("retained diagnostic");
	});

	test("display data belongs only to the last cell and preserves status notices", () => {
		const result = evalResult(["first output", "second output"], { jsonOutputs: [{ count: 3, ready: true }], notice: "truncated capture" });
		const output = view(result);
		expect(plain(nativeText(output.body![0]))).not.toContain("count: 3");
		expect(plain(nativeText(output.body![1]))).toContain("count: 3");
		expect(JSON.stringify(output.body![1])).toContain("truncated capture");
	});

	test("read and grep through Eval use AST context while preserving adjacent output", () => {
		const path = new URL("../.claude/scratchpad/eval-card-fixture.ts", import.meta.url).pathname;
		const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
		mkdirSync(dirname(path), { recursive: true });
		const source = "export class Probe {\n  value = 1;\n  run() {\n    return this.value;\n  }\n}\n";
		writeFileSync(path, source);
		try {
			const envelope = { text: "numbered read", details: { meta: { source: { type: "path", value: path } }, displayContent: { text: source, startLine: 1 }, totalLines: 6 } };
			const read = plain(nativeText(view(evalResult([Bun.inspect(envelope, { depth: 10 })])).body![0]));
			expect(read).toContain("Probe");
			expect(read).toContain("typescript");
			expect(read).not.toContain("return this.value");
			const range = '[' + path + '#ABCD]\n3:  run() {\n4:    return this.value;\n5:  }\n\n[Showing lines 3-5 of 6]\nnext command failed\n';
			const rangedResult = evalResult([range]);
			const ranged = plain(nativeText(view(rangedResult).body![0]));
			expect(ranged).toContain("Probe");
			expect(ranged).toContain("next command failed");
			expect(ranged).toContain("Showing lines 3-5");
			const grep = '[' + path + '#ABCD]\n *4:    return this.value;\n';
			const grepped = plain(nativeText(view(evalResult([grep])).body![0]));
			expect(grepped).toContain("Probe");
			expect(grepped).toContain("1 match");
			writeFileSync(path, "export class Changed {}\n");
			expect(plain(nativeText(view(rangedResult).body![0]))).toBe(ranged);
			const stale = plain(nativeText(view(evalResult([range])).body![0]));
			expect(stale).not.toContain("Changed");
			expect(stale).toContain("return this.value");
		} finally { rmSync(path, { force: true }); }
	});

	test("collapsed Eval uses inline gap markers and expansion restores every output row", () => {
		const rows = Array.from({ length: 12 }, (_, i) => "output-row-" + (i + 1));
		const result = evalResult([rows.join("\n")]);
		const renderer = toolRenderers.eval;
		const args = { language: "js", code: "print(rows)" };
		const folded = plain(renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, args)!.render(100).join("\n"));
		expect(folded).toContain("output-row-5 [...]");
		expect(folded).not.toContain("output-row-6");
		expect(folded).not.toContain("output-row-12");
		expect(folded).not.toContain("more lines");
		const expanded = plain(renderer.renderResult(result, { expanded: true, isPartial: false }, themeModule.theme, args)!.render(100).join("\n"));
		for (const row of rows) expect(expanded).toContain(row);
		expect(expanded).not.toContain("[...]");
		const native = renderer.describeResult!(result, { expanded: false, isPartial: false }, args)!;
		expect(plain(nativeText(native.body![0]))).toContain("output-row-5 [...]");
		expect(JSON.stringify(native)).toContain("omp.run.foot");
	});

});
