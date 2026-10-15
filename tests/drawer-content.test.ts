import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { boundedLines, contentDrawer } from "../lib/drawer-content";

const schemes = (): readonly string[] => contentDrawer.schemes;
const signal = new AbortController().signal;

// A host-shaped context with no live session: exercises the deterministic fallbacks without
// touching a real project. Only the fields the content adapters read are populated.
const sessionlessCtx = (): ExtensionContext =>
	({
		cwd: process.cwd(),
		agent: { id: "ContentDrawerTest", depth: 0 },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "content-drawer-test" },
	}) as unknown as ExtensionContext;

// A real `local://` root: `<artifactsDir>/local`, pinned through localProtocolOptions so the
// adapter takes its genuine locate -> bounded-read path without a registered session.
const makeLocalRoot = async (): Promise<{ root: string; ctx: ExtensionContext; cleanup: () => Promise<void> }> => {
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "drawer-content-"));
	const root = path.join(artifacts, "local");
	await fs.mkdir(root, { recursive: true });
	const ctx = {
		cwd: root,
		hasUI: false,
		agent: { id: "ContentDrawerLocal", depth: 0 },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "drawer-content-local" },
		localProtocolOptions: { getArtifactsDir: () => artifacts, getSessionId: () => "drawer-content-local" },
	} as unknown as ExtensionContext;
	return { root, ctx, cleanup: async () => fs.rm(artifacts, { recursive: true, force: true }) };
};

test("the content drawer owns the seven content schemes", () => {
	expect([...schemes()].sort()).toEqual(["artifact", "attachment", "local", "memory", "omp", "rule", "skill"]);
});

test("boundedLines caps the excerpt and reports the full line count", () => {
	const twenty = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const short = boundedLines(twenty);
	expect(short.lines).toHaveLength(20);
	expect(short.total).toBe(20);

	const long = boundedLines(Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n"));
	expect(long.total).toBe(120);
	expect(long.lines.length).toBeLessThanOrEqual(41);
	expect(long.lines[long.lines.length - 1]).toContain("more line(s)");
});

test("a non-content scheme yields a status page, never a thrown error", async () => {
	const page = await contentDrawer.load("vault://notes/x.md", sessionlessCtx(), { signal, fetch: false });
	expect(page.entries).toEqual([]);
	expect(page.status).toContain("Not a content scheme");
});

test("omp:// lists the embedded harness docs without a live session", async () => {
	const page = await contentDrawer.load("omp://", sessionlessCtx(), { signal, fetch: false });
	expect(page.entries.length).toBeGreaterThan(0);
	expect(page.entries.every(entry => entry.uri.startsWith("omp://"))).toBe(true);
});

test("memory:// returns a status page without a file-backed backend", async () => {
	const page = await contentDrawer.load("memory://", sessionlessCtx(), { signal, fetch: false });
	expect(Array.isArray(page.entries)).toBe(true);
	expect(page.status.length).toBeGreaterThan(0);
});

test("local:// browses a real directory and reads a bounded file excerpt", async () => {
	const { root, ctx, cleanup } = await makeLocalRoot();
	try {
		await fs.mkdir(path.join(root, "sub"), { recursive: true });
		await fs.writeFile(path.join(root, "note.txt"), "alpha\nbeta\n");

		const listing = await contentDrawer.load("local://", ctx, { signal, fetch: false });
		expect(listing.entries.map(entry => entry.label).sort()).toEqual(["note.txt", "sub"]);
		expect(listing.entries.find(entry => entry.label === "sub")?.kind).toBe("collection");

		const file = await contentDrawer.load("local://note.txt", ctx, { signal, fetch: false });
		expect(file.sections[0]?.title).toBe("Content");
		expect(file.sections[0]?.lines.join("\n")).toContain("alpha");
		expect(file.sections.some(section => section.title === "Source")).toBe(true);
	} finally {
		await cleanup();
	}
});

test("local:// shows metadata only for binary, database, and NUL-bearing files", async () => {
	const { root, ctx, cleanup } = await makeLocalRoot();
	try {
		await fs.writeFile(path.join(root, "data.db"), "not really a database");
		await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([1, 2, 3]));
		await fs.writeFile(path.join(root, "unknown.dat"), Buffer.from([1, 2, 0, 3, 4]));
		await fs.writeFile(path.join(root, "big.txt"), "a".repeat(20_000));

		const db = await contentDrawer.load("local://data.db", ctx, { signal, fetch: false });
		expect(db.status).toContain("database");
		expect(db.sections.some(section => section.title === "Content")).toBe(false);

		const bin = await contentDrawer.load("local://blob.bin", ctx, { signal, fetch: false });
		expect(bin.status).toContain("binary");

		const nul = await contentDrawer.load("local://unknown.dat", ctx, { signal, fetch: false });
		expect(nul.status).toContain("binary");
		expect(nul.sections.some(section => section.title === "Content")).toBe(false);

		const big = await contentDrawer.load("local://big.txt", ctx, { signal, fetch: false });
		expect(big.status).toContain("first 16 KiB");
	} finally {
		await cleanup();
	}
});

test("local:// caps a large directory listing and labels it partial", async () => {
	const { root, ctx, cleanup } = await makeLocalRoot();
	try {
		await Promise.all(
			Array.from({ length: 105 }, (_, i) => fs.writeFile(path.join(root, `f${String(i).padStart(3, "0")}.txt`), "x")),
		);
		const page = await contentDrawer.load("local://", ctx, { signal, fetch: false });
		expect(page.entries.length).toBe(100);
		expect(page.status).toContain("more not listed");
	} finally {
		await cleanup();
	}
});
