import { runningAgentsOutsideJobs } from "@oh-my-pi/pi-coding-agent/async/job-control";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { isSettingsInitialized, settings as hostSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgLaunchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { ProcEntry, ProcSources, XdDevice, XdSources } from "./xd-proc-drawers";

/**
 * Live `xd://` and `proc://` state for the completion drawers.
 *
 * OMP gives an extension no `ToolSession`. The calling agent's live `AgentSession` is reachable
 * through the process-global `AgentRegistry` under `ctx.agent.id` (the documented registry id,
 * e.g. `"Main"` or `"0-Explore"`), and it exposes everything the host's own `xd://`/`proc://`
 * handlers read: `getMountedXdevToolNames`, `getToolByName`, `getAgentId`, and `asyncJobManager`.
 *
 * Every specifier imported here must be one the running host maps into its extension module table
 * (see `lib/host-copies.ts`); an unmapped canonical subpath resolves to a duplicate on-disk copy of
 * the host package instead of the live module, and the whole extension is rejected when the on-disk
 * copy is absent. That is why services are read through `InternalUrlRouter` — the host's own
 * `proc://` handler is registered on that router and reaches the live daemon broker — rather than
 * through `launch/services`, which the table does not include.
 *
 * Jobs come straight from the snapshot. Running subagents reuse the host's own enumerator
 * (`runningAgentsOutsideJobs`) through a minimal `ToolSession` shim built from the `AgentSession`
 * plus `ctx.cwd`; using the host's handlers keeps this drawer and the `read proc://`/`read xd://`
 * listings in agreement about what exists.
 */

type AgentSession = NonNullable<AgentRef["session"]>;

/** The slice of `ExtensionContext` these adapters read. */
export type RuntimeContext = {
	agent: { id: string };
	cwd: string;
	sessionManager?: { getSessionId?(): string | undefined; getSessionFile?(): string | undefined };
};

/** The daemon fields the drawer shows; a structural subset of the host's `DaemonSnapshot`. */
type ServiceRow = { name: string; state: string; pid?: number; persist: boolean; detached: boolean };

/** Broker listings are one IPC round-trip; keep one per project for a couple of seconds. */
const SERVICES_TTL_MS = 2_000;

let servicesCache: { key: string; at: number; services: readonly ServiceRow[] } | undefined;

/** The live session for `ctx`: prefer the registry id, fall back to the session file. */
function sessionFor(ctx: RuntimeContext): AgentSession | undefined {
	const registry = AgentRegistry.global();
	const direct = registry.get(ctx.agent.id)?.session;
	if (direct) return direct;
	const file = ctx.sessionManager?.getSessionFile?.();
	return file ? (registry.list().find(ref => ref.sessionFile === file)?.session ?? undefined) : undefined;
}

/**
 * The live async-job manager and registry id for `ctx`, or undefined when the session exposes
 * neither. This is the session's own manager — the authoritative one for registering, cancelling,
 * and reading background jobs — never the process-global singleton.
 */
export function asyncJobsFor(ctx: RuntimeContext): { manager: AsyncJobManager; ownerId: string } | undefined {
	const session = sessionFor(ctx);
	const manager = session?.asyncJobManager;
	const ownerId = session?.getAgentId();
	// Without an owner id the job would be unowned: invisible to this session's `proc://` roster and
	// to its delivery scoping, so the caller falls back to the host-less path instead.
	return manager && ownerId ? { manager, ownerId } : undefined;
}

/** Project services, reusing a recent broker listing; aborts fall back to the cached rows. */
async function listProjectServices(
	ctx: RuntimeContext,
	shim: ToolSession,
	signal?: AbortSignal,
): Promise<readonly ServiceRow[]> {
	if (servicesCache?.key === ctx.cwd && Date.now() - servicesCache.at < SERVICES_TTL_MS) return servicesCache.services;
	try {
		const resource = await InternalUrlRouter.instance().resolve("proc://", { session: shim, signal });
		const services = resource.details?.proc?.daemons ?? [];
		servicesCache = { key: ctx.cwd, at: Date.now(), services };
		return services;
	} catch (error) {
		// The broker failure the host tolerates inside its own handler never reaches here; a real
		// throw (bad URL, missing session) leaves the last good listing in place for the drawer.
		if (signal?.aborted) return servicesCache?.services ?? [];
		throw error;
	}
}

/** `xd://` sources: every device the host's `xd://` handler can address in this session. */
export function xdSourcesFor(ctx: RuntimeContext): XdSources {
	return {
		devices(): readonly XdDevice[] {
			const session = sessionFor(ctx);
			if (!session) return [];
			// The host addresses `xd://<name>` for mounted devices and active top-level tools alike
			// (`xdev.ts` `resolveXdevTool`: `mountedNames.has(name) || isActive(name)`, where `isActive`
			// is the session's active-tool set). Native tools such as `eval` are never mounted but do
			// own doc topics, so the union — not the mount list — is the addressable set. Drop names the
			// canonical registry does not know, because the handler cannot resolve those either.
			const names = new Set([...session.getMountedXdevToolNames(), ...session.getActiveToolNames()]);
			const devices: XdDevice[] = [];
			for (const name of names) {
				const tool = session.getToolByName(name);
				if (!tool) continue;
				devices.push({
					name,
					description: tool.summary ?? tool.description,
					hasTopics: typeof tool.docTopics === "function",
				});
			}
			return devices;
		},
		topics(device: string): readonly string[] {
			return Object.keys(sessionFor(ctx)?.getToolByName(device)?.docTopics?.() ?? {});
		},
	};
}

/** `proc://` sources: this session's jobs, running subagents, and project services. */
export function procSourcesFor(ctx: RuntimeContext): ProcSources {
	return {
		async entries(signal?: AbortSignal): Promise<readonly ProcEntry[]> {
			const session = sessionFor(ctx);
			if (!session) return [];
			// The host's job/service enumerators take a `ToolSession`, which OMP does not expose to
			// extensions. They read only `asyncJobManager`, `agentRegistry`, `getAgentId`/`getSessionId`,
			// `cwd`, and the settings scope backing each launch flag; the live `AgentSession` carries the
			// job/agent state, and `ctx.cwd` plus the global settings scope fill in the rest.
			const shim = {
				cwd: ctx.cwd,
				settings: hostSettings,
				getSessionId: () => ctx.sessionManager?.getSessionId?.(),
				getAgentId: () => session.getAgentId(),
				asyncJobManager: session.asyncJobManager,
				agentRegistry: AgentRegistry.global(),
			} as unknown as ToolSession;
			const entries: ProcEntry[] = [];
			const seen = new Set<string>();

			const snapshot = session.getAsyncJobSnapshot({ recentLimit: 8 }) ?? { running: [], recent: [] };
			for (const job of [...snapshot.running, ...snapshot.recent]) {
				if (seen.has(job.id)) continue;
				seen.add(job.id);
				entries.push({ id: job.id, kind: "job", status: job.status, label: job.label });
			}

			for (const agent of runningAgentsOutsideJobs(shim)) {
				if (seen.has(agent.id)) continue;
				seen.add(agent.id);
				entries.push({ id: agent.id, kind: "agent", status: "running", label: agent.activity });
			}

			if (isSettingsInitialized() && cfgLaunchEnabled.get(hostSettings)) {
				for (const service of await listProjectServices(ctx, shim, signal)) {
					if (seen.has(service.name)) continue;
					seen.add(service.name);
					const flags = [service.pid === undefined ? "" : `pid ${service.pid}`, service.persist ? "persistent" : "", service.detached ? "detached" : ""]
						.filter(flag => flag.length > 0)
						.join(" ");
					entries.push({ id: service.name, kind: "service", status: service.state, label: flags || undefined });
				}
			}

			return entries;
		},
	};
}
