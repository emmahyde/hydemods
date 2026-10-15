import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isSettingsInitialized } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { drawerSession } from "../lib/drawer-host";
import { runtimeDrawer } from "../lib/drawer-runtime";
import type { DrawerPage } from "../lib/drawer-types";

type FakeSession = NonNullable<AgentRef["session"]>;
type FakeTool = { summary?: string; description?: string; docTopics?: () => Record<string, string> };

const signal = new AbortController().signal;
const request = { signal, fetch: false };

// A host-shaped context whose agent id is not in the registry: no live session, so every
// session-bound scheme must degrade instead of throwing.
const sessionlessCtx = (id: string): ExtensionContext =>
	({
		cwd: process.cwd(),
		hasUI: false,
		agent: { id, depth: 0 },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "runtime-drawer-test-session" },
	}) as unknown as ExtensionContext;

const SESSION_ID = "runtime-drawer-test-agent";

// The host builds every tool with the live `ToolSession` (`private readonly session`), and
// `drawerSession` reads it back off `read`. Mirror that shape so the guard accepts the fake.
const fakeToolSession = (): Record<string, unknown> => ({
	cwd: process.cwd(),
	hasUI: false,
	settings: {},
	sessionManager: {},
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	getSessionId: () => "runtime-drawer-test-session",
	asyncJobManager: { getRunningJobs: () => [] },
	agentRegistry: AgentRegistry.global(),
});

// An `AgentSession`-shaped stand-in covering only the fields the runtime drawers read: `xd://`
// device enumeration, the `proc://` job snapshot, and the tool instances `drawerSession` inspects.
const fakeSession = (tools: Readonly<Record<string, FakeTool>>): FakeSession => {
	const toolSession = fakeToolSession();
	return {
		settings: {},
		sessionManager: { getSessionId: () => "runtime-drawer-test-session" },
		asyncJobManager: { getRunningJobs: () => [] },
		sessionId: "runtime-drawer-test-session",
		skills: [],
		getAgentId: () => SESSION_ID,
		getImageAttachments: () => [],
		getMountedXdevToolNames: () => Object.keys(tools),
		getActiveToolNames: () => [],
		getToolByName: (name: string) => (name === "read" ? { session: toolSession } : tools[name]),
		getAsyncJobSnapshot: () => ({ running: [{ id: "job-1", status: "running", label: "bun run build" }], recent: [] }),
	} as unknown as FakeSession;
};

// Register a live session for the duration of `run`, then release it so no other file sees it.
const withLiveSession = async (
	tools: Readonly<Record<string, FakeTool>>,
	run: (ctx: ExtensionContext) => Promise<void>,
): Promise<void> => {
	const registry = AgentRegistry.global();
	registry.register({ id: SESSION_ID, displayName: SESSION_ID, kind: "main", session: fakeSession(tools), status: "running" });
	try {
		await run(sessionlessCtx(SESSION_ID));
	} finally {
		registry.unregister(SESSION_ID);
	}
};

const xdTools: Record<string, FakeTool> = {
	fake_read: { summary: "Read a file.", docTopics: () => ({ overview: "Reads a file.", examples: "read x" }) },
	fake_bash: { description: "Run a shell command." },
};

test("runtime drawer only answers its own schemes", async () => {
	expect(runtimeDrawer.schemes).toEqual(["proc", "agent", "history", "xd", "cfg"]);
	const ctx = sessionlessCtx("runtime-drawer-unregistered");
	for (const uri of ["vault://", "nope://thing"]) {
		const page = await runtimeDrawer.load(uri, ctx, request);
		expect(page.uri).toBe(uri);
		expect(page.status.startsWith("Unsupported scheme")).toBe(true);
	}
});

test("session-bound schemes report the missing-session state and dispatch nothing", async () => {
	const ctx = sessionlessCtx("runtime-drawer-unregistered");
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		["proc://", "proc://", "No live session for proc://."],
		["proc://job-1/kill", "proc://", "No live session for proc://."],
		["proc://svc/mode", "proc://", "No live session for proc://."],
		["xd://", "xd://", "No live session for xd://."],
		["xd://resolve", "xd://", "No live session for xd://."],
		["cfg://", "cfg://", "No live session for cfg://."],
	];
	for (const [uri, parent, status] of cases) {
		const page = await runtimeDrawer.load(uri, ctx, request);
		expect(page.status).toBe(status);
		expect(page.parent).toBe(parent);
		expect(page.entries).toEqual([]);
		expect(page.sections).toEqual([]);
	}
});

test("router-backed schemes browse, inspect, and turn a bad id into an error page", async () => {
	const ctx = sessionlessCtx("runtime-drawer-unregistered");
	const history = await runtimeDrawer.load("history://", ctx, request);
	expect(history.uri).toBe("history://");
	expect(history.entries.length).toBeLessThanOrEqual(200);
	for (const entry of history.entries) {
		expect(entry.uri.startsWith("history://")).toBe(true);
		expect(entry.kind === "collection" || entry.kind === "resource").toBe(true);
	}
	// When this host has transcripts, the first browse row must inspect into bounded sections.
	const first = history.entries[0];
	if (first) {
		const inspect = await runtimeDrawer.load(first.uri, ctx, request);
		expect(inspect.uri).toBe(first.uri);
		expect(inspect.sections.length).toBeGreaterThan(0);
		const lines = inspect.sections.flatMap(section => section.lines);
		expect(lines.length).toBeLessThanOrEqual(241);
		expect(lines.every(line => line.length <= 241)).toBe(true);
	}
	const missing = await runtimeDrawer.load("history://zzz-no-such-agent-zzz", ctx, request);
	expect(missing.status.startsWith("Error:")).toBe(true);
	expect(missing.sections[0]?.title).toBe("Error");

	const agents = await runtimeDrawer.load("agent://", ctx, request);
	expect(agents.uri).toBe("agent://");
	expect(agents.entries.length).toBeLessThanOrEqual(200);
});

test.skipIf(isSettingsInitialized())("the live session is recovered from a real tool instance", async () => {
	await withLiveSession(xdTools, async ctx => {
		const session = drawerSession(ctx);
		expect(session?.cwd).toBe(process.cwd());
		expect(typeof session?.getSessionFile).toBe("function");
		expect(typeof session?.getSessionSpawns).toBe("function");
		expect(session?.getSessionId?.()).toBe("runtime-drawer-test-session");
	});
});

test.skipIf(isSettingsInitialized())("live-session schemes render state from the registered session", async () => {
	await withLiveSession(xdTools, async ctx => {
		const xd: DrawerPage = await runtimeDrawer.load("xd://", ctx, request);
		const xdUris = xd.entries.map(entry => entry.uri);
		expect(xdUris).toContain("xd://fake_read");
		expect(xdUris).toContain("xd://fake_bash");
		expect(xdUris).toContain("xd://resolve");
		expect(xdUris).toContain("xd://reject");
		expect(xdUris).toContain("xd://propose");
		expect(xdUris).toContain("xd://report_issue");
		expect(xd.entries.find(entry => entry.uri === "xd://fake_read")?.kind).toBe("collection");
		expect(xd.entries.find(entry => entry.uri === "xd://fake_bash")?.kind).toBe("resource");

		const topics = await runtimeDrawer.load("xd://fake_read", ctx, request);
		expect(topics.entries.map(entry => entry.uri)).toEqual(["xd://fake_read/overview", "xd://fake_read/examples"]);

		const proc = await runtimeDrawer.load("proc://", ctx, request);
		expect(proc.entries.map(entry => entry.uri)).toContain("proc://job-1");
		expect(proc.refreshMs).toBe(3000);

		// A writable proc:// form must describe the action, never run it.
		const write = await runtimeDrawer.load("proc://job-1/kill", ctx, request);
		expect(write.status.startsWith("Writable form")).toBe(true);
		expect(write.sections[0]?.title).toBe("Available actions");
	});
});
