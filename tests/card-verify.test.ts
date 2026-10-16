import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";

describe("card verify harness for TOON output", async () => {
	const ompPath = Bun.which("omp");
	if (!ompPath) {
		console.warn("Skipping harness test: omp not in PATH");
		return;
	}
	const themeModule = await import("@oh-my-pi/pi-tui/theme");
	themeModule.ensureThemeSync();

	const { toolRenderers } = await import("@oh-my-pi/pi-tui/tools");

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
					text: "[lib/code-outline.ts#1234]\n251: export function renderOutline(outline: Outline, label: string): string[] {\n255: \t\t`${label} · ${outline.language} · ${outline.totalLines} lines · ${count} decl${count === 1 ? \"\" : \"s\"}`,\n"
				}
			],
			details: {
				cwd: process.cwd(),
				scopePath: "lib/code-outline.ts",
				displayContent: "   251│ export function renderOutline(outline: Outline, label: string): string[] {\n * 255│ \t\t`${label} · ${outline.language} · ${outline.totalLines} lines · ${count} decl${count === 1 ? \"\" : \"s\"}`,\n",
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
		expect(plain).toContain("255");
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
 251:export function renderOutline(outline: Outline, label: string): string[] {
*255:\t\t\`\${label} · \${outline.language} · \${outline.totalLines} lines · \${count} decl\${count === 1 ? "" : "s"}\`,
 256:\t\t...flat.map(outlineRow),
`
				}
			],
			details: {
				cwd: process.cwd(),
				searchPath: process.cwd(),
				displayContent: `# lib/
## code-outline.ts#52B3
 251│export function renderOutline(outline: Outline, label: string): string[] {
*255│\t\t\`\${label} · \${outline.language} · \${outline.totalLines} lines · \${count} decl\${count === 1 ? "" : "s"}\`,
    │...
 256│\t\t...flat.map(outlineRow),
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
		expect(plain).toContain("255");
		expect(plain).not.toContain("251:");
		expect(plain).not.toContain("256:");
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
	test("JS fold marker renders as a whole row, not an escape split across rows", () => {
		const code = Array.from({ length: 15 }, (_, i) => `const step${i} = ${i};`).join("\n");
		const result = { content: [{ type: "text", text: "logged line" }], details: {
			cells: [{ index: 0, code, language: "js", output: "logged line", status: "complete", exitCode: 0, durationMs: 1 }],
		}, isError: false };
		const rendered = toolRenderers.eval.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, { language: "js", code })!.render(100).join("\n");
		const rows = plain(rendered).split("\n");
		expect(rows.some(row => row.includes("[...]"))).toBe(true);
		expect(rows.some(row => row.includes("\u001b"))).toBe(false);
	});

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

	test("eval display with textOutput and large code compacts both code and TOON without duplicate raw JSON", () => {
		const renderer = toolRenderers.eval;
		const code = Array.from({ length: 15 }, (_, i) => `const step${i} = ${i};`).join("\n");
		const jsonVal = {
			status: "ok",
			records: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: `item-${i + 1}` })),
		};
		const rawDisplay = "display[1]:\n" + JSON.stringify(jsonVal, null, 2);
		const result = {
			content: [{ type: "text", text: `logged line\n\n${rawDisplay}\n\n[Showing lines 1-20 of 100. Read artifact://7 for full output]` }],
			details: {
				language: "js",
				cells: [{
					index: 0,
					code,
					language: "js",
					output: `logged line\n\n${rawDisplay}`,
					textOutput: "logged line",
					status: "complete",
					exitCode: 0,
					durationMs: 15,
				}],
				jsonOutputs: [jsonVal],
			},
			isError: false,
		};
		const args = { language: "js", code };
		const foldedAnsi = plain(renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, args)!.render(100).join("\n"));
		expect(foldedAnsi).toContain("const step0 = 0;");
		expect(foldedAnsi).not.toContain("const step10 = 10;");
		expect(foldedAnsi).toContain("status: ok");
		expect(foldedAnsi).not.toContain("display[1]:");
		expect(foldedAnsi).not.toContain("Read artifact://7");
	});

	const sessionListing = [
		"Sessions across projects, newest first:",
		"- 019e6a1b7c3d4 · 5m ago · ~/work/alpha · 42 msg · Reconcile ledger exports",
		"  recap: Fixed the ledger export totals and added a regression check",
		"- 019e5f20aa91b · 2h ago · ~/work/beta · 7 msg · failed · Probe cache warmup",
	].join("\n");
	const sessionDetail = [
		"Session 019e6a1b7c3d4 · Reconcile ledger exports",
		"project ~/work/alpha · created 1d ago · active 5m ago · 42 msgs",
		"file ~/.omp/agent/sessions/alpha/019e6a1b7c3d4.jsonl",
		"",
		"Recaps, oldest first:",
		"- 1d ago: Started tracing the export mismatch",
		"- 5m ago: Fixed the ledger export totals",
		"Prompts, oldest first:",
		"- 1d ago: why do exports disagree with the ledger",
	].join("\n");
	const artifactNotice = "[Output truncated. Full output: artifact://77]";
	function archiveEval(output: string, extra: Record<string, unknown> = {}) {
		return evalResult([output], extra);
	}
	function archiveSurfaces(result: ReturnType<typeof evalResult>, expanded: boolean) {
		const args = { language: "py", code: "print(archive.sessions())" };
		const ansi = plain(toolRenderers.eval.renderResult(result, { expanded, isPartial: false }, themeModule.theme, args)!.render(140).join("\n"));
		const native = plain(toolRenderers.eval.describeResult!(result, { expanded, isPartial: false }, args)!.body!.map((node: unknown) => nativeText(node)).join("\n"));
		return { ansi, native };
	}

	test("archive session listings become cards that keep every id, title, recap and status", () => {
		const result = archiveEval(sessionListing);
		const snapshot = JSON.stringify(result);
		for (const text of Object.values(archiveSurfaces(result, true))) {
			for (const fact of ["019e6a1b7c3d4", "Reconcile ledger exports", "Fixed the ledger export totals", "019e5f20aa91b", "Probe cache warmup", "failed", "42"]) {
				expect(text).toContain(fact);
			}
			expect(text).toContain("entries[2]");
		}
		expect(JSON.stringify(result)).toBe(snapshot);
		// Real card takeover: no native Eval box, no ANSI box border; a hydemods card with a foot instead.
		const nativeCard = JSON.stringify(view(result));
		expect(nativeCard).not.toContain("omp.tool.eval.input");
		expect(nativeCard).not.toContain("omp.run.foot");
		for (const expanded of [false, true]) {
			const ansi = plain(toolRenderers.eval.renderResult(result, { expanded, isPartial: false }, themeModule.theme, {})!.render(140).join("\n"));
			expect(ansi).not.toContain("╭");
			if (expanded) expect(ansi).toContain("foot: done");
		}
		expect(archiveSurfaces(result, true).native).toContain("foot: done");
	});

	test("archive session detail keeps recaps, prompts and file facts in a card", () => {
		const result = archiveEval(sessionDetail);
		for (const text of Object.values(archiveSurfaces(result, true))) {
			for (const fact of ["019e6a1b7c3d4", "Reconcile ledger exports", "Started tracing the export mismatch", "Fixed the ledger export totals", "why do exports disagree with the ledger", "019e6a1b7c3d4.jsonl"]) {
				expect(text).toContain(fact);
			}
			expect(text).toContain("recaps");
			expect(text).toContain("prompts");
		}
	});

	test("archive cards are built from a cell's textOutput, fold with it, and leave the original untouched", () => {
		const many = ["Sessions across projects, newest first:"];
		for (let i = 1; i <= 14; i++) many.push(`- 019e00000${String(i).padStart(4, "0")} · ${i}m ago · ~/work/p${i} · ${i} msg · Task number ${i}`);
		const result = archiveEval("placeholder");
		const cell = (result.details as { cells: Array<Record<string, unknown>> }).cells[0];
		cell.output = "ORIGINAL-OUTPUT-MARKER";
		cell.textOutput = many.join("\n");
		const snapshot = JSON.stringify(result);
		const folded = archiveSurfaces(result, false);
		const expanded = archiveSurfaces(result, true);
		expect(folded.ansi).not.toContain("Task number 14");
		for (const text of Object.values(expanded)) {
			expect(text).toContain("entries[14]");
			expect(text).not.toContain("ORIGINAL-OUTPUT-MARKER");
			for (let i = 1; i <= 14; i++) expect(text).toContain(`Task number ${i}`);
		}
		expect(JSON.stringify(result)).toBe(snapshot);
	});

	test("archive cards preserve code context, mixed prose, failures and artifact notices", () => {
		const output = ["before archive", sessionListing, "after archive: 2 shown", artifactNotice].join("\n");
		const result = archiveEval(output);
		(result.details as { cells: Array<Record<string, unknown>> }).cells[0].code = "print(archive.sessions())\nprint('after archive: 2 shown')";
		const args = { language: "py", code: "print('args fallback')" };
		const native = toolRenderers.eval.describeResult!(result, { expanded: true, isPartial: false }, args)!;
		const text = plain(native.body!.map((node: unknown) => nativeText(node)).join("\n"));
		for (const fact of ["before archive", "after archive: 2 shown", artifactNotice, "Reconcile ledger exports"]) expect(text).toContain(fact);
		expect(text).toContain("archive.sessions()");
		expect(JSON.stringify(native)).not.toContain("omp.tool.eval.input");
		const ansi = plain(toolRenderers.eval.renderResult(result, { expanded: true, isPartial: false }, themeModule.theme, args)!.render(140).join("\n"));
		for (const fact of ["before archive", "after archive: 2 shown", artifactNotice, "Reconcile ledger exports", "archive.sessions()"]) expect(ansi).toContain(fact);

		const failing = evalResult(["ok first", sessionListing + "\nArchiveError: no session matches 'zzz'"]);
		const cells = view(failing).body!;
		const footTone = (node: unknown): unknown => {
			const found = (n: unknown): Record<string, unknown> | undefined => {
				if (!n || typeof n !== "object") return undefined;
				const item = n as { p?: Record<string, unknown>; c?: unknown[] };
				if (item.p?.role === "omp.run.state") return item.p;
				for (const child of item.c ?? []) { const hit = found(child); if (hit) return hit; }
				return undefined;
			};
			return found(node)?.tone;
		};
		expect(footTone(cells[1])).toBe("error");
		expect(footTone(cells[0])).not.toBe("error");
		const failed = plain(nativeText(cells[1]));
		expect(failed).toContain("no session matches 'zzz'");
		expect(failed).toContain("Reconcile ledger exports");
	});

	test("archive card collapses when folded and restores every record on expansion", () => {
		const many = ["Sessions across projects, newest first:"];
		for (let i = 1; i <= 14; i++) many.push(`- 019e00000${String(i).padStart(4, "0")} · ${i}m ago · ~/work/p${i} · ${i} msg · Task number ${i}`);
		const result = archiveEval(many.join("\n"));
		const { ansi: folded } = archiveSurfaces(result, false);
		const { ansi: expanded, native: nativeExpanded } = archiveSurfaces(result, true);
		expect(folded).not.toContain("Task number 14");
		const foldedView = toolRenderers.eval.describeResult!(result, { expanded: false, isPartial: false }, { language: "py", code: "print(archive.sessions())" })! as { preview?: { lines?: number } };
		expect(foldedView.preview?.lines).toBeGreaterThan(0);
		for (let i = 1; i <= 14; i++) {
			expect(expanded).toContain(`Task number ${i}`);
			expect(nativeExpanded).toContain(`Task number ${i}`);
		}
	});

	test("archive presentation is skipped while streaming and never executes or alters malformed listings", () => {
		const streaming = view(archiveEval(sessionListing), true);
		expect(JSON.stringify(streaming)).toContain("omp.tool.eval.input");
		expect(plain(nativeText(streaming.body![0]))).toContain("019e6a1b7c3d4");
		const hostile = "Sessions across projects, newest first:\n- ${process.exit(1)} · 5m ago · (() => { throw 1 })() · 1 msg · $(rm -rf /)";
		const text = plain(archiveSurfaces(archiveEval(hostile), true).native);
		expect(text).toContain("$(rm -rf /)");
		expect(text).toContain("process.exit(1)");
	});

	test("archive cards leave ordinary bulleted prose and unsettled or failed Eval in the native box", () => {
		const prose = "Shopping list, newest first:\n- milk · 2 days ago\n- eggs · today";
		const plainView = view(evalResult([prose]));
		expect(JSON.stringify(plainView)).toContain("omp.tool.eval.input");
		expect(plain(nativeText(plainView.body![0]))).toContain("- milk · 2 days ago");
		expect(plain(nativeText(plainView.body![0]))).toContain("- eggs · today");

		const failed = archiveEval(sessionListing);
		const cell = (failed.details as { cells: Array<Record<string, unknown>> }).cells[0];
		cell.status = "error";
		cell.exitCode = 7;
		const failedView = view(failed);
		expect(JSON.stringify(failedView)).toContain("omp.tool.eval.input");
		expect(JSON.stringify(failedView)).toContain("omp.run.foot");
		expect(plain(nativeText(failedView.body![0]))).toContain("Reconcile ledger exports");
		expect(plain(toolRenderers.eval.renderResult(failed, { expanded: true, isPartial: false }, themeModule.theme, {})!.render(140).join("\n"))).not.toContain("foot: done");

		const markdown = archiveEval(sessionListing);
		(markdown.details as { cells: Array<Record<string, unknown>> }).cells[0].hasMarkdown = true;
		expect(JSON.stringify(view(markdown))).toContain("omp.tool.eval.input");
	});

});
