import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { drawerProvider, matchRank, type CompletionItem, type CompletionResult, type EditorProvider } from "./url-drawers";
import { summarize } from "./xd-proc-drawers";

/**
 * `@@agent` mentions: typing `@@` in the editor lists the task agent types that `/agents` shows,
 * each with its description inline. The prompt stays as typed; before the model turn, a separate
 * message names the mentioned agents and how to delegate to them through the task tool.
 */

export type AgentInfo = { name: string; description?: string };

const SCHEME = "@@";
// Same token boundary OMP's editor uses for `@` completion: line start, whitespace, quote or `=`.
const LEAD = String.raw`(?:^|[\s"'=])`;
// A name ends on a word character, so sentence punctuation after it (`@@explore.`) is not part of it.
const NAME = String.raw`[\w-]+(?:[.:][\w-]+)*`;
const TOKEN = new RegExp(`${LEAD}(${SCHEME}[\\w.:-]*)$`);
const MENTION = new RegExp(`${LEAD}${SCHEME}(${NAME})`, "g");
const MENTIONABLE = new RegExp(`^${NAME}$`);
// Fenced blocks and inline code spans: mentions inside them are quoted, not addressed.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const LIMIT = 25;
const CACHE_MS = 10_000;

/** Completions for an `@@…` token: matching agents, prefix matches first, then substring matches. */
export function agentCompletions(token: string, agents: readonly AgentInfo[], limit = LIMIT): CompletionResult {
	const query = token.slice(SCHEME.length).toLowerCase();
	const items: CompletionItem[] = agents
		.filter(agent => MENTIONABLE.test(agent.name))
		.map((agent, index) => ({ agent, index, rank: matchRank(agent.name, query) }))
		.filter(entry => entry.rank > 0)
		.sort((a, b) => b.rank - a.rank || a.index - b.index)
		.slice(0, limit)
		.map(({ agent }) => ({ value: `${SCHEME}${agent.name}`, label: `${SCHEME}${agent.name}`, description: summarize(agent.description) }));
	return items.length > 0 ? { items, prefix: token } : null;
}

/** True when `text` may hold a mention; a cheap gate before agent discovery. */
export function hasMention(text: string): boolean {
	return text.replace(CODE, "").search(MENTION) >= 0;
}

/**
 * Known agents that `text` mentions, by their real names, in first-mention order. Matching ignores
 * case; unknown names, `a@@b`, diff headers like `@@ -1 +1 @@`, and mentions inside code are skipped.
 */
export function mentionedAgents(text: string, agents: readonly AgentInfo[]): string[] {
	const byLower = new Map(agents.map(agent => [agent.name.toLowerCase(), agent.name]));
	const found = new Set<string>();
	for (const match of text.replace(CODE, "").matchAll(MENTION)) {
		const name = byLower.get(match[1]!.toLowerCase());
		if (name) found.add(name);
	}
	return [...found];
}

/** The note the model sees beside a prompt that mentions `names`. */
export function agentHint(names: readonly string[]): string {
	const list = names.map(name => `\`${name}\``).join(", ");
	const calls = names.map(name => `agent: "${name}"`).join(" or ");
	return `The user mentioned task agent${names.length > 1 ? "s" : ""} ${list} with @@. To delegate to ${names.length > 1 ? "them" : "it"}, call the task tool with ${calls}.`;
}

/**
 * Enabled agents for `cwd`, as `/agents` lists them; cached briefly because completion runs per
 * keystroke. Concurrent callers share one discovery. A failed discovery keeps the last list (or none)
 * for the cache window and reports once through `onError`.
 */
export function agentSource(
	cwd: () => string,
	disabled: () => readonly string[],
	onError: (error: unknown) => void = () => {},
): () => Promise<AgentInfo[]> {
	let cache: { cwd: string; at: number; agents: AgentInfo[] } | undefined;
	let pending: Promise<void> | undefined;
	const refresh = async (dir: string) => {
		try {
			const { agents } = await discoverAgents(dir);
			cache = { cwd: dir, at: Date.now(), agents: agents.map(a => ({ name: a.name, description: a.description })) };
		} catch (error) {
			cache = { cwd: dir, at: Date.now(), agents: cache?.cwd === dir ? cache.agents : [] };
			onError(error);
		}
	};
	return async () => {
		const dir = cwd();
		if (!cache || cache.cwd !== dir || Date.now() - cache.at > CACHE_MS) {
			pending ??= refresh(dir).finally(() => { pending = undefined; });
			await pending;
		}
		const off = new Set(disabled());
		return (cache?.agents ?? []).filter(agent => !off.has(agent.name));
	};
}

/** The `@@` drawer. Accepting an agent inserts `@@name ` and closes the drawer. */
export function withAgentDrawer(inner: EditorProvider, enabled: () => boolean, agents: () => Promise<AgentInfo[]>): EditorProvider {
	return drawerProvider(inner, enabled, TOKEN, SCHEME, async token => agentCompletions(token, await agents()), item => `${item.value} `);
}
