import { expect, test } from "bun:test";
import {
	procCompletions,
	withProcDrawer,
	withXdDrawer,
	xdCompletions,
	type ProcEntry,
	type ProcSources,
	type XdDevice,
	type XdSources,
} from "../lib/xd-proc-drawers";
import type { CompletionResult, EditorProvider } from "../lib/url-drawers";

// Shaped like the host's mounted device: name, description, and whether docTopics() exists.
const device = (name: string, description = ""): XdDevice => ({ name, description, hasTopics: false });

// Shaped like one host `proc://` id: an async job, a running subagent, or a project service.
const entry = (over: Partial<ProcEntry> & { id: string }): ProcEntry => ({
	kind: "job",
	status: "running",
	label: "bun run build",
	...over,
});

const xdSources = (devices: readonly XdDevice[], topics: Readonly<Record<string, string[]>> = {}): XdSources => ({
	devices: () => devices,
	topics: name => topics[name] ?? [],
});

const procSources = (entries: readonly ProcEntry[]): ProcSources => ({ entries: () => entries });

const values = (result: CompletionResult) => result?.items.map(item => item.value);

test("xd drawer lists mounted devices and filters on a partial name", () => {
	const devices = [
		device("read", "Read a file."),
		device("read_outline", "Outline a file."),
		device("mcp__linear_get_issue", "Fetch a Linear issue. Second sentence."),
		device("bash", "Run a shell command."),
	];

	// No query lists every mounted device in mount order.
	expect(values(xdCompletions("xd://", xdSources(devices)))).toEqual([
		"xd://read",
		"xd://read_outline",
		"xd://mcp__linear_get_issue",
		"xd://bash",
	]);
	expect(xdCompletions("xd://", xdSources(devices))?.items[0]?.description).toBe("Read a file.");

	// Prefix matches outrank substring matches; ties keep mount order. No match is exact, so each
	// value keeps the cursor on the URL for a second Tab.
	expect(values(xdCompletions("xd://re", xdSources([device("xread"), device("read_outline"), device("read")])))).toEqual([
		"xd://read_outline",
		"xd://read",
		"xd://xread",
	]);
	expect(values(xdCompletions("xd://linear_get", xdSources(devices)))).toEqual(["xd://mcp__linear_get_issue"]);
	expect(xdCompletions("xd://nope", xdSources(devices))).toBeNull();
});

test("an exact device name ends the token, and a device with topics drills into them", () => {
	const devices = [device("read"), { ...device("eval"), hasTopics: true }];

	// Exact name, no topics: the URL is complete, so accepting it ends the token.
	expect(values(xdCompletions("xd://read", xdSources(devices)))).toEqual(["xd://read "]);

	// Exact name with topics: accepting switches to the topic level instead of re-selecting the name.
	const topics = { eval: ["jsdoc", "metal"] };
	const exact = xdCompletions("xd://eval", xdSources(devices, topics));
	expect(values(exact)).toEqual(["xd://eval/jsdoc ", "xd://eval/metal "]);
	expect(exact?.items[0]?.description).toBe("eval");

	// `xd://<device>/<partial>` filters topics; an unknown device or a deeper path yields nothing.
	expect(values(xdCompletions("xd://eval/", xdSources(devices, topics)))).toEqual(["xd://eval/jsdoc ", "xd://eval/metal "]);
	expect(values(xdCompletions("xd://eval/me", xdSources(devices, topics)))).toEqual(["xd://eval/metal "]);
	expect(xdCompletions("xd://eval/nope", xdSources(devices, topics))).toBeNull();
	expect(xdCompletions("xd://ghost/", xdSources(devices, topics))).toBeNull();
	expect(xdCompletions("xd://eval/jsdoc/more", xdSources(devices, topics))).toBeNull();
});

test("proc drawer lists jobs, agents, and services with a kind-tagged summary", () => {
	const entries = [
		entry({ id: "build-42", status: "running", label: "bun run build" }),
		entry({ id: "0-Explore", kind: "agent", status: "running", label: "Reading the router" }),
		entry({ id: "web", kind: "service", status: "ready", label: "pid 8123" }),
	];

	const all = procCompletions("proc://", entries);
	expect(values(all)).toEqual(["proc://build-42", "proc://0-Explore", "proc://web"]);
	expect(all?.items[0]?.description).toBe("[job] running — bun run build");
	expect(all?.items[1]?.description).toBe("[agent] running — Reading the router");
	expect(all?.items[2]?.description).toBe("[service] ready — pid 8123");

	// Prefix matches outrank substring matches; an unknown id yields nothing.
	expect(values(procCompletions("proc://b", entries))).toEqual(["proc://build-42", "proc://web"]);
	expect(procCompletions("proc://ghost", entries)).toBeNull();
});

test("an exact proc id offers its writable parts instead of re-selecting itself", () => {
	const entries = [entry({ id: "build-42" }), entry({ id: "web", kind: "service" })];

	// Jobs and agents expose `/kill`; services also expose `/mode`. Every value is terminal.
	expect(values(procCompletions("proc://build-42", entries))).toEqual(["proc://build-42/kill "]);
	expect(values(procCompletions("proc://web", entries))).toEqual(["proc://web/kill ", "proc://web/mode "]);

	// A trailing slash or a partial action drifts into the same list.
	expect(values(procCompletions("proc://web/", entries))).toEqual(["proc://web/kill ", "proc://web/mode "]);
	expect(values(procCompletions("proc://web/m", entries))).toEqual(["proc://web/mode "]);

	// A complete action URL completes (adding the terminal space); an unknown id has nothing to offer.
	expect(values(procCompletions("proc://web/kill", entries))).toEqual(["proc://web/kill "]);
	expect(procCompletions("proc://ghost/kill", entries)).toBeNull();
});

const inner = (): EditorProvider & { calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		async getSuggestions() {
			calls.push("getSuggestions");
			return null;
		},
		applyCompletion(lines) {
			calls.push("applyCompletion");
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
	};
};

test("a disabled drawer defers, and unrelated text is never intercepted", async () => {
	const disabledTarget = inner();
	const disabled = withXdDrawer(disabledTarget, () => false, xdSources([device("read")]));
	expect(await disabled.getSuggestions(["xd://"], 0, 5)).toBeNull();
	expect(disabledTarget.calls).toEqual(["getSuggestions"]);

	const enabledTarget = inner();
	const enabled = withXdDrawer(enabledTarget, () => true, xdSources([device("read")]));
	expect(await enabled.getSuggestions(["hello world"], 0, 11)).toBeNull();
	expect(enabledTarget.calls).toEqual(["getSuggestions"]);

	const suggestions = await enabled.getSuggestions(["xd://re"], 0, 7);
	expect(values(suggestions)).toEqual(["xd://read"]);
});

test("the proc drawer awaits an async source", async () => {
	const sources: ProcSources = { entries: async () => [entry({ id: "build-42" })] };
	const drawer = withProcDrawer(inner(), () => true, sources);
	expect(values(await drawer.getSuggestions(["proc://"], 0, 7))).toEqual(["proc://build-42"]);
});

test("accepting a terminal item replaces the token and parks the cursor after it", async () => {
	const drawer = withProcDrawer(inner(), () => true, procSources([entry({ id: "build-42" })]));
	const suggestions = await drawer.getSuggestions(["proc://build-42"], 0, 15);
	const item = suggestions?.items[0];
	if (!item) throw new Error("expected a kill item");
	const applied = drawer.applyCompletion(["proc://build-42"], 0, 15, item, suggestions?.prefix ?? "");
	expect(applied.lines).toEqual(["proc://build-42/kill "]);
	expect(applied.cursorCol).toBe(21);
});

test("a device item keeps the cursor so the next Tab can drill in", async () => {
	const drawer = withXdDrawer(inner(), () => true, xdSources([device("read_outline")]));
	const suggestions = await drawer.getSuggestions(["xd://re"], 0, 7);
	const item = suggestions?.items[0];
	if (!item) throw new Error("expected a device item");
	const applied = drawer.applyCompletion(["xd://re"], 0, 7, item, suggestions?.prefix ?? "");
	expect(applied.lines).toEqual(["xd://read_outline"]);
	expect(applied.cursorCol).toBe(17);
});

test("an item from another provider is delegated to the wrapped completion", () => {
	const target = inner();
	const drawer = withXdDrawer(target, () => true, xdSources([device("read")]));
	drawer.applyCompletion(["vault://Notes"], 0, 13, { value: "vault://Notes/a.md", label: "a.md" }, "vault://Notes");
	expect(target.calls).toEqual(["applyCompletion"]);
});

test("withXdDrawer and withProcDrawer invoke onApplied callback on completion", () => {
	let appliedXd: string | undefined;
	let appliedProc: string | undefined;
	const xd = withXdDrawer(inner(), () => true, xdSources([device("read")]), item => { appliedXd = item.value; });
	const proc = withProcDrawer(inner(), () => true, procSources([entry({ id: "build-1" })]), item => { appliedProc = item.value; });

	const xRes = xd.applyCompletion(["xd://re"], 0, 7, { value: "xd://read", label: "read" }, "xd://re");
	xRes.onApplied?.();
	expect(appliedXd).toBe("xd://read");

	const pRes = proc.applyCompletion(["proc://bu"], 0, 9, { value: "proc://build-1", label: "build-1" }, "proc://bu");
	pRes.onApplied?.();
	expect(appliedProc).toBe("proc://build-1");
});
