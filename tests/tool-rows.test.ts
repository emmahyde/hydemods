import { beforeAll, expect, test } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { ReadToolGroupComponent, ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components";
import { callLabel, callSubject, CallSystemPrompt, cleanLine, commandName, commitMessage, fallbackLine, planRuns, toolLabel, withoutCopiedLines, withoutLabel, type ToolRowsMode } from "../lib/tool-rows";
import { ToolRows } from "../lib/tool-rows-host";

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
	expect(callLabel("web_search", { query: "x" })).toBe("Web Search");
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

function setup(mode: { value: ToolRowsMode }, reply?: (system: string, prompt: string) => Promise<string>) {
	const calls = new Map<string, { name: string; args: unknown }>();
	const readGroups = new Map<object, Map<string, { args: unknown; result?: { content: unknown[] } }>>();
	const rows = new ToolRows({
		mode: () => mode.value,
		expanded: () => false,
		theme: () => theme,
		complete: reply ?? (async (system, prompt) => {
			if (system.includes("burst")) return "1. Surveyed the sample project\n- Listed the files\nSurveyed the sample project\nChose to read a.ts first\nKept a fourth item";
			const { tool } = JSON.parse(prompt);
			return tool === "read" ? "wrong.ts: render draws rows; plan groups runs" : `Inspect with ${tool}`;
		}),
		repaint: () => { },
		readEntries: group => readGroups.get(group) as never,
		lookupCall: id => calls.get(id),
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
	return { rows, uninstall, transcript, tool, calls, readGroups, view: () => plain(transcript.renderViewport(100, 30, frame)) };
}

beforeAll(async () => {
	await initTheme(false);
});

test("lines mode draws a run's calls on adjacent rows, across a harness notice", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("bash", { command: "git status" }, "a");
		transcript.addChild(new StatusNotice("a harness notice"));
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "b");
		expect(view()).toEqual(["prompt", "", "✔ Git   git status", "✔ Grep  Finding TODOs"]);
		await settle();
		expect(view()).toEqual(["prompt", "", "✔ Git   Inspect with bash", "✔ Grep  Inspect with grep"]);
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
		expect(view()).toEqual(["✔ Git  Checking status"]);
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
		expect(view()).toEqual(["✔ Git  Checking status"]);
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
		expect(plain(live.renderViewport(100, 30, frame))).toEqual(["prompt", "", "✔ Git   Checking status", "✔ Grep  Finding TODOs"]);
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
			`✔ Read  ${" ".repeat(13)}  tool-rows-host.ts:10-40`,
			"✔ Grep  Finding TODOs",
			"✔ Read  Reading a      a.ts",
		]);
		await settle();
		expect(view().slice(2)).toEqual([
			"✔ Read  render draws rows; plan groups runs  tool-rows-host.ts:10-40",
			"✔ Grep  Inspect with grep",
			"✔ Read  render draws rows; plan groups runs  a.ts",
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
		await settle();
		const rows = plain(transcript.renderViewport(50, 30, frame)).slice(2);
		expect(rows.map(row => Bun.stringWidth(row) <= 50)).toEqual([true, true, true]);
		expect(rows[0]).toEndWith("  tool-rows-host.ts:10-40");
		expect(rows[0]).toBe("✔ Read  render draws row…  tool-rows-host.ts:10-40");
		expect(rows[1]).toBe("✔ Grep  Inspect with grep");
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
		expect(rows[0]).toBe(`✔ Read  ${long}  tool-rows-host.ts:698-712`);
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
		expect(view().slice(2)).toEqual(["✔ Grep  approval.ts: function resolveApproval"]);
	} finally {
		uninstall();
	}
});

test("the head holds its place until the run closes and its summary lands, then keeps that row in scrollback", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		const head = tool("bash", { command: "ls", i: "Listing files" }, "a");
		tool("read", { path: "src/a.ts", i: "Reading a.ts" }, "b");
		await settle();
		expect(head.isTranscriptBlockFinalized()).toBe(false);
		transcript.addChild(new Text("reply", 0, 0));
		expect(head.isTranscriptBlockFinalized()).toBe(false);
		await settle();
		// The model's reply keeps three distinct items, without its list markers.
		const rows = ["✔ 2 calls", "  • Surveyed the sample project", "  • Listed the files", "  • Chose to read a.ts first"];
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

test("a closed group without the model's items lists the agent's lines for its last changes", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode, async () => "");
	try {
		tool("read", { path: "src/a.ts", i: "Understanding the a module" }, "a");
		tool("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x", i: "Making a export x" }, "b");
		tool("bash", { command: "bun test", i: "Running the tests" }, "c");
		tool("edit", { input: "[src/b.ts#3C4D]\nPUT 1.=1:\n+y", i: "Making b import x" }, "d");
		transcript.addChild(new Text("reply", 0, 0));
		await settle();
		expect(view().slice(0, 3)).toEqual(["✔ 4 calls", "  • Making a export x", "  • Making b import x"]);
	} finally {
		uninstall();
	}
});

test("a group bullet wider than the pane wraps under its own text instead of being cut", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const { uninstall, transcript, tool } = setup(mode, async () => "Moved the file column last so every row lines up\nKept it");
	try {
		tool("read", { path: "src/a.ts", i: "Understanding the a module" }, "a");
		transcript.addChild(new Text("reply", 0, 0));
		transcript.renderViewport(30, 30, frame);
		await settle();
		expect(plain(transcript.renderViewport(30, 30, frame)).slice(0, 5)).toEqual([
			"✔ 1 call",
			"  • Moved the file column last",
			"    so every row lines up",
			"  • Kept it",
			"",
		]);
	} finally {
		uninstall();
	}
});

test("a group bullet longer than a call line keeps every word and wraps under its own text", async () => {
	const mode = { value: "group" as ToolRowsMode };
	const long = "Moved the file column to the end of every row so that the files line up under the longest status line in the batch";
	const { uninstall, transcript, tool } = setup(mode, async () => long);
	try {
		tool("read", { path: "src/a.ts", i: "Understanding the a module" }, "a");
		transcript.addChild(new Text("reply", 0, 0));
		transcript.renderViewport(40, 30, frame);
		await settle();
		const rows = plain(transcript.renderViewport(40, 30, frame));
		const bullet = rows.slice(1, rows.indexOf(""));
		expect(long.length).toBeGreaterThan(96);
		expect(bullet[0]).toStartWith("  • Moved");
		expect(bullet.slice(1).every(row => /^ {4}\S/.test(row))).toBe(true);
		expect(bullet.map(row => row.slice(4)).join(" ")).toBe(long);
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
		expect(view().slice(2)).toEqual(["✔ Read  Checking the a module  a.ts"]);
		await settle();
		expect(view().slice(2)).toEqual(["✔ Read  Learning how the a module loads its config  a.ts"]);
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
		expect(view().slice(2)).toEqual(["✔ Skill  Learning to write prompts native to each model  model-native-prompt"]);
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
