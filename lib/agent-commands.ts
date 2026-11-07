import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { drawerProvider, type CompletionItem, type CompletionResult, type EditorProvider } from "./url-drawers";

/**
 * Agent definition information used for slash-command invocation and completions.
 */
export type DiscoveredAgent = {
	name: string;
	description?: string;
	systemPrompt?: string;
	filePath?: string;
};

export const AGENT_COMMAND_TOKEN = /(?:^|[\s"'=])(\/(?:agent|agents)\/([\w.:-]*))$/i;
export const AGENT_COMMAND_SCHEME = "/agent";

/**
 * Formats an OMP agent definition as a skill invocation prompt.
 * If user arguments are provided, they are appended in standard skill invocation format.
 */
export function formatAgentSkillPrompt(agent: DiscoveredAgent, userArgs?: string): string {
	const trimmedPrompt = agent.systemPrompt?.trim() || "";
	const trimmedArgs = userArgs?.trim() ?? "";
	const header = `[IMPORTANT: User invoked the "${agent.name}" agent as a skill; follow its instructions. Full agent instructions below.]`;
	if (!trimmedArgs) {
		return `${header}\n\n${trimmedPrompt}`;
	}
	return `${header}\n\n${trimmedPrompt}\n\n---\n\nUser: ${trimmedArgs}`;
}

/**
 * Parses arguments for /agent and /agents commands.
 * Handles both space-separated (/agent structured-thinker <prompt>)
 * and leading slash syntax (/structured-thinker <prompt>).
 */
export function parseAgentCommandArgs(args: string): { agentName: string; userArgs: string } {
	const clean = args.trim().replace(/^\/+/, "");
	if (!clean) return { agentName: "", userArgs: "" };
	const spaceIndex = clean.indexOf(" ");
	if (spaceIndex === -1) {
		return { agentName: clean, userArgs: "" };
	}
	return {
		agentName: clean.slice(0, spaceIndex),
		userArgs: clean.slice(spaceIndex + 1).trim(),
	};
}

/**
 * Argument completions for `/agent <prefix>` and `/agents <prefix>`.
 * Returns null once a space is typed so the user can enter their free-form prompt.
 */
export function agentCommandCompletions(
	argumentPrefix: string,
	agents: readonly DiscoveredAgent[],
): AutocompleteItem[] | null {
	if (argumentPrefix.includes(" ")) return null;
	const query = argumentPrefix.trim().toLowerCase().replace(/^\/+/, "");
	const matches = agents
		.filter(a => a.name.toLowerCase().includes(query))
		.sort((a, b) => {
			const aStarts = a.name.toLowerCase().startsWith(query);
			const bStarts = b.name.toLowerCase().startsWith(query);
			if (aStarts && !bStarts) return -1;
			if (!aStarts && bStarts) return 1;
			return a.name.localeCompare(b.name);
		});
	if (matches.length === 0) return null;
	return matches.map(a => ({
		value: a.name,
		label: a.name,
		description: a.description?.split("\n")[0] || undefined,
	}));
}

/**
 * Completions for drawer popup when typing `/agent/` or `/agents/`.
 */
export function agentDrawerCompletions(
	token: string,
	agents: readonly DiscoveredAgent[],
): CompletionResult {
	const match = AGENT_COMMAND_TOKEN.exec(token);
	if (!match) return null;
	const query = (match[2] ?? "").toLowerCase();
	const matches = agents
		.filter(a => a.name.toLowerCase().includes(query))
		.sort((a, b) => {
			const aStarts = a.name.toLowerCase().startsWith(query);
			const bStarts = b.name.toLowerCase().startsWith(query);
			if (aStarts && !bStarts) return -1;
			if (!aStarts && bStarts) return 1;
			return a.name.localeCompare(b.name);
		});
	if (matches.length === 0) return null;
	return {
		prefix: match[1]!,
		items: matches.map(a => ({
			value: `/agent ${a.name}`,
			label: `/agent/${a.name}`,
			description: a.description?.split("\n")[0] || undefined,
		})),
	};
}

/**
 * Editor drawer provider for `/agent/` and `/agents/`.
 * Expands `/agent/<name>` completion to `/agent <name> ` so the user can immediately type their prompt.
 */
export function withAgentCommandDrawer(
	inner: EditorProvider,
	enabled: () => boolean,
	agents: () => Promise<readonly DiscoveredAgent[]>,
): EditorProvider {
	return drawerProvider(
		inner,
		enabled,
		AGENT_COMMAND_TOKEN,
		AGENT_COMMAND_SCHEME,
		async token => agentDrawerCompletions(token, await agents()),
		item => `${item.value} `,
	);
}

/**
 * Registers dynamic slash commands for `/agent/<name>` and `/agents/<name>`.
 */
export function registerAgentSubcommands(
	pi: ExtensionAPI,
	agents: readonly DiscoveredAgent[],
	enabled: () => boolean = () => true,
): void {
	for (const agent of agents) {
		const handler = async (userArgs: string) => {
			if (!enabled()) return;
			const prompt = formatAgentSkillPrompt(agent, userArgs);
			if (typeof pi.sendUserMessage === "function") {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendMessage(
					{ customType: "hydemods-agent-skill", display: true, content: prompt },
					{ triggerTurn: true },
				);
			}
		};
		pi.registerCommand(`agent/${agent.name}`, {
			description: agent.description?.split("\n")[0] || `Invoke ${agent.name} as a skill`,
			handler,
		});
		pi.registerCommand(`agents/${agent.name}`, {
			description: agent.description?.split("\n")[0] || `Invoke ${agent.name} as a skill`,
			handler,
		});
	}
}

/**
 * Registers the `/agent` and `/agents` slash commands.
 */
export function registerAgentCommands(
	pi: ExtensionAPI,
	getAgents: () => Promise<readonly DiscoveredAgent[]>,
	enabled: () => boolean = () => true,
): void {
	const handleCommand = async (args: string, ctx: ExtensionCommandContext) => {
		if (!enabled()) {
			if (ctx.hasUI) ctx.ui.notify("/agent commands are turned off in hydemods.", "warning");
			return;
		}
		const allAgents = await getAgents();
		const { agentName, userArgs } = parseAgentCommandArgs(args);
		if (!agentName) {
			const list = allAgents
				.map(a => `  • ${a.name}${a.description ? ` — ${a.description.split("\n")[0]}` : ""}`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "hydemods-agent-skill",
					display: true,
					content: `Usage: /agent <name> [prompt] (or /agent/<name> [prompt])\nInvokes an OMP agent as a skill for the active turn.\n\nAvailable agents:\n${list || "  (no agents discovered)"}`,
				},
				{ triggerTurn: false },
			);
			return;
		}
		const agent = allAgents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
		if (!agent) {
			const list = allAgents.map(a => a.name).join(", ");
			pi.sendMessage(
				{
					customType: "hydemods-agent-skill",
					display: true,
					content: `Unknown agent "${agentName}". Available agents: ${list || "none"}`,
				},
				{ triggerTurn: false },
			);
			return;
		}
		const prompt = formatAgentSkillPrompt(agent, userArgs);
		if (typeof pi.sendUserMessage === "function") {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendMessage(
				{ customType: "hydemods-agent-skill", display: true, content: prompt },
				{ triggerTurn: true },
			);
		}
	};

	const getArgumentCompletions = async (argumentPrefix: string) => {
		if (!enabled()) return null;
		return agentCommandCompletions(argumentPrefix, await getAgents());
	};

	pi.registerCommand("agent", {
		description: "Invoke an OMP agent as a skill: /agent <name> [prompt] or /agent/<name>",
		getArgumentCompletions,
		handler: handleCommand,
	});

	pi.registerCommand("agents", {
		description: "Invoke an OMP agent as a skill: /agents <name> [prompt] or /agents/<name>",
		getArgumentCompletions,
		handler: handleCommand,
	});
}
