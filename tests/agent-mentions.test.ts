import { expect, test } from "bun:test";
import { agentCompletions, expandAgentMentions } from "../lib/agent-mentions";

const agents = [
	{ name: "task", description: "General-purpose subagent\nwith more lines" },
	{ name: "explore", description: "Fast read-only scout" },
	{ name: "plan", description: "Architect" },
];

test("bare @@ lists every agent with its description, in discovery order", () => {
	const result = agentCompletions("@@", agents);
	expect(result?.prefix).toBe("@@");
	expect(result?.items.map(i => [i.label, i.description])).toEqual([
		["@@task", "General-purpose subagent"],
		["@@explore", "Fast read-only scout"],
		["@@plan", "Architect"],
	]);
});

test("prefix matches outrank substring matches; no match closes the drawer", () => {
	expect(agentCompletions("@@pl", agents)?.items.map(i => i.value)).toEqual(["@@plan", "@@explore"]);
	expect(agentCompletions("@@zzz", agents)).toBeNull();
});

test("known mentions become task-tool instructions; unknown ones and emails stay as typed", () => {
	const known = new Set(["explore"]);
	expect(expandAgentMentions("ask @@explore about auth", known)).toBe('ask the `explore` agent (task tool, agent: "explore") about auth');
	expect(expandAgentMentions("@@nobody and a@@explore", known)).toBe("@@nobody and a@@explore");
});
