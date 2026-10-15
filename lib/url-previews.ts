import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { resolveModelRoleValue, getModelMatchPreferences } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { isSettingsInitialized, settings as hostSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import type { DrawerAdapter, DrawerPage } from "./drawer-types";
import { sanitizeTerminalText } from "./tool-output";
/**
 * Fast local-model summary result for autofilled URL preview.
 */
export interface UrlSummaryResult {
	summary?: string;
	error?: string;
	modelId?: string;
}

/**
 * Fast local model summarizer for preview content.
 */
export type UrlSummarizer = (
	uri: string,
	content: string,
	signal?: AbortSignal,
) => Promise<UrlSummaryResult>;

/**
 * Preview kinds supported across internal URL helpers.
 */
export type UrlPreviewKind = "vault" | "pr" | "xd" | "proc" | "unsupported";

/**
 * Structured preview model for a completed internal URL.
 */
export type UrlPreviewState = {
	url: string;
	scheme: string;
	title: string;
	kind: UrlPreviewKind;
	loading: boolean;
	error?: string;
	/** Fast local-model summary or breakdown */
	summary?: string;
	/** One-line breadcrumb/status bar */
	header?: string;
	/** Key-value metadata rows or structured badges */
	badges?: readonly string[];
	/** Directory/item listings or excerpt rows */
	rows?: readonly string[];
	/** Footer note, bounds note, or freshness */
	footer?: string;
};

/**
 * Provider hook for acquiring safe read-only preview content for a URL.
 */
export type UrlPreviewFetcher = (url: string, signal: AbortSignal) => Promise<UrlPreviewState>;

/**
 * Check whether a URL or completed token matches a supported preview scheme.
 */
export function parsePreviewUrl(token: string): { url: string; scheme: string } | null {
	const trimmed = token.trim();
	const match = /^(vault|pr|xd|proc):\/\/[^\s"'`()<>]*$/i.exec(trimmed);
	if (!match) return null;
	const scheme = (match[1] ?? "").toLowerCase();
	return { url: trimmed, scheme };
}

/**
 * Canonical realpath containment check: ensures target lies strictly inside root.
 */
export async function isContainedWithin(targetPath: string, rootPath: string): Promise<boolean> {
	try {
		const realRoot = await realpath(rootPath);
		let realTarget: string;
		try {
			realTarget = await realpath(targetPath);
		} catch {
			// If target doesn't exist yet, check its existing parent directory
			const parent = path.dirname(targetPath);
			const realParent = await realpath(parent);
			const base = path.basename(targetPath);
			realTarget = path.join(realParent, base);
		}
		if (realTarget === realRoot) return true;
		const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
		return realTarget.startsWith(prefix);
	} catch {
		return false;
	}
}

/**
 * Format bytes into human-readable compact form.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Safe preview resolver for `vault://` URLs:
 * Queries Obsidian vault root, checks realpath containment, bounded directory enumeration,
 * distinguishes missing vault, missing directory, or unreadable directory from empty.
 */
export async function fetchVaultPreview(
	url: string,
	roots: Map<string, string>,
	signal?: AbortSignal,
	maxRows = 8,
): Promise<UrlPreviewState> {
	if (signal?.aborted) throw new Error("Aborted");
	const withoutScheme = url.slice("vault://".length);
	const slashIdx = withoutScheme.indexOf("/");

	if (slashIdx === -1) {
		const vaultName = decodeURIComponent(withoutScheme);
		const root = roots.get(vaultName);
		if (!root) {
			return {
				url,
				scheme: "vault",
				title: vaultName ? `Vault: ${vaultName}` : "Vaults",
				kind: "vault",
				loading: false,
				error: vaultName ? `Vault '${vaultName}' is not registered in Obsidian.` : "No vault specified.",
			};
		}
		return {
			url,
			scheme: "vault",
			title: `Vault: ${vaultName}`,
			kind: "vault",
			loading: false,
			badges: [`Root: ${root}`],
			footer: "Select a folder or note to browse",
		};
	}

	const vaultName = decodeURIComponent(withoutScheme.slice(0, slashIdx));
	const root = roots.get(vaultName);
	if (!root) {
		return {
			url,
			scheme: "vault",
			title: `Vault: ${vaultName}`,
			kind: "vault",
			loading: false,
			error: `Vault '${vaultName}' not found in Obsidian registry.`,
		};
	}

	const subPath = decodeURIComponent(withoutScheme.slice(slashIdx + 1));
	const absPath = path.resolve(root, subPath);

	// Security: containment check
	const contained = await isContainedWithin(absPath, root);
	if (!contained) {
		return {
			url,
			scheme: "vault",
			title: `Vault: ${vaultName}`,
			kind: "vault",
			loading: false,
			error: "Path traverses outside vault root.",
		};
	}

	let stat: Stats;
	try {
		stat = await fs.stat(absPath);
	} catch (err: unknown) {
		const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
		return {
			url,
			scheme: "vault",
			title: path.basename(absPath) || vaultName,
			kind: "vault",
			loading: false,
			error: code === "ENOENT" ? "Resource does not exist." : "Cannot access path.",
		};
	}

	if (stat.isDirectory()) {
		let dirEntries: Dirent[] = [];
		try {
			dirEntries = await fs.readdir(absPath, { withFileTypes: true });
		} catch {
			return {
				url,
				scheme: "vault",
				title: `${path.basename(absPath)}/`,
				kind: "vault",
				loading: false,
				error: "Permission denied or failed reading directory.",
			};
		}

		const visible = dirEntries.filter(e => !e.name.startsWith("."));
		const dirs = visible.filter(e => e.isDirectory());
		const files = visible.filter(e => e.isFile());

		const rows: string[] = [];
		for (const d of dirs.slice(0, maxRows)) {
			rows.push(`📁 ${d.name}/`);
		}
		const remainingFileSlots = maxRows - rows.length;
		for (const f of files.slice(0, remainingFileSlots)) {
			const icon = f.name.endsWith(".md") ? "📝" : "📄";
			rows.push(`${icon} ${f.name}`);
		}

		const totalCount = visible.length;
		const badges = [
			`${dirs.length} folder${dirs.length === 1 ? "" : "s"}`,
			`${files.length} file${files.length === 1 ? "" : "s"}`,
		];
		const footer = totalCount > maxRows ? `+${totalCount - maxRows} more items` : undefined;

		return {
			url,
			scheme: "vault",
			title: `${path.basename(absPath) || vaultName}/`,
			kind: "vault",
			loading: false,
			badges,
			rows: rows.length > 0 ? rows : ["(empty directory)"],
			footer,
		};
	}

	// File preview: show metadata and head excerpt if markdown/text
	const sizeStr = formatBytes(stat.size);
	const isMd = absPath.endsWith(".md");
	const isDb = absPath.endsWith(".db") || absPath.endsWith(".db-wal") || absPath.endsWith(".db-shm");
	const badges = [sizeStr, isMd ? "Markdown Note" : isDb ? "SQLite Database/WAL" : "File"];

	let rows: string[] | undefined;
	if (isMd && stat.size > 0 && stat.size < 256 * 1024) {
		try {
			const content = await fs.readFile(absPath, "utf8");
			const lines = content.split("\n").map(l => l.trimEnd()).filter(l => l.length > 0).slice(0, 4);
			if (lines.length > 0) {
				rows = lines.map(l => `  ${l}`);
			}
		} catch {
			// Ignore excerpt failure
		}
	}

	return {
		url,
		scheme: "vault",
		title: path.basename(absPath),
		kind: "vault",
		loading: false,
		badges,
		rows,
		footer: isDb ? "Binary/database file (read omitted for safety)" : undefined,
	};
}

/**
 * Preview resolver for `pr://` URLs using cached PR data.
 */
export function fetchPrPreview(
	url: string,
	cachedPrs: readonly {
		number: number;
		title: string;
		repo: string;
		isDraft: boolean;
		ci: string;
		unresolvedThreads: number;
		mergeable: string;
		approved: boolean | null;
	}[],
): UrlPreviewState {
	const rest = url.slice("pr://".length).trim();
	const parts = rest.split("/").filter(Boolean);
	if (parts.length < 3) {
		return {
			url,
			scheme: "pr",
			title: rest ? `PRs for ${rest}` : "Pull Requests",
			kind: "pr",
			loading: false,
			badges: [`${cachedPrs.length} loaded PRs`],
			footer: "Select a specific PR to see details",
		};
	}

	const repo = `${parts[0]}/${parts[1]}`.toLowerCase();
	const num = parseInt(parts[2] ?? "", 10);
	const match = cachedPrs.find(p => p.repo.toLowerCase() === repo && p.number === num);

	if (!match) {
		return {
			url,
			scheme: "pr",
			title: `PR #${parts[2]} (${parts[0]}/${parts[1]})`,
			kind: "pr",
			loading: false,
			error: "PR not found in cached viewer pull requests.",
		};
	}

	const ciIcon = match.ci === "pass" ? "✓ CI passed" : match.ci === "fail" ? "✗ CI failed" : match.ci === "pending" ? "… CI running" : "– CI none";
	const threadIcon = match.unresolvedThreads === 0 ? "✓ 0 threads" : `✗ ${match.unresolvedThreads} thread${match.unresolvedThreads === 1 ? "" : "s"}`;
	const mergeIcon = match.mergeable === "clean" ? "✓ mergeable" : match.mergeable === "conflicts" ? "✗ conflicts" : "? merge unknown";
	const badges = [ciIcon, threadIcon, mergeIcon];
	if (match.approved !== null) {
		badges.push(match.approved ? "✓ approved" : "– unapproved");
	}

	return {
		url,
		scheme: "pr",
		title: `#${match.number}: ${match.isDraft ? "[Draft] " : ""}${match.title}`,
		kind: "pr",
		loading: false,
		header: `Repo: ${match.repo}`,
		badges,
	};
}

/**
 * Preview resolver for `xd://` device and topic URLs.
 */
export function fetchXdPreview(
	url: string,
	devices: readonly { name: string; description?: string; hasTopics?: boolean }[],
	topicsForDevice: (name: string) => readonly string[],
): UrlPreviewState {
	const rest = url.slice("xd://".length).trim();
	const parts = rest.split("/").filter(Boolean);

	if (parts.length === 0) {
		return {
			url,
			scheme: "xd",
			title: "xd:// Tools & Devices",
			kind: "xd",
			loading: false,
			badges: [`${devices.length} addressable tools`],
			footer: "Read xd://<tool> for docs, write xd://<tool> to execute",
		};
	}

	const deviceName = parts[0]!;
	const device = devices.find(d => d.name.toLowerCase() === deviceName.toLowerCase());
	if (!device) {
		return {
			url,
			scheme: "xd",
			title: `xd://${deviceName}`,
			kind: "xd",
			loading: false,
			error: `Tool or device '${deviceName}' not mounted or active in this session.`,
		};
	}

	if (parts.length > 1) {
		const topic = parts[1]!;
		const allTopics = topicsForDevice(device.name);
		const hasTopic = allTopics.includes(topic);
		return {
			url,
			scheme: "xd",
			title: `${device.name}/${topic}`,
			kind: "xd",
			loading: false,
			header: `Topic doc for ${device.name}`,
			badges: hasTopic ? ["Available topic"] : ["Unknown topic"],
			error: hasTopic ? undefined : `Topic '${topic}' not found on ${device.name}.`,
			footer: `Read xd://${device.name}/${topic} to inspect full topic documentation`,
		};
	}

	const topics = topicsForDevice(device.name);
	const badges = [`Device: ${device.name}`];
	if (topics.length > 0) {
		badges.push(`${topics.length} topic${topics.length === 1 ? "" : "s"}`);
	}

	const rows: string[] = [];
	if (device.description) {
		rows.push(device.description);
	}
	if (topics.length > 0) {
		rows.push(`Topics: ${topics.slice(0, 5).join(", ")}${topics.length > 5 ? " …" : ""}`);
	}

	return {
		url,
		scheme: "xd",
		title: `xd://${device.name}`,
		kind: "xd",
		loading: false,
		badges,
		rows: rows.length > 0 ? rows : undefined,
		footer: "Read xd://<tool> for docs/schema · Write JSON to dispatch",
	};
}

/**
 * Preview resolver for `proc://` process/action URLs.
 */
export function fetchProcPreview(
	url: string,
	entries: readonly { id: string; kind: "job" | "agent" | "service"; status?: string; label?: string; actions?: readonly string[] }[],
): UrlPreviewState {
	const rest = url.slice("proc://".length).trim();
	const parts = rest.split("/").filter(Boolean);

	if (parts.length === 0) {
		const jobs = entries.filter(e => e.kind === "job").length;
		const agents = entries.filter(e => e.kind === "agent").length;
		const services = entries.filter(e => e.kind === "service").length;
		return {
			url,
			scheme: "proc",
			title: "proc:// Session Processes",
			kind: "proc",
			loading: false,
			badges: [`${jobs} jobs`, `${agents} agents`, `${services} services`],
			footer: "Write proc://<id>/kill to cancel",
		};
	}

	const id = parts[0]!;
	const entry = entries.find(e => e.id.toLowerCase() === id.toLowerCase());
	if (!entry) {
		return {
			url,
			scheme: "proc",
			title: `proc://${id}`,
			kind: "proc",
			loading: false,
			error: `No process, subagent, or service with ID '${id}' found in this session.`,
		};
	}

	if (parts.length > 1) {
		const action = parts[1]!;
		const valid = action === "kill" || (action === "mode" && entry.kind === "service");
		return {
			url,
			scheme: "proc",
			title: `proc://${entry.id}/${action}`,
			kind: "proc",
			loading: false,
			badges: [`Target: [${entry.kind}] ${entry.id}`],
			rows: [
				action === "kill"
					? "Cancel or terminate this execution."
					: action === "mode"
						? "Adjust persistence/detachment mode for this service."
						: `Unsupported action '${action}'.`,
			],
			error: valid ? undefined : `Action '${action}' is not supported for ${entry.kind}.`,
			footer: valid ? "Write payload to URL to execute action" : undefined,
		};
	}

	const badges = [`Kind: ${entry.kind}`];
	if (entry.status) badges.push(`Status: ${entry.status}`);
	const rows: string[] = [];
	if (entry.label) rows.push(entry.label);

	return {
		url,
		scheme: "proc",
		title: `proc://${entry.id}`,
		kind: "proc",
		loading: false,
		badges,
		rows: rows.length > 0 ? rows : undefined,
		footer: entry.kind === "service" ? "Actions: /kill, /mode" : "Actions: /kill",
	};
}

/**
 * Fast local-model summarizer for internal URL content.
 * Resolves the fast local model (via smol role or local/mlx candidate) and generates
 * a concise, single-line breakdown summarizing the referenced content.
 */
export async function summarizeUrlContent(
	ctx: ExtensionContext,
	uri: string,
	content: string,
	signal?: AbortSignal,
	customSummarizer?: UrlSummarizer,
): Promise<UrlSummaryResult> {
	const trimmed = content.trim();
	if (!trimmed) return {};

	try {
		if (customSummarizer) {
			return await customSummarizer(uri, content, signal);
		}
		type ContextWithRegistry = {
			modelRegistry?: {
				getAvailable(): Model<Api>[];
				getApiKey(m: Model<Api>, s?: string): Promise<string | undefined>;
				resolver(m: Model<Api>, s?: string): unknown;
			};
		};
		const registry = (ctx as unknown as ContextWithRegistry).modelRegistry;
		if (!registry || typeof registry.getAvailable !== "function") {
			return { summary: undefined };
		}

		const available = registry.getAvailable();
		// Specifically resolve local-only models (via @tiny role or local/mlx/ollama providers).
		// Never send user vault notes or internal data to remote models for inline preview tooltips.
		const isLocal = (m: Model<Api>) => m.provider === "mlx" || m.provider === "local" || m.provider === "ollama";

		let tinyResolvedModel: Model<Api> | undefined;
		if (isSettingsInitialized()) {
			const tinyResolved = resolveModelRoleValue("@tiny", available, {
				settings: hostSettings,
				matchPreferences: getModelMatchPreferences(hostSettings),
			});
			tinyResolvedModel = tinyResolved?.model;
		}

		const candidate = (tinyResolvedModel && isLocal(tinyResolvedModel))
			? tinyResolvedModel
			: available.find(isLocal);
		if (!candidate) {
			return { summary: undefined };
		}

		const apiKey = await registry.getApiKey(candidate);
		if (!apiKey && !isLocal(candidate)) {
			return { summary: undefined };
		}

		const systemPrompt = "You are a concise indexer. Summarize the following referenced content in ONE short sentence or phrase (under 15 words) for an inline IDE preview tooltip. Do not include markdown formatting or quotes.";
		const userPrompt = `URI: ${uri}\n\nContent:\n${trimmed.slice(0, 1500)}`;

		const timeoutSignal = AbortSignal.timeout(3000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					candidate,
					{
						systemPrompt: [systemPrompt],
						messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
					},
					{
						apiKey: registry.resolver(candidate) as unknown as string | undefined,
						maxTokens: 40,
						temperature: 0,
						disableReasoning: true,
						signal: combinedSignal,
					},
				),
			{ signal: combinedSignal, provider: candidate.provider },
		);

		const text = response.content
			?.map(c => c.type === "text" ? c.text : "")
			.join("")
			.trim()
			.replace(/[\r\n\t]+/g, " ");

		return { summary: text || undefined, modelId: `${candidate.provider}/${candidate.id}` };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
/**
 * Render preview lines formatted for a widget container above or below editor.
 */
export function formatUrlPreviewLines(preview: UrlPreviewState, width = 80): string[] {
	const out: string[] = [];
	const prefix = " ⎘ ";
	const titlePart = `${prefix}${preview.title}`;
	out.push(titlePart);

	if (preview.summary) {
		out.push(`   💡 ${preview.summary}`);
	}

	if (preview.header) {
		out.push(`   ${preview.header}`);
	}

	if (preview.badges && preview.badges.length > 0) {
		out.push(`   ${preview.badges.join(" · ")}`);
	}

	if (preview.error) {
		out.push(`   ⚠️  ${preview.error}`);
	} else if (preview.rows && preview.rows.length > 0) {
		for (const r of preview.rows) {
			out.push(`   ${r}`);
		}
	}

	if (preview.footer) {
		out.push(`   ${preview.footer}`);
	}

	return out;
}

const WIDGET_KEY = "hydemods:url-preview";

/**
 * Manages the immediate post-autofill preview lifecycle across all internal URL helpers.
 */
export class UrlPreviewLifecycle {
	private active?: AbortController;
	private unsubscribe?: () => void;
	private context?: ExtensionContext;
	private installed = new WeakSet<object>();
	private previewGeneration = 0;
	private summarizer?: UrlSummarizer;

	constructor(
		private readonly adapters: readonly DrawerAdapter[],
		summarizer?: UrlSummarizer,
	) {
		this.summarizer = summarizer;
	}

	setSummarizer(summarizer?: UrlSummarizer): void {
		this.summarizer = summarizer;
	}

	reset(): void {
		this.previewGeneration++;
		this.active?.abort();
		this.active = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.context?.hasUI) {
			this.context.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	install(ctx: ExtensionContext): void {
		this.reset();
		this.context = ctx;
		if (!ctx.hasUI) return;

		// Clear preview and abort active in-flight request on any subsequent keystroke
		this.unsubscribe = ctx.ui.onTerminalInput(() => {
			this.reset();
			return undefined;
		});

		if (this.installed.has(ctx.ui)) return;
		this.installed.add(ctx.ui);
	}

	showPreview(ctx: ExtensionContext, uri: string, page?: DrawerPage): void {
		const generation = ++this.previewGeneration;
		if (this.active) {
			this.active.abort();
		}
		const controller = new AbortController();
		this.active = controller;

		const render = (value?: DrawerPage, summary?: string) => {
			if (generation !== this.previewGeneration) return;
			const clean = (text: string) => sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");
			const details = value?.entries.length
				? value.entries.slice(0, 3).map(e => e.label)
				: value?.sections.flatMap(s => s.lines).slice(0, 3) ?? [];

			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => ({
					render(width: number): readonly string[] {
						const lines: string[] = [
							theme.fg("accent", truncateToWidth(` ⎘ ${clean(uri)}`, width)),
						];
						if (summary) {
							lines.push(theme.fg("warning", truncateToWidth(`   💡 ${clean(summary)}`, width)));
						}
						lines.push(
							theme.fg("muted", truncateToWidth(`   ${clean(value?.status ?? "Internal URL referenced")}  ${details.map(clean).join(" · ")}`, width)),
						);
						return lines;
					},
					invalidate() {},
				}),
				{ placement: "aboveEditor" },
			);
		};

		const triggerSummary = (contentToSummarize: string, loadedPage?: DrawerPage) => {
			void summarizeUrlContent(ctx, uri, contentToSummarize, controller.signal, this.summarizer)
				.then(summaryResult => {
					if (!controller.signal.aborted && generation === this.previewGeneration && summaryResult.summary) {
						render(loadedPage, summaryResult.summary);
					}
				})
				.catch(() => undefined);
		};

		if (page) {
			render(page);
			const excerpt = page.sections.flatMap(s => s.lines).join("\n") || page.entries.map(e => e.label).join(", ");
			if (excerpt) {
				triggerSummary(excerpt, page);
			}
			return;
		}

		const scheme = /^([a-z]+):\/\//i.exec(uri)?.[1]?.toLowerCase();
		const adapter = this.adapters.find(a => (a.schemes as readonly string[]).includes(scheme ?? ""));
		if (!adapter) {
			render(undefined);
			this.active = undefined;
			return;
		}

		void adapter
			.load(uri, ctx, { signal: controller.signal, fetch: false })
			.then(loadedPage => {
				if (!controller.signal.aborted && generation === this.previewGeneration) {
					render(loadedPage);
					const excerpt = loadedPage.sections.flatMap(s => s.lines).join("\n") || loadedPage.entries.map(e => e.label).join(", ");
					if (excerpt) {
						triggerSummary(excerpt, loadedPage);
					}
				}
			})
			.catch(() => {
				if (!controller.signal.aborted && generation === this.previewGeneration) {
					render(undefined);
				}
			})
			.finally(() => {
				if (this.active === controller) {
					this.active = undefined;
				}
			});
	}
}

/**
 * Registers the URL preview lifecycle manager and binds session disposal / switch events.
 */
export function registerUrlPreviewLifecycle(pi: ExtensionAPI, adapters: readonly DrawerAdapter[]): UrlPreviewLifecycle {
	const manager = new UrlPreviewLifecycle(adapters);
	pi.on("session_shutdown", async () => { manager.reset(); });
	pi.on("session_switch", async (_event, ctx) => { manager.install(ctx); });
	pi.on("session_branch", async (_event, ctx) => { manager.install(ctx); });
	pi.on("session_tree", async (_event, ctx) => { manager.install(ctx); });
	return manager;
}
