import { describe, expect, test } from "bun:test";
import {
	agentCommandCompletions,
	agentDrawerCompletions,
	formatAgentSkillPrompt,
	parseAgentCommandArgs,
	registerAgentCommands,
	registerAgentSubcommands,
	withAgentCommandDrawer,
	type DiscoveredAgent,
} from "../lib/agent-commands";
import type { EditorProvider } from "../lib/url-drawers";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

const sampleAgents: DiscoveredAgent[] = [
	{
		name: "structured-thinker",
		description: "Use this agent when answering questions involving judgment or design choices.",
		systemPrompt: "You are a rigorous analytical advisor.\n1. Restate the question.\n2. Three interpretations.\n3. Strongest counter-case.\n4. Final answer.",
		filePath: "/path/to/.omp/agents/structured-thinker.md",
	},
	{
		name: "reviewer",
		description: "Code review specialist for quality and security analysis.",
		systemPrompt: "Review code thoroughly and report concrete defects.",
		filePath: "/path/to/reviewer.md",
	},
	{
		name: "scout",
		description: "Fast read-only scout.",
		systemPrompt: "Search codebase and summarize findings.",
	},
];

describe("formatAgentSkillPrompt", () => {
	test("formats prompt without user args", () => {
		const result = formatAgentSkillPrompt(sampleAgents[0]!);
		expect(result).toContain('[IMPORTANT: User invoked the "structured-thinker" agent as a skill; follow its instructions. Full agent instructions below.]');
		expect(result).toContain("1. Restate the question.");
		expect(result).not.toContain("User:");
	});

	test("formats prompt with user args appended", () => {
		const result = formatAgentSkillPrompt(sampleAgents[0]!, "Should we unify recall classification?");
		expect(result).toContain('[IMPORTANT: User invoked the "structured-thinker" agent as a skill; follow its instructions. Full agent instructions below.]');
		expect(result).toContain("1. Restate the question.");
		expect(result).toContain("---\n\nUser: Should we unify recall classification?");
	});

	test("handles empty or missing systemPrompt", () => {
		const result = formatAgentSkillPrompt({ name: "minimal" });
		expect(result).toBe('[IMPORTANT: User invoked the "minimal" agent as a skill; follow its instructions. Full agent instructions below.]\n\n');
	});
});

describe("parseAgentCommandArgs", () => {
	test("parses bare agent name", () => {
		expect(parseAgentCommandArgs("structured-thinker")).toEqual({
			agentName: "structured-thinker",
			userArgs: "",
		});
	});

	test("parses agent name with user arguments", () => {
		expect(parseAgentCommandArgs("structured-thinker Evaluate these 3 approaches")).toEqual({
			agentName: "structured-thinker",
			userArgs: "Evaluate these 3 approaches",
		});
	});

	test("strips leading slashes", () => {
		expect(parseAgentCommandArgs("/structured-thinker Some prompt")).toEqual({
			agentName: "structured-thinker",
			userArgs: "Some prompt",
		});
	});

	test("returns empty for blank input", () => {
		expect(parseAgentCommandArgs("   ")).toEqual({
			agentName: "",
			userArgs: "",
		});
	});
});

describe("agentCommandCompletions", () => {
	test("returns all agents on empty argumentPrefix", () => {
		const completions = agentCommandCompletions("", sampleAgents);
		expect(completions?.map(c => c.value)).toEqual(["reviewer", "scout", "structured-thinker"]);
	});

	test("filters by prefix and substring", () => {
		const completions = agentCommandCompletions("str", sampleAgents);
		expect(completions?.map(c => c.value)).toEqual(["structured-thinker"]);
	});

	test("returns null when user has typed a space after agent name", () => {
		expect(agentCommandCompletions("structured-thinker ", sampleAgents)).toBeNull();
		expect(agentCommandCompletions("structured-thinker what about X", sampleAgents)).toBeNull();
	});

	test("returns null when no agent matches", () => {
		expect(agentCommandCompletions("nonexistent", sampleAgents)).toBeNull();
	});
});

describe("agentDrawerCompletions", () => {
	test("matches /agent/ and returns completions", () => {
		const result = agentDrawerCompletions("/agent/", sampleAgents);
		expect(result?.prefix).toBe("/agent/");
		expect(result?.items.map(i => [i.label, i.value])).toEqual([
			["/agent/reviewer", "/agent reviewer"],
			["/agent/scout", "/agent scout"],
			["/agent/structured-thinker", "/agent structured-thinker"],
		]);
	});

	test("matches /agents/ and filters by query", () => {
		const result = agentDrawerCompletions("/agents/str", sampleAgents);
		expect(result?.prefix).toBe("/agents/str");
		expect(result?.items.map(i => i.label)).toEqual(["/agent/structured-thinker"]);
	});

	test("returns null for non-matching token", () => {
		expect(agentDrawerCompletions("/other/", sampleAgents)).toBeNull();
		expect(agentDrawerCompletions("hello", sampleAgents)).toBeNull();
	});
});

describe("withAgentCommandDrawer", () => {
	const createMockEditor = (): EditorProvider & { calls: string[] } => {
		const calls: string[] = [];
		return {
			calls,
			getSuggestions: async () => { calls.push("suggest"); return null; },
			applyCompletion: (lines, line, col, item, prefix) => {
				calls.push("apply");
				const current = lines[line] ?? "";
				const before = current.slice(0, col - prefix.length);
				return { lines: [before + item.value], cursorLine: line, cursorCol: (before + item.value).length };
			},
		};
	};

	test("drawer opens on /agent/ and completes to /agent <name> with trailing space", async () => {
		const base = createMockEditor();
		const drawer = withAgentCommandDrawer(base, () => true, async () => sampleAgents);

		const suggestions = await drawer.getSuggestions(["/agent/str"], 0, 10);
		expect(suggestions?.items.map(i => i.value)).toEqual(["/agent structured-thinker"]);

		const applied = drawer.applyCompletion(
			["/agent/str"],
			0,
			10,
			{ value: "/agent structured-thinker", label: "/agent/structured-thinker" },
			"/agent/str",
		);
		expect(applied.lines).toEqual(["/agent structured-thinker "]);
		expect(applied.cursorCol).toBe("/agent structured-thinker ".length);
	});

	test("disabled drawer forwards to inner provider", async () => {
		const base = createMockEditor();
		const drawer = withAgentCommandDrawer(base, () => false, async () => sampleAgents);

		await drawer.getSuggestions(["/agent/str"], 0, 10);
		expect(base.calls).toEqual(["suggest"]);
	});
});

describe("registerAgentCommands", () => {
	const createMockApi = () => {
		type Registered = { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => Promise<unknown> | unknown };
		const commands = new Map<string, Registered>();
		const sentMessages: Array<{ msg: { customType?: string; content?: string; display?: boolean }; opts?: { triggerTurn?: boolean } }> = [];
		const userMessages: Array<{ content: string; opts?: unknown }> = [];
		const api = {
			registerCommand: (name: string, options: Registered) => {
				commands.set(name, options);
			},
			sendMessage: (msg: { customType?: string; content?: string; display?: boolean }, opts?: { triggerTurn?: boolean }) => {
				sentMessages.push({ msg, opts });
			},
			sendUserMessage: (content: string, opts?: unknown) => {
				userMessages.push({ content, opts });
			},
		} as unknown as ExtensionAPI;
		return { api, commands, sentMessages, userMessages };
	};

	test("registers agent and agents commands with argument completions", async () => {
		const { api, commands } = createMockApi();
		registerAgentCommands(api, async () => sampleAgents);

		expect(commands.has("agent")).toBe(true);
		expect(commands.has("agents")).toBe(true);

		const agentCmd = commands.get("agent")!;
		const completions = await agentCmd.getArgumentCompletions!("str");
		expect(completions?.map(c => c.value)).toEqual(["structured-thinker"]);
	});

	test("handler with no args prints usage and list of agents", async () => {
		const { api, commands, sentMessages } = createMockApi();
		registerAgentCommands(api, async () => sampleAgents);

		const agentCmd = commands.get("agent")!;
		await agentCmd.handler("", { hasUI: true } as unknown as ExtensionCommandContext);

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].msg.content).toContain("Usage: /agent <name> [prompt]");
		expect(sentMessages[0].msg.content).toContain("structured-thinker");
		expect(sentMessages[0].opts.triggerTurn).toBe(false);
	});

	test("handler with unknown agent reports error", async () => {
		const { api, commands, sentMessages } = createMockApi();
		registerAgentCommands(api, async () => sampleAgents);

		const agentCmd = commands.get("agent")!;
		await agentCmd.handler("ghost-agent", { hasUI: true } as unknown as ExtensionCommandContext);

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].msg.content).toContain('Unknown agent "ghost-agent"');
		expect(sentMessages[0].opts.triggerTurn).toBe(false);
	});

	test("handler with known agent invokes as skill via sendUserMessage", async () => {
		const { api, commands, userMessages } = createMockApi();
		registerAgentCommands(api, async () => sampleAgents);

		const agentCmd = commands.get("agent")!;
		await agentCmd.handler("structured-thinker How should we design this?", { hasUI: true } as unknown as ExtensionCommandContext);

		expect(userMessages.length).toBe(1);
		expect(userMessages[0].content).toContain('[IMPORTANT: User invoked the "structured-thinker" agent as a skill');
		expect(userMessages[0].content).toContain("1. Restate the question.");
		expect(userMessages[0].content).toContain("User: How should we design this?");
	});

	test("registerAgentSubcommands creates direct slash commands for each agent", async () => {
		const { api, commands, userMessages } = createMockApi();
		registerAgentSubcommands(api, sampleAgents);

		expect(commands.has("agent/structured-thinker")).toBe(true);
		expect(commands.has("agents/structured-thinker")).toBe(true);
		expect(commands.has("agent/reviewer")).toBe(true);

		const subCmd = commands.get("agent/structured-thinker")!;
		await subCmd.handler("Audit the plan", {} as unknown as ExtensionCommandContext);

		expect(userMessages.length).toBe(1);
		expect(userMessages[0].content).toContain('[IMPORTANT: User invoked the "structured-thinker" agent as a skill');
		expect(userMessages[0].content).toContain("User: Audit the plan");
	});
});
