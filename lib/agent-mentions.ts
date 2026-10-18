import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { drawerProvider, matchRank, type CompletionItem, type CompletionResult, type EditorProvider } from "./url-drawers";

/**
 * `@@agent` mentions: typing `@@` in the editor lists the task agent types that `/agents` shows,
 * each with its description inline. On submit, a mention of a known agent becomes an explicit
 * instruction to delegate through the task tool with that agent.
 */

export type AgentInfo = { name: string; description?: string };

const SCHEME = "@@";
// `@@` at the start of the line or after whitespace or an opening bracket/quote.
const TOKEN = /(?:^|[\s"'`(<])(@@[\w.:-]*)$/;
const MENTION = /(^|[\s"'`(<])@@([\w.:-]+)/g;
const LIMIT = 25;
const SUMMARY_MAX = 90;
const CACHE_MS = 10_000;

function summarize(text: string | undefined): string | undefined {
	const line = text?.split("\n").find(l => l.trim())?.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** Completions for an `@@…` token: matching agents, prefix matches first, then substring matches. */
export function agentCompletions(token: string, agents: readonly AgentInfo[], limit = LIMIT): CompletionResult {
	const query = token.slice(SCHEME.length).toLowerCase();
	const items: CompletionItem[] = agents
		.map((agent, index) => ({ agent, index, rank: matchRank(agent.name, query) }))
		.filter(entry => entry.rank > 0)
		.sort((a, b) => b.rank - a.rank || a.index - b.index)
		.slice(0, limit)
		.map(({ agent }) => ({ value: `${SCHEME}${agent.name}`, label: `${SCHEME}${agent.name}`, description: summarize(agent.description) }));
	return items.length > 0 ? { items, prefix: token } : null;
}

/**
 * Rewrites each `@@name` of a known agent into a delegation instruction. Unknown names stay as typed,
 * so an email-like `a@@b` or a stray `@@` reaches the model unchanged.
 */
export function expandAgentMentions(text: string, known: ReadonlySet<string>): string {
	return text.replace(MENTION, (whole, lead: string, name: string) =>
		known.has(name) ? `${lead}the \`${name}\` agent (task tool, agent: "${name}")` : whole,
	);
}

/** Enabled agents for `cwd`, as `/agents` lists them; cached briefly because completion runs per keystroke. */
export function agentSource(cwd: () => string, disabled: () => readonly string[]): () => Promise<AgentInfo[]> {
	let cache: { cwd: string; at: number; agents: AgentInfo[] } | undefined;
	return async () => {
		const dir = cwd();
		if (!cache || cache.cwd !== dir || Date.now() - cache.at > CACHE_MS) {
			try {
				const { agents } = await discoverAgents(dir);
				cache = { cwd: dir, at: Date.now(), agents: agents.map(a => ({ name: a.name, description: a.description })) };
			} catch {
				return cache?.agents ?? [];
			}
		}
		const off = new Set(disabled());
		return cache.agents.filter(agent => !off.has(agent.name));
	};
}

/** The `@@` drawer. Accepting an agent inserts `@@name ` and closes the drawer. */
export function withAgentDrawer(inner: EditorProvider, enabled: () => boolean, agents: () => Promise<AgentInfo[]>): EditorProvider {
	return drawerProvider(inner, enabled, TOKEN, SCHEME, async token => agentCompletions(token, await agents()), item => `${item.value} `);
}
