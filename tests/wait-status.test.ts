import { expect, test } from "bun:test";
import { waitStatusLine } from "../lib/wait-status";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const colored = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text } as never;
const job = (id: string, status: string) => ({ id, label: id, type: "task", status });
const result = (jobs: ReturnType<typeof job>[], extra: Record<string, unknown> = {}) => ({
	content: [{ type: "text", text: "## Completed (1)\n\n### X [task] — completed\n..." }],
	details: { op: "wait", jobs },
	...extra,
});
const line = (r: Parameters<typeof waitStatusLine>[0], o: Partial<Parameters<typeof waitStatusLine>[1]> = {}, t = theme) =>
	waitStatusLine(r, { expanded: false, isPartial: false, ...o }, t);

test("a completed job reads as one line with its count and name", () => {
	expect(line(result([job("GatePoll", "completed")]))).toBe("✓ Wait · 1 completed GatePoll");
});

test("a failed job leads, turns red, and the line has no newline", () => {
	const out = line(result([job("A", "completed"), job("B", "failed")]), {}, colored)!;
	expect(out).toContain("<error>✗ Wait</error>");
	expect(out).toContain("1 failed, 1 completed");
	expect(out).not.toContain("\n");
});

test("only-running snapshots read as still waiting and extra names collapse to a count", () => {
	const out = line(result([job("A", "running"), job("B", "running"), job("C", "running")]), {}, colored)!;
	expect(out).toContain("<warning>◐ Wait</warning>");
	expect(out).toContain("3 running");
	expect(out).toContain("A, B");
	expect(out).toContain("+1");
});

test("partial calls show waiting with the intent", () => {
	expect(line(undefined, { isPartial: true, intent: "Waiting for scouts" })).toBe("⏳ Waiting · Waiting for scouts");
	expect(line(undefined, { isPartial: true })).toBe("⏳ Waiting");
});

test("expanded defers to the native card", () => {
	expect(line(result([job("A", "completed")]), { expanded: true })).toBeUndefined();
});

test("interrupted waits read as skipped, not completed", () => {
	const out = line({ content: [{ type: "text", text: "Skipped due to a queued background completion" }], details: { __interrupted: true }, isError: true });
	expect(out).toContain("Wait skipped");
});

test("without details the text section headings supply the counts", () => {
	const out = line({ content: [{ type: "text", text: "## Completed (2)\n\n### One [task] — completed\n### Two [task] — completed\n" }] });
	expect(out).toBe("✓ Wait · 2 completed One, Two");
});

test("unparseable errors say failed; unparseable successes say no job changes", () => {
	expect(line({ content: [{ type: "text", text: "boom" }], isError: true })).toBe("✗ Wait failed");
	expect(line({ content: [{ type: "text", text: "Nothing" }] })).toBe("✓ Wait · no job changes");
});
