import { afterEach, beforeAll, beforeEach, expect, test, vi } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { applyHyperlinkSetting, fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { ReadToolGroupComponent, ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components";
import { callLabel, callSubject, CallSystemPrompt, cleanLine, commandName, commitMessage, fallbackLine, planRuns, toolLabel, withoutCopiedLines, withoutLabel, type ToolRowsMode } from "../lib/tool-rows";
import { letterColor, ToolRows } from "../lib/tool-rows-host";

test("a model line copied from the prompt's examples is dropped, so the row keeps the intent", () => {
	expect(withoutCopiedLines("Looking for where approvalMode is set", CallSystemPrompt)).toBeUndefined();
	expect(withoutCopiedLines("Looking for where tool rows cut long titles", CallSystemPrompt)).toBe("Looking for where tool rows cut long titles");
});

test("a run spans quiet blocks between its calls but leaves trailing quiet blocks outside", () => {
	expect(planRuns(["break", "tool", "quiet", "tool", "quiet"], false)).toEqual([{ head: 1, tools: [1, 3], quiet: [2], closed: false }]);
});

test("a break closes the run before it and the next call starts a new run", () => {
	expect(planRuns(["tool", "quiet", "break", "tool"], false)).toEqual([
		{ head: 0, tools: [0], quiet: [], closed: true },
		{ head: 3, tools: [3], quiet: [], closed: false },
	]);
});

test("an idle agent closes the open run", () => {
	expect(planRuns(["tool", "tool"], true)).toEqual([{ head: 0, tools: [0, 1], quiet: [], closed: true }]);
});

test("model replies become one plain phrase or are refused", () => {
	expect(cleanLine('"Show recent commits touching db/migrate."\nExplanation: ...')).toBe("Show recent commits touching db/migrate");
	expect(cleanLine("- **read** the `config` file")).toBe("Read the config file");
	expect(cleanLine("Done")).toBeUndefined();
	expect(cleanLine("\x1b]8;;https://x\x07 \n")).toBeUndefined();
	expect(cleanLine(`Read ${"very ".repeat(40)}long`)!.length).toBeLessThanOrEqual(96);
});

test("titles name files by bare filename and keep URLs whole", () => {
	expect(cleanLine("edit ~/work/hydemods/README.md to document marker")).toBe("Edit README.md to document marker");
	expect(cleanLine("Fetch https://example.com/docs/page.html for setup")).toBe("Fetch https://example.com/docs/page.html for setup");
	expect(cleanLine("List files in app/models")).toBe("List files in app/models");
});

test("read titles drop the Read prefix, keep the filename's case, and cut whole method clauses", () => {
	expect(cleanLine("Read: hydemods/index.ts: recommendFor ranks tools; execute returns picks")).toBe("index.ts: recommendFor ranks tools; execute returns picks");
	expect(cleanLine("Read lib/tool-rows-host.ts: lineKey keys the cache")).toBe("tool-rows-host.ts: lineKey keys the cache");
	const long = cleanLine(`index.ts: first does ${"a ".repeat(20)}thing; second does ${"b ".repeat(20)}thing; third does c`)!;
	expect(long).toBe(`index.ts: first does ${"a ".repeat(20)}thing`);
});

test("the fallback line prefers the agent's intent, then the call's main argument", () => {
	expect(fallbackLine({ command: "ls", i: "Listing files" })).toBe("Listing files");
	expect(fallbackLine({ language: "py", title: "Loading rows", code: "x" })).toBe("Loading rows");
	expect(fallbackLine({ command: "git status\ngit log" })).toBe("git status");
	expect(fallbackLine(undefined)).toBe("");
});

test("a git commit row falls back to the commit message, not the whole command", () => {
	expect(fallbackLine({ command: 'git add index.ts && git commit -q -m "feat(cards): toggle with Ctrl+Shift+T" && git push -q' })).toBe("feat(cards): toggle with Ctrl+Shift+T");
	expect(commitMessage("git commit -am 'fix: typo'")).toBe("fix: typo");
	expect(commitMessage('git -C repo commit --message="say \\"hi\\""')).toBe('say "hi"');
	expect(commitMessage('git commit -m "subject\n\nbody"')).toBe("subject\n\nbody");
	expect(fallbackLine({ command: 'git commit -m "subject\n\nbody"' })).toBe("subject");
	expect(commitMessage("git commit --amend --no-edit")).toBeUndefined();
	expect(commitMessage('echo "-m x" && git status')).toBeUndefined();
	expect(fallbackLine({ command: "git commit" })).toBe("git commit");
});

test("tool labels title-case names and drop the MCP server prefix", () => {
	expect(toolLabel("web_search")).toBe("Web Search");
	expect(toolLabel("mcp__notes_create_page")).toBe("Create Page");
});

test("a bash row is labelled by the program its command runs", () => {
	expect(commandName("git pull")).toBe("git");
	expect(commandName("cd lib && bun test tests/a.test.ts")).toBe("bun");
	expect(commandName("cd ~/work/app; cd sub && rails db:migrate")).toBe("rails");
	expect(commandName("RAILS_ENV=test FOO='a b' bundle exec rspec")).toBe("bundle");
	expect(commandName("sudo /usr/bin/make install")).toBe("make");
	expect(commandName("$(which git) status")).toBeUndefined();
	expect(callLabel("bash", { command: "git pull\ngit log" })).toBe("Git");
	expect(callLabel("bash", { command: "" })).toBe("Bash");
	expect(callLabel("web_search", { query: "x" })).toBe("Web");
	expect(callLabel("read", { path: "xd://skill_search" })).toBe("Search");
	expect(callLabel("write", { path: "xd://ast_grep", content: "{}" })).toBe("AST");
	expect(callLabel("read", { path: "xd://wiki_reindex_embeddings" })).toBe("Index");
	expect(callLabel("xd__wiki_observe", {})).toBe("Observe");
	expect(callLabel("context_notes", {})).toBe("Notes");
	expect(callLabel("read", { path: "xd://wiki_status" })).toBe("Status");
	expect(callLabel("wiki_observe", {})).toBe("Observe");
	expect(callLabel("wiki_recall", {})).toBe("Recall");
	expect(callLabel("generate_image", {})).toBe("Image");
	expect(callLabel("write", { path: "xd://generate_image", content: "{}" })).toBe("Image");
});

test("small models' tool prefixes are stripped from titles", () => {
	expect(cleanLine("Tool-grep: finds approvalMode in pi-tui")).toBe("Finds approvalMode in pi-tui");
	expect(cleanLine("Grep · find registerSlashCommand in src")).toBe("Find registerSlashCommand in src");
	expect(cleanLine("Find lines that mention approval")).toBe("Find lines that mention approval");
	expect(cleanLine("Tool-glob scans global node modules")).toBe("Scans global node modules");
	expect(cleanLine("Grep approval in pi-coding-agent")).toBe("Grep approval in pi-coding-agent");
	expect(cleanLine("Tool-approval.ts does find getToolDecision")).toBe("approval.ts does find getToolDecision");
	expect(cleanLine("approval.ts: function resolveApproval")).toBe("approval.ts: function resolveApproval");
});

test("a small model's echo of the -ing verb rule is stripped from its line", () => {
	expect(cleanLine("-ing: Understanding how withTone works")).toBe("Understanding how withTone works");
	expect(cleanLine("-Understanding how Orca renames panes")).toBe("Understanding how Orca renames panes");
});

test("the subject column names the file a call works on, from its arguments", () => {
	expect(callSubject("read", { path: "lib/tool-rows-host.ts:527-548" })).toBe("tool-rows-host.ts:527-548");
	expect(callSubject("read", { path: "src/a.ts:raw" })).toBe("a.ts");
	expect(callSubject("read", { path: "/Users/x/.omp/" })).toBe(".omp/");
	expect(callSubject("read", { path: "https://example.com/a.html" })).toBeUndefined();
	expect(callSubject("edit", { input: "[lib/a.ts#1A2B]\nPUT 1.=1:\n+x\n[lib/b.ts#3C4D]\nCUT 2" })).toBe("a.ts +1");
	expect(callSubject("grep", { pattern: "x", path: "lib" })).toBeUndefined();
});

test("titles never repeat the row's tool name", () => {
	expect(withoutLabel("Reading about the title cache", ["Read"])).toBe("Learning about the title cache");
	expect(withoutLabel("Grepping for approvalMode", ["Grep"])).toBe("Looking for approvalMode");
	expect(withoutLabel("Writing config.yml defaults", ["Write"])).toBe("Creating config.yml defaults");
	expect(withoutLabel("Git status for dirty files", ["Bash", "Git"])).toBe("Status for dirty files");
	expect(withoutLabel("Grep: approvalMode in pi-tui", ["Grep"])).toBe("approvalMode in pi-tui");
	expect(withoutLabel("G++ build of the parser", ["Bash", "G++"])).toBe("Build of the parser");
	expect(withoutLabel("Understanding the read path", ["Read"])).toBe("Understanding the read path");
	expect(withoutLabel("Reading", ["Read"])).toBe("Reading");
});

/* ------------------------- drawn into a transcript ------------------------- */

const plain = (rows: readonly string[]) => rows.map(row => row.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").trimEnd());
const frame = { tick: 0, now: 0 };
const ui = { requestRender() { }, requestComponentRender() { }, resetDisplay() { } };
// The line cache starts each request on a microtask and awaits the model on another.
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// The intent judge batches calls for 150 ms before it asks; fake timers step past that. A "not enough"
// verdict asks for the model line on the next draw, so draw once, then let the line land.
const judged = async (draw: () => unknown) => {
	vi.advanceTimersByTime(200);
	await settle();
	draw();
	await settle();
};

function setup(mode: { value: ToolRowsMode }, reply?: (system: string, prompt: string) => Promise<string>, intentSays: (intent: string) => number = () => 0, pills = false, knows?: (subject: string) => boolean) {
	const judgeStates: unknown[] = [];
	const calls = new Map<string, { name: string; args: unknown }>();
	const readGroups = new Map<object, Map<string, { args: unknown; result?: { content: unknown[] } }>>();
	const rows = new ToolRows({
		mode: () => mode.value,
		expanded: () => false,
		pills: () => pills,
		knows,
		theme: () => theme,
		complete: reply ?? (async (system, prompt) => {
			if (system.includes("burst")) return "1. Ls: Surveyed the sample project\n- Read: Chose to read a.ts first\nLs: Listed the files\nGrep: Kept a stray item";
			const { tool } = JSON.parse(prompt);
			return tool === "read" ? "wrong.ts: render draws rows; plan groups runs" : `Inspect with ${tool}`;
		}),
		repaint: () => { },
		readEntries: group => readGroups.get(group) as never,
		lookupCall: id => calls.get(id),
		judge: () => ({
			label: "test/judge",
			judge: async request => {
				judgeStates.push(request.state);
				const state = request.state as { calls: Record<string, { intent: string }> };
				const answers = Object.fromEntries(Object.entries(state.calls).map(([id, call]) => [id, { type: "noul", noul: intentSays(call.intent) }]));
				return { api: "test", provider: "test", model: "test", answers, usage: undefined } as never;
			},
		}),
	});
	const uninstall = rows.install();
	rows.setIdle(false);
	const transcript = new TranscriptContainer();
	const tool = (name: string, args: Record<string, unknown>, id: string) => {
		calls.set(id, { name, args });
		const component = new ToolExecutionComponent(name, args, {}, undefined, ui, process.cwd(), id);
		transcript.addChild(component);
		component.updateArgs(args, id);
		component.updateResult({ content: [{ type: "text", text: "line one\nline two" }] }, false, id);
		return component;
	};
	return { rows, uninstall, transcript, tool, calls, readGroups, judgeStates, view: () => plain(transcript.renderViewport(100, 30, frame)), raw: () => transcript.renderViewport(100, 30, frame) };
}

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("read labels link to the original local file rather than a matching basename in the cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "hydemods-file-links-"));
	mkdirSync(join(root, "notes with spaces"));
	const packagePath = join(root, "package.json");
	const skillPath = join(root, "notes with spaces", "SKILL.md");
	const imagePath = join(root, "screenshot-2026-10-22T16-04-22-733.png");
	for (const path of [packagePath, skillPath, imagePath]) writeFileSync(path, "");
	const { uninstall, tool, raw, view } = setup({ value: "lines" });
	applyHyperlinkSetting("always");
	try {
		tool("read", { path: `${packagePath}:1-44`, i: "Inspecting settings" }, "package");
		tool("read", { path: `${skillPath}:raw`, i: "Learning the skill" }, "skill");
		tool("read", { path: `~/${relative(homedir(), imagePath)}`, i: "Inspecting screenshot" }, "image");
		tool("read", { path: "lib/tool-rows-host.ts:1-16", i: "Inspecting renderer" }, "source");
		tool("read", { path: join(root, "missing.ts"), i: "Inspecting missing file" }, "missing");
		tool("write", { path: packagePath, content: "{}", i: "Writing settings" }, "write");
		tool("edit", { input: `[${skillPath}#ABCD]\nPUT 1.=1:\n+x`, i: "Changing the skill" }, "edit");
		const targets = raw().flatMap(row => [...row.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)/g)].map(match => match[1]));
		expect(targets).toEqual([
			fileUriForTerminal(packagePath, { line: 1 }, TERMINAL.id),
			fileUriForTerminal(skillPath, undefined, TERMINAL.id),
			fileUriForTerminal(imagePath, undefined, TERMINAL.id),
			fileUriForTerminal(resolve("lib/tool-rows-host.ts"), { line: 1 }, TERMINAL.id),
			fileUriForTerminal(packagePath, undefined, TERMINAL.id),
			fileUriForTerminal(skillPath, undefined, TERMINAL.id),
		]);
		expect(view().join("\n")).toContain("package.json:1-44");
		expect(view().join("\n")).toContain("SKILL.md");
	} finally {
		applyHyperlinkSetting("auto");
		uninstall();
		rmSync(root, { recursive: true, force: true });
	}
});

test("lines mode draws a run's calls on adjacent rows, across a harness notice", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("bash", { command: "git status" }, "a");
		transcript.addChild(new StatusNotice("a harness notice"));
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "b");
		expect(view()).toEqual(["prompt", "", "✔ GIT   git status", "✔ GREP  Finding TODOs"]);
		await judged(view);
		expect(view()).toEqual(["prompt", "", "✔ GIT   Inspect with bash", "✔ GREP  Inspect with grep"]);
	} finally {
		uninstall();
	}
});

test("pills upper-case each label on a fill, keep titles aligned, and reset only what they set", () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, tool, view, raw } = setup(mode, undefined, undefined, true);
	try {
		tool("read", { path: "a.ts", i: "Reading a" }, "a");
		tool("bash", { command: "ls", i: "Listing files" }, "b");
		expect(view()).toEqual(["✔  READ   Reading a      a.ts", "✔  LS     Listing files"]);
		// Truecolour: a fill with contrast text, closed by resetting only bold and colours. Otherwise reversed.
		expect(raw()[0]).toMatch(/\x1b\[48;2;[\d;]+m\x1b\[38;2;[\d;]+m\x1b\[1m READ \x1b\[22;39;49m|\x1b\[7m.* READ /);
	} finally {
		uninstall();
	}
});

test("a call keeps the agent's intent after OMP strips it from the args it runs with", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, calls, view } = setup(mode);
	try {
		// Streamed args carry `i`; the args at execution start, and the call record here, do not.
		calls.set("a", { name: "bash", args: { command: "git status" } });
		const streamed = new ToolExecutionComponent("bash", { command: "git status", i: "Checking status" }, {}, undefined, ui, process.cwd(), "a");
		transcript.addChild(streamed);
		streamed.updateArgs({ command: "git status", i: "Checking status" }, "a");
		streamed.updateArgs({ command: "git status" }, "a");
		streamed.updateResult({ content: [{ type: "text", text: "clean" }] }, false, "a");
		// Checked before the model line lands, which then replaces the intent.
		expect(view()).toEqual(["✔ GIT  Checking status"]);
	} finally {
		uninstall();
	}
});

test("a card built from stripped args takes the agent's intent from the call record", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, calls, view } = setup(mode);
	try {
		// The live stream or session still records the intent; the card only ever saw stripped args.
		calls.set("a", { name: "bash", args: { command: "git status", i: "Checking status" } });
		const card = new ToolExecutionComponent("bash", { command: "git status" }, {}, undefined, ui, process.cwd(), "a");
		transcript.addChild(card);
		card.updateArgs({ command: "git status" }, "a");
		card.updateResult({ content: [{ type: "text", text: "clean" }] }, false, "a");
		// Checked before the model line lands, which then replaces the intent.
		expect(view()).toEqual(["✔ GIT  Checking status"]);
	} finally {
		uninstall();
	}
});

test("blocks moved into another transcript without addChild still draw as rows (a resumed session)", () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool } = setup(mode);
	try {
		tool("bash", { command: "git status", i: "Checking status" }, "a");
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "b");
		// Resume builds the history in one transcript, then hands its blocks to the live one.
		const live = new TranscriptContainer();
		live.addChild(new Text("prompt", 0, 0));
		live.children.push(...transcript.children.splice(0));
		expect(plain(live.renderViewport(100, 30, frame))).toEqual(["prompt", "", "✔ GIT   Checking status", "✔ GREP  Finding TODOs"]);
		mode.value = "cards";
		expect(plain(live.renderViewport(100, 30, frame)).some(row => row.startsWith("✔ "))).toBe(false);
	} finally {
		uninstall();
	}
});

test("lines mode shows intents at once, lets model lines replace them, aligns columns, and drops the model's filename lead", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("read", { path: "lib/tool-rows-host.ts:10-40" }, "a");
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "b");
		tool("read", { path: "lib/a.ts", i: "Reading a" }, "c");
		// The intents show as written at once; the call without one has an empty status line until the model answers.
		expect(view().slice(2)).toEqual([
			`✔ READ  ${" ".repeat(13)}  tool-rows-host.ts:10-40`,
			"✔ GREP  Finding TODOs",
			"✔ READ  Reading a      a.ts",
		]);
		await judged(view);
		expect(view().slice(2)).toEqual([
			"✔ READ  render draws rows; plan groups runs  tool-rows-host.ts:10-40",
			"✔ GREP  Inspect with grep",
			"✔ READ  render draws rows; plan groups runs  a.ts",
		]);
	} finally {
		uninstall();
	}
});

test("a narrow pane cuts the status line, so the run's files stay on screen and aligned", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool } = setup(mode);
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("read", { path: "lib/tool-rows-host.ts:10-40" }, "a");
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "b");
		tool("read", { path: "lib/a.ts", i: "Reading a" }, "c");
		transcript.renderViewport(50, 30, frame);
		await judged(() => transcript.renderViewport(50, 30, frame));
		const rows = plain(transcript.renderViewport(50, 30, frame)).slice(2);
		expect(rows.map(row => Bun.stringWidth(row) <= 50)).toEqual([true, true, true]);
		expect(rows[0]).toEndWith("  tool-rows-host.ts:10-40");
		expect(rows[0]).toBe("✔ READ  render draws row…  tool-rows-host.ts:10-40");
		expect(rows[1]).toBe("✔ GREP  Inspect with grep");
		expect(rows[2]).toEndWith("  a.ts");
		expect(rows[2]!.indexOf("a.ts")).toBe(rows[0]!.indexOf("tool-rows-host.ts"));
	} finally {
		uninstall();
	}
});

test("a title longer than the others still lines up every row's file", () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		const long = "Understanding how rowsFor function works with component and state";
		tool("read", { path: "lib/tool-rows-host.ts:698-712", i: long }, "a");
		tool("read", { path: "a.txt", i: "Learning a.txt" }, "b");
		tool("edit", { input: "[a.txt#ABCD]\nPUT 1.=1:\n+x", i: "Making a change" }, "c");
		const rows = view().slice(2);
		const column = rows[0]!.indexOf("tool-rows-host.ts");
		expect(rows[0]).toBe(`✔ READ  ${long}  tool-rows-host.ts:698-712`);
		expect(rows.slice(1).map(row => row.lastIndexOf("a.txt"))).toEqual([column, column]);
	} finally {
		uninstall();
	}
});

test("a call with no subject column keeps the model's filename lead", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode, async () => "approval.ts: function resolveApproval");
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("grep", { pattern: "resolveApproval" }, "a");
		view();
		await settle();
		expect(view().slice(2)).toEqual(["✔ GREP  approval.ts: function resolveApproval"]);
	} finally {
		uninstall();
	}
});

test("a live group lists its calls line by line, then the head holds until its per-tool bullets land and keeps them in scrollback", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		const head = tool("bash", { command: "ls", i: "Listing files" }, "a");
		tool("read", { path: "src/a.ts", i: "Reading a.ts" }, "b");
		await settle();
		expect(view()).toEqual(["✔ LS    Listing files", "✔ READ  Reading a.ts   a.ts"]);
		expect(head.isTranscriptBlockFinalized()).toBe(false);
		transcript.addChild(new Text("reply", 0, 0));
		expect(head.isTranscriptBlockFinalized()).toBe(false);
		await settle();
		// One bullet per distinct tool in first-use order; the first line for a label wins, unknown labels drop.
		const rows = ["✔ 2 calls", "  • LS   Surveyed the sample project", "  • READ Chose to read a.ts first"];
		expect(view()).toEqual([...rows, "", "reply"]);
		expect(head.isTranscriptBlockFinalized()).toBe(true);
		const batch = transcript.peekFinalizedBatch(100, 1);
		expect(plain(batch?.rows ?? [])).toEqual([...rows, ""]);
		transcript.acknowledgeFinalizedBatch(batch!.id);
		// Switching back to cards must not redraw the absorbed call below the scrollback row.
		mode.value = "cards";
		expect(view()).toEqual(["reply"]);
	} finally {
		uninstall();
	}
});

test("a closed group without the model's bullets shows each tool's last settled title", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode, async () => "");
	try {
		tool("read", { path: "src/a.ts", i: "Understanding the a module" }, "a");
		tool("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x", i: "Making a export x" }, "b");
		tool("bash", { command: "bun test", i: "Running the tests" }, "c");
		tool("edit", { input: "[src/b.ts#3C4D]\nPUT 1.=1:\n+y", i: "Making b import x" }, "d");
		transcript.addChild(new Text("reply", 0, 0));
		await settle();
		expect(view().slice(0, 4)).toEqual(["✔ 4 calls", "  • READ Understanding the a module", "  • EDIT Making b import x", "  • BUN  Running the tests"]);
	} finally {
		uninstall();
	}
});

test("a group bullet wider than the pane wraps under its own text instead of being cut", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const { uninstall, transcript, tool } = setup(mode, async () => "Read: Moved the file column last so every row lines up\nRead: Kept it");
	try {
		tool("read", { path: "src/a.ts", i: "Understanding the a module" }, "a");
		transcript.addChild(new Text("reply", 0, 0));
		transcript.renderViewport(30, 30, frame);
		await settle();
		expect(plain(transcript.renderViewport(30, 30, frame)).slice(0, 4)).toEqual(["✔ 1 call", "  • READ Moved the file column", "    last so every row lines up", ""]);
	} finally {
		uninstall();
	}
});

test("a group bullet longer than a call line keeps every word and wraps under its own text", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const long = "Moved the file column to the end of every row so that the files line up under the longest status line in the batch";
	const { uninstall, transcript, tool } = setup(mode, async () => `Read: ${long}`);
	try {
		tool("read", { path: "src/a.ts", i: "Understanding the a module" }, "a");
		transcript.addChild(new Text("reply", 0, 0));
		transcript.renderViewport(40, 30, frame);
		await settle();
		const rows = plain(transcript.renderViewport(40, 30, frame));
		const bullet = rows.slice(1, rows.indexOf(""));
		expect(long.length).toBeGreaterThan(96);
		expect(bullet[0]).toStartWith("  • READ Moved");
		expect(bullet.slice(1).every(row => /^ {4}\S/.test(row))).toBe(true);
		expect(bullet.map(row => row.slice(4)).join(" ")).toBe(`READ ${long}`);
	} finally {
		uninstall();
	}
});

test("a task row names its agents and keeps the subagent footer under it", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode, async () => "");
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		const args = { tasks: [{ name: "AuthRefactor", task: "split refresh" }, { name: "Docs", task: "document it" }], i: "Splitting the auth refresh path" };
		const task = tool("task", args, "a");
		const progress = [{ id: "0-AuthRefactor", status: "running", task: "t", description: "split the refresh path", recentTools: [], toolCount: 2, requests: 3, cost: 0, durationMs: 0 }];
		task.updateResult({ content: [], details: { progress } }, true, "a");
		const rows = view().slice(2);
		expect(rows[0]).toMatch(/^• TASK  Splitting the auth refresh path  AuthRefactor \+1$/);
		expect(rows[1]).toStartWith("    ◐ 1 running");
		expect(rows[2]).toContain("AuthRefactor");
		expect(rows[2]).toStartWith("    ");
	} finally {
		uninstall();
	}
});

test("a row whose subject the wiki knows leads its subject with a badge, and the column stays aligned", () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode, async () => "", undefined, false, subject => subject === "gallery.ts");
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("read", { path: "lib/gallery.ts", i: "Seeing the gallery" }, "a");
		tool("read", { path: "lib/a.ts", i: "Seeing a" }, "b");
		expect(view().slice(2)).toEqual(["✔ READ  Seeing the gallery  ◆ gallery.ts", "✔ READ  Seeing a            a.ts"]);
	} finally {
		uninstall();
	}
});

test("a call's line request names the agent's intent and the steps before it", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const prompts: string[] = [];
	const { uninstall, transcript, tool, view } = setup(mode, async (_system, prompt) => (prompts.push(prompt), ""));
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "a");
		tool("bash", { command: "git status" }, "b");
		await judged(view);
		await judged(view);
		const second = prompts.map(prompt => JSON.parse(prompt)).find(prompt => prompt.tool === "bash");
		expect(second).toEqual({ tool: "bash", args: { command: "git status" }, earlier: ["Grep: Finding TODOs"] });
		const first = prompts.map(prompt => JSON.parse(prompt)).find(prompt => prompt.tool === "grep");
		expect(first).toEqual({ tool: "grep", intent: "Finding TODOs", args: { pattern: "TODO" } });
	} finally {
		uninstall();
	}
});

test("a grouped read whose args OMP stripped of the intent shows the agent's intent until the model line replaces it", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, calls, readGroups, view } = setup(mode, async () => "Learning how the a module loads its config");
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		const group = new ReadToolGroupComponent();
		calls.set("r1", { name: "read", args: { path: "src/a.ts", i: "Checking the a module" } });
		readGroups.set(group, new Map([["r1", { args: { path: "src/a.ts" }, result: { content: [{ type: "text", text: "x" }] } }]]));
		transcript.addChild(group);
		expect(view().slice(2)).toEqual(["✔ READ  Checking the a module  a.ts"]);
		await judged(view);
		expect(view().slice(2)).toEqual(["✔ READ  Learning how the a module loads its config  a.ts"]);
	} finally {
		uninstall();
	}
});

test("an intent the judge finds enough stays, and the model is never asked for that call", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const prompts: string[] = [];
	const { uninstall, transcript, tool, judgeStates, view } = setup(mode, async (_system, prompt) => {
		prompts.push(prompt);
		return "Rummaging through the code for loose ends";
	}, intent => (intent.startsWith("Finding") ? 0.9 : 0.1));
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("grep", { pattern: "TODO", i: "Finding TODOs left in the tool rows host" }, "a");
		tool("bash", { command: "ls", i: "Looking" }, "b");
		view();
		await judged(view);
		expect(view().slice(2)).toEqual(["✔ GREP  Finding TODOs left in the tool rows host", "✔ LS    Rummaging through the code for loose ends"]);
		// Both calls went to the judge in one request; only the vague one reached the model.
		expect(judgeStates).toHaveLength(1);
		expect(prompts.map(prompt => JSON.parse(prompt).tool)).toEqual(["bash"]);
	} finally {
		uninstall();
	}
});

test("a skill read is labelled Skill, names the skill, and asks the model to sum up what the skill teaches", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const prompts: string[] = [];
	const { uninstall, transcript, tool, view } = setup(mode, async (system, prompt) => {
		prompts.push(system + prompt);
		return "Learning to write prompts native to each model";
	});
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("read", { path: "skill://model-native-prompt/references/dispatch.md" }, "a");
		view();
		await settle();
		expect(view().slice(2)).toEqual(["✔ SKILL  Learning to write prompts native to each model  model-native-prompt"]);
		expect(prompts.some(text => text.includes("skill:// path") && text.includes("skill://model-native-prompt/references/dispatch.md"))).toBe(true);
	} finally {
		uninstall();
	}
});

test("a full replay in cards mode draws every call of a committed run, as a fresh cards transcript does", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool } = setup(mode);
	try {
		const head = tool("bash", { command: "echo alpha", i: "Echo alpha" }, "a");
		tool("bash", { command: "echo bravo", i: "Echo bravo" }, "b");
		tool("bash", { command: "echo charlie", i: "Echo charlie" }, "c");
		transcript.addChild(new Text("reply", 0, 0));
		await settle();
		head.releaseRenderCaches();
		mode.value = "cards";
		const all = plain(transcript.render(100) as string[]);
		const fresh = setup({ value: "cards" as ToolRowsMode });
		fresh.tool("bash", { command: "echo alpha", i: "Echo alpha" }, "a");
		fresh.tool("bash", { command: "echo bravo", i: "Echo bravo" }, "b");
		fresh.tool("bash", { command: "echo charlie", i: "Echo charlie" }, "c");
		fresh.transcript.addChild(new Text("reply", 0, 0));
		const expected = plain(fresh.transcript.render(100) as string[]);
		fresh.uninstall();
		expect(all).toEqual(expected);
	} finally {
		uninstall();
	}
});

test("xd:// and MCP calls are labelled by their device, as bash rows are by their program", () => {
	const { uninstall, tool, view } = setup({ value: "lines" });
	try {
		tool("bash", { command: "git status", i: "Checking status" }, "a");
		tool("write", { path: "xd://mcp__linear_get_issue", content: "{\"id\":\"X-1\"}", i: "Fetching the issue" }, "b");
		tool("read", { path: "xd://mcp__dash_api_list_installed_docsets", i: "Reading the docs" }, "c");
		tool("write", { path: "xd://wiki_observe", content: "{}", i: "Noting the decision" }, "d");
		tool("mcp__blender_mcp_get_objects_summary", { i: "Listing objects" }, "e");
		expect(view().map(row => row.replace(/\[[^\]]+\] /, ""))).toEqual([
			"✔ GIT      Checking status",
			"✔ LINEAR   Fetching the issue",
			"✔ DASH     Reading the docs",
			"✔ OBSERVE  Noting the decision",
			"✔ BLENDER  Listing objects",
		]);
	} finally { uninstall(); }
});

test("labels without a fixed colour take one from their first letter", () => {
	expect(letterColor("Git")).toBe(letterColor("grep"));
	expect(letterColor("Git")).not.toBe(letterColor("Bun"));
	expect(letterColor("Linear")).not.toBe(letterColor("Mkdir"));
	expect(letterColor("")).toBeDefined();
});
