import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStall, detectStalls, toolStage } from "../lib/stall-watch";

const now = new Date("2026-10-01T16:00:00.000Z");
const old = "2026-10-01T15:54:00.000Z";
const thresholds = { modelStallMinutes: 5, toolStageMinutes: [6, 12, 20] };
const toolAt = (startedAt: string) => fixture([{ timestamp: startedAt, type: "custom", customType: "tool_execution_start", data: { toolName: "bash", startedAt } }]);

function fixture(lines: unknown[]): string {
	const root = mkdtempSync(join(tmpdir(), "hydemods-stall-"));
	const session = join(root, "parent.jsonl");
	writeFileSync(session, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
	return session;
}

describe("stall watch", () => {
	test("classifies an old tool result as model stall", () => {
		const path = fixture([
			{ timestamp: old, type: "message", message: { role: "assistant", model: "gpt-5.6-luna", content: [] } },
			{ timestamp: old, type: "message", message: { role: "toolResult", toolCallId: "call-1" } },
		]);
		const stall = classifyStall(path, now, thresholds);
		expect(stall?.kind).toBe("model");
		expect(stall?.message).toContain("parent idle 6m");
		expect(stall?.message).toContain("waiting on model (gpt-5.6-luna)");
	});

	test("escalates an open tool call: check-in, alert, then kill", () => {
		expect(classifyStall(toolAt("2026-10-01T15:55:00.000Z"), now, thresholds)).toBeUndefined();
		const checkIn = classifyStall(toolAt("2026-10-01T15:53:00.000Z"), now, thresholds);
		expect(checkIn).toMatchObject({ kind: "tool", toolName: "bash", stage: 0, action: "check-in" });
		expect(classifyStall(toolAt("2026-10-01T15:47:00.000Z"), now, thresholds)).toMatchObject({ stage: 1, action: "alert" });
		const kill = classifyStall(toolAt("2026-10-01T15:30:00.000Z"), now, thresholds);
		expect(kill).toMatchObject({ stage: 2, action: "kill" });
		expect(kill?.message).toContain("waiting on tool bash for 30m");
	});

	test("a single tool stage only checks in and never kills", () => {
		expect(toolStage(30, [6])).toEqual({ stage: 0, action: "check-in" });
	});

	test("alerts once per tool stage as a call keeps running", () => {
		const path = toolAt("2026-10-01T15:53:00.000Z");
		const alerted = new Set<string>();
		expect(detectStalls(path, now, thresholds, alerted).map(s => s.action)).toEqual(["check-in"]);
		expect(detectStalls(path, new Date("2026-10-01T16:03:00.000Z"), thresholds, alerted)).toHaveLength(0);
		expect(detectStalls(path, new Date("2026-10-01T16:06:00.000Z"), thresholds, alerted).map(s => s.action)).toEqual(["alert"]);
		expect(detectStalls(path, new Date("2026-10-01T16:14:00.000Z"), thresholds, alerted).map(s => s.action)).toEqual(["kill"]);
	});

	test("ignores a subagent that finished with yield", () => {
		const path = fixture([{ timestamp: old, type: "message", message: { role: "toolResult", toolName: "yield", toolCallId: "call-1" } }]);
		expect(classifyStall(path, now, thresholds)).toBeUndefined();
	});

	test("deduplicates an episode and rearms after a new entry", () => {
		const path = fixture([{ timestamp: old, type: "message", message: { role: "user", content: "go" } }]);
		const dir = path.slice(0, -".jsonl".length);
		const alerted = new Set<string>();
		expect(detectStalls(path, now, thresholds, alerted)).toHaveLength(1);
		expect(detectStalls(path, now, thresholds, alerted)).toHaveLength(0);
		writeFileSync(path, JSON.stringify({ timestamp: "2026-10-01T15:53:00.000Z", type: "message", message: { role: "user", content: "again" } }) + "\n");
		expect(detectStalls(path, now, thresholds, alerted)).toHaveLength(1);
		void dir;
	});
});
