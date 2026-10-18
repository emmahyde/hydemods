import { decodeSegment, drawerProvider, matchRank, type CompletionItem, type CompletionResult, type EditorProvider } from "./url-drawers";

/**
 * Completion drawers for OMP's session-bound internal URLs:
 *
 * - `xd://` — every tool the host addresses through `xd://` in this session (mounted devices
 *   and active native tools such as `eval`), plus each tool's doc topics (`xd://<device>/<topic>`).
 * - `proc://` — this session's background jobs, running subagents, and project services,
 *   plus the writable URL parts the host accepts under an id (`/kill`, `/mode`).
 *
 * These functions are pure. The live host state arrives through the source adapters in
 * `host-runtime.ts`, so tests do not load OMP and the host-specific access lives in one file.
 *
 * A completion item whose `value` ends in a space ends the token (the URL is complete). A value
 * without a trailing space keeps the cursor on the URL, so the next Tab reopens the drawer one
 * level down — the same convention the `vault://` drawer uses for folders.
 */

const DRAWER_LIMIT = 25;

// Same token boundary OMP uses for internal-URL completion.
const XD_TOKEN = /(?:^|[\s"'`(<=])(xd:\/\/[^\s"'`()<>]*)$/i;
const PROC_TOKEN = /(?:^|[\s"'`(<=])(proc:\/\/[^\s"'`()<>]*)$/i;

const XD_SCHEME = "xd://";
const PROC_SCHEME = "proc://";

const SUMMARY_MAX = 90;

/** First non-blank line, whitespace-collapsed and cut to fit one drawer description row. */
export function summarize(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = text.split(/\r?\n/).find(part => part.trim().length > 0);
	if (!line) return undefined;
	const flat = line.trim().replace(/\s+/g, " ");
	return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/** Split `<scheme>a/b/c` into the completed segments, the partial last segment, and the depth. */
function splitToken(token: string, scheme: string): { segments: string[]; partial: string; depth: number } {
	const segments = token.slice(scheme.length).split("/").map(decodeSegment);
	return { segments, partial: (segments[segments.length - 1] ?? "").toLowerCase(), depth: segments.length - 1 };
}

/** Ranked, capped matches: prefix matches outrank substring matches; equal ranks keep source order. */
function ranked<T>(items: readonly T[], query: string, name: (item: T) => string, limit: number): T[] {
	return items
		.map(item => ({ item, rank: matchRank(name(item), query) }))
		.filter(entry => entry.rank > 0)
		.sort((a, b) => b.rank - a.rank)
		.slice(0, limit)
		.map(entry => entry.item);
}

/* -------------------------------------------------------------------------- */
/*                                    xd://                                   */
/* -------------------------------------------------------------------------- */

/**
 * One `xd://` device. `hasTopics` is true when the device publishes `docTopics()`, so
 * `xd://<device>/…` lists topic names; `topics()` is then consulted for the names.
 */
export type XdDevice = { name: string; description?: string; hasTopics?: boolean };

/** Authoritative `xd://` state, read from the live session. */
export type XdSources = {
	/** Every tool `xd://<name>` resolves for this session: mounted devices plus active tools. */
	devices(): readonly XdDevice[];
	/** Doc-topic keys for one device, for `xd://<device>/<topic>`. */
	topics(device: string): readonly string[];
};

/**
 * Completions for an `xd://…` token. `xd://<partial>` lists addressable devices; accepting one
 * keeps the cursor on the URL so the next Tab exposes that device's doc topics (or ends the token
 * when the device publishes none). `xd://<device>/<partial>` lists that device's topic names.
 */
export function xdCompletions(token: string, sources: XdSources, limit = DRAWER_LIMIT): CompletionResult {
	const { segments, partial, depth } = splitToken(token, XD_SCHEME);
	const devices = sources.devices();

	if (depth === 0) {
		const exact = devices.find(device => device.name.toLowerCase() === partial);
		if (exact) {
			// The name is complete. Show its topics when it has any; otherwise end the token.
			if (exact.hasTopics) {
				const topics = sources.topics(exact.name).slice(0, limit);
				if (topics.length > 0) {
					return {
						items: topics.map(topic => ({
							value: `${XD_SCHEME}${exact.name}/${topic} `,
							label: topic,
							description: exact.name,
						})),
						prefix: token,
					};
				}
			}
			return {
				items: [{ value: `${XD_SCHEME}${exact.name} `, label: exact.name, description: summarize(exact.description) }],
				prefix: token,
			};
		}
		const matches = ranked(devices, partial, device => device.name, limit).map(device => ({
			value: `${XD_SCHEME}${device.name}`,
			label: device.name,
			description: summarize(device.description),
		}));
		return matches.length > 0 ? { items: matches, prefix: token } : null;
	}

	if (depth === 1) {
		const device = devices.find(item => item.name.toLowerCase() === segments[0]?.toLowerCase());
		if (!device) return null;
		const topics = ranked(sources.topics(device.name), partial, topic => topic, limit);
		return topics.length > 0
			? {
					items: topics.map(topic => ({
						value: `${XD_SCHEME}${device.name}/${topic} `,
						label: topic,
						description: device.name,
					})),
					prefix: token,
				}
			: null;
	}

	return null;
}

/** The `xd://` drawer: addressable devices and their doc topics. */
export function withXdDrawer(inner: EditorProvider, enabled: () => boolean, sources: XdSources, onApplied?: (item: CompletionItem) => void): EditorProvider {
	return drawerProvider(inner, enabled, XD_TOKEN, XD_SCHEME, async token => xdCompletions(token, sources), item => item.value, onApplied);
}

/* -------------------------------------------------------------------------- */
/*                                   proc://                                  */
/* -------------------------------------------------------------------------- */

export type ProcEntryKind = "job" | "agent" | "service";

/** One `proc://` id: a background job, a running subagent, or a project service. */
export type ProcEntry = {
	id: string;
	kind: ProcEntryKind;
	status?: string;
	label?: string;
	/** Writable URL parts under the id; defaults to the kind's standard actions. */
	actions?: readonly string[];
};

/** Authoritative `proc://` state. Services require a broker round-trip, so this may be async. */
export type ProcSources = { entries(signal?: AbortSignal): readonly ProcEntry[] | Promise<readonly ProcEntry[]> };

// What the host's `proc://` handler accepts after an id. `mode` only applies to services.
const DEFAULT_ACTIONS: Record<ProcEntryKind, readonly string[]> = {
	job: ["kill"],
	agent: ["kill"],
	service: ["kill", "mode"],
};

const ACTION_DESCRIPTION: Record<string, string> = {
	kill: "cancel",
	mode: "change how it runs",
};

/**
 * Completions for a `proc://…` token. `proc://<partial>` lists this session's jobs, running
 * subagents, and services by id. Accepting an id keeps the cursor on the URL; a second Tab then
 * offers that id's writable parts, because accepting an exact id no longer re-selects itself.
 * `proc://<id>/<partial>` lists the actions the host accepts under that id.
 */
export function procCompletions(token: string, entries: readonly ProcEntry[], limit = DRAWER_LIMIT): CompletionResult {
	const { segments, partial, depth } = splitToken(token, PROC_SCHEME);

	// At depth 0 an exact id is a complete URL: advancing means choosing an action, not the id again.
	const entry =
		depth === 0
			? partial
				? entries.find(candidate => candidate.id.toLowerCase() === partial)
				: undefined
			: depth === 1
				? entries.find(candidate => candidate.id.toLowerCase() === segments[0]?.toLowerCase())
				: undefined;

	if (entry) {
		const actions = ranked(entry.actions ?? DEFAULT_ACTIONS[entry.kind], depth === 0 ? "" : partial, action => action, limit);
		if (actions.length === 0) return null;
		return {
			items: actions.map(action => ({
				value: `${PROC_SCHEME}${entry.id}/${action} `,
				label: `/${action}`,
				description: `${ACTION_DESCRIPTION[action] ?? action} ${entry.kind}`,
			})),
			prefix: token,
		};
	}

	if (depth !== 0) return null;

	const matches = ranked(entries, partial, candidate => candidate.id, limit).map(candidate => {
		const detail = [candidate.status, candidate.label].filter((part): part is string => !!part && part.length > 0).join(" — ");
		return {
			value: `${PROC_SCHEME}${candidate.id}`,
			label: candidate.id,
			description: detail ? `[${candidate.kind}] ${detail}` : `[${candidate.kind}]`,
		};
	});
	return matches.length > 0 ? { items: matches, prefix: token } : null;
}

/** The `proc://` drawer: this session's jobs, running subagents, and services, with their actions. */
export function withProcDrawer(inner: EditorProvider, enabled: () => boolean, sources: ProcSources, onApplied?: (item: CompletionItem) => void): EditorProvider {
	return drawerProvider(
		inner,
		enabled,
		PROC_TOKEN,
		PROC_SCHEME,
		async (token, signal) => procCompletions(token, await sources.entries(signal)),
		item => item.value,
		onApplied,
	);
}
