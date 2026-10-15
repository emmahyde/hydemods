import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DrawerPage } from "../lib/drawer-types";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	fetchProcPreview,
	fetchPrPreview,
	fetchVaultPreview,
	fetchXdPreview,
	formatUrlPreviewLines,
	isContainedWithin,
	parsePreviewUrl,
	summarizeUrlContent,
	UrlPreviewLifecycle,
	type UrlPreviewState,
} from "../lib/url-previews";
describe("url-previews", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "url-previews-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("parsePreviewUrl identifies valid schemes and rejects non-schemes", () => {
		expect(parsePreviewUrl("vault://notes/test")).toEqual({ url: "vault://notes/test", scheme: "vault" });
		expect(parsePreviewUrl("pr://owner/repo/123")).toEqual({ url: "pr://owner/repo/123", scheme: "pr" });
		expect(parsePreviewUrl("xd://read")).toEqual({ url: "xd://read", scheme: "xd" });
		expect(parsePreviewUrl("proc://job-1/kill")).toEqual({ url: "proc://job-1/kill", scheme: "proc" });
		expect(parsePreviewUrl("https://example.com")).toBeNull();
		expect(parsePreviewUrl("file:///tmp")).toBeNull();
		expect(parsePreviewUrl("plain text")).toBeNull();
	});

	test("isContainedWithin verifies realpath containment and blocks escapes", async () => {
		const root = path.join(tmpDir, "vault");
		const nested = path.join(root, "nested");
		const outside = path.join(tmpDir, "outside");
		await fs.mkdir(nested, { recursive: true });
		await fs.mkdir(outside, { recursive: true });

		expect(await isContainedWithin(nested, root)).toBe(true);
		expect(await isContainedWithin(root, root)).toBe(true);
		expect(await isContainedWithin(outside, root)).toBe(false);

		// Symlink escape
		const link = path.join(root, "link-out");
		await fs.symlink(outside, link);
		expect(await isContainedWithin(link, root)).toBe(false);
	});

	test("fetchVaultPreview returns vault listing and file excerpt safely", async () => {
		const vaultRoot = path.join(tmpDir, "my-vault");
		await fs.mkdir(path.join(vaultRoot, "subfolder"), { recursive: true });
		await fs.writeFile(path.join(vaultRoot, "note.md"), "# Title\n\nSome note content");
		await fs.writeFile(path.join(vaultRoot, "data.db"), "binary SQLite mock");

		const roots = new Map([["my-vault", vaultRoot]]);

		// Root preview
		const rootPreview = await fetchVaultPreview("vault://my-vault/", roots);
		expect(rootPreview.error).toBeUndefined();
		expect(rootPreview.title).toContain("my-vault");
		expect(rootPreview.rows).toBeDefined();
		expect(rootPreview.rows?.some(r => r.includes("subfolder"))).toBe(true);
		expect(rootPreview.rows?.some(r => r.includes("note.md"))).toBe(true);

		// Note file preview with text excerpt
		const notePreview = await fetchVaultPreview("vault://my-vault/note.md", roots);
		expect(notePreview.error).toBeUndefined();
		expect(notePreview.title).toBe("note.md");
		expect(notePreview.badges?.some(b => b.includes("Markdown Note"))).toBe(true);
		expect(notePreview.rows?.some(r => r.includes("# Title"))).toBe(true);

		// Binary DB file preview omits body reads
		const dbPreview = await fetchVaultPreview("vault://my-vault/data.db", roots);
		expect(dbPreview.error).toBeUndefined();
		expect(dbPreview.footer).toContain("Binary/database file");
		expect(dbPreview.rows).toBeUndefined();

		// Non-existent path returns error without throwing
		const missingPreview = await fetchVaultPreview("vault://my-vault/missing.md", roots);
		expect(missingPreview.error).toContain("Resource does not exist");

		// Path escaping vault root returns error
		const escapePreview = await fetchVaultPreview("vault://my-vault/../../etc/passwd", roots);
		expect(escapePreview.error).toContain("outside vault root");
	});

	test("fetchPrPreview formats cached PR status and checks", () => {
		const prs = [
			{
				number: 42,
				title: "Add preview drawer",
				repo: "acme/repo",
				isDraft: false,
				ci: "pass",
				unresolvedThreads: 0,
				mergeable: "clean",
				approved: true,
			},
		];

		const preview = fetchPrPreview("pr://acme/repo/42", prs);
		expect(preview.error).toBeUndefined();
		expect(preview.title).toContain("#42: Add preview drawer");
		expect(preview.badges?.some(b => b.includes("CI passed"))).toBe(true);
		expect(preview.badges?.some(b => b.includes("0 threads"))).toBe(true);
		expect(preview.badges?.some(b => b.includes("mergeable"))).toBe(true);
		expect(preview.badges?.some(b => b.includes("approved"))).toBe(true);

		// Missing PR returns clean error
		const missing = fetchPrPreview("pr://acme/repo/999", prs);
		expect(missing.error).toContain("not found in cached viewer");
	});

	test("fetchXdPreview resolves devices and doc topics safely without tool execution", () => {
		const devices = [
			{ name: "read", description: "Read file or resource", hasTopics: false },
			{ name: "git", description: "Git commands", hasTopics: true },
		];
		const topics = (name: string) => (name === "git" ? ["status", "diff"] : []);

		// Device listing preview
		const listPreview = fetchXdPreview("xd://", devices, topics);
		expect(listPreview.error).toBeUndefined();
		expect(listPreview.badges?.some(b => b.includes("addressable tools"))).toBe(true);

		// Single device preview
		const devPreview = fetchXdPreview("xd://git", devices, topics);
		expect(devPreview.error).toBeUndefined();
		expect(devPreview.title).toBe("xd://git");
		expect(devPreview.rows?.some(r => r.includes("Git commands"))).toBe(true);
		expect(devPreview.rows?.some(r => r.includes("status, diff"))).toBe(true);

		// Topic preview
		const topicPreview = fetchXdPreview("xd://git/status", devices, topics);
		expect(topicPreview.error).toBeUndefined();
		expect(topicPreview.title).toBe("git/status");

		// Missing tool returns error
		const missingPreview = fetchXdPreview("xd://unknown", devices, topics);
		expect(missingPreview.error).toContain("not mounted or active");
	});

	test("fetchProcPreview resolves session processes and actions", () => {
		const entries = [
			{ id: "ci-watcher", kind: "job" as const, status: "running", label: "watch CI build" },
			{ id: "agent-1", kind: "agent" as const, status: "idle", label: "code reviewer" },
		];

		// Overview preview
		const overview = fetchProcPreview("proc://", entries);
		expect(overview.error).toBeUndefined();
		expect(overview.badges?.some(b => b.includes("1 jobs"))).toBe(true);

		// Process entry preview
		const jobPreview = fetchProcPreview("proc://ci-watcher", entries);
		expect(jobPreview.error).toBeUndefined();
		expect(jobPreview.title).toBe("proc://ci-watcher");
		expect(jobPreview.badges?.some(b => b.includes("running"))).toBe(true);
		expect(jobPreview.rows?.some(r => r.includes("watch CI build"))).toBe(true);

		// Process action preview
		const killPreview = fetchProcPreview("proc://ci-watcher/kill", entries);
		expect(killPreview.error).toBeUndefined();
		expect(killPreview.title).toBe("proc://ci-watcher/kill");
		expect(killPreview.rows?.some(r => r.includes("Cancel or terminate"))).toBe(true);

		// Missing process returns error
		const missing = fetchProcPreview("proc://unknown-id", entries);
		expect(missing.error).toContain("No process, subagent, or service");
	});

	test("formatUrlPreviewLines renders header, badges, rows, and footer cleanly", () => {
		const state: UrlPreviewState = {
			url: "vault://notes/test.md",
			scheme: "vault",
			title: "test.md",
			kind: "vault",
			loading: false,
			header: "Vault: notes",
			badges: ["1.2 KiB", "Markdown Note"],
			rows: ["  # First Line", "  Second Line"],
			footer: "+2 more lines",
		};

		const lines = formatUrlPreviewLines(state);
		expect(lines[0]).toContain("test.md");
		expect(lines[1]).toContain("Vault: notes");
		expect(lines[2]).toContain("1.2 KiB · Markdown Note");
		expect(lines.some(l => l.includes("# First Line"))).toBe(true);
		expect(lines.some(l => l.includes("+2 more lines"))).toBe(true);
	});

	test("UrlPreviewLifecycle mounts widget and dismisses on next terminal input", () => {
		let currentWidget: unknown = undefined;
		let terminalInputHandler: (() => unknown) | undefined;
		const mockUi = {
			setWidget: (key: string, widget: unknown) => {
				if (key === "hydemods:url-preview") currentWidget = widget;
			},
			onTerminalInput: (handler: () => unknown) => {
				terminalInputHandler = handler;
				return () => { terminalInputHandler = undefined; };
			},
		};
		const mockCtx = { hasUI: true, ui: mockUi } as unknown as ExtensionContext;
		const manager = new (require("../lib/url-previews").UrlPreviewLifecycle)([]);

		manager.install(mockCtx);
		expect(terminalInputHandler).toBeDefined();

		// Show preview mounts widget
		manager.showPreview(mockCtx, "vault://notes/test.md", {
			uri: "vault://notes/test.md",
			title: "test.md",
			entries: [],
			sections: [],
			status: "Clean",
		});
		expect(currentWidget).toBeDefined();

		if (terminalInputHandler) {
			terminalInputHandler();
		}
		expect(currentWidget).toBeUndefined();
	});

	test("UrlPreviewLifecycle aborts in-flight fetch and clears widget immediately on terminal input", async () => {
		let currentWidget: unknown = undefined;
		let terminalInputHandler: (() => unknown) | undefined;
		const mockUi = {
			setWidget: (key: string, widget: unknown) => {
				if (key === "hydemods:url-preview") currentWidget = widget;
			},
			onTerminalInput: (handler: () => unknown) => {
				terminalInputHandler = handler;
				return () => { terminalInputHandler = undefined; };
			},
		};
		const mockCtx = { hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const slow = Promise.withResolvers<DrawerPage>();
		let aborted = false;
		const mockAdapter = {
			schemes: ["vault"],
			load: (_uri: string, _ctx: unknown, req: { signal: AbortSignal }) => {
				req.signal.addEventListener("abort", () => { aborted = true; });
				return slow.promise;
			},
		};

		const manager = new (require("../lib/url-previews").UrlPreviewLifecycle)([mockAdapter]);
		manager.install(mockCtx);

		// Start in-flight preview
		manager.showPreview(mockCtx, "vault://slow/path");
		expect(aborted).toBe(false);

		// User types while load is in flight: must immediately abort and reset
		if (terminalInputHandler) {
			terminalInputHandler();
		}
		expect(aborted).toBe(true);
		expect(currentWidget).toBeUndefined();

		// Late resolution must not mount widget
		slow.resolve({ uri: "vault://slow/path", title: "Late", entries: [], sections: [], status: "Done" });
		await Promise.resolve();
		expect(currentWidget).toBeUndefined();
	});

	test("summarizeUrlContent invokes custom summarizer and handles errors safely", async () => {
		const mockCtx = {} as ExtensionContext;

		// Empty content returns empty object without error or model call
		const emptyRes = await summarizeUrlContent(mockCtx, "vault://empty", "   ");
		expect(emptyRes.summary).toBeUndefined();
		expect(emptyRes.error).toBeUndefined();

		// Custom summarizer success path
		const mockSummarizer = async (uri: string, content: string) => ({
			summary: `Breakdown of ${uri}: ${content.slice(0, 10)}`,
			modelId: "test/fast-model",
		});
		const res = await summarizeUrlContent(mockCtx, "vault://test.md", "hello world note", undefined, mockSummarizer);
		expect(res.summary).toBe("Breakdown of vault://test.md: hello worl");
		expect(res.modelId).toBe("test/fast-model");

		// Custom summarizer failure handled gracefully
		const failingSummarizer = async () => {
			throw new Error("Local model worker unavailable");
		};
		const failRes = await summarizeUrlContent(mockCtx, "vault://test.md", "content", undefined, failingSummarizer);
		expect(failRes.error).toBe("Local model worker unavailable");
		expect(failRes.summary).toBeUndefined();
	});
	test("summarizeUrlContent filters strictly to local models and rejects remote fallbacks", async () => {
		const remoteRegistry = {
			getAvailable: () => [
				{ provider: "google-antigravity", id: "gemini-3.8-flash:low" },
				{ provider: "anthropic", id: "claude-haiku-4-5" },
			],
			getApiKey: async () => "test-key",
			resolver: () => "test-key",
		};
		const mockRemoteCtx = { modelRegistry: remoteRegistry } as unknown as ExtensionContext;

		// Must skip summarization when no local model exists
		const remoteRes = await summarizeUrlContent(mockRemoteCtx, "vault://sensitive/note.md", "Secret contents");
		expect(remoteRes.summary).toBeUndefined();
		expect(remoteRes.error).toBeUndefined();

		// Mock registry with local/mlx model
		let calledWithModel: unknown = undefined;
		const localRegistry = {
			getAvailable: () => [
				{ provider: "google-antigravity", id: "gemini-3.8-flash:low" },
				{ provider: "mlx", id: "mlx-community/Qwen3-4B-Instruct-2507-4bit-DWQ-2510" },
			],
			getApiKey: async () => undefined,
			resolver: () => undefined,
		};
		const mockLocalCtx = { modelRegistry: localRegistry } as unknown as ExtensionContext;

		// Custom summarizer hook still works when provided
		const customHook = async (uri: string, content: string) => ({
			summary: `Local summary for ${uri}`,
			modelId: "mlx/qwen",
		});
		const localRes = await summarizeUrlContent(mockLocalCtx, "vault://note.md", "Some content", undefined, customHook);
		expect(localRes.summary).toBe("Local summary for vault://note.md");
		expect(localRes.modelId).toBe("mlx/qwen");
	});

	test("UrlPreviewLifecycle displays fast local-model summary in rendered widget", async () => {
		let currentWidgetFactory: ((tui: unknown, theme: { fg: (c: string, s: string) => string }) => { render(w: number): readonly string[] }) | undefined;
		const mockUi = {
			setWidget: (key: string, widget: unknown) => {
				if (key === "hydemods:url-preview") {
					currentWidgetFactory = widget as typeof currentWidgetFactory;
				}
			},
			onTerminalInput: () => () => {},
		};
		const mockCtx = { hasUI: true, ui: mockUi } as unknown as ExtensionContext;

		const summarySettled = Promise.withResolvers<void>();
		const mockSummarizer = async (_uri: string, content: string) => {
			const result = {
				summary: `Fast breakdown: ${content.trim()}`,
				modelId: "local/fast",
			};
			summarySettled.resolve();
			return result;
		};
		const manager = new UrlPreviewLifecycle([], mockSummarizer);
		manager.install(mockCtx);

		manager.showPreview(mockCtx, "vault://notes/summary-test.md", {
			uri: "vault://notes/summary-test.md",
			title: "summary-test.md",
			entries: [],
			sections: [{ title: "Summary", lines: ["Architecture specification details"] }],
			status: "Active",
		});

		const fakeTheme = { fg: (_c: string, s: string) => s };
		// Initially rendered before summary finishes
		expect(currentWidgetFactory).toBeDefined();
		let lines = currentWidgetFactory!(undefined, fakeTheme).render(80);
		expect(lines.some(l => l.includes("summary-test.md"))).toBe(true);

		// Await the summarizer resolution deterministically without real wall-clock delays
		await summarySettled.promise;
		// Flush queued microtasks where render() updates the widget
		await Promise.resolve();

		lines = currentWidgetFactory!(undefined, fakeTheme).render(80);
		expect(lines.some(l => l.includes("Fast breakdown: Architecture specification details"))).toBe(true);
	});
});
