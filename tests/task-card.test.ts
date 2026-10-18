import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { taskCardBody, type ProgressRow, type ResultRow } from "../lib/task-card";

// Each colour gets a distinct SGR code, so width maths sees real escapes and assertions can see the colour.
const CODES: Record<string, number> = { accent: 31, success: 32, warning: 33, error: 34, dim: 35, muted: 36, text: 37, statusLineCost: 38 };
const theme = { fg: (color: string, text: string) => `\x1b[${CODES[color]}m${text}\x1b[0m`, bold: (text: string) => text } as never;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const painted = (color: string, text: string) => `\x1b[${CODES[color]}m${text}\x1b[0m`;
const NOW = 1_000_000;

function live(over: Partial<ProgressRow> & { id: string }): ProgressRow {
	return { status: "running", task: "t", recentTools: [], toolCount: 0, requests: 0, cost: 0, durationMs: 0, ...over };
}

function done(over: Partial<ResultRow> & { id: string }): ResultRow {
	return { task: "t", exitCode: 0, requests: 0, durationMs: 0, ...over };
}

const body = (details: Parameters<typeof taskCardBody>[0], width = 100, expanded = false) => taskCardBody(details, { expanded, width, nowMs: NOW }, theme);

test("expanded view and empty details defer to the native renderer", () => {
	expect(body({ progress: [live({ id: "0-A" })] }, 100, true)).toBeUndefined();
	expect(body(undefined)).toBeUndefined();
	expect(body({ progress: [] })).toBeUndefined();
});

test("review data, yielded data and nested task trees defer to the native renderer", () => {
	expect(body({ progress: [live({ id: "0-A", extractedToolData: { yield: [{}] } })] })).toBeUndefined();
	expect(body({ progress: [live({ id: "0-A", inflightTaskDetails: {} })] })).toBeUndefined();
	expect(body({ results: [done({ id: "0-A", extractedToolData: { task: [{}] } })] })).toBeUndefined();
});

test("a running agent gets one dense row plus a tool-colored activity line", () => {
	const card = body({
		progress: [live({ id: "0-AuthRefactor", description: "split the refresh path", currentTool: "edit", currentToolArgs: "src/a.ts", currentToolStartMs: NOW - 1000, toolCount: 12, requests: 34, cost: 0.18 })],
	})!;
	const rows = card.lines.map(plain);
	expect(rows[0]).toContain("◐ 1 running");
	expect(rows[1]).toContain("AuthRefactor");
	expect(rows[1]).toContain("split the refresh path");
	expect(rows[1]).toMatch(/12 ⚙ · 34 req · \$0\.18$/);
	expect(rows[2]).toBe(`  └ edit "src/a.ts"`);
	expect(card.lines[2]).toContain(painted("warning", `edit "src/a.ts"`));
	expect(card.failed).toBe(false);
});

test("a tool call past six minutes reads as stalled, past five seconds shows its elapsed time", () => {
	const slow = body({ progress: [live({ id: "0-A", currentTool: "bash", currentToolStartMs: NOW - 20_000 })] })!;
	expect(plain(slow.lines[2]!)).toMatch(/bash 20\.0s$/);
	const stalled = body({ progress: [live({ id: "0-A", currentTool: "bash", currentToolStartMs: NOW - 7 * 60_000 })] })!;
	expect(plain(stalled.lines[0]!)).toContain("⏸ 1 stalled");
	expect(stalled.lines[1]).toContain(painted("warning", "⏸"));
});

test("failures stay visible with a red reason line and mark the card failed", () => {
	const card = body({ results: [done({ id: "0-Docs", exitCode: 1, aborted: true, abortReason: "context exhausted\nmore", usage: { cost: { total: 0.02 } } })], totalDurationMs: 5000 })!;
	expect(card.failed).toBe(true);
	expect(plain(card.lines[0]!)).toContain("✗ 1 failed");
	expect(plain(card.lines[2]!)).toBe("  └ aborted: context exhausted");
	expect(card.lines[2]).toContain("\x1b[34m");
});

test("context shows only past 50% and warns past 80%", () => {
	const at = (frac: number) => body({ progress: [live({ id: "0-A", contextTokens: frac * 1000, contextWindow: 1000 })] })!.lines.map(plain).join("\n");
	expect(at(0.4)).not.toContain("ctx");
	expect(at(0.6)).toContain("ctx 60%");
	const hot = body({ progress: [live({ id: "0-A", contextTokens: 900, contextWindow: 1000 })] })!;
	expect(hot.lines[1]).toContain(painted("warning", "ctx 90%"));
});

test("a cost outlier among three or more agents is colored as a warning", () => {
	const card = body({ progress: [live({ id: "0-A", cost: 0.05 }), live({ id: "1-B", cost: 0.06 }), live({ id: "2-C", cost: 1.5 })] })!;
	const row = (name: string) => card.lines.find(line => plain(line).includes(name))!;
	expect(row("C")).toContain(painted("warning", "$1.50"));
	expect(row("A")).toContain(painted("statusLineCost", "$0.05"));
});

test("narrow widths drop stats right to left in importance and never overflow", () => {
	const agent = live({ id: "0-Agent", description: "a fairly long assignment summary that needs room", toolCount: 12, requests: 34, cost: 0.18 });
	for (const width of [100, 60, 40, 30]) {
		const card = body({ progress: [agent] }, width)!;
		for (const line of card.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	const mid = body({ progress: [agent] }, 42)!.lines.map(plain)[1]!;
	expect(mid).toContain("$0.18");
	expect(mid).not.toContain("req");
});

test("large batches fold finished and queued agents into summary lines", () => {
	const progress = [
		...Array.from({ length: 5 }, (_, i) => live({ id: `${i}-Done${i}`, status: "completed" as const })),
		live({ id: "5-Run", currentTool: "read", currentToolArgs: "x" }),
		...Array.from({ length: 4 }, (_, i) => live({ id: `${6 + i}-Wait${i}`, status: "pending" as const })),
	];
	const lines = body({ progress })!.lines.map(plain);
	expect(lines[0]).toContain("✓ 5 done");
	expect(lines.join("\n")).toContain("✓ 5 done: Done0, Done1, Done2, Done3, Done4");
	expect(lines.join("\n")).toContain("○ 2 more queued");
	expect(lines.slice(1).filter(line => line.startsWith("✓ ")).length).toBe(1);
	expect(lines.slice(1).filter(line => line.startsWith("○ ")).length).toBe(3);
});

test("a small batch keeps every finished row", () => {
	const lines = body({ results: [done({ id: "0-A", description: "first" }), done({ id: "1-B", description: "second" })] })!.lines.map(plain);
	expect(lines.slice(1).filter(line => line.startsWith("✓ ")).length).toBe(2);
});

test("finished tasks wear the shared success green on their glyph and in the digest", () => {
	const lines = body({ progress: [live({ id: "0-A", status: "completed" as const }), live({ id: "1-B" })] })!.lines;
	const GREEN = "\x1b[38;2;156;219;117m";
	expect(lines[0]).toContain(`${GREEN}✓ 1 done`);
	expect(lines.join("\n")).toContain(`${GREEN}✓`);
	expect(lines.join("\n")).not.toContain(painted("success", "✓"));
});
