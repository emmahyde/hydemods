import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * The live host bridge for the internal-URL drawers.
 *
 * OMP does not hand an extension a `ToolSession`, but the host builds every tool instance with the
 * live one (`private readonly session: ToolSession` — TS-private, runtime-visible) and the calling
 * agent's `AgentSession` is reachable through the process-global `AgentRegistry` under
 * `ctx.agent.id`. {@link drawerSession} recovers that authoritative `ToolSession` from a live tool,
 * structurally validated, and hands it to the host's own `InternalUrlRouter`, so a drawer and
 * `read <scheme>://…` agree about what exists. Recovering the real session also carries the fields a
 * reconstructed adapter cannot supply (`xdev`, `conflictHistory`, `agentRegistry`,
 * `localProtocolOptions`, `activeRules`).
 *
 * Reads only. `readDrawerResource` resolves through `InternalUrlRouter.resolve`; it never calls
 * `write`, never dispatches `xd://` devices, never runs security scans, and never applies conflicts.
 */

type AgentSession = NonNullable<AgentRef["session"]>;

/** Upper bound on returned content; longer resources are cut with a note. */
const CONTENT_MAX_CHARS = 200_000;

/** A bounded projection of the host's `InternalResource` for drawer rendering. */
export type DrawerResource = {
	/** Resolved text content. */
	content: string;
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Structured host snapshots (e.g. `proc`, `cfg`); passed through unchanged. */
	details?: unknown;
	/** Resolution notes (source, extraction, superseded banners). */
	notes?: string[];
	/** True when the resource is a directory listing, not file content. */
	isDirectory?: boolean;
	/** Canonical URL that was resolved. */
	url?: string;
};

/** One autocomplete candidate for a scheme's host/path portion. */
export type DrawerCandidate = { value: string; label?: string; description?: string };

/** One live MCP resource or template across connected servers. */
export type McpResourceRow = {
	server: string;
	/** Resource URI, or URI template for {@link isTemplate} rows. */
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	isTemplate: boolean;
};

/** The live session for `ctx`: registry id first, session file second. */
function liveSession(ctx: ExtensionContext): AgentSession | undefined {
	const registry = AgentRegistry.global();
	const direct = registry.get(ctx.agent.id)?.session;
	if (direct) return direct;
	const file = ctx.sessionManager.getSessionFile?.();
	return file ? (registry.list().find(ref => ref.sessionFile === file)?.session ?? undefined) : undefined;
}

/**
 * Built-in tools the host constructs with the session's live `ToolSession` (`new XTool(session)`).
 * Any one of these exposes the session at runtime; `read` is first because a normal session always
 * has it, and the remainder cover sessions restricted to a narrower tool set.
 */
const TOOL_SESSION_PROBES = ["read", "bash", "grep", "glob", "edit", "write", "find"] as const;

/** The TS-private, runtime-visible `session` field the host's tool classes hold. */
type ToolWithSession = { session?: unknown };

/**
 * Structural guard for the recovered value. The real `ToolSession` always carries a `cwd`, the two
 * required closures, and the initialized settings; a tool that holds something else is rejected
 * rather than passed to the router.
 */
function isToolSession(value: unknown): value is ToolSession {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ToolSession>;
	return (
		typeof candidate.cwd === "string" &&
		typeof candidate.getSessionFile === "function" &&
		typeof candidate.getSessionSpawns === "function" &&
		typeof candidate.settings === "object" &&
		candidate.settings !== null
	);
}

/**
 * The session's authoritative `ToolSession`, recovered from a live tool instance the host built for
 * this caller's `AgentSession`, or `undefined` when none of the probe tools is registered. Callers
 * get the host's own object — `xdev`, `conflictHistory`, `agentRegistry`, `localProtocolOptions`,
 * and the settings scope are the live ones, not a reconstruction.
 */
export function drawerSession(ctx: ExtensionContext): ToolSession | undefined {
	const live = liveSession(ctx);
	if (!live) return undefined;
	for (const name of TOOL_SESSION_PROBES) {
		const tool = live.getToolByName(name) as ToolWithSession | undefined;
		if (isToolSession(tool?.session)) return tool.session;
	}
	return undefined;
}

/**
 * The `ResolveContext` the host's protocol handlers expect. Everything comes from the recovered
 * `ToolSession` when there is one — so identity-bound schemes (`history://<id>`, `memory://`) bind to
 * this caller and `rule://` sees this session's applicable rules — and falls back to `ctx` and the
 * process-global registry otherwise.
 */
export function drawerResolveContext(ctx: ExtensionContext, signal: AbortSignal): ResolveContext {
	const session = drawerSession(ctx);
	return {
		cwd: session?.cwd ?? ctx.cwd,
		sessionFile: session?.getSessionFile() ?? ctx.sessionManager.getSessionFile?.() ?? undefined,
		sessionId: session?.getSessionId?.() ?? ctx.sessionManager.getSessionId?.() ?? undefined,
		agentRegistry: session?.agentRegistry ?? AgentRegistry.global(),
		settings: session?.settings,
		localProtocolOptions: session?.localProtocolOptions ?? ctx.localProtocolOptions,
		signal,
		...(session ? { session, skills: session.skills, rules: session.activeRules } : {}),
	};
}

/**
 * Read one internal URL through the host's own router, using the live session as the caller.
 * Read-only: no `write`, no device dispatch, no scans. Throws the handler's own error (e.g. a
 * "requires a tool session" message) when `uri` names a session-bound scheme with no live session.
 */
export async function readDrawerResource(
	uri: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<DrawerResource> {
	const resource = await InternalUrlRouter.instance().resolve(uri, drawerResolveContext(ctx, signal));
	// Cut oversized resources (full transcripts, long service logs) so the drawer stays bounded.
	const content =
		resource.content.length <= CONTENT_MAX_CHARS
			? resource.content
			: `${resource.content.slice(0, CONTENT_MAX_CHARS)}\n… [truncated ${resource.content.length - CONTENT_MAX_CHARS} chars]`;
	return {
		content,
		contentType: resource.contentType,
		...(resource.details !== undefined ? { details: resource.details } : {}),
		...(resource.notes !== undefined ? { notes: resource.notes } : {}),
		...(resource.isDirectory === true ? { isDirectory: true } : {}),
		url: resource.url,
	};
}

/**
 * Enumerate a scheme's candidates through the host's `complete()` hook. Returns `[]` for schemes
 * that do not implement it (e.g. `mcp`, `conflict`, `attachment`).
 */
export async function listDrawerResources(
	scheme: string,
	query: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<DrawerCandidate[]> {
	const completions = await InternalUrlRouter.instance().complete(scheme, query, drawerResolveContext(ctx, signal));
	if (completions === null) return [];
	return completions.map(completion => ({
		value: completion.value,
		...(completion.label !== undefined ? { label: completion.label } : {}),
		...(completion.description !== undefined ? { description: completion.description } : {}),
	}));
}

/** Locate the local file backing `uri`, through the host's router; `null` when none exists. */
export async function locateDrawerResource(
	uri: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<string | null> {
	return InternalUrlRouter.instance().locate(uri, drawerResolveContext(ctx, signal));
}

/**
 * Live MCP resources and templates across connected servers. Reads the same process-global
 * {@link MCPManager} singleton the host's own `mcp://` handler uses, through the statically mapped
 * `mcp` subpath. Read-only: it surfaces what the manager already cached; it never starts a server.
 */
export async function listMcpResources(_ctx?: ExtensionContext): Promise<McpResourceRow[]> {
	const manager = MCPManager.instance();
	if (!manager) return [];
	const rows: McpResourceRow[] = [];
	for (const server of manager.getConnectedServers()) {
		const bundle = manager.getServerResources(server);
		if (!bundle) continue;
		for (const resource of bundle.resources) {
			rows.push({
				server,
				uri: resource.uri,
				name: resource.name,
				...(resource.description !== undefined ? { description: resource.description } : {}),
				...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
				isTemplate: false,
			});
		}
		for (const template of bundle.templates) {
			rows.push({
				server,
				uri: template.uriTemplate,
				name: template.name,
				...(template.description !== undefined ? { description: template.description } : {}),
				...(template.mimeType !== undefined ? { mimeType: template.mimeType } : {}),
				isTemplate: true,
			});
		}
	}
	return rows;
}
