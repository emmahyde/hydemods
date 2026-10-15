import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { McpResourceRow } from "../lib/drawer-host";
import {
	createRemoteDrawer,
	parseDirectoryEntries,
	parseIssuePrEntries,
	parsePrDiffEntries,
	parseSecurityFindingEntries,
	parseSecurityScanEntries,
	parseSshHostEntries,
	remoteDrawer,
	type ConflictBlockView,
	type ConflictSource,
	type DrawerResourceReader,
} from "../lib/drawer-remote";

// A host-shaped context with no live session: the injected reader/source ignores it beyond identity.
const ctx = (agentId = "RemoteDrawerTest", sessionId = "remote-drawer-test"): ExtensionContext =>
	({
		cwd: process.cwd(),
		agent: { id: agentId },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => sessionId },
	}) as unknown as ExtensionContext;

const signal = new AbortController().signal;
const request = (fetch: boolean) => ({ signal, fetch });

const ISSUE_LIST = [
	"# Issues in owner/repo (open, up to 30)",
	"",
	"- [open] #12  @alice  2024-01-02T03:04:05Z",
	"    Fix the widget  labels: bug, p1",
	"    issue://owner/repo/12",
	"",
	"- [closed] #7  @bob  2024-01-01T00:00:00Z",
	"    Old thing",
	"    issue://owner/repo/7",
].join("\n");

const PR_DIFF_LIST = [
	"# Pull Request Diff: owner/repo#5 (2 files)",
	"",
	"1. src/a.ts  +3 -1  [modified]",
	"   pr://owner/repo/5/diff/1",
	"",
	"2. old/b.ts  +0 -0  [renamed]  (renamed from old/a.ts)",
	"   pr://owner/repo/5/diff/2",
].join("\n");

test("the remote drawer owns the six remote/local-registry schemes", () => {
	expect([...remoteDrawer.schemes].sort()).toEqual(["conflict", "issue", "mcp", "pr", "security", "ssh"]);
});

test("issue/pr lists parse into entries keyed by the host URL, with state, author, labels", () => {
	const entries = parseIssuePrEntries(ISSUE_LIST);
	expect(entries.map(e => e.uri)).toEqual(["issue://owner/repo/12", "issue://owner/repo/7"]);
	expect(entries[0].label).toBe("#12 Fix the widget");
	expect(entries[0].description).toContain("@alice");
	expect(entries[0].description).toContain("labels: bug, p1");
	expect(entries[1].label).toBe("#7 Old thing");
});

test("pr diff listings parse path, stats, change type, and rename detail", () => {
	const entries = parsePrDiffEntries(PR_DIFF_LIST);
	expect(entries).toHaveLength(2);
	expect(entries[0]).toMatchObject({ uri: "pr://owner/repo/5/diff/1", label: "src/a.ts", kind: "resource" });
	expect(entries[0].description).toBe("+3 -1 · modified");
	expect(entries[1].label).toBe("old/b.ts");
	expect(entries[1].description).toBe("+0 -0 · renamed · renamed from old/a.ts");
});

test("ssh host index and directory listings parse into navigable children", () => {
	const hosts = parseSshHostEntries(
		["# SSH hosts", "", "- [prod](ssh://prod/) — `deploy@10.0.0.1:2222` (web)", "- [dev](ssh://dev/)"].join("\n"),
	);
	expect(hosts.map(h => h.uri)).toEqual(["ssh://prod/", "ssh://dev/"]);
	expect(hosts[0].description).toBe("deploy@10.0.0.1:2222 (web)");
	expect(hosts[1].description).toBeUndefined();

	const dir = parseDirectoryEntries(["sub/", "file.txt", "(empty directory)"].join("\n"), "ssh://host/a/");
	expect(dir.map(e => e.uri)).toEqual(["ssh://host/a/sub/", "ssh://host/a/file.txt"]);
	expect(dir[0].kind).toBe("collection");
});

test("security scan and finding listings parse into entries", () => {
	const scans = parseSecurityScanEntries("# Security scans\n\n- `scan-1` — complete; 3 finding(s); semgrep; 2024-01-01\n");
	expect(scans).toHaveLength(1);
	expect(scans[0].uri).toBe("security://scans/scan-1");
	expect(scans[0].description).toBe("complete; 3 finding(s); semgrep; 2024-01-01");

	const findings = parseSecurityFindingEntries("- `f1` **high** — SQL injection (`sql-injection`)\n", "scan-1");
	expect(findings[0]).toMatchObject({
		uri: "security://scans/scan-1/findings/f1",
		label: "SQL injection",
		description: "high · sql-injection",
	});
});

test("remote schemes never read without an explicit fetch and expose needsFetch", async () => {
	const calls: string[] = [];
	const reader: DrawerResourceReader = async uri => {
		calls.push(uri);
		return { content: ISSUE_LIST };
	};
	const drawer = createRemoteDrawer(reader);
	const page = await drawer.load("issue://owner/repo", ctx(), request(false));
	expect(calls).toEqual([]);
	expect(page.needsFetch).toBe(true);
	expect(page.entries).toEqual([]);
	expect(page.sections.some(s => s.title === "Fetch needed")).toBe(true);
});

test("a fetch reads once and the next non-fetch load serves the cache", async () => {
	const calls: string[] = [];
	const reader: DrawerResourceReader = async uri => {
		calls.push(uri);
		return { content: ISSUE_LIST, contentType: "text/markdown" };
	};
	const drawer = createRemoteDrawer(reader);
	const fetched = await drawer.load("issue://owner/repo", ctx(), request(true));
	expect(calls).toEqual(["issue://owner/repo"]);
	expect(fetched.needsFetch).toBe(false);
	expect(fetched.entries.map(e => e.uri)).toEqual(["issue://owner/repo/12", "issue://owner/repo/7"]);

	const cached = await drawer.load("issue://owner/repo", ctx(), request(false));
	expect(calls).toHaveLength(1);
	expect(cached.needsFetch).toBe(true);
	expect(cached.status).toContain("Cached");
	expect(cached.entries).toHaveLength(2);
});

test("a single PR offers diff navigation before any fetch", async () => {
	const drawer = createRemoteDrawer(async () => ({ content: "" }));
	const page = await drawer.load("pr://owner/repo/5", ctx(), request(false));
	expect(page.entries.some(e => e.uri === "pr://owner/repo/5/diff" && e.kind === "collection")).toBe(true);
	expect(page.parent).toBe("pr://owner/repo");
});

test("a PR diff slice offers previous, next, and the diff list", async () => {
	const drawer = createRemoteDrawer(async () => ({ content: "diff --git a/x b/x" }));
	const page = await drawer.load("pr://owner/repo/5/diff/2", ctx(), request(true));
	expect(page.entries.map(e => e.uri)).toEqual([
		"pr://owner/repo/5/diff",
		"pr://owner/repo/5/diff/1",
		"pr://owner/repo/5/diff/3",
	]);
	expect(page.sections.some(s => s.title.includes("File 2"))).toBe(true);
});

test("an ssh directory resolves through isDirectory and lists children", async () => {
	const reader: DrawerResourceReader = async () => ({ content: "sub/\nfile.txt", isDirectory: true });
	const drawer = createRemoteDrawer(reader);
	const page = await drawer.load("ssh://host/a/b", ctx(), request(true));
	expect(page.entries.map(e => e.uri)).toEqual([
		"ssh://host/a/b/sub/",
		"ssh://host/a/b/file.txt",
		"ssh://host/a/",
	]);
	expect(page.parent).toBe("ssh://host/a/");
});

test("an ssh file renders its content as a section, not children", async () => {
	const drawer = createRemoteDrawer(async () => ({ content: "127.0.0.1 localhost" }));
	const page = await drawer.load("ssh://host/etc/hosts", ctx(), request(true));
	expect(page.entries).toEqual([{ uri: "ssh://host/etc/", label: "Parent directory", kind: "collection" }]);
	expect(page.sections.some(s => s.lines.includes("127.0.0.1 localhost"))).toBe(true);
});

test("mcp:// lists live resources from the injected enumerator with no URL read", async () => {
	const calls: string[] = [];
	const rows: McpResourceRow[] = [
		{ server: "notes", uri: "test://notes", name: "Notes", isTemplate: false },
		{ server: "notes", uri: "test://{id}", isTemplate: true },
	];
	const drawer = createRemoteDrawer(
		async uri => {
			calls.push(uri);
			return { content: "" };
		},
		async () => rows,
	);
	const page = await drawer.load("mcp://", ctx(), request(false));
	expect(calls).toEqual([]);
	expect(page.entries.map(e => e.uri)).toEqual(["mcp://test://notes", "mcp://test://{id}"]);
	expect(page.entries[0].label).toBe("Notes");
	expect(page.entries[1].description).toContain("template");
	expect(page.status).toBe("2 resource(s)");
});

test("security:// reads the local store even without fetch and parses scans", async () => {
	const calls: string[] = [];
	const reader: DrawerResourceReader = async uri => {
		calls.push(uri);
		if (uri === "security://scans") return { content: "- `scan-1` — complete; 3 finding(s); semgrep; 2024-01-01" };
		return { content: "" };
	};
	const drawer = createRemoteDrawer(reader);
	const page = await drawer.load("security://scans", ctx(), request(false));
	expect(calls).toEqual(["security://scans"]);
	expect(page.entries[0].uri).toBe("security://scans/scan-1");
	expect(page.needsFetch).toBeUndefined();
});

const conflictBlock = (id: number, hasBase = false): ConflictBlockView => ({
	id,
	absolutePath: `/work/f${id}.ts`,
	displayPath: `src/f${id}.ts`,
	startLine: 10,
	endLine: 20,
	hasBase,
});

test("conflict:// enumerates the session's live registry, not a stub", async () => {
	const conflicts: ConflictSource = {
		list: () => [conflictBlock(1), conflictBlock(2, true)],
		read: async () => ({ content: "" }),
	};
	const drawer = createRemoteDrawer(async () => ({ content: "" }), undefined, conflicts);
	const page = await drawer.load("conflict://", ctx(), request(false));
	expect(page.entries.map(e => e.uri)).toEqual(["conflict://1", "conflict://2"]);
	expect(page.entries[0].label).toBe("src/f1.ts:10-20");
	expect(page.status).toBe("2 registered");
});

test("conflict:// root with an empty registry explains how blocks register", async () => {
	const conflicts: ConflictSource = { list: () => [], read: async () => ({ content: "" }) };
	const drawer = createRemoteDrawer(async () => ({ content: "" }), undefined, conflicts);
	const page = await drawer.load("conflict://", ctx(), request(false));
	expect(page.entries).toEqual([]);
	expect(page.status).toBe("0 registered");
	expect(page.sections.some(s => s.lines.join(" ").includes("registered in this session"))).toBe(true);
});

test("conflict://<N> reads the live block and offers its sides", async () => {
	const calls: string[] = [];
	const conflicts: ConflictSource = {
		list: () => [conflictBlock(3, true)],
		read: async uri => {
			calls.push(uri);
			return { content: "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs" };
		},
	};
	const drawer = createRemoteDrawer(async () => ({ content: "" }), undefined, conflicts);
	const page = await drawer.load("conflict://3", ctx(), request(false));
	expect(calls).toEqual(["conflict://3"]);
	expect(page.entries.map(e => e.uri)).toEqual([
		"conflict://3/ours",
		"conflict://3/theirs",
		"conflict://3/base",
		"conflict://",
	]);
	expect(page.sections.some(s => s.lines.some(l => l.includes("<<<<<<<")))).toBe(true);
});

test("a two-way block omits the base side", async () => {
	const conflicts: ConflictSource = { list: () => [conflictBlock(1)], read: async () => ({ content: "" }) };
	const drawer = createRemoteDrawer(async () => ({ content: "" }), undefined, conflicts);
	const page = await drawer.load("conflict://1", ctx(), request(false));
	expect(page.entries.map(e => e.uri)).toEqual(["conflict://1/ours", "conflict://1/theirs", "conflict://"]);
});

test("the fetch cache is scoped to the session, never shared across agents", async () => {
	const calls: string[] = [];
	const reader: DrawerResourceReader = async uri => {
		calls.push(uri);
		return { content: ISSUE_LIST };
	};
	const drawer = createRemoteDrawer(reader);
	await drawer.load("issue://owner/repo", ctx("AgentA", "session-a"), request(true));
	expect(calls).toHaveLength(1);

	// A different session must not see AgentA's fetched bytes: no read, and Fetch is still required.
	const other = await drawer.load("issue://owner/repo", ctx("AgentB", "session-b"), request(false));
	expect(calls).toHaveLength(1);
	expect(other.needsFetch).toBe(true);
	expect(other.entries).toEqual([]);

	// The originating session still serves its own cache.
	const same = await drawer.load("issue://owner/repo", ctx("AgentA", "session-a"), request(false));
	expect(same.status).toContain("Cached");
	expect(same.entries).toHaveLength(2);
});

test("a fetch failure becomes an error section, never a thrown adapter", async () => {
	const drawer = createRemoteDrawer(async () => {
		throw new Error("gh: not authenticated");
	});
	const page = await drawer.load("issue://owner/repo", ctx(), request(true));
	expect(page.status).toContain("Fetch failed");
	expect(page.sections.some(s => s.lines.some(l => l.includes("gh: not authenticated")))).toBe(true);
});

test("an unsupported scheme yields a status page, never a thrown error", async () => {
	const drawer = createRemoteDrawer(async () => ({ content: "" }));
	const page = await drawer.load("vault://notes/x.md", ctx(), request(false));
	expect(page.entries).toEqual([]);
	expect(page.status).toBe("Unsupported");
});
