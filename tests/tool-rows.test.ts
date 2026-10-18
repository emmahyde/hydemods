import { beforeAll, expect, test } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components";
import { cleanLine, fallbackLine, planRuns, toolLabel, type ToolRowsMode } from "../lib/tool-rows";
import { ToolRows } from "../lib/tool-rows-host";

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

test("tool labels title-case names and drop the MCP server prefix", () => {
	expect(toolLabel("web_search")).toBe("Web Search");
	expect(toolLabel("mcp__notes_create_page")).toBe("Create Page");
});

/* ------------------------- drawn into a transcript ------------------------- */

const plain = (rows: readonly string[]) => rows.map(row => row.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").trimEnd());
const frame = { tick: 0, now: 0 };
const ui = { requestRender() { }, requestComponentRender() { }, resetDisplay() { } };
// The line cache starts each request on a microtask and awaits the model on another.
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function setup(mode: { value: ToolRowsMode }) {
	const calls = new Map<string, { name: string; args: unknown }>();
	const rows = new ToolRows({
		mode: () => mode.value,
		expanded: () => false,
		theme: () => theme,
		complete: async (system, prompt) => (system.includes("burst") ? "Survey the sample project" : `Inspect with ${JSON.parse(prompt).tool}`),
		repaint: () => { },
		readEntries: () => undefined,
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
	return { rows, uninstall, transcript, tool, view: () => plain(transcript.renderViewport(100, 30, frame)) };
}

beforeAll(async () => {
	await initTheme(false);
});

test("lines mode draws a run's calls on adjacent rows, across a harness notice", async () => {
	const mode = { value: "lines" as ToolRowsMode };
	const { uninstall, transcript, tool, view } = setup(mode);
	try {
		transcript.addChild(new Text("prompt", 0, 0));
		tool("bash", { command: "ls", i: "Listing files" }, "a");
		transcript.addChild(new StatusNotice("a harness notice"));
		tool("grep", { pattern: "TODO", i: "Finding TODOs" }, "b");
		expect(view()).toEqual(["prompt", "", "• Bash · Listing files", "• Grep · Finding TODOs"]);
		await settle();
		expect(view()).toEqual(["prompt", "", "• Bash · Inspect with bash", "• Grep · Inspect with grep"]);
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
		expect(view()).toEqual(["• Survey the sample project · 2 calls", "", "reply"]);
		expect(head.isTranscriptBlockFinalized()).toBe(true);
		const batch = transcript.peekFinalizedBatch(100, 1);
		expect(plain(batch?.rows ?? [])).toEqual(["• Survey the sample project · 2 calls", ""]);
		transcript.acknowledgeFinalizedBatch(batch!.id);
		// Switching back to cards must not redraw the absorbed call below the scrollback row.
		mode.value = "cards";
		expect(view()).toEqual(["reply"]);
	} finally {
		uninstall();
	}
});
