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
	const extModule = await import("/Users/emmahyde/projects/hydemods/index.ts");
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
			const cellNode = tspView!.body![0] as { p?: { role?: string } } | undefined;
			expect(cellNode?.p?.role).toBe("omp.tool.eval.cell");
			const str = JSON.stringify(tspView);
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
});
