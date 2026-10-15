import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { drawerScheme } from "./drawer-types";
import type { DrawerAdapter, DrawerEntry, DrawerPage, DrawerRequest, DrawerSection } from "./drawer-types";
import { drawerSession, listDrawerResources, readDrawerResource } from "./drawer-host";
import type { DrawerCandidate } from "./drawer-host";
import { procSourcesFor, xdSourcesFor } from "./host-runtime";
import { matchRank } from "./url-drawers";
import type { ProcEntry, XdDevice } from "./xd-proc-drawers";

/**
 * Browse and inspect pages for OMP's session-bound internal URLs: `proc://`, `agent://`,
 * `history://`, `xd://`, and `cfg://`.
 *
 * Every page is produced from live state. Enumerations reuse the host's own hooks — `proc://` and
 * `xd://` through the live-session sources in `host-runtime`, the rest through the router's
 * `complete()` — and inspection goes through {@link readDrawerResource}, i.e. the host's real
 * protocol handlers. The drawer never executes writes, never dispatches a device, and never
 * starts remote work; the only remote-capable schemes it owns are `agent://` and `history://`,
 * and both resolve from session-local stores.
 */

const MAX_ENTRIES = 200;
const MAX_LINES = 240;
const MAX_LINE_CHARS = 240;

/** Resolution devices plus the issue reporter: addressable without a mounted `xdev` state. */
const SPECIAL_XD_DEVICES: readonly XdDevice[] = [
	{ name: "resolve", description: "Apply a staged, already-previewed action", hasTopics: false },
	{ name: "reject", description: "Discard a staged action", hasTopics: false },
	{ name: "propose", description: "Submit a plan for approval", hasTopics: false },
	{ name: "report_issue", description: "Report a bug in a tool for the user to submit", hasTopics: false },
];

const PROC_ACTIONS: readonly { name: string; description: string }[] = [
	{ name: "kill", description: "Cancel the job, agent, or service (write-only; the drawer never runs it)" },
	{ name: "mode", description: "Switch a service between persist, session, and detached (write-only)" },
];

/** The part of `uri` after `scheme://`, with any trailing slashes removed. */
function schemeRest(uri: string): string {
	const index = uri.indexOf("://");
	return index === -1 ? "" : uri.slice(index + 3).replace(/\/+$/, "");
}

/** Cap a text body to a fixed line count and per-line width. */
function boundedLines(text: string): string[] {
	const lines = text.split("\n");
	const capped = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`] : lines;
	return capped.map(line => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** Assemble a page, keeping entries and sections bounded. */
function makePage(
	uri: string,
	title: string,
	status: string,
	parts: { entries?: DrawerEntry[]; sections?: DrawerSection[]; parent?: string; refreshMs?: number } = {},
): DrawerPage {
	return {
		uri,
		title,
		status,
		entries: (parts.entries ?? []).slice(0, MAX_ENTRIES),
		sections: parts.sections ?? [],
		...(parts.parent !== undefined ? { parent: parts.parent } : {}),
		...(parts.refreshMs !== undefined ? { refreshMs: parts.refreshMs } : {}),
	};
}

/** A page that reports a failed resolution without throwing into the drawer shell. */
function errorPage(uri: string, title: string, error: unknown): DrawerPage {
	const message = error instanceof Error ? error.message : String(error);
	return makePage(uri, title, `Error: ${message}`, { sections: [{ title: "Error", lines: boundedLines(message) }] });
}

/** Filter by case-insensitive prefix/substring rank and cap; empty query keeps source order. */
function rankedEntries(entries: readonly DrawerEntry[], query: string): DrawerEntry[] {
	if (!query) return entries.slice(0, MAX_ENTRIES);
	const matched = entries
		.map(entry => ({ entry, rank: matchRank(entry.label, query) }))
		.filter(item => item.rank > 0)
		.sort((left, right) => right.rank - left.rank)
		.slice(0, MAX_ENTRIES)
		.map(item => item.entry);
	return matched;
}

/** Split a transcript on markdown headings; the body is bounded before it is split, so no section
 * can grow past the shared line cap. */
function transcriptSections(text: string): DrawerSection[] {
	const sections: DrawerSection[] = [];
	let title = "Transcript";
	let lines: string[] = [];
	const flush = (): void => {
		if (lines.length > 0) sections.push({ title, lines });
		lines = [];
	};
	for (const line of boundedLines(text)) {
		if (/^#{2,3} /.test(line)) {
			flush();
			title = line.replace(/^#+\s*/, "").slice(0, MAX_LINE_CHARS);
			continue;
		}
		lines.push(line);
	}
	flush();
	return sections;
}

/* -------------------------------------------------------------------------- */
/*                                   proc://                                  */
/* -------------------------------------------------------------------------- */

function procEntry(entry: ProcEntry): DrawerEntry {
	const description = [entry.kind, entry.status, entry.label].filter(part => part && part.length > 0).join(" · ");
	return { uri: `proc://${entry.id}`, label: entry.id, description, kind: "resource" };
}

async function loadProc(uri: string, ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerPage> {
	if (!drawerSession(ctx)) return makePage(uri, "proc://", "No live session for proc://.", { parent: "proc://" });
	const rest = schemeRest(uri);
	const action = /^(.*)\/(kill|mode)$/.exec(rest);
	if (action) {
		const id = action[1];
		return makePage(uri, `proc://${id}`, `Writable form (proc://${id}/${action[2]}); the drawer never executes it.`, {
			parent: `proc://${id}`,
			sections: [{ title: "Available actions", lines: PROC_ACTIONS.map(item => `${item.name} — ${item.description}`) }],
		});
	}
	let entries: readonly ProcEntry[];
	try {
		entries = await procSourcesFor(ctx).entries(request.signal);
	} catch (error) {
		return errorPage(uri, "proc://", error);
	}
	if (rest && entries.some(entry => entry.id === rest)) {
		try {
			const resource = await readDrawerResource(`proc://${rest}`, ctx, request.signal);
			const sections: DrawerSection[] = [];
			if (resource.notes && resource.notes.length > 0) sections.push({ title: "Notes", lines: resource.notes });
			sections.push({ title: "Live detail / output tail", lines: boundedLines(resource.content) });
			return makePage(uri, `proc://${rest}`, "Live process detail", { parent: "proc://", sections, refreshMs: 3000 });
		} catch (error) {
			return errorPage(uri, `proc://${rest}`, error);
		}
	}
	const counts = { job: 0, agent: 0, service: 0 };
	for (const entry of entries) counts[entry.kind] += 1;
	const status = entries.length === 0
		? "No background jobs, running agents, or services."
		: `${counts.job} jobs · ${counts.agent} agents · ${counts.service} services`;
	return makePage(uri, "proc://", status, {
		parent: "proc://",
		entries: rankedEntries(entries.map(procEntry), rest),
		refreshMs: 3000,
	});
}

/* -------------------------------------------------------------------------- */
/*                                  agent://                                  */
/* -------------------------------------------------------------------------- */

/** Artifact ids plus live/parked registry ids, deduped; the roster the `agent://` scheme can serve. */
async function agentRoster(ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerEntry[]> {
	const entries: DrawerEntry[] = [];
	const seen = new Set<string>();
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind === "advisor" || seen.has(ref.id)) continue;
		seen.add(ref.id);
		entries.push({
			uri: `agent://${ref.id}`,
			label: ref.id,
			description: [ref.status, ref.kind, ref.parentId ? `parent ${ref.parentId}` : ""].filter(Boolean).join(" · "),
			kind: "resource",
		});
	}
	for (const candidate of await listDrawerResources("agent", "", ctx, request.signal)) {
		if (seen.has(candidate.value)) continue;
		seen.add(candidate.value);
		entries.push({ uri: `agent://${candidate.value}`, label: candidate.value, kind: "resource" });
	}
	return entries;
}

async function loadAgent(uri: string, ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerPage> {
	const rest = schemeRest(uri);
	if (rest) {
		try {
			const resource = await readDrawerResource(`agent://${rest}`, ctx, request.signal);
			const sections: DrawerSection[] = [];
			if (resource.notes && resource.notes.length > 0) sections.push({ title: "Notes", lines: resource.notes });
			sections.push({ title: "Output", lines: boundedLines(resource.content) });
			return makePage(uri, `agent://${rest}`, "Agent output", { parent: "agent://", sections });
		} catch (error) {
			return errorPage(uri, `agent://${rest}`, error);
		}
	}
	let roster: DrawerEntry[];
	try {
		roster = await agentRoster(ctx, request);
	} catch (error) {
		return errorPage(uri, "agent://", error);
	}
	return makePage(uri, "agent://", `${roster.length} agent output ids`, {
		parent: "agent://",
		entries: rankedEntries(roster, ""),
	});
}

/* -------------------------------------------------------------------------- */
/*                                 history://                                 */
/* -------------------------------------------------------------------------- */

async function loadHistory(uri: string, ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerPage> {
	const rest = schemeRest(uri);
	if (rest) {
		try {
			const resource = await readDrawerResource(`history://${rest}`, ctx, request.signal);
			return makePage(uri, `history://${rest}`, "Session history", {
				parent: "history://",
				sections: transcriptSections(resource.content),
			});
		} catch (error) {
			return errorPage(uri, `history://${rest}`, error);
		}
	}
	let candidates: DrawerCandidate[];
	try {
		candidates = await listDrawerResources("history", "", ctx, request.signal);
	} catch (error) {
		return errorPage(uri, "history://", error);
	}
	const entries: DrawerEntry[] = candidates.map(candidate => ({
		uri: `history://${candidate.value}`,
		label: candidate.value,
		...(candidate.description !== undefined ? { description: candidate.description } : {}),
		kind: "resource",
	}));
	return makePage(uri, "history://", `${entries.length} agent transcripts`, { parent: "history://", entries });
}

/* -------------------------------------------------------------------------- */
/*                                    xd://                                   */
/* -------------------------------------------------------------------------- */

function xdDeviceEntry(device: XdDevice): DrawerEntry {
	return {
		uri: `xd://${device.name}`,
		label: device.name,
		...(device.description !== undefined ? { description: device.description } : {}),
		kind: device.hasTopics ? "collection" : "resource",
	};
}

async function loadXd(uri: string, ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerPage> {
	if (!drawerSession(ctx)) return makePage(uri, "xd://", "No live session for xd://.", { parent: "xd://" });
	const rest = schemeRest(uri);
	const sources = xdSourcesFor(ctx);
	if (rest.includes("/")) {
		try {
			const resource = await readDrawerResource(`xd://${rest}`, ctx, request.signal);
			return makePage(uri, `xd://${rest}`, "Tool documentation", {
				parent: `xd://${rest.split("/")[0]}`,
				sections: [{ title: "Documentation", lines: boundedLines(resource.content) }],
			});
		} catch (error) {
			return errorPage(uri, `xd://${rest}`, error);
		}
	}
	const devices: readonly XdDevice[] = [...sources.devices(), ...SPECIAL_XD_DEVICES];
	const selected = rest ? devices.find(device => device.name === rest) : undefined;
	if (selected) {
		if (selected.hasTopics) {
			const topics = sources.topics(selected.name);
			const entries: DrawerEntry[] = topics.map(topic => ({
				uri: `xd://${selected.name}/${topic}`,
				label: topic,
				kind: "resource",
			}));
			return makePage(uri, `xd://${selected.name}`, `${topics.length} doc topics`, {
				parent: "xd://",
				entries,
				sections: topics.length === 0 ? [{ title: "Topics", lines: ["This device publishes no doc topics."] }] : [],
			});
		}
		try {
			const resource = await readDrawerResource(`xd://${selected.name}`, ctx, request.signal);
			return makePage(uri, `xd://${selected.name}`, "Tool device", {
				parent: "xd://",
				sections: [{ title: "Usage", lines: boundedLines(resource.content) }],
			});
		} catch (error) {
			return errorPage(uri, `xd://${selected.name}`, error);
		}
	}
	return makePage(uri, "xd://", `${devices.length} addressable devices`, {
		parent: "xd://",
		entries: rankedEntries(devices.map(xdDeviceEntry), rest),
		refreshMs: 5000,
	});
}

/* -------------------------------------------------------------------------- */
/*                                    cfg://                                  */
/* -------------------------------------------------------------------------- */

async function loadCfg(uri: string, ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerPage> {
	if (!drawerSession(ctx)) return makePage(uri, "cfg://", "No live session for cfg://.", { parent: "cfg://" });
	const rest = schemeRest(uri).replaceAll(".", "/");
	let candidates: DrawerCandidate[];
	try {
		candidates = await listDrawerResources("cfg", "", ctx, request.signal);
	} catch (error) {
		return errorPage(uri, "cfg://", error);
	}
	if (!rest) {
		const namespaces = new Set<string>();
		const topLevelSettings: DrawerEntry[] = [];
		for (const candidate of candidates) {
			const separator = candidate.value.indexOf("/");
			if (separator === -1) {
				topLevelSettings.push({
					uri: `cfg://${candidate.value}`,
					label: candidate.value,
					...(candidate.description !== undefined ? { description: candidate.description } : {}),
					kind: "resource",
				});
				continue;
			}
			namespaces.add(candidate.value.slice(0, separator));
		}
		const entries: DrawerEntry[] = [
			...topLevelSettings,
			...[...namespaces].sort().map(name => ({ uri: `cfg://${name}`, label: name, kind: "collection" as const })),
		];
		return makePage(uri, "cfg://", `${candidates.length} settings · ${namespaces.size} namespaces`, {
			parent: "cfg://",
			entries,
		});
	}
	const exact = candidates.find(candidate => candidate.value.toLowerCase() === rest.toLowerCase());
	const children = candidates.filter(candidate => candidate.value.toLowerCase().startsWith(`${rest.toLowerCase()}/`));
	if (!exact && children.length > 0) {
		const entries: DrawerEntry[] = children.map(child => ({
			uri: `cfg://${child.value}`,
			label: child.value.slice(rest.length + 1),
			...(child.description !== undefined ? { description: child.description } : {}),
			kind: "resource",
		}));
		return makePage(uri, `cfg://${rest}`, `${children.length} settings`, { parent: "cfg://", entries });
	}
	try {
		const resource = await readDrawerResource(`cfg://${rest}`, ctx, request.signal);
		return makePage(uri, `cfg://${rest}`, "Setting value (credentials redacted by the host)", {
			parent: "cfg://",
			sections: [{ title: "Value, type, default, source", lines: boundedLines(resource.content) }],
		});
	} catch (error) {
		return errorPage(uri, `cfg://${rest}`, error);
	}
}

/* -------------------------------------------------------------------------- */

const LOADERS: Record<string, (uri: string, ctx: ExtensionContext, request: DrawerRequest) => Promise<DrawerPage>> = {
	proc: loadProc,
	agent: loadAgent,
	history: loadHistory,
	xd: loadXd,
	cfg: loadCfg,
};

/** Drawer adapter for the live runtime schemes: process, agents, history, tools, and settings. */
export const runtimeDrawer: DrawerAdapter = {
	schemes: ["proc", "agent", "history", "xd", "cfg"],
	async load(uri, ctx, request) {
		const scheme = drawerScheme(uri);
		const loader = scheme ? LOADERS[scheme] : undefined;
		if (!loader) return makePage(uri, uri, `Unsupported scheme in this drawer: ${uri}`, {});
		try {
			return await loader(uri, ctx, request);
		} catch (error) {
			return errorPage(uri, uri, error);
		}
	},
};
