import { afterEach, expect, mock, test } from "bun:test";
import { agentCompletions, agentHint, agentSource, hasMention, mentionedAgents, withAgentDrawer } from "../lib/agent-mentions";
import type { EditorProvider } from "../lib/url-drawers";

let discover: (cwd: string) => Promise<{ agents: { name: string; description?: string }[] }> = async () => ({ agents: [] });
let discoveries = 0;
// Bun rebinds the already-imported module's live exports, so agent-mentions sees this stub.
mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: (cwd: string) => {
		discoveries++;
		return discover(cwd);
	},
}));

const agents = [
	{ name: "task", description: "General-purpose subagent\nwith more lines" },
	{ name: "explore", description: "Fast read-only scout" },
	{ name: "plan", description: "Architect" },
];

afterEach(() => {
	discoveries = 0;
	discover = async () => ({ agents: [] });
});

test("bare @@ lists every agent with its description, in discovery order", () => {
	const result = agentCompletions("@@", agents);
	expect(result?.prefix).toBe("@@");
	expect(result?.items.map(i => [i.label, i.description])).toEqual([
		["@@task", "General-purpose subagent"],
		["@@explore", "Fast read-only scout"],
		["@@plan", "Architect"],
	]);
});

test("prefix matches outrank substring matches; no match or an unmentionable name closes the drawer", () => {
	expect(agentCompletions("@@pl", agents)?.items.map(i => i.value)).toEqual(["@@plan", "@@explore"]);
	expect(agentCompletions("@@zzz", agents)).toBeNull();
	expect(agentCompletions("@@my", [{ name: "my agent" }])).toBeNull();
});

test("mentions resolve to real agent names across sentence punctuation and case", () => {
	expect(mentionedAgents("ask @@explore.", agents)).toEqual(["explore"]);
	expect(mentionedAgents("@@Explore: find auth, then @@plan and @@explore again", agents)).toEqual(["explore", "plan"]);
	expect(mentionedAgents('say "@@task"\nline two @@plan', agents)).toEqual(["task", "plan"]);
	// The submit path gates with hasMention first; the gate must not shift where matching starts.
	expect(hasMention("ok. @@Explore.") && mentionedAgents("ok. @@Explore.", agents)).toEqual(["explore"]);
});

test("unknown names, emails, diff headers and code are not mentions", () => {
	expect(mentionedAgents("@@nobody and a@@explore", agents)).toEqual([]);
	expect(hasMention("@@ -1,3 +1,4 @@")).toBe(false);
	expect(mentionedAgents("see `@@explore` and\n```\n@@plan\n```", agents)).toEqual([]);
	expect(hasMention("(@@explore")).toBe(false);
});

test("the hint names each agent and its task call", () => {
	expect(agentHint(["explore"])).toBe('The user mentioned task agent `explore` with @@. To delegate to it, call the task tool with agent: "explore".');
	expect(agentHint(["explore", "plan"])).toContain('agent: "explore" or agent: "plan"');
});

const inner = (): EditorProvider & { calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		getSuggestions: async () => {
			calls.push("suggest");
			return null;
		},
		applyCompletion: (lines, cursorLine, cursorCol) => {
			calls.push("apply");
			return { lines, cursorLine, cursorCol };
		},
	};
};

test("the drawer opens only on OMP's token boundaries and inserts the name with a space", async () => {
	const base = inner();
	const drawer = withAgentDrawer(base, () => true, async () => agents);
	expect((await drawer.getSuggestions(["ask @@ex"], 0, 8))?.items.map(i => i.value)).toEqual(["@@explore"]);
	for (const line of ["mail a@@ex", "(@@ex", "`@@ex"]) await drawer.getSuggestions([line], 0, line.length);
	await withAgentDrawer(base, () => false, async () => agents).getSuggestions(["@@ex"], 0, 4);
	expect(base.calls).toEqual(["suggest", "suggest", "suggest", "suggest"]);
	expect(drawer.applyCompletion(["ask @@ex"], 0, 8, { value: "@@explore", label: "@@explore" }, "@@ex")).toEqual({ lines: ["ask @@explore "], cursorLine: 0, cursorCol: 14 });
});

test("the source shares one discovery, caches it, filters disabled agents, and keeps the list on failure", async () => {
	let disabled: string[] = ["explore"];
	let cwd = "/a";
	const errors: unknown[] = [];
	discover = async () => ({ agents });
	const source = agentSource(() => cwd, () => disabled, error => errors.push(error));

	const [first] = await Promise.all([source(), source()]);
	expect(first.map(a => a.name)).toEqual(["task", "plan"]);
	disabled = [];
	expect((await source()).map(a => a.name)).toEqual(["task", "explore", "plan"]);
	expect(discoveries).toBe(1);

	cwd = "/b";
	discover = async () => { throw new Error("boom"); };
	expect(await source()).toEqual([]);
	expect(await source()).toEqual([]);
	expect(discoveries).toBe(2);
	expect(errors).toHaveLength(1);
});
